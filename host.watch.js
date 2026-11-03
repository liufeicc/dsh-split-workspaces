/**
 * 多工作区平铺 —— 派出去之后的「盯」与「认」。
 *
 * 两件事放在一起，因为它们共用同一个判断：**目标上的那个 goal 是不是本插件派的**。
 *
 *   - `watchDetached`：`wait: none` 派完就走之后，后台一直盯着目标，终态一到就把结论
 *     记进 `pending`，等 A 回来取；
 *   - `adoptOrphanGoals`：Host 重启后 `pending` 没了，凭 goal 的固定前缀把单子认回来。
 *
 * ## 为什么认领不落盘
 *
 * `pending` 只活在内存里，而 goal 活在 DSH 的目标服务里、重启不丢。把 `pending` 落盘
 * 会变成两份状态 —— 而落盘文件被删、格式版本对不上时（`loadStore` 的既定策略是
 * 「读不懂就当空表」），兜底的东西自己也会失效。所以这里改为**每次需要时现场问目标
 * 服务**：goal 才是真相。
 *
 * ## 单订阅长听，不切段
 *
 * 工具调用必须切段（一次最多等 5 分钟），但后台监视不是工具调用。切成一段一段会丢事件：
 * 两段之间的空档没人听，结论可能在某段说完、终态在下一段才被看见。从头到尾一个监听
 * 就没有这个问题。
 *
 * @module @local/dsh-split-workspaces/host-watch
 */

import { ASYNC_MAX_MS, ASYNC_RECHECK_MS, DISPATCH_TAG } from './host.constants.js';
import { assistantText } from './host.message.js';
import { goalSupport, resolveTargetAgent } from './host.wait.js';

/**
 * 后台盯住一个已经派出去的目标，直到它有结论。
 *
 * 这是 `wait: 'none'` 的另一半：派完就返回之后，总得有人在目标结束的那一刻把结论
 * 记下来 —— 否则 A 过一会儿回来查，只能看见「跑完了」却拿不到内容。
 *
 * ## 为什么是「订阅一次、一直听」，而不是反复等一段
 *
 * 工具调用必须切段（一次最多等 5 分钟，不能让调用永久挂着），但**后台监视不是工具
 * 调用**，它没有这个限制。所以这里从头到尾只挂一个 `session/event` 监听。
 *
 * 这一点很关键：事件流只在你订阅着的时候从你面前流过，错过就没了。如果像工具那样
 * 切成一段一段（退订 → 再订阅），就会出现两个问题：
 *   1. 两段之间的空档里到达的事件会丢；
 *   2. 结论可能在这一段说完、而终态在下一段才被看见，于是那一段「听到的」是空的。
 * 单订阅长听把这两个问题一起消掉了 —— 助手文本从头攒到尾，终态一来就有东西可交。
 *
 * ## 几个必须照顾到的情况
 *
 *   - 用自己的 AbortController，**不复用调用方的 signal**：调用方那一轮结束就会 abort，
 *     而后台监视必须活过那一轮（这正是「派完就走」的意义）；
 *   - 进来先读一次状态：目标可能在我们挂上监听之前就已经结束了；
 *   - 目标被删掉（`cleared`）也算终态，不能一直等下去；
 *   - 没有事件时靠一个定期重读兜底（`unref` 过，不会吊住进程）；
 *   - 状态长时间读不到（会话被回收）时如实放弃，而不是永远占着一条订阅。
 *
 * @param ctx - 宿主上下文。
 * @param service - 绑定表（要读它的复查间隔）。
 * @param key - `ownerId\u0000targetId`。
 * @param agent - 目标的活 agent。
 */
export function watchDetached(ctx, service, key, agent) {
  const entry = service.pending.get(key);
  if (entry === undefined) return;
  const goals = ctx.get('goals');
  if (goals === undefined || goals === null || typeof goals.get !== 'function') return;
  const sessionId = agent?.session?.id ?? agent?.id;
  if (typeof sessionId !== 'string' || sessionId === '') return;

  const controller = new AbortController();
  entry.controller = controller;
  const startedAt = Date.now();
  let text = '';
  let done = false;
  let timer = null;
  let off = () => {};

  /** 收摊：退订、停表。注意它不改 `entry.settled` —— 交不交结果由调用方决定。 */
  const stop = () => {
    done = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    try {
      off();
    } catch {
      /* 退订失败不该盖住已经拿到的结论 */
    }
  };

  /**
   * 读一次目标状态。
   * 读不到（agent 已经不是活实例）返回 `null` —— 「不知道」，继续等。
   */
  const readPhase = () => {
    try {
      /*
       * 必须用**当前活着的** agent：`goals.get()` 会校验 agent 是不是活的，会话被重新
       * 唤醒（重载、恢复）之后，派单时拿到的那个引用已经失效，一直拿它去问只会永远
       * 抛错 —— 于是明明做完的目标要等满兜底时长才被记成 unknown。
       */
      const registry = ctx.get('agents');
      const candidate = registry !== undefined && registry !== null && typeof registry.get === 'function'
        ? registry.get(sessionId)
        : undefined;
      // 只认「看起来是活 agent」的那个（有 session）；否则退回派单时那个引用。
      const live = candidate !== undefined && candidate !== null && candidate.session !== undefined
        ? candidate
        : agent;
      const view = goals.get(live);
      if (view === undefined || view === null) return { phase: 'cleared', reason: '' };
      const reason = view.blockedReason === undefined || view.blockedReason === null
        ? ''
        : (view.blockedReason.message ?? view.blockedReason.code ?? '');
      return { phase: view.phase, reason };
    } catch {
      return null;
    }
  };

  /** 到了终态就把结论记进 pending，等 A 来取。 */
  const settle = (current) => {
    if (done) return;
    stop();
    entry.settled = {
      status: typeof current.phase === 'string' ? current.phase : 'complete',
      reply: text,
      reason: typeof current.reason === 'string' ? current.reason : '',
    };
  };

  /** 查一次：已终态就结算并返回 true。 */
  const check = () => {
    if (done) return true;
    const current = readPhase();
    if (current !== null && current.phase !== 'active') {
      settle(current);
      return true;
    }
    /*
     * 兜底：目标状态长时间读不到（会话被回收、agent 已释放）时不能永远挂着。
     * 如实记成一条「状态未知」，让 A 取走并结清，而不是留一个永远等不到的坑。
     */
    if (Date.now() - startedAt > ASYNC_MAX_MS) {
      stop();
      entry.settled = { status: 'unknown', reply: text, reason: '目标状态长时间读不到（会话可能已被回收）' };
      return true;
    }
    return false;
  };

  off = ctx.on('session/event', (session, event) => {
    if (done) return;
    if (session === undefined || session.id !== sessionId) return;
    if (event !== undefined && event.type === 'assistant/message') {
      const said = assistantText(event.data);
      if (said !== '') text = said;
    }
    // 任何事件之后都重读一次：目标的推进与结束都体现在会话日志里。
    check();
  });

  controller.signal.addEventListener('abort', () => stop(), { once: true });

  // 进来先看一眼：目标可能在我们挂上监听之前就结束了。
  if (check()) return;

  timer = setInterval(check, service.asyncRecheckMs ?? ASYNC_RECHECK_MS);
  timer.unref?.();
}

/**
 * 这个目标视图是不是**本插件派出去**的那一单。
 *
 * 唯一依据是 objective 的固定前缀（见 `DISPATCH_TAG`）。用户自己用 `/goal` 设的目标
 * 不带这个前缀，所以不会被误认 —— 认错的代价是让 A 去取一件它从没派过的事。
 *
 * @param view - `goals.get()` 的返回值。
 * @returns 是就返回 true。
 */
function isOurGoal(view) {
  return view !== undefined && view !== null
    && typeof view.objective === 'string'
    && view.objective.startsWith(DISPATCH_TAG);
}

/**
 * 目标在重启**之前**就做完了、A 还没来得及取时，回给 A 的那句话。
 *
 * 为什么不能假装拿到了结论：`goals.get()` 只返回 phase 与 objective，**没有"结论"
 * 这个字段** —— 结论在会话消息历史里。所以这里如实说明，并指一个能自己去看的地方。
 *
 * @param label - 目标会话的显示名。
 * @returns 一句可以原样放进结果里的话。
 */
function restartLostNote(label) {
  return 'Host 重启过，这一单的结论没能自动恢复 —— 请到「' + label + '」里看它最后一条回复。';
}

/**
 * 把「派出去了、但内存里没有记录」的单子从目标服务里认回来。
 *
 * ## 为什么需要它
 *
 * `pending` 只活在内存里，而 goal 活在 DSH 的目标服务里、重启不丢。Host 一重启，
 * 内存归零、目标还在跑 —— 两边一脱节，A 再来续等就会被当成「从没派过」：
 * 报一句「第一次派任务必须给出 task」，而活其实已经干完了。结果永久丢失，
 * 而且没有任何人察觉（收尾提醒数的也是 `pending`，它同样是空的）。
 *
 * ## 为什么不把 `pending` 落盘
 *
 * 那会变成两份状态，而 goal 才是真相 —— 落盘文件被删、格式版本对不上时
 * （`loadStore` 的既定策略是「读不懂就当空表」），兜底的东西自己也会失效。
 * 这里改为**每次需要时现场问目标服务**，不新增任何持久化。
 *
 * ## 认回来之后分两种
 *
 *   - 还在 `active`：重建记录并重挂后台监视，之后照常收结论；
 *   - 已经 `complete`：结论恢复不了，如实记一条「去目标会话里看」。
 *
 * 认领只认**绑定表里还在的边**：箭头被删掉就是授权撤回，那条边上的单子不该被复活。
 *
 * @param ctx - 宿主上下文。
 * @param service - 绑定表（要读写它的 `pending`）。
 * @param ownerId - 发起方会话 id。
 * @returns 认回来的条数。
 */
export async function adoptOrphanGoals(ctx, service, ownerId) {
  const bindings = service.bindings.get(ownerId) ?? [];
  if (bindings.length === 0) return 0;
  // 没有目标服务就没有孤儿可认 —— 老部署那条路本来也不记 pending。
  const support = goalSupport(ctx);
  if (support === null) return 0;
  /*
   * 同一个发起方可能同时来两次续等（一次工具调用 + 一次收尾前的查询）。认领要读目标
   * 状态、还要挂后台监视，重入会挂出第二条监视 —— 这里直接把后到的那次跳过。
   */
  if (service.adopting.has(ownerId)) return 0;
  service.adopting.add(ownerId);

  let adopted = 0;
  try {
    for (const binding of bindings) {
      const key = ownerId + '\u0000' + binding.id;
      if (service.pending.has(key)) continue;
      /*
       * 已经结清过的不算孤儿：pending 空有两种来路 ——「重启丢了」与「正常领取了」。
       * 墓碑只活在这个进程里，所以重启后它自然是空的，跨进程的那种才会被认回来。
       */
      if (service.concluded?.has(key)) continue;
      let agent;
      try {
        // 冷会话也能唤醒；唤醒只是拿到 agent，不会替它开一轮。
        agent = await resolveTargetAgent(support, binding);
      } catch {
        continue;
      }
      let view;
      try {
        view = support.goals.get(agent);
      } catch {
        continue;
      }
      if (!isOurGoal(view)) continue;
      if (view.phase === 'complete') {
        // 已经做完、结论只剩在目标会话的历史里：给一条能指导下一步的说明。
        service.pending.set(key, {
          replaced: undefined,
          settled: { status: 'complete', reply: '', reason: restartLostNote(binding.label) },
          controller: null,
        });
      } else {
        // 还在跑（或停在 blocked/paused）：重建记录，重挂后台监视。
        service.pending.set(key, { replaced: undefined, settled: null, controller: null });
        watchDetached(ctx, service, key, agent);
      }
      adopted += 1;
    }
  } finally {
    service.adopting.delete(ownerId);
  }
  return adopted;
}
