/**
 * 多工作区平铺 —— 向目标会话「咨询」一个问题。
 *
 * ## 它是什么
 *
 * 把 A 的问题作为一条**真实用户消息**投递进 B 的会话，等 B 用自己的完整工具
 * （读文件、跑命令、必要时修改文件）回答完这一轮，再把回答交回 A。
 *
 * 它与 `report_task` 的本质区别：
 *   - `report_task` 是旁注：读 B 的历史、另起一次模型请求，不落地、没有工具；
 *   - `consult_task` 是对话：问题与回答都写进 B 的会话日志，用户看得到，B 能动手核实。
 *
 * 它与 `dispatch_task` 的本质区别：
 *   - 派单会建 goal、进入交付/审核状态机；
 *   - 咨询不建 goal、不写 pending/reviews、不产生交付结论，只等 B 这一轮结束。
 *
 * ## 忙闲
 *
 * 与派单一致：目标正在跑一个回合时**跳过**，不排队。把咨询混进目标正在执行的任务
 * 上下文，回答会不可靠，也会污染它正在做的事。多目标时只跳过忙的那些，其余照常问。
 *
 * @module @local/dsh-split-workspaces/host-consult
 */

import { CONSULT_TIMEOUT_MS } from './host.constants.js';
import { errorText } from './host.message.js';
import { consultAndWait, runningText } from './host.wait.js';

/**
 * 把 `waitForTurn` 的状态词映射成咨询结果的状态词。
 *
 * `completed` 是唯一「答完了」的状态；其余都保留原词，让 A 能区分超时、用户停止、
 * 取消和真正的错误。
 *
 * @param status - `waitForTurn` 返回的状态。
 * @returns 咨询结果状态。
 */
function mapStatus(status) {
  if (status === 'completed') return 'ok';
  if (typeof status === 'string' && status !== '') return status;
  return 'error';
}

/**
 * 给非正常状态配一句人话说明。
 *
 * @param status - 映射后的状态。
 * @param reason - `waitForTurn` 给的结束原因。
 * @param timeoutMs - 本次的超时上限。
 * @returns 说明文本；正常完成时为空串。
 */
function noteOf(status, reason, timeoutMs) {
  if (status === 'ok') return '';
  if (status === 'timeout') {
    return '目标在 ' + String(Math.round(timeoutMs / 60000)) + ' 分钟内没有回答完；'
      + '上面的内容是它已经给出的部分，可能不完整。';
  }
  if (status === 'interrupted') return '用户手动停止了目标会话，这一轮没有答完。';
  if (status === 'cancelled') return '调用方取消了等待；目标可能还在回答，回答不会自动回到这里。';
  if (typeof reason === 'string' && reason !== '') return reason;
  return '';
}

/**
 * 向一个目标咨询。
 *
 * 异常在这里收口，不向外抛：一个目标失败不该让整批咨询崩掉。
 *
 * @param ctx - 宿主上下文。
 * @param binding - 目标绑定 `{ id, label }`。
 * @param question - 问题正文。
 * @param options - `{ sourceLabel, signal, timeoutMs }`。
 * @returns `{ target, status, reply, progress, note }`。
 */
export async function runConsult(ctx, binding, question, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : CONSULT_TIMEOUT_MS;
  /*
   * 先查一次忙闲再投递：忙的目标直接跳过，不产生任何消息。
   * `consultAndWait` 内部还会再查一次，防止「检查完到投递之间目标刚好开跑」的竞态。
   */
  if (runningText(ctx, binding) !== null) {
    return {
      target: binding.label,
      status: 'busy',
      reply: '',
      progress: '',
      note: '目标正在跑一个回合，本次咨询跳过；等它闲下来再问。',
    };
  }
  try {
    const outcome = await consultAndWait(
      ctx,
      binding,
      question,
      options.sourceLabel,
      options.signal,
      { timeoutMs },
    );
    const status = mapStatus(outcome.status);
    return {
      target: binding.label,
      status,
      reply: status === 'ok' ? outcome.reply : '',
      progress: status === 'ok' ? '' : outcome.progress,
      note: noteOf(status, outcome.reason, timeoutMs),
    };
  } catch (error) {
    return {
      target: binding.label,
      status: 'error',
      reply: '',
      progress: '',
      note: errorText(error),
    };
  }
}

/**
 * 并行向一批目标咨询。
 *
 * 每个目标独立投递、独立等待、独立超时；一个失败不影响其它目标。
 * 顺序与输入一致，方便 A 按 targets 的顺序读结果。
 *
 * @param options.ctx - 宿主上下文。
 * @param options.bindings - 目标绑定数组。
 * @param options.question - 问题正文。
 * @param options.sourceLabel - 发起方显示名。
 * @param options.signal - 调用方取消信号。
 * @param options.timeoutMs - 单目标超时。
 * @returns `{ status, results, note }`。
 */
export async function runConsults(options) {
  const { ctx, bindings, question, sourceLabel, signal, timeoutMs } = options;
  const results = await Promise.all(
    bindings.map((binding) => runConsult(ctx, binding, question, {
      sourceLabel,
      signal,
      timeoutMs,
    })),
  );
  const okCount = results.filter((item) => item.status === 'ok').length;
  const cancelled = results.length > 0 && results.every((item) => item.status === 'cancelled');
  /*
   * 全部目标都忙时单独给一个 `busy` 整批状态：这不是「咨询失败」，而是「这次没人能接」。
   * 混进 `failed` 会让 A 误以为投递/回答出了问题，反复重试同一批目标。
   */
  const allBusy = results.length > 0 && results.every((item) => item.status === 'busy');
  let status;
  if (cancelled) status = 'cancelled';
  else if (allBusy) status = 'busy';
  else if (okCount === results.length) status = 'ok';
  else if (okCount === 0) status = 'failed';
  else status = 'partial';
  const skipped = results.filter((item) => item.status === 'busy').length;
  const failed = results.filter((item) => item.status !== 'ok' && item.status !== 'busy').length;
  const parts = [];
  if (skipped > 0) parts.push(String(skipped) + ' 个目标正忙，已跳过');
  if (failed > 0) parts.push(String(failed) + ' 个目标没有正常回答');
  return {
    status,
    results,
    note: parts.length === 0 ? '' : parts.join('；') + '。',
  };
}