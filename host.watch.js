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

import { ASYNC_MAX_MS, ASYNC_RECHECK_MS, DISPATCH_TAG, STATUS_INTERRUPTED } from './host.constants.js';
import { classifyGoal, liveAgent } from './host.goal-state.js';
import { assistantText } from './host.message.js';
import { goalSupport, isUserStop, resolveTargetAgent } from './host.wait.js';

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
   * 读一次目标状态，并合成为派单状态。
   *
   * 读不到（agent 已经不是活实例）返回 `null` —— 「不知道」，继续等。
   * 必须用 `liveAgent()` 换成当前活着的 agent：重启/重载之后派单时拿到的引用会失效，
   * 一直拿它去问只会永远抛错，目标要等满兜底时长才被记成 unknown。
   */
  const readState = () => {
    try {
      const live = liveAgent(ctx, agent);
      const view = goals.get(live);
      return classifyGoal(view, live);
    } catch {
      return null;
    }
  };

  /** 到了终态就把结论记进 pending，等 A 来取。 */
  const settle = (current) => {
    if (done) return;
    stop();
    /*
     * 只有 `complete` 才算交付；其余状态（含用户手停的 `interrupted`、重启后的
     * `paused`）都只把文本记成 `progress`。这是与 `waitForGoal` 同一条约定 ——
     * 两个入口看到的「结论」必须一样，否则 A 从哪条路拿到结果，行为会不一致。
     */
    const delivered = current.status === 'complete';
    entry.settled = {
      status: typeof current.status === 'string' ? current.status : 'complete',
      reply: delivered ? text : '',
      progress: delivered ? '' : text,
      reason: typeof current.reason === 'string' ? current.reason : '',
      interruptedBy: current.interruptedBy === 'user' ? 'user' : '',
    };
    /*
     * 交付即记审核：不再等「结果被 A 取走」才落账。
     *
     * 真机踩过：目标 11:13 完成、Host 17:41 重启，中间 A 没回来取结果 —— 旧实现
     * 只在领取时 markReviewNeeded，审核账从未落盘；重启后 pending 和 reviews 一起
     * 消失，而 goal 仍是 complete，界面显示「待审核」，派单闸却放行。
     */
    if (delivered) {
      const [ownerId, targetId] = key.split('\u0000');
      /*
       * 以**当前绑定表**为准，而不是派单时的旧 label：箭头可能已经被撤掉，
       * 撤掉之后就不该再补一条审不了也拦不住的审核账。
       */
      const targetBinding = service.bindings.get(ownerId)?.find((item) => item.id === targetId);
      if (targetBinding !== undefined) {
        service.markReviewNeeded(ownerId, targetBinding, {
          status: current.status,
          reply: text,
        });
      }
    }
  };

  /** 查一次：已终态就结算并返回 true。 */
  const check = () => {
    if (done) return true;
    const current = readState();
    if (current !== null && current.status !== 'running') {
      /*
       * 纠正的中间窗口：`disarm → 停当前轮 → 重发 → resume`。这期间目标会短暂
       * 呈现 active + disarmed + idle，和「Host 重启后停住」完全一样；不能在这里
       * 结算，否则一次正在进行的纠正会被误记成 paused。
       */
      if (current.status === 'paused' && service.redirecting?.has(key)) return false;
      settle(current);
      return true;
    }
    /*
     * 兜底：目标状态长时间读不到（会话被回收、agent 已释放）时不能永远挂着。
     * 如实记成一条「状态未知」，让 A 取走并结清，而不是留一个永远等不到的坑。
     */
    if (Date.now() - startedAt > ASYNC_MAX_MS) {
      stop();
      entry.settled = {
        status: 'unknown',
        reply: '',
        progress: text,
        reason: '目标状态长时间读不到（会话可能已被回收）',
        interruptedBy: '',
      };
      return true;
    }
    return false;
  };

  off = ctx.on('session/event', (session, event) => {
    if (done) return;
    if (session === undefined || session.id !== sessionId) return;
    if (event !== undefined && event.type === 'assistant/message') {
      const said = assistantText(event.data);
      if (said !== '') {
        text = said;
        /*
         * A 用 `wait: none` 中途查看时，要能看到最新过程稿。
         * 只写还在表里的那条 entry —— 记录可能已经被领取/撤箭头了。
         */
        if (service.pending.get(key) === entry) entry.progress = said;
      }
    }
    /*
     * 用户按停止：不能等 goal 变 paused（停普通轮时 goal 仍 active）。直接结算成
     * `interrupted`，让 A 知道「这一单被用户接管了，未交付」。
     */
    if (isUserStop(event)) {
      settle({ status: STATUS_INTERRUPTED, reason: '用户手动停止了目标会话。', interruptedBy: 'user' });
      return;
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
export function isOurGoal(view) {
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
 * ## 认回来之后分三种
 *
 *   - 还在跑（`active + armed`，或 agent 真的在跑一个回合）：重建记录并重挂后台
 *     监视，之后照常收结论；
 *   - 已经 `complete`：结论恢复不了，如实记一条「去目标会话里看」。如果审核账已经
 *     存在，只差审核，不再伪造一条「结果还没取」；如果不存在，补记审核并保留一条
 *     `deliverable: false` 的领取记录，让 A 第一次回来就知道结论丢了。
 *   - 停住（`paused` / `blocked` / `active + disarmed + idle`）：立刻结算成停止态，
 *     不挂监视。这一条专门修「DSH 重启后 goal 仍 active、A 却永远看到 running」：
 *     重启时 round-driver 只 disarm、不改 durable phase，必须靠 classification 收口。
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
   * 同一个发起方可能同时来两次认领（一次工具调用 + 一次会话重建时的后台查询）。
   * 重入会挂出第二条监视，所以后到的那次**等待同一个 Promise**，而不是直接返回 0。
   * 旧实现返回 0 时，工具调用会看到空表并报「没有可接着等的派单」，紧接着的新派单
   * 还可能跳过 complete goal 的审核闸。
   */
  const inflight = service.adopting.get(ownerId);
  if (inflight !== undefined) return inflight;

  const task = (async () => {
    let adopted = 0;
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
      const state = classifyGoal(view, agent);
      if (state.status === 'complete') {
        /*
         * 已有审核账：结果早就取走了，只差审核。不要再补一条「结果还没取」的
         * pending，否则 A 会先被要求再取一次结论。
         */
        if (service.reviewOf(ownerId, binding.id) === undefined) {
          /*
           * 重启前结论还没被取走，审核账也没建：补一条待审核记录，让 GoalBar 上的
           * 「待审核」和插件的派单闸保持一致；同时补一条领取记录，如实告诉 A
           * 「结论只剩在目标会话历史里」。
           */
          service.markReviewNeeded(ownerId, binding, { status: 'complete', reply: '' });
          service.pending.set(key, {
            replaced: undefined,
            settled: {
              status: 'complete',
              // 目标确实完成了，但结论只剩在会话历史里 —— 不能把它当交付结论。
              deliverable: false,
              reply: '',
              progress: '',
              reason: restartLostNote(binding.label),
              interruptedBy: '',
            },
            controller: null,
            progress: '',
          });
        }
        adopted += 1;
        continue;
      }
      if (state.status === 'running') {
        // 还在跑：重建记录，重挂后台监视。
        service.pending.set(key, {
          replaced: undefined,
          settled: null,
          controller: null,
          progress: '',
        });
        watchDetached(ctx, service, key, agent);
        adopted += 1;
        continue;
      }
      /*
       * 停住：paused / blocked / active + disarmed + idle。
       * 立即结算，不挂监视 —— 目标自己不会推进，挂监视只会让 A 一直看到 running。
       */
      service.pending.set(key, {
        replaced: undefined,
        settled: {
          status: state.status,
          deliverable: false,
          reply: '',
          progress: '',
          reason: state.reason,
          interruptedBy: '',
        },
        controller: null,
        progress: '',
      });
      adopted += 1;
    }
    return adopted;
  })();

  service.adopting.set(ownerId, task);
  try {
    return await task;
  } finally {
    if (service.adopting.get(ownerId) === task) service.adopting.delete(ownerId);
  }
}

/**
 * 审核时兜底：审核账丢了，但目标上还挂着一个**本插件派的 complete goal**。
 *
 * 旧实现只认 `service.reviews`，于是「重启前交付、审核账没落盘」的目标会报
 * 「没有待审核的交付」；而界面上的目标条仍然显示「待审核」。这里把 goal 当作最终
 * 真相补记一条审核记录，`runReviews` 就能继续走正常的审核/清 goal 流程。
 *
 * 只认 `[任务分派]` 前缀且 `complete` 的目标；用户自己设的 goal、active/paused 的
 * 目标都不会被误审。
 *
 * @param ctx - 宿主上下文。
 * @param service - 绑定表（要写它的 `reviews`）。
 * @param ownerId - 发起方会话 id。
 * @param binding - 要审核的目标绑定。
 * @returns 审核记录；补不出来时 undefined。
 */
export async function ensureReviewFromGoal(ctx, service, ownerId, binding) {
  const existing = service.reviewOf(ownerId, binding.id);
  if (existing !== undefined) return existing;
  const support = goalSupport(ctx);
  if (support === null) return undefined;
  let agent;
  try {
    agent = await resolveTargetAgent(support, binding);
  } catch {
    return undefined;
  }
  let view;
  const live = liveAgent(ctx, agent);
  try {
    view = support.goals.get(live);
  } catch {
    return undefined;
  }
  if (!isOurGoal(view)) return undefined;
  if (classifyGoal(view, live).status !== 'complete') return undefined;
  service.markReviewNeeded(ownerId, binding, { status: 'complete', reply: '' });
  return service.reviewOf(ownerId, binding.id);
}
