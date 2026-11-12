/**
 * 多工作区平铺 —— 把 A 的「纠正」变成「停止当前轮 + 重新输入」。
 *
 * 与旧实现的区别：旧实现把纠正作为一条排队消息塞进目标当前轮之后（`mode: queue`），
 * 目标会先按错的方向把当前轮跑完。现在按用户要求的语义执行：
 *   1. 先挂起目标的自动推进（`goals.disarm`），避免停止与重发之间插进一个目标轮；
 *   2. 停掉目标当前轮（`agent.cancel(..., keepInbox)`，与界面停止按钮同一个底层动作）；
 *   3. 把纠正作为一条**普通用户消息**投递（`mode: queue`；目标空闲时就是新一轮）；
 *   4. 重新启动目标（`goals.resume`）—— 停止如果把它暂停了，也在这一步拉起。
 *
 * 两个容易踩的点：
 *   - 停止原因用 `hook` 而不是 `user`。`aborted.user` 的语义是「用户接管了这一单」，
 *     A 那边的后台监视/等待看到它会把整单记成 interrupted。插件自己的停止不能冒充
 *     用户，否则「A 让目标停一下改方向」会被 A 误读成「用户抢走了这一单」。
 *     底层动作与界面停止完全相同（abort 当前轮、保留 inbox），只是原因标签不同。
 *   - `resume` 会推进 goal revision。停轮留下的旧 attempt 在纠正轮结束时本来会把
 *     目标暂停（goal-round-driver 只在 revision 未变时 pause）；revision 一变，
 *     这个暂停就不会发生，目标会接着往下推进。
 *
 * @module @local/dsh-split-workspaces/host-redirect
 */

import { randomUUID } from 'node:crypto';

import { REDIRECT_CANCEL_REASON, REDIRECT_STOP_TIMEOUT_MS, STATUS_REDIRECTED } from './host.constants.js';
import { errorText, wrapRedirect } from './host.message.js';
import { goalSupport, resolveTargetAgent } from './host.wait.js';

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
 * 重新启动目标的自动推进。
 *
 * 只处理三种有意义的现状：
 *   - 已经 `active + armed`：本来就在跑，什么也不用做；
 *   - `active` 但被 disarm，或 `paused`：`resume` 一并恢复阶段与激活；
 *   - `complete` / `blocked`：这是目标的真实终态，不越过策略去复活它，如实报告。
 *
 * `resume` 会推进 revision —— 这正是我们要的副作用，见文件头注释。
 *
 * @param support - `goalSupport()` 的返回值。
 * @param agent - 目标会话的活 agent。
 * @returns `{ ok, note }`；`ok` 为 false 时 `note` 是给 A 的原因。
 */
function restartGoal(support, agent) {
  const view = readGoal(support, agent);
  if (view === undefined || view === null) {
    /*
     * 目标在停止过程中被清掉了（用户 /clear-goal 之类）。纠正消息可能已经作为
     * 一条普通用户消息发出去，但没有目标可启动，必须如实告诉 A 不会自动继续。
     */
    return { ok: false, note: '目标在停止过程中已被清除，不能重新启动。' };
  }
  if (view.phase === 'active' && view.activation === 'armed') {
    return { ok: true, note: '' };
  }
  if (view.phase === 'complete' || view.phase === 'blocked') {
    return {
      ok: false,
      note: '目标在停止过程中已经进入 ' + view.phase + ' 状态，不能重新启动。',
    };
  }
  try {
    support.goals.resume(agent, goalRefOf(view));
    return { ok: true, note: '' };
  } catch (reason) {
    return { ok: false, note: '重新启动目标失败：' + errorText(reason) };
  }
}

/**
 * 等目标把当前轮真正停下来（只认我们自己这次 hook 停止产生的 `turn/end`）。
 *
 * 为什么必须等：goal-round-driver 在 `turn/end` 里处理停止——如果被停的不是
 * goal 轮，它会 **disarm** 目标。要是我们抢在它前面 `resume`，它随后又 disarm，
 * 目标就会停在 active + disarmed，A 会一直等不到推进。所以先等这一轮收尾，
 * 让所有监听者跑完，再继续「重发 + 启动」。
 *
 * 目标本来就空闲时调用方不会等；这里再给一个短超时兜底，避免某个不响应 abort
 * 的工具把整次纠正挂住。
 *
 * @param ctx - 宿主上下文（用来订阅 `session/event`）。
 * @param sessionId - 目标会话 id。
 * @param timeoutMs - 最长等多久。
 * @returns 停止事件被看到（或超时）时兑现的 Promise。
 */
function waitForStop(ctx, sessionId, timeoutMs = REDIRECT_STOP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let off = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        off();
      } catch {
        /* 退订失败不该盖住「已经停了」这件事 */
      }
      resolve();
    };
    off = ctx.on('session/event', (session, event) => {
      if (session === undefined || session.id !== sessionId) return;
      if (event === undefined || event.type !== 'turn/end') return;
      const reason = event.data?.reason;
      if (reason?.kind !== 'aborted') return;
      if (reason.reason?.kind !== 'hook' || reason.reason.reason !== REDIRECT_CANCEL_REASON) return;
      /*
       * 同一事件的所有同步监听者都跑完之后再兑现：goal-round-driver 的处理
       * 可能就在这一拍里 disarm，我们要排在它后面。
       */
      queueMicrotask(finish);
    });
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}

/**
 * 把一批纠正变成「停止目标当前轮 + 作为新消息重新提交 + 重新启动目标」。
 *
 * 投递前先读一次 goal 的 phase：目标可能刚好在 A 决定纠正之前结束了 —— 这时硬塞
 * 一条「纠正」会被当成一条新的用户消息，让目标再跑一轮无关的工作。这种情况下记成
 * `failed`，让 A 先取走结果。
 *
 * @param options.ctx - 宿主上下文。
 * @param options.service - 绑定表（用来取发起方显示名）。
 * @param options.ownerId - 发起方会话 id。
 * @param options.bindings - 正在跑的目标。
 * @param options.task - 纠正内容。
 * @param options.signal - 调用方取消信号。
 * @returns `{ status, results, stillRunning, note }`。
 */
export async function redirectBatch(options) {
  const { ctx, service, ownerId, bindings, task, signal } = options;
  const support = goalSupport(ctx);
  if (support === null) {
    throw new Error('这个部署没有目标服务，做不到中途纠正：请等目标跑完、拿到结论后再处理。');
  }
  if (typeof support.goals.disarm !== 'function'
    || typeof support.goals.resume !== 'function'
    || typeof support.goals.get !== 'function') {
    throw new Error('这个部署的目标服务缺少「停止并重新启动」所需的方法，做不到这种纠正：'
      + '请等目标跑完、拿到结论后再处理。');
  }
  const ownerLabel = service.labels.get(ownerId) ?? ownerId;
  const results = [];
  let redirected = 0;
  for (const binding of bindings) {
    try {
      const agent = await resolveTargetAgent(support, binding);
      if (typeof agent.cancel !== 'function') {
        throw new Error('目标会话没有提供 cancel()，没法停止它的当前轮。');
      }
      const view = readGoal(support, agent);
      if (view === undefined || view === null || view.phase !== 'active') {
        results.push({
          target: binding.label,
          status: 'failed',
          deliverable: false,
          reply: '',
          progress: '',
          interruptedBy: '',
          note: '目标已经不在运行中，不能纠正；先取走它的结果，或按新任务重新派。',
        });
        continue;
      }

      let held = false;
      try {
        /*
         * 先挂起自动推进。不这么做的话，停止后的空闲瞬间目标轮驱动可能插进一轮
         * 新 goal round，把刚发出去的建议挤到后面。
         */
        support.goals.disarm(agent);
        held = true;

        /*
         * 停止当前轮。与界面停止同一个底层动作：abort 当前回合、保留排队输入。
         * 原因用 hook：这是插件发起的停止，不是用户接管。
         *
         * 先挂监听再 cancel：目标正在跑时要等这一轮真正收尾 —— goal-round-driver
         * 在「被停的不是 goal 轮」时会 disarm，必须让它先跑完，我们再 resume，
         * 否则会被它覆盖回 disarmed。
         */
        const stopWait = agent.status === 'running'
          ? waitForStop(ctx, binding.id)
          : null;
        agent.cancel(
          { kind: 'hook', reason: REDIRECT_CANCEL_REASON },
          { keepInbox: true },
        );
        if (stopWait !== null) await stopWait;

        /*
         * 停完再看一眼：目标可能在停止过程中结束 / 被清掉。
         * 这时不要再把纠正当成新任务塞进去，否则 A 会等一个已经结束的目标。
         */
        const afterStop = readGoal(support, agent);
        const resumable = afterStop !== undefined && afterStop !== null
          && (afterStop.phase === 'active' || afterStop.phase === 'paused');
        if (!resumable) {
          throw new Error('目标在停止过程中已经结束（'
            + (afterStop === undefined || afterStop === null ? '已清除' : afterStop.phase)
            + '），这次纠正没有发出；先取走结果，再按新任务重新派。');
        }

        /*
         * 作为一条普通用户消息投递。目标此刻已经停下（或本来就空闲），这条消息
         * 会像用户重新输入一样，作为新的一轮输入被认领。
         */
        const requestId = randomUUID();
        const accepted = await support.sessions.prompt(
          {
            requestId,
            sessionId: binding.id,
            mode: 'queue',
            content: [{ type: 'text', text: wrapRedirect(task, ownerLabel) }],
          },
          signal,
        );
        if (accepted === undefined || accepted === null || accepted.accepted !== true) {
          throw new Error('目标没有接受这条纠正。');
        }

        /*
         * 重新启动。如果停止让目标进入了 paused，resume 会同时恢复阶段与激活；
         * 如果它还是 active（我们提前 disarm 了），resume 会把它重新 arm 起来。
         */
        const restarted = restartGoal(support, agent);
        redirected += 1;
        results.push({
          target: binding.label,
          status: STATUS_REDIRECTED,
          deliverable: false,
          reply: '',
          progress: '',
          interruptedBy: '',
          note: '已停止目标的当前轮，纠正已作为一条新消息重新提交。'
            + (restarted.ok
              ? '目标已重新启动；'
              : restarted.note + '纠正消息已发出，但目标不会自动继续；')
            + '你可以继续做别的，之后用 dispatch_task 取结果。',
        });
      } catch (reason) {
        /*
         * 停止已经发生、消息却没送出去：把自动推进恢复回去，别让目标停在半路。
         * 已经送出去之后才失败的情况不会走到这里（restartGoal 自己把错误写进结果）。
         */
        const restored = held ? restartGoal(support, agent) : { ok: true, note: '' };
        results.push({
          target: binding.label,
          status: 'failed',
          deliverable: false,
          reply: errorText(reason),
          progress: '',
          interruptedBy: '',
          note: '纠正没有送出去。'
            + (restored.ok ? '目标的自动推进已恢复原状。' : restored.note),
        });
      }
    } catch (reason) {
      results.push({
        target: binding.label,
        status: 'failed',
        deliverable: false,
        reply: errorText(reason),
        progress: '',
        interruptedBy: '',
        note: '纠正没有送出去。',
      });
    }
  }
  if (redirected === 0) {
    throw new Error(results.map((item) => item.reply || item.note).join('\n'));
  }
  return {
    status: redirected === results.length ? STATUS_REDIRECTED : 'partial',
    results,
    stillRunning: redirected,
    note: '纠正已经停掉目标的当前轮并作为新消息重新提交，目标已重新启动；不是新任务。'
      + '你可以继续做不依赖它的部分，之后用 dispatch_task 取结果。',
  };
}
