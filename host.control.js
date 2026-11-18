/**
 * 多工作区平铺 —— 停止与唤醒（`control_task` 的宿主半边）。
 *
 * ## 为什么单独一层
 *
 * 「停止」和「唤醒」看起来只是纠正流程的两半，但它们与纠正有一个本质区别：
 *
 *   - 纠正 = 停止 + **立刻重发一条消息** + 重新启动。三步在同一个调用里完成，
 *     中间的空窗很短，所以 `host.redirect.js` 可以用 3 秒兜底；
 *   - 停止 = 停止 + **留在暂停态**。中间没有下一条消息，主会话可能过很久才决定
 *     唤醒还是派新任务。因此这里必须把「目标是否真的停下」确认清楚，并且把
 *     `pending` 这笔账结干净，不能让后台监视和后续调用看到半截状态。
 *
 * 唤醒则相反：它不新建目标、不重发任务正文，只把原有 goal 重新 arm，再开一张
 * 新的派单票，让 A 之后可以照常 `dispatch_task` 续等。
 *
 * ## 停止的顺序（不能换）
 *
 *   1. `goals.disarm` —— 先掐掉自动推进，防止停止与暂停之间又起一轮；
 *   2. `agent.cancel({ kind: 'hook', ... }, { keepInbox: true })` —— 与界面停止
 *      同一个底层动作，但原因标成 hook；
 *   3. 等目标真正 idle（`turn/end` 只是信号之一，`agent.status` 才是事实）；
 *   4. 这时才 `goals.pause` —— 目标已 idle，`goal-round-driver` 不会因为
 *      `goal/changed` 的 pause 再补一刀 `aborted.user`；
 *   5. 确认 phase 已经 paused（或 active + disarmed + idle），再结清 pending。
 *
 * 第 4 步的坑：如果 agent 还在 running 时调 `goals.pause`，`dsh-goal-round-driver`
 * 会按「用户暂停」的语义 `agent.cancel({ kind: 'user' })`。A 的后台监视看到
 * `aborted.user` 就会把这一单记成「用户手动停止、被用户接管」，与「主会话停止」
 * 完全混掉。先等 idle 再 pause，这一刀就不会发生。
 *
 * ## 超时
 *
 * 等 idle 有上限（默认 30 秒）。超时返回 `stopping`，**不能报 paused**：目标可能
 * 卡在某个不响应中止的工具里。此时目标已经 disarm，不会再自动开新轮；`pending`
 * 保留，后台监视会在它真正停下时结算。主会话可以稍后再 stop 一次确认。
 *
 * @module @local/dsh-split-workspaces/host-control
 */

import {
  STATUS_PAUSED,
  STATUS_RESUMED,
  STATUS_STOPPING,
  STOP_CANCEL_REASON,
  STOP_TIMEOUT_MS,
} from './host.constants.js';
import { errorText } from './host.message.js';
import { goalSupport, resolveTargetAgent } from './host.wait.js';
import { isOurGoal, watchDetached } from './host.watch.js';

/** 等 agent 状态变化的轮询间隔。只用于兜底，正常路径靠事件立刻醒来。 */
const IDLE_POLL_MS = 25;

/**
 * 读一次目标状态；读不到就当作「不知道」。
 *
 * @param support - `goalSupport()` 的返回值。
 * @param agent - 目标会话的活 agent。
 * @returns `GoalView` 或 `undefined`。
 */
function readGoal(support, agent) {
  try {
    return support.goals.get(agent);
  } catch {
    return undefined;
  }
}

/**
 * 把目标视图压成 CAS 需要的 `{ id, revision }`。
 *
 * @param view - `goals.get()` 的返回值。
 * @returns 目标引用。
 */
function goalRefOf(view) {
  return { id: view.id, revision: view.revision };
}

/**
 * 确认目标服务具备控制所需的方法。
 *
 * 老部署或精简宿主可能只有 `create/get`。这时必须明确拒绝，而不是做到一半：
 * 比如能 cancel 却没法 pause，目标会停在 active + armed + idle，下一轮又自己
 * 跑起来，主会话却以为已经停了。
 *
 * @param support - `goalSupport()` 的返回值。
 */
function assertControlMethods(support) {
  const missing = ['get', 'disarm', 'pause', 'resume']
    .filter((name) => typeof support.goals[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      '这个部署的目标服务缺少 ' + missing.join(' / ') + '，做不到停止与唤醒。'
      + '先等目标自己跑完，再按新任务重新派。',
    );
  }
}

/**
 * 查一下这个目标是不是正被**另一个**主会话使用。
 *
 * `pending` 的 key 是 `ownerId\u0000targetId`。如果同一目标在别人的 key 下还有票，
 * 说明那一单是另一个会话派的：本会话不该越过它去停或唤醒，否则会干扰别人的任务。
 *
 * 只在**没有自己这张票**时才会走到这个检查；自己有票时，本会话就是这单的主人。
 *
 * @param service - 绑定表（读 `pending`）。
 * @param ownerId - 本次调用的发起方。
 * @param targetId - 目标会话 id。
 * @returns 另一个主人（发起方 id），或 null。
 */
function otherOwnerPending(service, ownerId, targetId) {
  for (const key of service.pending.keys()) {
    const cut = key.indexOf('\u0000');
    if (cut < 0) continue;
    const owner = key.slice(0, cut);
    const target = key.slice(cut + 1);
    if (target === targetId && owner !== ownerId) return owner;
  }
  return null;
}

/**
 * 等目标 agent 真正空闲下来。
 *
 * 三个结束条件：
 *   - `idle`：`agent.status !== 'running'`；
 *   - `timeout`：到了时限还没停；
 *   - `cancelled`：主会话自己按了停止（调用方 signal 被 abort）。
 *
 * 为什么不能只等 `turn/end`：事件到达时 agent 的 phase 可能还要一拍才切到 idle；
 * 更关键的是，队列里如果还有消息，它可能立刻再起一轮。只有 `agent.status` 才
 * 代表「此刻真的没有回合在跑」。`turn/end` 用来提前触发一次检查，事件本身不是
 * 完成的证据。
 *
 * 监听要在调用 `cancel()` **之前**挂好：停止很快的目标可能在 cancel 返回前就
 * 发出 `turn/end` 并切到 idle，晚挂监听会永远等不到。
 *
 * @param ctx - 宿主上下文（订阅 `agent/status` 与 `session/event`）。
 * @param agent - 目标 agent。
 * @param timeoutMs - 最长等多久。
 * @param signal - 调用方取消信号。
 * @returns 兑现 `'idle' | 'timeout' | 'cancelled'`。
 */
function waitForIdle(ctx, agent, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let poll = null;
    let deadline = null;
    let offStatus = () => {};
    let offEvent = () => {};
    let offAbort = () => {};

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (poll !== null) clearInterval(poll);
      if (deadline !== null) clearTimeout(deadline);
      offStatus();
      offEvent();
      offAbort();
      resolve(result);
    };

    const check = () => {
      if (agent.status !== 'running') finish('idle');
    };

    // 已经空闲：不用挂监听，也不用等一个永远不会来的状态变化。
    if (agent.status !== 'running') {
      finish('idle');
      return;
    }

    offStatus = ctx.on('agent/status', (payload) => {
      if (payload === undefined || payload === null) return;
      const who = payload.agent;
      // 只认这个 agent 的状态变化；其它会话的 idle 与我们无关。
      if (who === undefined || who === null || who.id !== agent.id) return;
      if (payload.status !== 'running') finish('idle');
    });
    offEvent = ctx.on('session/event', (session, event) => {
      if (session === undefined || session.id !== (agent.session?.id ?? agent.id)) return;
      if (event === undefined || event.type !== 'turn/end') return;
      /*
       * turn/end 的同步监听者（包括 goal-round-driver）还要跑完，agent 的 phase
       * 也通常在 kick 的 finally 里才切到 idle。让出一拍再查，避免抢在 driver
       * 前面把「已经 idle」当成事实。
       */
      setImmediate(check);
    });

    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        finish('cancelled');
        return;
      }
      const onAbort = () => finish('cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
      offAbort = () => signal.removeEventListener('abort', onAbort);
    }

    // 事件可能因为宿主实现差异而漏发；轮询是兜底，不承担主路径。
    poll = setInterval(check, IDLE_POLL_MS);
    poll.unref?.();
    /*
     * 超时定时器**不能 unref**：等待的 Promise 只靠它兜底。unref 之后，如果目标
     * 既不响应 cancel 也不发状态事件，Host 里虽然还有别的活干，但独立运行的脚本
     * （测试、CLI）会直接退出，这个 Promise 永远悬着。它最多活 30 秒，成功时
     * 立刻清掉，不值得为它冒这个险。
     */
    deadline = setTimeout(() => finish('timeout'), Math.max(1, timeoutMs));
    check();
  });
}

/**
 * 停掉目标当前轮，并等它真正 idle。
 *
 * 先挂等待、再发 cancel：顺序反了会漏掉「cancel 返回前就结束」的那一拍。
 * 原因固定用 `hook`，绝不冒充 `user` —— `aborted.user` 在 A 的监视里代表
 * 「用户接管了这一单」。
 *
 * `keepInbox: true` 与界面停止按钮一致：只中止当前回合，不清空目标队列里用户
 * 自己排的消息。`false` 会把它们整批丢掉，属于破坏性动作。
 *
 * @param ctx - 宿主上下文。
 * @param agent - 目标 agent。
 * @param timeoutMs - 等 idle 的上限。
 * @param signal - 调用方取消信号。
 * @returns 兑现 `'idle' | 'timeout' | 'cancelled'`。
 */
async function cancelAndWait(ctx, agent, timeoutMs, signal) {
  if (agent.status !== 'running') return 'idle';
  const waiting = waitForIdle(ctx, agent, timeoutMs, signal);
  try {
    agent.cancel(
      { kind: 'hook', reason: STOP_CANCEL_REASON },
      { keepInbox: true },
    );
  } catch {
    /*
     * cancel 抛错不改变「等待」本身：目标可能已经自己结束，也可能继续跑。
     * 让 waitForIdle 用状态给出结论；超时就是 stopping，不在这里假装成功。
     */
  }
  return waiting;
}

/**
 * 在 agent 已经 idle 的前提下，把目标切到 durable paused。
 *
 * 这是 best effort：如果目标服务拒绝（比如 revision 在停止过程中变了），回退到
 * `active + disarmed + idle`。这个组合在 DSH 目标栏同样显示「已暂停的目标」，
 * `goals.resume` 也认它，所以不算失败。真正的失败判据是后面的 `stopped` 检查。
 *
 * 调用方必须保证此刻 `agent.status !== 'running'`：否则 driver 会把 pause 当成
 * 用户暂停，补一刀 `aborted.user`。
 *
 * @param support - `goalSupport()` 的返回值。
 * @param agent - 目标 agent。
 * @returns 重新读到的目标视图（可能为 undefined）。
 */
function pauseAfterIdle(support, agent) {
  const before = readGoal(support, agent);
  if (before === undefined || before === null || before.phase !== 'active') return before;
  try {
    support.goals.pause(agent, goalRefOf(before));
  } catch {
    /*
     * revision 竞争：目标可能刚被 driver 暂停/清除。重读一次再试；仍不行就保留
     * disarmed 状态，让调用方按 classify 的语义收口。
     */
    const after = readGoal(support, agent);
    if (after !== undefined && after !== null && after.phase === 'active') {
      try {
        support.goals.pause(agent, goalRefOf(after));
      } catch {
        /* best effort：active + disarmed + idle 也算已暂停 */
      }
    }
  }
  return readGoal(support, agent);
}

/**
 * 唤醒目标；revision 竞争时重读一次再试。
 *
 * `goals.resume` 是 CAS：调用前读到的 revision 必须还是当前值。停止流程刚 pause
 * 过目标，revision 很可能在两次读之间又变了一次；重试一次能把这种瞬时竞争吃掉，
 * 又不会无限重试掩盖真正的问题（比如轮数已经用完）。
 *
 * @param support - `goalSupport()` 的返回值。
 * @param agent - 目标 agent。
 * @returns resume 后的目标视图。
 */
function resumeGoal(support, agent) {
  const before = readGoal(support, agent);
  if (before === undefined || before === null) throw new Error('目标已经不存在，不能唤醒。');
  try {
    return support.goals.resume(agent, goalRefOf(before));
  } catch (reason) {
    const after = readGoal(support, agent);
    if (after !== undefined && after !== null
      && (after.revision !== before.revision || after.phase !== before.phase)) {
      return support.goals.resume(agent, goalRefOf(after));
    }
    throw reason;
  }
}

/**
 * 造一条控制结果。
 *
 * 形状与 `dispatch_task` 的 results 保持一致，模型不需要学第二套读法。
 * 控制永远不是交付：`deliverable` 固定 false，`reply` 为空。
 *
 * @param binding - 目标绑定。
 * @param status - 状态词。
 * @param note - 给模型看的说明。
 * @returns 结果对象。
 */
function resultOf(binding, status, note) {
  return {
    target: binding.label,
    status,
    deliverable: false,
    reply: '',
    progress: '',
    interruptedBy: '',
    note,
  };
}

/**
 * 整理一批控制结果的顶层状态。
 *
 * 与批处理的 `partial` 约定一致：只有所有目标都是同一个状态才算那个状态；
 * 「已暂停 + 还没确认停止」整批算 `stopping` —— 不能因为有一个停了就说全停了。
 *
 * @param results - 每个目标的结果。
 * @returns 顶层状态词。
 */
function batchStatusOf(results) {
  if (results.length === 0) return 'partial';
  const statuses = new Set(results.map((item) => item.status));
  if (statuses.size === 1) return results[0].status;
  const allSettling = results.every((item) => item.status === STATUS_PAUSED
    || item.status === STATUS_STOPPING);
  if (allSettling) return STATUS_STOPPING;
  return 'partial';
}

/**
 * 停止一批目标，并等它们真正停下来。
 *
 * 每个目标独立处理：一个失败不拖垮整批，结果里如实区分「已暂停」「还没确认」
 * 「已经完成」「已受阻」「不能停」。
 *
 * @param options.ctx - 宿主上下文。
 * @param options.service - 绑定表（读写 `pending`）。
 * @param options.ownerId - 发起方会话 id。
 * @param options.bindings - 要停止的目标（已解析）。
 * @param options.signal - 调用方取消信号。
 * @param options.timeoutMs - 等 idle 的上限（默认 30 秒）。
 * @returns `{ status, results, stillRunning, note }`。
 */
export async function stopBatch(options) {
  const {
    ctx, service, ownerId, bindings, signal,
    timeoutMs = STOP_TIMEOUT_MS,
  } = options;
  const support = goalSupport(ctx);
  if (support === null) {
    throw new Error('这个部署没有目标服务，做不到停止：只能等目标自己跑完，或按新任务重新派。');
  }
  if (signal?.aborted) throw new Error('这次停止已经被取消。');
  assertControlMethods(support);

  const results = [];
  for (const binding of bindings) {
    const key = ownerId + '\u0000' + binding.id;
    try {
      const agent = await resolveTargetAgent(support, binding);
      const view = readGoal(support, agent);
      if (view === undefined || view === null) {
        results.push(resultOf(binding, 'failed',
          '目标已经不存在（可能被清除或会话已结束），没有可停止的任务。'));
        continue;
      }
      if (!isOurGoal(view)) {
        results.push(resultOf(binding, 'failed',
          '这不是任务分派创建的目标；要停止目标会话自己的回合，请在目标窗格里手动停。'));
        continue;
      }
      const other = otherOwnerPending(service, ownerId, binding.id);
      if (other !== null) {
        results.push(resultOf(binding, 'failed',
          '这个目标的任务是另一个会话派的，不能由当前会话停止。'));
        continue;
      }

      if (view.phase === 'complete') {
        results.push(resultOf(binding, 'complete',
          '停止晚了一步：目标已经完成。当前这单不是停止结果，'
          + '用 dispatch_task（不带 task）取回结论并审核。'));
        continue;
      }
      if (view.phase === 'blocked') {
        results.push(resultOf(binding, 'blocked',
          '目标已经受阻，不需要停止。让用户到目标窗格查看受阻原因并决定下一步。'));
        continue;
      }
      if (view.phase === 'paused') {
        /*
         * 已经是暂停态：可能刚被用户 pause，也可能是上一次停止的结果。不要再
         * cancel（会把用户自己的回合也掐掉）；如果它还有回合在跑，只等它收尾，
         * 不主动打断。
         */
        if (agent.status === 'running') {
          const waited = await waitForIdle(ctx, agent, timeoutMs, signal);
          if (waited === 'timeout') {
            results.push(resultOf(binding, STATUS_STOPPING,
              '目标已是暂停状态，但当前回合还没在时限内收尾。它不会自动开新轮；'
              + '稍后再调一次 stop 确认，或到目标窗格手动停。'));
            continue;
          }
          if (waited === 'cancelled') {
            results.push(resultOf(binding, STATUS_STOPPING,
              '等待被取消：目标已是暂停状态，停止请求没有再等下去。'));
            continue;
          }
        }
        /*
         * 已经暂停的目标也把票结掉，保持「stop 之后这单就结束」的语义。
         * 唯一的例外是用户手停留下的 `interrupted`：那条记录是「不要越过用户」
         * 的证据，wake 还要靠它拦一次，不能在这里删掉。
         */
        const existing = service.pending.get(key);
        if (existing !== undefined && existing.settled?.interruptedBy !== 'user') {
          service.forget(key);
        }
        results.push(resultOf(binding, STATUS_PAUSED,
          '目标已经是暂停状态，没有需要停止的回合。可以用 control_task resume 唤醒，'
          + '或按新任务重新派。'));
        continue;
      }
      if (view.phase !== 'active') {
        results.push(resultOf(binding, 'failed',
          '目标当前处于未知状态（' + view.phase + '），不能安全地停止。'));
        continue;
      }

      /*
       * 先 disarm：从这一刻起，goal-round-driver 不会在停止与暂停之间再插一轮。
       * 即使后面 cancel 失败、超时，目标也不会继续自动推进。
       *
       * 这里**不**清 `humanStopped`：用户手停过的目标，即使主会话现在又停了一次，
       * 也不代表用户同意唤醒。标记只在新任务、或观察到目标已经被重新启动时清。
       */
      try {
        support.goals.disarm(agent);
      } catch (reason) {
        results.push(resultOf(binding, 'failed',
          '没能挂起目标的自动推进（' + errorText(reason) + '），这次没有停。'));
        continue;
      }

      if (agent.status === 'running') {
        const waited = await cancelAndWait(ctx, agent, timeoutMs, signal);
        if (waited === 'timeout') {
          results.push(resultOf(binding, STATUS_STOPPING,
            '停止请求已发出，但 ' + String(Math.round(timeoutMs / 1000))
            + ' 秒内没确认目标停下（可能卡在不响应中止的工具里）。'
            + '目标已经不会再自动开新轮；这单保留在后台等它真正停下，'
            + '稍后再调一次 stop 确认，或用 dispatch_task 取结果。不要当成已停止。'));
          continue;
        }
        if (waited === 'cancelled') {
          results.push(resultOf(binding, STATUS_STOPPING,
            '等待被取消：停止请求已经发出，目标不会再自动开新轮，但当前回合是否收尾没有确认。'
            + '稍后再调一次 stop 确认。'));
          continue;
        }
      }

      const afterStop = readGoal(support, agent);
      if (afterStop === undefined || afterStop === null) {
        results.push(resultOf(binding, 'failed',
          '目标在停止过程中被清除了，没有可暂停的目标；如果它还在跑，去目标窗格手动停。'));
        continue;
      }
      if (afterStop.phase === 'complete') {
        results.push(resultOf(binding, 'complete',
          '停止晚了一步：目标已经完成。用 dispatch_task（不带 task）取回结论并审核。'));
        continue;
      }
      if (afterStop.phase === 'blocked') {
        results.push(resultOf(binding, 'blocked',
          '目标在停止过程中进入了受阻状态，已经停住，不需要再暂停。'));
        continue;
      }

      /*
       * 只有 agent 真的 idle 才 pause。这一拍是同步的：检查与 pause 之间没有
       * await，所以新的回合不可能插进来，driver 看到的也一定是 idle。
       */
      let final = afterStop;
      if (afterStop.phase === 'active' && agent.status !== 'running') {
        final = pauseAfterIdle(support, agent);
      }

      /*
       * 停止与 pause 之间目标可能刚好完成/受阻（例如最后一轮在等我们这一拍）。
       * 这时不能再报 stopping —— 目标已经进入终态，如实说清并保留票。
       */
      if (final !== undefined && final !== null && final.phase === 'complete') {
        results.push(resultOf(binding, 'complete',
          '停止晚了一步：目标在收尾时完成了。用 dispatch_task（不带 task）取回结论并审核。'));
        continue;
      }
      if (final !== undefined && final !== null && final.phase === 'blocked') {
        results.push(resultOf(binding, 'blocked',
          '目标在停止过程中进入了受阻状态，已经停住，不需要再暂停。'));
        continue;
      }

      const stopped = final !== undefined && final !== null
        && (final.phase === 'paused'
          || (final.phase === 'active'
            && final.activation === 'disarmed'
            && agent.status !== 'running'));
      if (!stopped) {
        results.push(resultOf(binding, STATUS_STOPPING,
          '停止请求已发出，但目标没有进入可确认的暂停状态。它已经不会再自动开新轮；'
          + '稍后再调一次 stop 确认，或到目标窗格手动停。'));
        continue;
      }

      /*
       * 确认停了：结清这单。目标上的 goal 留着（paused 或 active + disarmed），
       * 之后可以 resume 唤醒；这里删的是「派单票」，不是目标本身。
       */
      service.forget(key);
      results.push(resultOf(binding, STATUS_PAUSED,
        '已停止并暂停：目标不会自动继续，当前这单未交付。'
        + '之后可以 control_task resume 唤醒原目标，或用 dispatch_task 派新任务。'));
    } catch (reason) {
      results.push(resultOf(binding, 'failed', errorText(reason)));
    }
  }

  const status = batchStatusOf(results);
  const stopping = results.filter((item) => item.status === STATUS_STOPPING).length;
  let note = '';
  if (status === STATUS_PAUSED) {
    note = '这些目标已经停止并暂停，不会再自动推进。当前这单未交付；'
      + '可以用 control_task resume 唤醒原目标，或直接派新任务。';
  } else if (status === STATUS_STOPPING) {
    note = '至少有一个目标还没确认停下。它已经不会再自动开新轮；后台会继续等，'
      + '稍后再调一次 stop 确认，或用 dispatch_task 取结果。不要把 stopping 当成已停止。';
  } else if (status === 'complete') {
    note = '目标在停止之前已经完成。用 dispatch_task（不带 task）取回结论并审核。';
  }
  return { status, results, stillRunning: stopping, note };
}

/**
 * 唤醒一批暂停的原目标。
 *
 * 只恢复目标，不重发任务：调用 `goals.resume` 之后，round driver 会用原来的
 * objective 发下一轮，目标会话的历史还在，能接上。成功后重新开一张派单票并挂
 * 后台监视，A 之后照常 `dispatch_task` 续等即可。
 *
 * 拒绝的四类：
 *   - `complete`：已经交付，先取结果并审核；
 *   - `blocked`：策略性停住（轮数耗尽、提示被拒），不自动复活；
 *   - 用户手动停止过：不越过用户，先问用户；
 *   - 不是任务分派创建的目标：不能替用户在目标窗格里恢复它自己的目标。
 *
 * @param options.ctx - 宿主上下文。
 * @param options.service - 绑定表（读写 `pending`）。
 * @param options.ownerId - 发起方会话 id。
 * @param options.bindings - 要唤醒的目标（已解析）。
 * @param options.signal - 调用方取消信号。
 * @returns `{ status, results, stillRunning, note }`。
 */
export async function resumeBatch(options) {
  const { ctx, service, ownerId, bindings, signal } = options;
  if (signal?.aborted) throw new Error('这次唤醒已经被取消。');
  const support = goalSupport(ctx);
  if (support === null) {
    throw new Error('这个部署没有目标服务，做不到唤醒：只能按新任务重新派。');
  }
  assertControlMethods(support);

  const results = [];
  for (const binding of bindings) {
    const key = ownerId + '\u0000' + binding.id;
    try {
      const agent = await resolveTargetAgent(support, binding);
      const view = readGoal(support, agent);
      if (view === undefined || view === null) {
        results.push(resultOf(binding, 'failed',
          '目标已经不存在，没有可唤醒的原目标；要新工作就派新任务。'));
        continue;
      }
      if (!isOurGoal(view)) {
        results.push(resultOf(binding, 'failed',
          '这不是任务分派创建的目标；要恢复请在目标窗格手动操作。'));
        continue;
      }
      const other = otherOwnerPending(service, ownerId, binding.id);
      if (other !== null) {
        results.push(resultOf(binding, 'failed',
          '这个目标的任务是另一个会话派的，不能由当前会话唤醒。'));
        continue;
      }
      const pending = service.pending.get(key);

      if (view.phase === 'active' && view.activation === 'armed') {
        /*
         * 已经 active + armed：说明有人（用户点「继续执行目标」，或别的路径）
         * 已经把它重新启动了。用户手停的旧标记这时已经过期，顺手清掉。
         */
        service.humanStopped?.delete(key);
        results.push(resultOf(binding, 'running',
          '目标已经在运行，不需要唤醒。用 dispatch_task（不带 task）接着等结果。'));
        continue;
      }
      if (view.phase === 'complete') {
        results.push(resultOf(binding, 'failed',
          '目标已经完成，不能唤醒。先用 dispatch_task 取回结论并审核；'
          + '要新工作就派新任务。'));
        continue;
      }
      if (view.phase === 'blocked') {
        results.push(resultOf(binding, 'failed',
          '目标已经受阻（策略性停住），不自动唤醒。'
          + '让用户到目标窗格查看原因，决定是提高轮数上限还是重新派任务。'));
        continue;
      }
      const stoppedState = view.phase === 'paused'
        || (view.phase === 'active' && view.activation === 'disarmed');
      if (!stoppedState) {
        results.push(resultOf(binding, 'failed',
          '目标当前状态（' + view.phase + '）不是可唤醒的暂停态。'));
        continue;
      }
      /*
       * 用户手动停止过的目标：不越过用户。
       *
       * 两道证据：还没取走的中断结果（pending 里的 `interruptedBy`），以及服务上
       * 的短命标记（结果取走之后仍在）。两道都查不到时，说明是 Host 重启丢了记录，
       * 只能靠工具描述要求模型先问用户 —— 这一点在 wake 的说明里写死了。
       */
      if (service.humanStopped?.has(key) || pending?.settled?.interruptedBy === 'user') {
        results.push(resultOf(binding, 'failed',
          '这个目标上一次是用户手动停止的，不能越过用户自动唤醒。'
          + '先问用户是否要继续，再由用户决定。'));
        continue;
      }
      /*
       * 还在收尾的目标不能唤醒：此时 resume 会让 driver 在旧回合还没结束时
       * 重新 arm，等旧回合结束又开一轮，等于把「停止」撤销了一半。
       */
      if (agent.status === 'running') {
        results.push(resultOf(binding, 'failed',
          '目标还在停止收尾（agent 仍在 running），等它真正 idle 再唤醒。'));
        continue;
      }

      let resumed;
      try {
        resumed = resumeGoal(support, agent);
      } catch (reason) {
        /*
         * 读与 resume 之间可能有人（用户点「继续执行目标」、或另一条路径）先一步
         * 把它启动了。这时它已经是 active + armed，不需要再唤醒一次，按 running
         * 返回即可，不要让主会话看到一条假的失败。
         */
        const current = readGoal(support, agent);
        if (current !== undefined && current !== null
          && current.phase === 'active' && current.activation === 'armed') {
          service.humanStopped?.delete(key);
          results.push(resultOf(binding, 'running',
            '目标已经被重新启动，不需要再唤醒。用 dispatch_task（不带 task）接着等结果。'));
          continue;
        }
        results.push(resultOf(binding, 'failed',
          '唤醒失败：' + errorText(reason)
          + '。如果是轮数用完，需要在目标里提高上限，或按新任务重新派。'));
        continue;
      }
      if (resumed === undefined || resumed === null
        || resumed.phase !== 'active' || resumed.activation !== 'armed') {
        results.push(resultOf(binding, 'failed',
          '唤醒调用返回了非 active + armed 的状态，不能确认目标已经继续。'));
        continue;
      }

      /*
       * 重新开一张派单票：唤醒不是一次「取结果」，A 之后还要能 `dispatch_task`
       * 续等。先掐掉旧票（可能还挂着一条后台监视），再换一张新的。
       */
      if (pending !== undefined) service.forget(key);
      service.humanStopped?.delete(key);
      service.pending.set(key, {
        replaced: null,
        settled: null,
        controller: null,
        progress: '',
      });
      watchDetached(ctx, service, key, agent);

      results.push(resultOf(binding, STATUS_RESUMED,
        '已唤醒：目标会从原来的 objective 继续，不是新任务、也没有重发任务正文。'
        + '之后用 dispatch_task（不带 task）等它的结果。'));
    } catch (reason) {
      results.push(resultOf(binding, 'failed', errorText(reason)));
    }
  }

  const status = batchStatusOf(results);
  const running = results.filter((item) => item.status === STATUS_RESUMED
    || item.status === 'running').length;
  let note = '';
  if (status === STATUS_RESUMED) {
    note = '已唤醒的目标会继续原来的目标（不是新任务）。'
      + '用 dispatch_task（不带 task）等结果。';
  } else if (status === 'running') {
    note = '目标本来就在运行，不需要唤醒。用 dispatch_task（不带 task）接着等结果。';
  }
  return { status, results, stillRunning: running, note };
}
