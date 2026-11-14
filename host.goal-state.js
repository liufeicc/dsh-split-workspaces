/**
 * 多工作区平铺 —— 目标状态分类。
 *
 * ## 为什么单独一个文件
 *
 * 同一个 goal 会在三个地方被读取：重启认领（`adoptOrphanGoals`）、后台监视
 * （`watchDetached`）、阻塞等待（`waitForGoal`）。这三处以前都只看 `view.phase`，
 * 于是 `active + disarmed` 被当成 `running` —— 而 DSH 重启后，目标轮驱动会把所有
 * goal 的自动推进 disarm，durable phase 仍然是 `active`。结果就是界面显示「已暂停的
 * 目标」，主会话的 `dispatch_task` 却一直说 `running`。
 *
 * 把「phase + activation + agent 执行态」的合成规则收成一个纯函数，三处共用，
 * 以后不会再各自漂移。
 *
 * ## 状态词表
 *
 * 与 `dispatch_task` 结果里的 `status` 保持一致：
 *
 *   - `running`：目标还在被推进（active + armed，或 agent 真的在跑一个回合）；
 *   - `complete`：目标完成，属于交付；
 *   - `paused` / `blocked`：目标停住，未交付；
 *   - `cleared`：目标已经被清掉；
 *   - `unknown`：状态读不到。
 *
 * ## 关键边界：active + disarmed 不一定是「停止」
 *
 * 目标轮驱动在等待子代理时，agent 也可能是 idle。所以不能只看 activation，必须同时
 * 满足「agent 不是 running」才能判成停止。真实重启后 round-driver 会 disarm 所有
 * goal，目标会话也没有回合在跑，这个组合就是「无人推进」。
 *
 * @module @local/dsh-split-workspaces/host-goal-state
 */

/**
 * 重启后 goal 仍是 active、但自动推进被 disarm 时，给模型看的原因。
 *
 * 这句话会出现在 `dispatch_task` 的 `reply` 里，所以必须同时说清「发生了什么」和
 * 「下一步能做什么」：用户或 A 可以点目标栏的继续按钮，也可以带 task 发纠正。
 */
export const RESTART_STOPPED_REASON = 'Host 重启后这一轮已经中止：目标仍是 active，'
  + '但自动推进已被 disarm，当前没有回合在跑。'
  + '可以点目标栏的「继续执行目标」，或用 dispatch_task 带 task 发纠正重新启动。';

/**
 * 这个 agent 是不是真的有一个回合在跑。
 *
 * 只认 `status === 'running'`：`idle` / `paused` / 其它都说明当前没有执行中的回合。
 * agent 可能是 undefined（会话已释放），按「没在跑」处理。
 *
 * @param agent - 目标会话的活 agent；可能为 undefined。
 * @returns 是否正在跑一个回合。
 */
export function isAgentRunning(agent) {
  return agent !== undefined && agent !== null && agent.status === 'running';
}

/**
 * 把 goal 视图合成为派单状态。
 *
 * 合成顺序（从确定到推测）：
 *   1. 没有 view → `cleared`；
 *   2. `complete` / `paused` / `blocked` 是 durable 终态，直接返回；
 *   3. `active` 时，只有「armed」或「agent 真在跑」才算 `running`；
 *   4. 其余 `active`（disarmed + agent 空闲）是 Host 重启后的停止态，返回 `paused`；
 *   5. 未知 phase 按终态处理，避免永远等一个不会自己变化的目标。
 *
 * 返回的 `terminal` 表示调用方是否应该立即收口；`reason` 是已经翻好的人话，
 * 可以直接拼进结果里。
 *
 * @param view - `goals.get()` 的返回值；可能为 undefined。
 * @param agent - 与这个 view 对应的活 agent。
 * @returns `{ status, terminal, reason }`。
 */
export function classifyGoal(view, agent) {
  if (view === undefined || view === null) {
    return { status: 'cleared', terminal: true, reason: '' };
  }
  const phase = typeof view.phase === 'string' ? view.phase : '';
  if (phase === 'complete') {
    return { status: 'complete', terminal: true, reason: '' };
  }
  if (phase === 'paused') {
    return { status: 'paused', terminal: true, reason: '' };
  }
  if (phase === 'blocked') {
    const blocked = view.blockedReason;
    let reason = '';
    if (blocked !== undefined && blocked !== null) {
      if (typeof blocked.message === 'string' && blocked.message !== '') reason = blocked.message;
      else if (typeof blocked.code === 'string') reason = blocked.code;
    }
    return { status: 'blocked', terminal: true, reason };
  }
  if (phase === 'active') {
    if (isAgentRunning(agent)) {
      return { status: 'running', terminal: false, reason: '' };
    }
    /*
     * 只有**明确**是 disarmed 且 agent 空闲，才判成 Host 重启后的停止态。
     *
     * 为什么不在 activation 缺失时也判停：旧版目标服务/测试替身可能没有这个字段，
     * 读不到就不该猜「停了」；真实 DSH 的 view 一定带 activation，真机 bug 正是
     * `active + disarmed + idle`。
     */
    if (view.activation === 'disarmed') {
      return { status: 'paused', terminal: true, reason: RESTART_STOPPED_REASON };
    }
    return { status: 'running', terminal: false, reason: '' };
  }
  return {
    status: phase === '' ? 'unknown' : phase,
    terminal: true,
    reason: '',
  };
}

/**
 * 取当前会话的活 agent。
 *
 * 派单时拿到的 agent 引用可能已经因为重启/重载失效，而 goal 服务要求 agent 必须是
 * 注册表里的活实例（`assertLive`）。所以读 goal 之前先按 session id 换一次，
 * 换不到才退回原引用 —— 让 goal 服务自己给出「不是活实例」的错误。
 *
 * @param ctx - 宿主上下文。
 * @param agent - 手里持有的 agent 引用。
 * @returns 注册表里的活 agent，或原引用。
 */
export function liveAgent(ctx, agent) {
  const sessionId = agent?.session?.id ?? agent?.id;
  if (typeof sessionId === 'string' && sessionId !== '') {
    const registry = ctx.get('agents');
    if (registry !== undefined && registry !== null && typeof registry.get === 'function') {
      try {
        const candidate = registry.get(sessionId);
        if (candidate !== undefined && candidate !== null && candidate.session !== undefined) {
          return candidate;
        }
      } catch {
        /* 读注册表失败就退回原引用；真正读 goal 时还会有一次明确的错误 */
      }
    }
  }
  return agent;
}
