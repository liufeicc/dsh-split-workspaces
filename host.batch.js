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

import { WAIT_ALL, WAIT_ANY } from './host.constants.js';
import { errorText, wrapTask } from './host.message.js';
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
  if (aborted) return 'cancelled';
  if (results.length === 0) return 'failed';
  if (results.some((item) => item.status === 'running')) return 'running';
  const failed = results.filter((item) => item.status === 'failed').length;
  if (failed === results.length) return 'failed';
  const succeeded = results.filter((item) => isSuccessStatus(item.status)).length;
  if (failed === 0 && succeeded === results.length) return 'complete';
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
  const idle = conflicts.filter((item) => item.why === 'idle').map((item) => '「' + item.binding.label + '」');
  const lines = [];
  if (running.length > 0) {
    lines.push(
      '这些目标还在跑上一次派出去的那件事：' + running.join('、') + '。',
      '先等它们结束（省略 task，只等它们），再派新的；不要给正在跑的会话叠加第二个目标。',
    );
  }
  if (idle.length > 0) {
    lines.push(
      '这些目标当前没有进行中的派单：' + idle.join('、') + '，没什么可等的。',
      '要派任务就给 task；只给 task 不给 targets 时，会派给这个会话全部可派目标。',
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

  // ── 1. 分流：哪些是新派、哪些是续等 ──────────────────────────────────
  const fresh = [];
  const resume = [];
  const conflicts = [];
  for (const binding of bindings) {
    const key = ownerId + '\u0000' + binding.id;
    const pending = service.pending.get(key);
    if (task !== '') {
      if (pending === undefined) fresh.push({ binding, key });
      else conflicts.push({ binding, why: 'running' });
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
      created = support.goals.create(agent, { objective: wrapTask(task, ownerLabel) });
    } catch (reason) {
      failures.push({
        binding: item.binding,
        reply: '目标「' + item.binding.label + '」当前的目标没法替换（' + errorText(reason)
          + '）。请先在那个会话里结束或清除它现有的目标，再派新的。',
      });
      continue;
    }
    service.pending.set(item.key, {
      goalId: created === undefined || created === null ? undefined : created.id,
      startedAt: Date.now(),
    });
    entries.push({ ...item, agent });
  }

  for (const item of resume) {
    try {
      entries.push({ ...item, agent: await resolveTargetAgent(support, item.binding) });
    } catch (reason) {
      // 唤醒失败：这条派单已经等不上了，清掉 pending，免得把它永远挂在那里。
      service.pending.delete(item.key);
      failures.push({ binding: item.binding, reply: errorText(reason) });
    }
  }

  // ── 4. 并发等待 ────────────────────────────────────────────────────
  const links = [];
  const waiters = entries.map((item, index) => {
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

  // ── 5. 整理结果、清理 pending ──────────────────────────────────────
  const byId = new Map();
  for (const entry of collected) {
    if (entry.item === null || entry.item === undefined) continue;
    const item = entry.item;
    const outcome = entry.outcome;
    if (support !== null) {
      // 还在跑就留着 pending，下一轮接着等；有结论了就核销。
      if (isTerminalStatus(outcome.status)) service.pending.delete(item.key);
    }
    byId.set(item.binding.id, {
      target: item.binding.label,
      status: outcome.status,
      reply: composeReply(outcome),
      note: composeItemNote(outcome),
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
  return value === WAIT_ANY ? WAIT_ANY : WAIT_ALL;
}
