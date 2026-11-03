/**
 * 多工作区平铺 —— 把任务送进目标会话并等它停下来。
 *
 * 两条路：
 *   - **目标模式**（新部署）：任务被设成对方会话的 goal，等 phase 离开 active；
 *     一轮结束不等于任务做完，这是与下面那条路的本质区别。
 *   - **普通投递**（老部署没有 goals 服务）：按 rpcId 认领自己那条消息，等它之后
 *     的 turn/end。
 *
 * 两条路都遵守同一条取消约定：调用方在 A 那边按停止，等待立即结束，但**不会**去
 * 停 B —— B 是独立会话，不该因为 A 放弃等待被掐断。
 *
 * @module @local/dsh-split-workspaces/host-wait
 */

import { randomUUID } from 'node:crypto';

import { DISPATCH_SLICE_MS, DISPATCH_TIMEOUT_MS } from './host.constants.js';
import { assistantText, errorText, wrapTask } from './host.message.js';

/**
 * 目标会话此刻是不是正忙；忙的话返回一句可以直接抛出去的说明。
 *
 * 为什么**拒绝**而不是排队：用户对这套功能的前提说得很清楚 ——「B、C 要空闲」。
 * 排队看似更宽容，实际会让「一轮结束」这个唯一的结果信号变得不可靠：我们的消息排在
 * 别人那一轮后面时，`turn/end` 先到的是**别人**的结束，于是取回来的回复对不上人。
 * 与其猜，不如如实拒绝，让人等目标空闲了再派。
 *
 * 冷会话（`ctx.agents.get` 取不到）一律当作空闲：它没有活着的回合，唤醒就是一次
 * 干净的新轮次，不会撞上别人的结束信号。
 *
 * @param ctx - 宿主上下文。
 * @param binding - 目标绑定 `{ id, label }`。
 * @returns 忙的时候是一句人话，空闲时 null。
 */
export function runningText(ctx, binding) {
  const agents = ctx.get('agents');
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return null;
  let live;
  try {
    live = agents.get(binding.id);
  } catch {
    return null;
  }
  if (live === undefined || live === null) return null;
  if (live.status !== 'running') return null;
  return '目标会话「' + binding.label + '」正在跑一个回合，暂时不能接任务。等它闲下来再派。';
}

/**
 * 等目标会话把「我们投进去的那条消息」跑完。
 *
 * 事件筛选的两道闸：
 *   - `user/message` 且 `source.rpcId === requestId` —— 认领我们这条消息，记下它的
 *     seq。在它之前的事件一律不收集（那可能是目标会话上一轮还在跑）。
 *   - 认领之后、seq 更大的 `assistant/message` 收集文本；遇到 `turn/end` 收尾。
 *
 * 三种结束方式：
 *   - 正常：返回那一轮的结束原因（completed / aborted / error / blocked）；
 *   - 超时：返回 `timeout`，并带上已经收到的文本（有总比没有强）；
 *   - 取消：返回 `cancelled`，同样带上已收到的文本。
 *
 * @param ctx - 宿主上下文（用来订阅 `session/event`）。
 * @param targetId - 目标会话 id。
 * @param requestId - 本次投递的一次性 id（会写进消息的 rpcId）。
 * @param signal - 调用方的取消信号。
 * @returns `{ status, reply }`。
 */
export function waitForTurn(ctx, targetId, requestId, signal) {
  return new Promise((resolve) => {
    let claimed = false;
    let acceptSeq = -1;
    let lastText = '';
    let settled = false;
    let timer = null;
    let off = () => {};
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        off();
      } catch {
        /* 取消订阅失败不该盖住结果 */
      }
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ status: 'cancelled', reply: lastText });
    off = ctx.on('session/event', (session, event) => {
      if (settled || session === undefined || event === undefined) return;
      if (session.id !== targetId) return;
      if (event.type === 'user/message') {
        const source = event.data === undefined ? undefined : event.data.source;
        if (source !== undefined && source !== null && source.rpcId === requestId) {
          claimed = true;
          acceptSeq = event.seq;
        }
        return;
      }
      if (!claimed || event.seq <= acceptSeq) return;
      if (event.type === 'assistant/message') {
        const text = assistantText(event.data);
        if (text !== '') lastText = text;
        return;
      }
      if (event.type === 'turn/end') {
        const kind = event.data?.reason?.kind;
        finish({ status: typeof kind === 'string' ? kind : 'completed', reply: lastText });
      }
    });
    if (signal.aborted) {
      finish({ status: 'cancelled', reply: '' });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish({ status: 'timeout', reply: lastText }), DISPATCH_TIMEOUT_MS);
    /*
     * 兜底定时器**不许吊住事件循环**：它最长 20 分钟，而它唯一的作用是「万一没人叫醒
     * 这个 Promise」。在长驻宿主里这没什么，但在短命进程（离线测试、一次性脚本）里，
     * 一个没人再等的计时器会让进程白白挂 20 分钟才退出。
     */
    timer.unref?.();
  });
}

/**
 * 等目标会话把「目标」推进到终态。
 *
 * 与 `waitForTurn` 的区别在于「完成」的定义：一轮结束不等于任务做完 —— 目标模式的价值
 * 恰恰是它会在多轮里继续推进。所以这里等的是 **goal 的 phase 离开 active**
 * （complete / blocked / paused），而不是某一个 turn/end。
 *
 * 两个细节：
 *   - 每收到一条该会话的事件就读一次 goal：goal 变化本身就是会话事件，不必自己维护状态；
 *   - 助手文本取**最后一个非空**的：目标的最后一轮通常就是结论，中途那些「继续查…」
 *     不是用户要的。
 *
 * @param ctx - 宿主上下文。
 * @param agent - 目标会话的活 agent。
 * @param signal - 调用方取消信号。
 * @returns `{ status, reply, reason }`；`status` 是 goal 的终态或 `timeout`/`cancelled`。
 */
export function waitForGoal(ctx, agent, signal, options) {
  const goals = ctx.get('goals');
  const sliceMs = options?.sliceMs ?? DISPATCH_SLICE_MS;
  const sessionId = agent.session === undefined ? undefined : agent.session.id;
  return new Promise((resolve) => {
    let lastText = '';
    let settled = false;
    let timer = null;
    let off = () => {};
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        off();
      } catch {
        /* 取消订阅失败不该盖住结果 */
      }
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ status: 'cancelled', reply: lastText, reason: '', rounds: rounds() });
    /**
     * 读一次目标状态。
     * 读不到（agent 已不是活实例）时返回 `{ phase: null }` —— 表示「不知道」，继续等。
     * 目标被清掉（`undefined`）时返回 `{ phase: 'cleared' }` —— 这是一种终态。
     */
    const read = () => {
      try {
        const view = goals.get(agent);
        if (view === undefined || view === null) return { phase: 'cleared', rounds: 0, reason: '' };
        const reason = view.blockedReason === undefined || view.blockedReason === null
          ? ''
          : (view.blockedReason.message ?? view.blockedReason.code ?? '');
        return { phase: view.phase, rounds: view.roundsStarted ?? 0, reason };
      } catch {
        return { phase: null, rounds: 0, reason: '' };
      }
    };
    const rounds = () => read().rounds;
    /** 到了终态就收尾；`active` 不算终态。 */
    const settleIfTerminal = () => {
      const current = read();
      if (current.phase === null || current.phase === 'active') return false;
      finish({ status: current.phase, reply: lastText, reason: current.reason, rounds: current.rounds });
      return true;
    };
    off = ctx.on('session/event', (session, event) => {
      if (settled || session === undefined || sessionId === undefined || session.id !== sessionId) return;
      if (event !== undefined && event.type === 'assistant/message') {
        const text = assistantText(event.data);
        if (text !== '') lastText = text;
      }
      // 任何事件之后都重读一次：目标的推进与结束都体现在会话日志里。
      settleIfTerminal();
    });
    if (signal.aborted) {
      finish({ status: 'cancelled', reply: '', reason: '', rounds: 0 });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    /*
     * 进来先看一眼：目标可能在我们挂上监听之前就结束了（两次调用之间对方刚好做完）。
     * 少了这一步，续等的那一次会白等满 5 分钟才报「还在跑」。
     */
    if (settleIfTerminal()) return;
    timer = setTimeout(() => {
      const current = read();
      if (current.phase === null || current.phase === 'active') {
        // 还在跑：带着目前的进度返回，让派单方看见进展并决定是否接着等。
        finish({ status: 'running', reply: lastText, reason: '', rounds: current.rounds });
        return;
      }
      finish({ status: current.phase, reply: lastText, reason: current.reason, rounds: current.rounds });
    }, sliceMs);
    timer.unref?.();
  });
}

/**
 * 把任务当作「目标」交给目标会话。
 *
 * 为什么走 `resolveAgent` 而不是直接 `agents.get`：目标可能是冷会话，需要按控制器自己的
 * 策略（预设、子代理归属）把它唤醒。`resolveAgent` 正是这条公开入口。
 *
 * @param ctx - 宿主上下文。
 * @param binding - 目标绑定。
 * @param objective - 写进目标的目标描述。
 * @param signal - 调用方取消信号。
 * @returns `{ status, reply, reason }`，或 `null` 表示这个部署没有目标服务、应回落到普通投递。
 */
export function goalSupport(ctx) {
  const sessions = ctx.get('sessionController');
  const goals = ctx.get('goals');
  if (goals === undefined || goals === null || typeof goals.create !== 'function') return null;
  if (sessions === undefined || sessions === null || typeof sessions.resolveAgent !== 'function') return null;
  return { sessions, goals };
}

/**
 * 唤醒目标会话并拿到它的活 agent。
 *
 * 走 `resolveAgent` 而不是 `agents.get`：目标可能是冷会话，需要按控制器自己的策略
 * （预设、子代理归属）把它唤醒 —— 这正是那条公开入口做的事。
 *
 * @param support - `goalSupport()` 的返回值。
 * @param binding - 目标绑定。
 * @returns 活的 agent。
 */
export async function resolveTargetAgent(support, binding) {
  const resolved = await support.sessions.resolveAgent(binding.id);
  if (resolved === undefined || resolved === null) {
    throw new Error('无法唤醒目标会话「' + binding.label + '」。');
  }
  if (resolved.error !== undefined) {
    const message = resolved.error.message ?? resolved.error.code ?? '未知原因';
    throw new Error('无法唤醒目标会话「' + binding.label + '」：' + message);
  }
  return resolved.agent;
}

/**
 * 把一条任务投递给目标会话并等它停下来。
 *
 * 顺序很关键：**先装监听、再投递**。反过来的话，目标会话很快的那一轮可能在
 * `prompt()` 的 Promise 兑现之前就跑完并发出 `turn/end`，我们就永远等不到了。
 *
 * 投递失败时，那条「等待」必须被主动取消 —— 否则它会一直挂到 20 分钟超时，白白占着
 * 一个订阅。这里用一个内部 AbortController 把两条路并起来。
 *
 * @param ctx - 宿主上下文。
 * @param binding - 目标绑定 `{ id, label }`。
 * @param task - 任务正文（已由模型给出）。
 * @param sourceLabel - 发起方的显示名。
 * @param signal - 调用方取消信号。
 * @returns `{ status, reply }`。
 */
export async function deliverAndWait(ctx, binding, task, sourceLabel, signal) {
  const busy = runningText(ctx, binding);
  if (busy !== null) throw new Error(busy);
  const sessions = ctx.get('sessionController');
  if (sessions === undefined || sessions === null || typeof sessions.prompt !== 'function') {
    throw new Error('这个部署没有会话服务（sessionController），没法向另一个会话投递任务。');
  }
  const requestId = randomUUID();
  const inner = new AbortController();
  const onOuterAbort = () => inner.abort();
  if (signal.aborted) inner.abort();
  signal.addEventListener('abort', onOuterAbort, { once: true });
  const waiting = waitForTurn(ctx, binding.id, requestId, inner.signal);
  let accepted;
  try {
    /*
     * 第二个参数是 **AbortSignal**，不是消息来源。
     *
     * `SessionController.prompt(request, signal)` 的第一行就是 `signal.throwIfAborted()`
     * （见 dsh-api-session-controller 的 lib/index.js），而 `user-rpc` 那条消息来源是
     * 它自己用 `request.requestId` 拼出来的 —— 所以这里只交信号，不交 source。
     * 传错会得到「signal.throwIfAborted is not a function」，也就是这条注释的由来。
     *
     * 交的是 `inner.signal`（已与调用方信号联动）：用户在 A 那边按停止时，正在进行的
     * 投递也会被取消，而不是先把消息塞进 B 再丢掉等待。
     */
    accepted = await sessions.prompt(
      {
        requestId,
        sessionId: binding.id,
        mode: 'queue',
        content: [{ type: 'text', text: wrapTask(task, sourceLabel) }],
      },
      inner.signal,
    );
  } catch (reason) {
    inner.abort();
    await waiting.catch(() => undefined);
    throw new Error('向目标会话投递任务失败：' + errorText(reason));
  }
  if (accepted === undefined || accepted === null || accepted.accepted !== true) {
    inner.abort();
    await waiting.catch(() => undefined);
    throw new Error('目标会话没有接受这条任务。');
  }
  /*
   * 联动必须在**整个等待期间**都挂着，所以解绑放在这里而不是 `finally`。
   *
   * 踩过的坑：第一版把 `signal.removeEventListener` 写进 `prompt()` 那一段的
   * `finally`，于是投递一返回联动就断了 —— 用户在 A 那边按停止时，正在等 B 的这个
   * 等待收不到任何通知，会一直挂到 20 分钟兜底。而「投递完成后等 B 跑完」正是这段
   * 功能里**最长**、也最需要能取消的那一段。
   */
  try {
    return await waiting;
  } finally {
    signal.removeEventListener('abort', onOuterAbort);
  }
}
