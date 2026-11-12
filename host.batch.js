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
 *   1. **分流**：把请求拆成「新派」「续等」「纠正」三拨，并检查语义冲突
 *      （给了 task 却选中一个已有结论没收的目标 / 没给 task 却选中一个从没派过的目标）。
 *      目标正在跑时给 task 不再报错，而是当成**纠正**：先停当前轮，再把纠正作为
 *      新消息重新提交 —— 这是 A 看到过程稿之后唯一能改方向的路。
 *   2. **预检**：把这一批新派的目标**全部**查一遍忙闲，全部空闲才动手。
 *      少了这一步就会出现「派出去一半」：目标 B 建好了、目标 C 报忙，模型拿到一个
 *      半截状态，还得自己猜哪些生效了。
 *   3. **并发等待**：每个目标一条独立的等待，按 `wait` 语义决定什么时候收尾。
 *
 * ## 交付与过程稿分开
 *
 * 只有 `complete` 是**交付**：文本进 `reply`，`deliverable` 为 true。其余状态
 * （running / blocked / paused / interrupted / timeout / cancelled）的文本一律进
 * `progress`，并明确标注「过程稿，可能被推翻」。这样 A 不会把 B 的中途判断当成结论。
 *
 * ## 用户手停
 *
 * 用户在界面上按停止时，`turn/end` 会带 `aborted.user`。这一单按 `interrupted` 收口，
 * 而不是 `paused` 或 `running`：A 必须知道「是用户停的、未交付、可以继续做别的」，
 * 且不能越过用户去纠正目标。
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

import { STATUS_INTERRUPTED, WAIT_ALL, WAIT_ANY, WAIT_NONE } from './host.constants.js';
import { describeCandidates, errorText, matchBinding, wrapTask } from './host.message.js';
import { redirectBatch } from './host.redirect.js';
import {
  deliverAndWait,
  goalSupport,
  resolveTargetAgent,
  runningText,
  waitForGoal,
} from './host.wait.js';
import { watchDetached } from './host.watch.js';

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
 * 把非交付状态的过程文本整理成**明确标着「过程稿」**的一段话。
 *
 * 为什么前缀要写死在数据里而不是只在工具描述里叮嘱：模型最容易忽略的就是描述，
 * 而它一定会读到结果文本。让「这是过程稿」和内容长在一起，误用的概率最低。
 *
 * @param outcome - 等待结果。
 * @returns 带前缀的过程稿；没有内容时返回空串。
 */
function composeProgress(outcome) {
  const progress = typeof outcome?.progress === 'string' ? outcome.progress : '';
  if (progress === '') return '';
  return '（过程稿，可能被后续推翻）\n' + progress;
}

/**
 * 单个结果的补充说明：讲清楚「这一单交付了没有、能不能拿它行动」。
 *
 * @param outcome - 等待结果。
 * @param interruptedBy - `'user'` 表示用户手动停止。
 * @returns 说明文字；成功交付时是空串。
 */
function composeItemNote(outcome, interruptedBy) {
  const status = outcome?.status;
  const lines = [];
  if (status === 'running') {
    const rounds = Number(outcome?.rounds ?? 0);
    lines.push(rounds > 0 ? '已到第 ' + String(rounds) + ' 轮。' : '目标还在做。');
    lines.push('这是过程稿，不是交付结论；方向不对时，可以用 dispatch_task 带 task 给这个目标发纠正（会先停止它的当前轮，再把纠正作为新消息重新提交，并重新启动目标）。');
  } else if (status === 'complete' && outcome?.deliverable === false) {
    lines.push('目标已完成，但结论没能自动恢复；去目标会话里看最后一条回复。');
  } else if (interruptedBy === 'user') {
    lines.push('用户手动停止了目标并接管了这一单，未交付。');
    lines.push('你可以继续做不依赖它的部分；不要越过用户去纠正它，等用户处理完再派。');
  } else if (status === 'paused') {
    lines.push('目标已暂停，未交付。');
  } else if (status === 'blocked') {
    lines.push('目标受阻，未交付。');
  } else if (status === 'cleared') {
    lines.push('目标已被清除，未交付。');
  } else if (status === 'cancelled') {
    lines.push('这次等待被取消了，目标仍在跑，未交付。');
  } else if (status === 'timeout') {
    lines.push('等待超时，目标仍未交付；可以再等一次。');
  } else if (status === 'error') {
    lines.push('等待出错，未交付。');
  }
  return lines.join(' ');
}

/**
 * 把一次等待结果整形成对模型友好的结果项。
 *
 * 三个字段一起回答 A 最关心的问题：
 *   - `deliverable`：这一单到底交付了没有（只有 complete / completed 为 true）；
 *   - `reply`：交付结论（未交付时只有结束原因，不含过程稿）；
 *   - `progress`：未交付时的过程稿（带「可能被推翻」前缀）。
 *
 * @param target - 目标显示名。
 * @param outcome - 等待结果。
 * @param replaced - 建目标前清掉的旧目标（可选）。
 * @returns 结果项。
 */
function shapeResult(target, outcome, replaced) {
  // 个别「目标已完成、但结论没恢复」的条目会显式带 `deliverable: false`。
  const delivered = outcome?.deliverable === false ? false : isSuccessStatus(outcome?.status);
  const interruptedBy = outcome?.interruptedBy === 'user' ? 'user' : '';
  return {
    target,
    status: typeof outcome?.status === 'string' ? outcome.status : 'error',
    deliverable: delivered,
    reply: composeReply(outcome),
    progress: delivered ? '' : composeProgress(outcome),
    interruptedBy,
    note: [composeItemNote(outcome, interruptedBy), replacedNote(replaced)]
      .filter((text) => text !== '')
      .join(' '),
  };
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
  /*
   * 全部目标都被用户手动停止：这不是「部分做成」，而是一整批被接管。
   * 单独给一个状态，A 才知道该继续做不依赖它的部分，而不是按 partial 的语义去复核半成品。
   */
  const interrupted = results.filter((item) => item.status === STATUS_INTERRUPTED).length;
  if (interrupted === results.length) return STATUS_INTERRUPTED;
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
 * 语义冲突时的说明。
 *
 * 现在只剩三种：
 *   - 目标刚被用户手动停止并接管（`interrupted`）；
 *   - 上一次派单有结论还没取（`uncollected`）；
 *   - 没给 task 却选中一个从没派过的目标（`idle`）。
 * 「目标正在跑」不再是冲突 —— 带 task 的调用会被当成纠正（先停当前轮再重新提交）。
 *
 * 四种都**直接拒绝**而不是猜：猜错的代价是模型以为事情已经办好了，而实际上没有。
 *
 * @param conflicts - `[{ binding, why, review? }]`，`why` 是 `'interrupted'` / `'uncollected'` / `'idle'` / `'review'`。
 * @returns 一整段可直接抛给模型的话。
 */
function explainConflicts(conflicts) {
  const interrupted = conflicts.filter((item) => item.why === 'interrupted').map((item) => '「' + item.binding.label + '」');
  const uncollected = conflicts.filter((item) => item.why === 'uncollected').map((item) => '「' + item.binding.label + '」');
  const idle = conflicts.filter((item) => item.why === 'idle').map((item) => '「' + item.binding.label + '」');
  const review = conflicts.filter((item) => item.why === 'review');
  const lines = [];
  if (interrupted.length > 0) {
    lines.push(
      '这些目标刚被用户手动停止并接管：' + interrupted.join('、') + '。',
      '这一单未交付；先省略 task 取走中断说明，不要越过用户去纠正它。等用户处理完再派。',
    );
  }
  if (uncollected.length > 0) {
    lines.push(
      '这些目标上一次派单的**结果还没取**：' + uncollected.join('、') + '。',
      '先省略 task 把它们取回来（结果只会交付一次），再派新的。',
    );
  }
  if (review.length > 0) {
    lines.push(
      '这些目标上一单已经交付，但还没审核：' + review.map((item) => '「' + item.binding.label + '」').join('、') + '。',
      '先对照验收标准自己复核，再用 dispatch_task 带 reviews 记录审核结论（accepted / rejected + 理由）；',
      '审核之后才能给同一个目标派新任务。',
      '上一单的结论也留在各自目标会话的历史里，Host 重启后照样可以回去复核。',
      '如果目标已经删除或不再需要接活，撤掉箭头会一并清掉这条审核记录。',
    );
    for (const item of review) {
      const excerpt = typeof item.review?.excerpt === 'string' ? item.review.excerpt.trim() : '';
      if (excerpt !== '') lines.push('「' + item.binding.label + '」的结论开头：' + excerpt);
    }
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
 * 这一批之外、此刻空闲、可以直接接新单的目标名单。
 *
 * 为什么需要它：工具描述刻意不写忙闲（写了每轮都变，提示词缓存全废），于是 A 派完一批
 * 就不知道还有谁闲着 —— 真机上出现过「三个 worker 都空了，A 只派了一个就收工」。
 * 把空闲名单挂在**这一批的结果**后面，是既不增加往返、又不破坏缓存的时机。
 *
 * 三种目标不算空闲：
 *   1. 本批已经派过的（不重复提示）；
 *   2. 这个会话还有没取走的结论（要先收结果，再派会被拒）；
 *   3. 此刻正在跑一个回合（runningText 非 null）。
 *
 * @param ctx - 宿主上下文。
 * @param service - 绑定表。
 * @param ownerId - 发起方会话 id。
 * @param batch - 本批已操作的目标。
 * @returns 可直接拼进 note 的一句话；没有其他空闲目标时返回空串。
 */
function idleNote(ctx, service, ownerId, batch) {
  const all = service.bindings.get(ownerId) ?? [];
  if (all.length <= 1) return '';
  const used = new Set(batch.map((item) => item.id));
  const idle = [];
  for (let index = 0; index < all.length; index += 1) {
    const item = all[index];
    if (used.has(item.id)) continue;
    // pending 存在 = 这个会话对它有在途单或没取的结论，两种情况都不该再派。
    if (service.pending.has(ownerId + '\u0000' + item.id)) continue;
    if (runningText(ctx, item) !== null) continue;
    idle.push((index + 1) + ') ' + item.label);
  }
  if (idle.length === 0) return '';
  return '另外还有 ' + String(idle.length) + ' 个可派目标此刻空闲：' + idle.join('、') + '。'
    + '如果这次没派完的活还能拆成相对独立的部分，优先继续派给它们（targets 一次列全），'
    + '不要让它们空着，也不要自己顺手做完 —— 用户连箭头就是希望这些活由它们承担。';
}

/**
 * 人已经点过目标条上的「审核完成」：goal 被清掉了，但插件的待审核记录还在。
 *
 * 以 goal 为真相 —— 目标上已经没有 complete 的 goal（或换成了新 goal），就说明审核
 * 这一步已经被人做过，把记录清掉、放行新派单。读不到目标状态时保留审核闸：宁严勿松。
 *
 * @param ctx - 宿主上下文。
 * @param service - 绑定表。
 * @param ownerId - 发起方会话 id。
 * @param bindings - 这一次要派的目标。
 */
async function releaseHumanReviewed(ctx, service, ownerId, bindings) {
  const support = goalSupport(ctx);
  if (support === null) return;
  for (const binding of bindings) {
    if (service.reviewOf(ownerId, binding.id) === undefined) continue;
    let agent;
    try {
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
    if (view === undefined || view === null || view.phase !== 'complete') {
      service.takeReview(ownerId, binding.id);
    }
  }
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
  /*
   * 人可能已经点了目标条上的「审核完成」——goal 被清掉，插件的待审核记录还在。
   * 派新单之前以 goal 为真相对齐一次，避免人工审核之后还被旧记录拦住。
   */
  if (task !== '' && support !== null) {
    await releaseHumanReviewed(ctx, service, ownerId, bindings);
  }

  // ── 1. 分流：哪些是新派、哪些是续等、哪些其实是在纠正 ──────────────────
  const fresh = [];
  const resume = [];
  const redirects = [];
  const conflicts = [];
  for (const binding of bindings) {
    const key = ownerId + '\u0000' + binding.id;
    const pending = service.pending.get(key);
    if (task !== '') {
      if (pending === undefined) {
        /*
         * 上一单交付了、还没审核：这一单不能派。
         *
         * 与「结果没取」的区别：结果已经交给模型看过了，缺的是**验收动作**。按目标拦，
         * 只堵这一个 worker；其他空闲目标照常可以接活。
         */
        const review = service.reviewOf(ownerId, binding.id);
        if (review === undefined) fresh.push({ binding, key });
        else conflicts.push({ binding, why: 'review', review });
      }
      // 有结论却没收 = 「结果还没取」，与「还在跑」是两回事，得分开说。
      else if (pending.settled !== null && pending.settled !== undefined) {
        conflicts.push({
          binding,
          why: pending.settled.status === STATUS_INTERRUPTED ? 'interrupted' : 'uncollected',
        });
      } else {
        /*
         * 目标正在跑，而且 A 给了新内容：这是**纠正**，不是第二个任务。
         *
         * 旧行为是直接报「目标忙」，于是 A 看到过程稿发现方向不对也改不了，只能等它
         * 按错的方向跑完。上一版改成排队一条消息到下一轮 —— 当前轮仍然会按错的
         * 方向跑完。现在按用户要求：先停止目标当前轮（与界面停止按钮同一条路径），
         * 再把纠正作为一条新消息重新提交，并重新启动目标（用户手停 / 我们停掉的
         * paused 状态都会拉起）。用户手动停止过的目标不在这里（settled 已存在，
         * 走 `interrupted` 冲突），避免 A 越过用户去驱动目标。
         */
        redirects.push({ binding, key });
      }
    } else if (pending === undefined) {
      conflicts.push({ binding, why: 'idle' });
    } else {
      resume.push({ binding, key });
    }
  }
  if (conflicts.length > 0) throw new Error(explainConflicts(conflicts));
  if (redirects.length > 0) {
    if (fresh.length > 0) {
      throw new Error(
        '一次调用里不能同时「纠正正在跑的目标」和「给空闲目标派新任务」：'
        + '同一个 task 会有两种语义。请分成两次调用 —— 先只发给正在跑的目标，再发新任务。',
      );
    }
    return redirectBatch({ ctx, service, ownerId, bindings, task, signal });
  }

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
      /** 最新过程稿：让 `wait: none` 中途查看时也能看到进展。 */
      progress: '',
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
        const shaped = shapeResult(binding.label, settled, entry.replaced);
        if (shaped.deliverable === true) service.markReviewNeeded(ownerId, binding, shaped);
        byId.set(binding.id, shaped);
      } else {
        byId.set(binding.id, {
          target: binding.label,
          status: 'running',
          deliverable: false,
          reply: '',
          progress: composeProgress({ progress: entry.progress ?? '' }),
          interruptedBy: '',
          note: [composeItemNote({ status: 'running', rounds: 0 }, ''), replacedNote(entry.replaced)]
            .filter((text) => text !== '')
            .join(' '),
        });
      }
    }
    for (const failure of failures) {
      byId.set(failure.binding.id, {
        target: failure.binding.label,
        status: 'failed',
        deliverable: false,
        reply: failure.reply,
        progress: '',
        interruptedBy: '',
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
      const hint = idleNote(ctx, service, ownerId, bindings);
      const baseNote = '已经派出去了，不用在这里等。你可以先做自己的事；'
        + '如果结果里提示还有空闲目标、而手上还有能拆出去的活，先继续派给它们，再回来收结果。'
        + '需要结果时再调用一次 dispatch_task（省略 task 与 targets）来取。'
        + '不收尾是不会结束的 —— 这个回合结束前会提醒你一次。';
      return {
        status: 'dispatched',
        results,
        stillRunning,
        note: hint === '' ? baseNote : baseNote + '\n\n' + hint,
      };
    }
    const hint = stillRunning === 0 ? idleNote(ctx, service, ownerId, bindings) : '';
    return {
      status: batchStatus(results, signal.aborted),
      results,
      stillRunning,
      note: stillRunning === 0
        ? hint
        : '还有 ' + String(stillRunning) + ' 个目标在跑。返回里的 progress 是过程稿，不是交付结论。'
          + '可以再用 wait: none 看一眼，或者用默认的 wait: all 阻塞着等它们出结论。',
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
       *
       * 如果后台已经看到终态、而这次阻塞等待只拿到 `running`（切片到期），
       * 应当直接采用后台的终态 —— 尤其是 `interrupted`：用户手停后 A 不该再等。
       */
      if (record !== undefined && record !== null
        && record.settled !== null && record.settled !== undefined) {
        if (outcome.status === 'running') outcome.status = record.settled.status;
        if (outcome.reply === undefined || outcome.reply === '') outcome.reply = record.settled.reply;
        if (outcome.progress === undefined || outcome.progress === '') outcome.progress = record.settled.progress;
        if ((outcome.reason === undefined || outcome.reason === '')
          && typeof record.settled.reason === 'string') outcome.reason = record.settled.reason;
        if (outcome.interruptedBy === undefined || outcome.interruptedBy === '') {
          outcome.interruptedBy = record.settled.interruptedBy;
        }
      }
      // 还在跑就留着 pending，下一轮接着等；有结论了就结清（并掐掉后台监视）。
      if (isTerminalStatus(outcome.status)) service.forget(item.key);
    }
    const shaped = shapeResult(
      item.binding.label,
      outcome,
      record === undefined || record === null ? null : record.replaced,
    );
    // 真正交付的结论进入「待审核」：同一个目标下一次派单必须先过这一关。
    if (shaped.deliverable === true) service.markReviewNeeded(ownerId, item.binding, shaped);
    byId.set(item.binding.id, shaped);
  }
  for (const failure of failures) {
    byId.set(failure.binding.id, {
      target: failure.binding.label,
      status: 'failed',
      deliverable: false,
      reply: failure.reply,
      progress: '',
      interruptedBy: '',
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
    note = '还有 ' + stillRunning + ' 个目标在做。返回里的 progress 是**过程稿**，可能被后面推翻，'
      + '不是交付结论；可以据此判断方向，并用 dispatch_task 带 task 给目标发纠正'
      + '（会先停止它的当前轮，再把纠正作为新消息重新提交）。'
      + '要继续等就**继续调用** dispatch_task 并省略 task 与 targets，接着等下一段，直到状态不再是 running。';
  } else if (status === STATUS_INTERRUPTED) {
    note = '这一批被用户手动停止了：用户接管了目标，这一单未交付。'
      + '你可以继续做不依赖它的部分；等用户处理完再派，不要越过用户去纠正它。';
  } else if (status === 'partial') {
    note = '这一批里有目标没做成、没派出去，或被用户接管；看 results 里各自的 status 与 note。'
      + '只有 deliverable 为 true 的 reply 才是交付结论，其余内容都只是过程稿。';
  } else if (status === 'failed') {
    note = '这一批一个都没派出去，先按 reply 里的原因处理，再重新派。';
  }
  /*
   * 只在整批有结论之后提示空闲目标：还在跑时 note 的主题是「接着等下一段」，
   * 再塞一句「还有谁空闲」会把下一步指令搅乱。
   */
  if (status !== 'running') {
    const hint = idleNote(ctx, service, ownerId, bindings);
    if (hint !== '') note = note === '' ? hint : note + '\n\n' + hint;
  }
  return { status, results, stillRunning, note };
}

/**
 * 记录一次审核（`dispatch_task` 的 `reviews` 参数）。
 *
 * 审核按目标进行：
 *   - 只有**真的交付过**（deliverable: true）且还没审核的目标才能审；
 *   - 通过或驳回都会清掉待审核状态 —— 驳回之后就能带着缺口重派；
 *   - 驳回必须写清缺什么，否则重派时还是同一句「再做一遍」。
 *
 * 先整批校验、再整批落账：任何一项不合法都不改动已审状态，避免「批里错一个、
 * 前面几个已经被清掉」的半截状态。
 *
 * @param options.service - 绑定表（读写待审核记录）。
 * @param options.ownerId - 发起方会话 id。
 * @param options.bindings - 这个会话可派的目标。
 * @param options.reviews - 模型给的数组 `[{ target, verdict, note? }]`。
 * @returns `{ status: 'reviewed', results, stillRunning: 0, note }`。
 */
export async function runReviews(options) {
  const { ctx, service, ownerId, bindings, reviews } = options;
  const plan = [];
  const seen = new Set();
  for (const raw of reviews) {
    const targetText = typeof raw?.target === 'string' ? raw.target.trim() : '';
    if (targetText === '') throw new Error('reviews 里每一项都要给 target（序号、标题或会话 id）。');
    const binding = matchBinding(bindings, targetText);
    if (binding === null) {
      throw new Error(
        '没认出要审核哪个目标：' + targetText + '。当前可派的是：\n' + describeCandidates(bindings),
      );
    }
    if (seen.has(binding.id)) throw new Error('同一个目标一次只能审一次：「' + binding.label + '」。');
    seen.add(binding.id);
    const verdict = raw?.verdict;
    if (verdict !== 'accepted' && verdict !== 'rejected') {
      throw new Error('reviews 里的 verdict 只能是 accepted 或 rejected。');
    }
    const note = typeof raw?.note === 'string' ? raw.note.trim() : '';
    if (verdict === 'rejected' && note === '') {
      throw new Error('驳回必须写清缺什么（note），否则重派时对方还是不知道要补哪一条。');
    }
    if (service.reviewOf(ownerId, binding.id) === undefined) {
      throw new Error(
        '「' + binding.label + '」没有待审核的交付：只有上一单真的交付了（deliverable: true）才需要审核；'
        + 'failed / blocked / interrupted 不需要。',
      );
    }
    plan.push({ binding, verdict, note });
  }
  if (plan.length === 0) throw new Error('reviews 是空的：至少给一项 { target, verdict }。');

  const support = goalSupport(ctx);
  const results = [];
  for (const item of plan) {
    service.takeReview(ownerId, item.binding.id);
    /*
     * 审核完就把那个已完成的 goal 清掉：GoalBar 上的「待审核」随之消失，目标也不再
     * 占着「complete 只能被 create 替换」的位置。清不掉（目标已清、会话读不到）不回滚
     * 审核记录 —— 记录已经落账，用户还可以在目标条上点「审核完成」收尾。
     */
    if (support !== null) {
      try {
        const agent = await resolveTargetAgent(support, item.binding);
        const view = support.goals.get(agent);
        if (view !== undefined && view !== null && view.phase === 'complete') {
          support.goals.clear(agent, { id: view.id, revision: view.revision });
        }
      } catch {
        /* 留给目标条上的「审核完成」按钮。 */
      }
    }
    results.push({
      target: item.binding.label,
      status: item.verdict,
      deliverable: false,
      reply: '',
      progress: '',
      interruptedBy: '',
      note: item.verdict === 'accepted'
        ? '审核通过。现在可以给这个目标派新任务。'
        : '已记录驳回。用 dispatch_task 带 task 把具体缺口发回去'
          + (item.note === '' ? '。' : '：' + item.note),
    });
  }
  return {
    status: 'reviewed',
    results,
    stillRunning: 0,
    note: '审核已记录。通过的目标可以派新任务；驳回的目标请带着 note 里的具体缺口重派。',
  };
}

/** `wait` 参数的取值归一（模型给别的值时退回默认的 `all`）。 */
export function normalizeWait(value) {
  if (value === WAIT_ANY) return WAIT_ANY;
  if (value === WAIT_NONE) return WAIT_NONE;
  return WAIT_ALL;
}
