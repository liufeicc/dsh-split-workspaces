/**
 * 多工作区平铺 —— 一次派给多个目标的批处理。
 *
 * ## 为什么单独一层
 *
 * 「派给一个目标」和「派给一批目标」的差别不在投递，而在**收尾**：一批里有先有后、
 * 有成功有失败，必须能说清楚「这一批现在到底算完了没有」。把这层收尾逻辑从工具定义里
 * 摘出来，工具只管参数解析与结果整形，这里只管调度，两边都可以单独测。
 *
 * ## 三个阶段，顺序不能换
 *
 *   1. **分流**：把请求拆成「新派」与「续等」两拨，并检查语义冲突
 *      （给了 task 却选中一个还在跑的旧派单 / 没给 task 却选中一个从没派过的目标）。
 *   2. **预检**：把这一批新派的目标**全部**查一遍忙闲，全部空闲才动手。
 *      少了这一步就会出现「派出去一半」：目标 B 建好了、目标 C 报忙，模型拿到一个
 *      半截状态，还得自己猜哪些生效了。
 *   3. **并发等待**：每个目标一条独立的等待，按 `wait` 语义决定什么时候收尾。
 *
 * ## wait 的两种语义
 *
 *   - `all`（默认）：等这一批**全部**进入终态（或切片到期）才返回。
 *   - `any`：第一个目标进入终态就返回，其余标成 running 留给下一次续等。
 *
 * 两者共用同一批等待：`any` 只是「先返回、其余主动收手」，`all` 是「全收」。所以
 * 这个选项不带来第二套实现，只改变收尾时机。
 *
 * 注意 `any` **不会**让整批更快拿全结果：它只是更早拿到第一个，剩下的仍要再调一次
 * （而且每次调用都要重发一遍工具描述）。要全部结论就用 `all`。
 *
 * ## 部分失败是真实状态，不掩盖
 *
 * 预检只能挡住「对方正忙」；`goals.create` 仍可能在运行时抛错（比如两次调用之间对方
 * 又接了一个目标）。目标已经建好的那些没法回滚，所以这里如实记成「这个目标没派出去」，
 * 其余照常等待，让模型看见之后自己决定怎么办。
 *
 * @module @local/dsh-split-workspaces/host-batch
 */

import { ASYNC_MAX_MS, ASYNC_RECHECK_MS, WAIT_ALL, WAIT_ANY, WAIT_NONE } from './host.constants.js';
import { assistantText, errorText, wrapTask } from './host.message.js';
import {
  deliverAndWait,
  goalSupport,
  resolveTargetAgent,
  runningText,
  waitForGoal,
} from './host.wait.js';

/**
 * 这个状态是不是「已经有结论了」。
 *
 * 唯一的非终态是 `running`（还在做）。其余 `complete` / `blocked` / `paused` /
 * `cleared` / `cancelled` / `timeout` / `error` 都已经不会再自己变化。
 *
 * @param status - 单个目标的等待结果。
 * @returns 是否已经到终态。
 */
export function isTerminalStatus(status) {
  return typeof status === 'string' && status !== 'running';
}

/**
 * 这个终态算不算「做成了」。
 *
 * 目标模式说 `complete`，老部署的普通投递说 `completed` —— 两套词都在用，判成功时
 * 必须都认，否则老部署下每个目标都会被算成「没做成」。
 *
 * @param status - 单个目标的等待结果。
 * @returns 是否成功。
 */
export function isSuccessStatus(status) {
  return status === 'complete' || status === 'completed';
}

/**
 * 造一个「跟着调用方一起取消」的独立信号。
 *
 * 每个目标一条，好处是 `any` 模式收手时可以只掐掉还没回来的那几条，而不影响
 * 调用方信号本身（用户按停止与「我们主动不等了」是两件事，收尾时要能分开）。
 *
 * @param signal - 调用方的取消信号。
 * @returns `{ signal, abort, release }`。
 */
function linkSignal(signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    release: () => signal.removeEventListener('abort', onAbort),
  };
}

/**
 * 把一次等待的结果整理成一段可以直接给模型看的文字。
 *
 * 卡住的原因必须附在结论后面：只说 `status: blocked` 对派单方没有任何帮助，它既
 * 不知道该催谁，也不知道要不要换个做法。
 *
 * @param outcome - `waitForGoal` / `deliverAndWait` 的返回值。
 * @returns 拼好的结论文本，可能是空串（对方还没产出可读文字）。
 */
function composeReply(outcome) {
  const reply = typeof outcome?.reply === 'string' ? outcome.reply : '';
  const reason = typeof outcome?.reason === 'string' && outcome.reason !== '' ? outcome.reason : '';
  if (reason === '') return reply;
  return (reply === '' ? '' : reply + '\n\n') + '（' + reason + '）';
}

/**
 * 单个结果的补充说明（目前只有「还在做，已到第几轮」这一条）。
 * @param outcome - 等待结果。
 * @returns 说明文字；已终态时是空串。
 */
function composeItemNote(outcome) {
  if (outcome?.status !== 'running') return '';
  return '已到第 ' + String(outcome.rounds ?? 0) + ' 轮。';
}

/**
 * 把一个「受阻」视图里的人话取出来。
 *
 * 真实形状是 `{ code, message }`（code 是稳定分类码，message 是给人看的那句话）。
 * **不能用 `explanation`** —— 那个字段不存在，取出来永远是 undefined，于是只能退回去
 * 显示 `round-limit` 这类码，而不是真正的原因。
 *
 * @param view - 目标视图。
 * @returns 原因文本；没有就返回空串。
 */
function blockReasonText(view) {
  const reason = view === undefined || view === null ? undefined : view.blockedReason;
  if (reason === undefined || reason === null) return '';
  if (typeof reason.message === 'string' && reason.message !== '') return reason.message;
  return typeof reason.code === 'string' ? reason.code : '';
}

/**
 * 建一个新目标；如果对方有一个**已经停住但不可直接替换**的旧目标，先清掉它。
 *
 * `goals.create` 的契约是「已 complete 的目标可以被替换；其余阶段必须先 clear 或
 * resume」。所以对方一旦 `blocked` 或 `paused`，直接 create 必然失败 —— 这正是
 * 「B 受阻之后 A 再也派不进去」的根因。
 *
 * 只清 `blocked` / `paused` 两种**已经停了**的阶段：
 *   - `active` 不清：对方真的在干活，那属于「忙」，应该拒绝；
 *   - `complete` 不用清：create 自己就能替换。
 * 清除会留下 durable tombstone 与历史，不是把记录抹掉。
 *
 * @param support - `goalSupport()` 的返回值。
 * @param agent - 目标的活 agent。
 * @param objective - 写进新目标的目标描述。
 * @returns `{ view, replaced }`；`replaced` 非空表示清掉过一个旧目标。
 */
function createGoalFor(support, agent, objective) {
  try {
    return { view: support.goals.create(agent, { objective }), replaced: null };
  } catch (reason) {
    let current;
    try {
      current = support.goals.get(agent);
    } catch {
      current = undefined;
    }
    if (current === undefined || current === null) throw reason;
    if (current.phase !== 'blocked' && current.phase !== 'paused') throw reason;
    try {
      support.goals.clear(agent, { id: current.id, revision: current.revision });
    } catch {
      // 清不掉（比如 revision 又变了）：保留原始错误，让调用方看到真实原因。
      throw reason;
    }
    return {
      view: support.goals.create(agent, { objective }),
      replaced: { phase: current.phase, reason: blockReasonText(current) },
    };
  }
}

/**
 * 结果里那句「派单前清掉过旧目标」的说明。
 * @param replaced - `createGoalFor()` 返回的 `replaced`。
 * @returns 说明文本；没清过就返回空串。
 */
function replacedNote(replaced) {
  if (replaced === undefined || replaced === null) return '';
  const what = replaced.phase === 'paused' ? '暂停' : '受阻';
  const why = replaced.reason === '' ? '' : '（原因：' + replaced.reason + '）';
  return '派单前已清除对方一个' + what + '的旧目标' + why + '，本次是新的目标。';
}

/**
 * 这一批整体算什么状态。
 *
 * 词汇刻意与单个目标分开：`complete` 表示「这一批全部做成」，`partial` 表示「有结论
 * 但不算全都做成」（有卡住的、有没派出去的），`running` 表示还得接着等。
 *
 * @param results - 每个目标的 `{ status }`。
 * @param aborted - 调用方是否取消了这次调用。
 * @returns 批次状态。
 */
export function batchStatus(results, aborted) {
  if (results.length === 0) return 'failed';
  if (results.some((item) => item.status === 'running')) return 'running';
  const failed = results.filter((item) => item.status === 'failed').length;
  if (failed === results.length) return 'failed';
  const succeeded = results.filter((item) => isSuccessStatus(item.status)).length;
  if (failed === 0 && succeeded === results.length) return 'complete';
  /*
   * 取消放在最后判：用户可能在结果已经全部到手的瞬间按了停止，那时这一批其实是成功的，
   * 报 cancelled 会让模型以为没拿到结果、白白重派一次。
   */
  if (aborted && results.some((item) => item.status === 'cancelled')) return 'cancelled';
  return 'partial';
}

/**
 * 语义冲突时的说明：给了 task 却选中还在跑的旧派单，或者反过来。
 *
 * 两种都**直接拒绝**而不是猜：猜错的代价是模型以为新任务已经派出去了，而对方其实还在
 * 做上一件 —— 用户会得到一份对不上的结论。
 *
 * @param conflicts - `[{ binding, why }]`，`why` 是 `'running'` 或 `'idle'`。
 * @returns 一整段可直接抛给模型的话。
 */
function explainConflicts(conflicts) {
  const running = conflicts.filter((item) => item.why === 'running').map((item) => '「' + item.binding.label + '」');
  const uncollected = conflicts.filter((item) => item.why === 'uncollected').map((item) => '「' + item.binding.label + '」');
  const idle = conflicts.filter((item) => item.why === 'idle').map((item) => '「' + item.binding.label + '」');
  const lines = [];
  if (uncollected.length > 0) {
    lines.push(
      '这些目标上一次派单的**结果还没取**：' + uncollected.join('、') + '。',
      '先省略 task 把它们取回来（结果只会交付一次），再派新的。',
    );
  }
  if (running.length > 0) {
    lines.push(
      '这些目标还在跑上一次派出去的那件事：' + running.join('、') + '。',
      '先等它们结束（省略 task，只等它们），再派新的；不要给正在跑的会话叠加第二个目标。',
    );
  }
  if (idle.length > 0) {
    lines.push(
      '这些目标当前没有进行中的派单：' + idle.join('、') + '，没什么可等的。',
      '要派任务就给 task；可派目标多于一个时还要用 targets 指明派给谁。',
    );
  }
  return lines.join('\n');
}

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
function watchDetached(ctx, service, key, agent) {
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
 * 等待一批目标，按 `wait` 语义决定什么时候收尾。
 *
 * @param waiters - 每个目标一条等待，解析成 `{ index, item, outcome }`。
 * @param wait - `'all'` 或 `'any'`。
 * @param links - 与 `waiters` 同序的取消把手，`any` 收手时要掐掉还没回来的那几条。
 * @returns 已经收到结果的条目（`any` 模式下没等到的会被收手并记成 running）。
 */
async function collect(waiters, wait, links) {
  if (wait !== WAIT_ANY) return Promise.all(waiters);

  const collected = [];
  const pending = new Set(waiters.map((_item, index) => index));
  while (pending.size > 0) {
    const first = await Promise.race([...pending].map((index) => waiters[index]));
    pending.delete(first.index);
    collected.push(first);
    // 一到终态就收手：这是一个「先到先看」的请求，不该被最慢的那个拖住。
    if (isTerminalStatus(first.outcome.status)) break;
  }
  if (pending.size === 0) return collected;

  /*
   * 还没回来的那些：主动掐掉等待，但**记成 running 而不是 cancelled** —— 「我们不等了」
   * 与「用户按了停止」是两件事，后者才该报 cancelled。掐掉是为了立刻释放它们挂着的
   * `session/event` 订阅，而不是留到切片到期。
   */
  const indexes = [...pending];
  for (const index of indexes) links[index].abort();
  const settled = await Promise.all(indexes.map((index) => waiters[index]));
  for (const value of settled) {
    collected.push({
      index: value.index,
      item: value.item,
      outcome: { ...value.outcome, status: 'running' },
    });
  }
  return collected;
}

/**
 * 一次多目标派单的完整流程。
 *
 * @param options.ctx - 宿主上下文。
 * @param options.service - 绑定表（读写 pending）。
 * @param options.ownerId - 发起方会话 id。
 * @param options.bindings - 这一次要操作的（已解析好的）目标。
 * @param options.task - 任务正文；空串表示续等。
 * @param options.wait - `'all'` 或 `'any'`。
 * @param options.signal - 调用方取消信号。
 * @returns `{ status, results, stillRunning, note }`。
 */
export async function runBatch(options) {
  const { ctx, service, ownerId, bindings, task, wait, signal } = options;
  const ownerLabel = service.labels.get(ownerId) ?? ownerId;
  const support = goalSupport(ctx);
  const nonBlocking = wait === WAIT_NONE;
  /*
   * 「派完就走」依赖目标服务：后台监视要读 goal 的 phase，结果也记在 pending 里。
   * 老部署没有 goals 时这条路根本走不通 —— 必须当场拒绝，不能假装派成了。
   * （踩过：少了这条判断，老部署上会返回 status: dispatched，而一条消息都没投出去。）
   */
  if (nonBlocking && support === null) {
    throw new Error('这个部署没有目标服务，做不到「派完就走」：请省略 wait（默认 all），同步等到结论。');
  }

  // ── 1. 分流：哪些是新派、哪些是续等 ──────────────────────────────────
  const fresh = [];
  const resume = [];
  const conflicts = [];
  for (const binding of bindings) {
    const key = ownerId + '\u0000' + binding.id;
    const pending = service.pending.get(key);
    if (task !== '') {
      if (pending === undefined) fresh.push({ binding, key });
      // 有结论却没收 = 「结果还没取」，与「还在跑」是两回事，得分开说。
      else if (pending.settled !== null && pending.settled !== undefined) {
        conflicts.push({ binding, why: 'uncollected' });
      } else conflicts.push({ binding, why: 'running' });
    } else if (pending === undefined) {
      conflicts.push({ binding, why: 'idle' });
    } else {
      resume.push({ binding, key });
    }
  }
  if (conflicts.length > 0) throw new Error(explainConflicts(conflicts));

  // ── 2. 预检：新派的目标必须**全部**空闲，否则一个都不派 ──────────────
  if (fresh.length > 0) {
    const busy = [];
    for (const item of fresh) {
      const text = runningText(ctx, item.binding);
      if (text !== null) busy.push(text);
    }
    if (busy.length > 0) {
      const lines = busy.slice();
      if (busy.length > 1) {
        lines.push('批量派单要求这些目标全部空闲；有一个不闲就一个都不派，请先等它们结束。');
      }
      throw new Error(lines.join('\n'));
    }
  }

  // ── 3. 启动：建目标、记 pending；失败只记这一条，不拖垮整批 ──────────
  const entries = [];
  const failures = [];
  for (const item of fresh) {
    if (support === null) {
      // 老部署没有目标服务：走普通消息投递，那条路不记 pending。
      entries.push(item);
      continue;
    }
    let agent;
    try {
      agent = await resolveTargetAgent(support, item.binding);
    } catch (reason) {
      failures.push({ binding: item.binding, reply: errorText(reason) });
      continue;
    }
    let created;
    try {
      created = createGoalFor(support, agent, wrapTask(task, ownerLabel));
    } catch (reason) {
      failures.push({
        binding: item.binding,
        reply: '目标「' + item.binding.label + '」当前的目标没法替换（' + errorText(reason)
          + '）。请先在那个会话里结束或清除它现有的目标，再派新的。',
      });
      continue;
    }
    service.pending.set(item.key, {
      /** 建本单之前清掉过一个受阻/暂停的旧目标时会记在这里。 */
      replaced: created.replaced,
      /** 后台监视写进来的结论；null 表示还在跑。 */
      settled: null,
      /** 后台监视的取消把手（撤箭头、卸载时掐掉）。 */
      controller: null,
    });
    if (nonBlocking) {
      // 派完就走：挂一条后台监视，目标结束时把结论记进 pending，等 A 回来取。
      watchDetached(ctx, service, item.key, agent);
    }
    entries.push({ ...item, agent });
  }

  for (const item of resume) {
    try {
      entries.push({ ...item, agent: await resolveTargetAgent(support, item.binding) });
    } catch (reason) {
      // 唤醒失败：这条派单已经等不上了，结清记录（连同它的后台监视），免得永远挂着。
      service.forget(item.key);
      failures.push({ binding: item.binding, reply: errorText(reason) });
    }
  }

  // ── 4a. `wait: 'none'`：只回一份快照，绝不阻塞 ──────────────────────
  if (nonBlocking) {
    const byId = new Map();
    for (const binding of bindings) {
      const key = ownerId + '\u0000' + binding.id;
      const entry = service.pending.get(key);
      if (entry === undefined) continue;
      if (entry.settled !== null && entry.settled !== undefined) {
        // 有结论了就交付并结清：领取一次之后不再重复给，避免同一段结论反复进上下文。
        const settled = entry.settled;
        service.forget(key);
        byId.set(binding.id, {
          target: binding.label,
          status: settled.status,
          reply: composeReply(settled),
          note: replacedNote(entry.replaced),
        });
      } else {
        byId.set(binding.id, {
          target: binding.label,
          status: 'running',
          reply: '',
          note: replacedNote(entry.replaced),
        });
      }
    }
    for (const failure of failures) {
      byId.set(failure.binding.id, {
        target: failure.binding.label,
        status: 'failed',
        reply: failure.reply,
        note: '',
      });
    }
    const results = bindings.map((binding) => byId.get(binding.id)).filter((item) => item !== undefined);

    // 与阻塞路径同样的失败口径：一个都没派出去、或单目标失败，都直接抛。
    if (entries.length === 0 && failures.length > 0) {
      throw new Error(failures.map((item) => item.reply).join('\n'));
    }
    if (bindings.length === 1) {
      const only = results[0];
      if (only !== undefined && (only.status === 'failed' || only.status === 'error')) {
        throw new Error(only.reply);
      }
    }

    const stillRunning = results.filter((item) => item.status === 'running').length;
    if (task !== '') {
      return {
        status: 'dispatched',
        results,
        stillRunning,
        note: '已经派出去了，不用在这里等。你可以先做自己的事；需要结果时再调用一次 dispatch_task'
          + '（省略 task 与 targets）来取。不收尾是不会结束的 —— 这个回合结束前会提醒你一次。',
      };
    }
    return {
      status: batchStatus(results, signal.aborted),
      results,
      stillRunning,
      note: stillRunning === 0
        ? ''
        : '还有 ' + String(stillRunning) + ' 个目标在跑。可以再用 wait: none 看一眼，'
          + '或者用默认的 wait: all 阻塞着等它们出结论。',
    };
  }

  // ── 4. 并发等待 ────────────────────────────────────────────────────
  /*
   * 有些目标可能在「派完就走」之后、这一次调用之前就已经结束了。它们的结论早就被
   * 后台监视记下了，直接交付即可 —— 再等一轮只会白等满一段切片。
   */
  const ready = [];
  const waiting = [];
  for (const item of entries) {
    const entry = support === null ? undefined : service.pending.get(item.key);
    if (entry !== undefined && entry !== null && entry.settled !== null && entry.settled !== undefined) {
      ready.push(item);
    } else {
      waiting.push(item);
    }
  }

  const links = [];
  const waiters = waiting.map((item, index) => {
    const link = linkSignal(signal);
    links.push(link);
    const promise = support === null
      ? deliverAndWait(ctx, item.binding, task, ownerLabel, link.signal)
      : waitForGoal(ctx, item.agent, link.signal, { sliceMs: service.sliceMs });
    return promise.then(
      (outcome) => ({ index, item, outcome }),
      (reason) => ({ index, item, outcome: { status: 'error', reply: errorText(reason) } }),
    );
  });

  const collected = await collect(waiters, wait, links);
  // 这一次调用不再需要听调用方的取消了；留着监听等于把 signal 一直挂在外面。
  for (const link of links) link.release();
  for (const item of ready) {
    const entry = service.pending.get(item.key);
    if (entry === undefined || entry === null) continue;
    collected.push({ index: -1, item, outcome: entry.settled });
  }

  // ── 5. 整理结果、清理 pending ──────────────────────────────────────
  const byId = new Map();
  for (const collectedItem of collected) {
    if (collectedItem.item === null || collectedItem.item === undefined) continue;
    const item = collectedItem.item;
    const outcome = { ...collectedItem.outcome };
    const record = support === null ? undefined : service.pending.get(item.key);
    if (support !== null) {
      /*
       * 后台监视从**派出那一刻**就在听，比「这一次阻塞等待」看到的历史更长。
       * 目标恰好在阻塞期间结束时，两边会同时结算：这时必须以后台攒下的文本为准。
       * 否则「结论早说、终态晚到且不带文本」会把结论覆盖成空串 —— 真机可复现。
       */
      if (record !== undefined && record !== null
        && record.settled !== null && record.settled !== undefined) {
        if (outcome.reply === undefined || outcome.reply === '') outcome.reply = record.settled.reply;
        if ((outcome.reason === undefined || outcome.reason === '')
          && typeof record.settled.reason === 'string') outcome.reason = record.settled.reason;
      }
      // 还在跑就留着 pending，下一轮接着等；有结论了就结清（并掐掉后台监视）。
      if (isTerminalStatus(outcome.status)) service.forget(item.key);
    }
    byId.set(item.binding.id, {
      target: item.binding.label,
      status: outcome.status,
      reply: composeReply(outcome),
      note: [composeItemNote(outcome), replacedNote(record === undefined || record === null ? null : record.replaced)]
        .filter((text) => text !== '')
        .join(' '),
    });
  }
  for (const failure of failures) {
    byId.set(failure.binding.id, {
      target: failure.binding.label,
      status: 'failed',
      reply: failure.reply,
      note: '',
    });
  }
  // 按用户请求的顺序输出，而不是按谁先回来 —— 模型对着名单核对更省事。
  const results = bindings.map((binding) => byId.get(binding.id)).filter((item) => item !== undefined);

  /*
   * 失败怎么报，分三种情况 —— 差别在于「有没有别的东西在跑」：
   *   1. 一个目标都没启动（预检之后全在建目标那步倒下）→ 整次调用就是失败的，直接抛；
   *   2. 只派一个目标，而它失败了 → 单目标场景下模型期待的是「成功或异常」，抛更清楚，
   *      也不会让人把一条 error 结果当成派成了；
   *   3. 多目标里部分失败 → 不抛，记在 results 里，别拖垮已经跑起来的那些。
   */
  if (entries.length === 0 && failures.length > 0) {
    throw new Error(failures.map((item) => item.reply).join('\n'));
  }
  if (bindings.length === 1) {
    const only = results[0];
    if (only !== undefined && (only.status === 'failed' || only.status === 'error')) {
      throw new Error(only.reply);
    }
  }

  const status = batchStatus(results, signal.aborted);
  const stillRunning = results.filter((item) => item.status === 'running').length;
  let note = '';
  if (status === 'running') {
    note = '还有 ' + stillRunning + ' 个目标在做。继续调用 dispatch_task 并省略 task 与 targets，'
      + '接着等下一段，直到状态不再是 running。';
  } else if (status === 'partial') {
    note = '这一批里有目标没做成或没派出去，看 results 里各自的 status 与 reply。';
  } else if (status === 'failed') {
    note = '这一批一个都没派出去，先按 reply 里的原因处理，再重新派。';
  }
  return { status, results, stillRunning, note };
}

/** `wait` 参数的取值归一（模型给别的值时退回默认的 `all`）。 */
export function normalizeWait(value) {
  if (value === WAIT_ANY) return WAIT_ANY;
  if (value === WAIT_NONE) return WAIT_NONE;
  return WAIT_ALL;
}
