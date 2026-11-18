/**
 * 多工作区平铺 —— 面向模型的 `control_task` 工具。
 *
 * 与 `dispatch_task` 分开一只工具，而不是在它上面加 `action`：
 * `dispatch_task` 已经有「新派 / 续等 / 审核 / 纠正」四种隐式语义，再混进
 * 「停止 / 唤醒」，模型很容易把控制动作当成派新任务。这里只讲两件事，
 * 描述短、边界清楚，误用成本低。
 *
 * @module @local/dsh-split-workspaces/host-tool-control
 */

import {
  ACTION_RESUME,
  ACTION_STOP,
  CONTROL_TOOL_NAME,
  MAX_BATCH_TARGETS,
  STOP_TIMEOUT_MS,
} from './host.constants.js';
import { resumeBatch, stopBatch } from './host.control.js';
import { describeCandidates } from './host.message.js';
import { explainNoTarget, pickTargets } from './host.tool.js';

/**
 * `control_task` 的工具描述。
 *
 * 必须写清三件事，否则模型会拿它当「派新任务」或「取结果」用：
 *   1. stop 和 resume 各自改变什么、不改变什么；
 *   2. `stopping` 不是 `paused`，不能当成已经停了；
 *   3. 哪些目标不能停 / 不能唤醒。
 *
 * @param service - 绑定表。
 * @param ownerId - 发起方会话 id。
 * @returns 完整的工具描述。
 */
export function controlDescription(service, ownerId) {
  const roster = typeof ownerId === 'string' && ownerId !== ''
    ? (service.bindings.get(ownerId) ?? [])
    : [];
  const base = [
    '停止或唤醒一个**已经派出去**的任务。只做控制，不派新任务，也不取结果。',
    '',
    '## 什么时候用',
    '- 方向不对、想先停下来想清楚：`action: "stop"`；想清楚后要么 `action: "resume"` 继续原目标，',
    '  要么用 dispatch_task 带 task 发纠正（停止 + 新指令 + 重新启动一次完成）；',
    '- 目标因为暂停/等待停住了，你想让它继续原目标：`action: "resume"`。',
    '不要用 stop 代替纠正，也不要用 resume 代替派新任务。',
    '',
    '## stop',
    '- 与目标窗格的停止按钮同一个底层动作：中止当前回合，保留目标队列里用户自己的输入；',
    '- 停止后目标进入暂停状态，不会自动再开一轮；',
    '- 会等到目标 agent 真正 idle 才返回（最多 ' + Math.round(STOP_TIMEOUT_MS / 1000) + ' 秒）。',
    '  返回 status: "stopping" 表示**还没确认停下**，不要当成已停；它已经不会再自动推进，',
    '  稍后再 stop 一次确认，或用 dispatch_task 取结果；',
    '- 停止成功返回 status: "paused"，当前这单按「未交付」结清；停止过程中已经说出的文本不是结论；',
    '- 只停本会话派出去的任务。不会杀后台进程或目标自己派出的子代理。',
    '',
    '## resume',
    '- 只恢复**暂停的原目标**：不重发任务正文、不新建目标，目标从原 objective 继续；',
    '- 返回 status: "resumed" 后，用 dispatch_task（不带 task）等它的结果；',
    '- 不能唤醒：已完成（complete）、已受阻（blocked）、用户手动停止的目标、',
    '  不是任务分派创建的目标。用户手停的目标要先问用户。',
    '',
    '## 参数',
    '- `targets` 必填，用下面的序号、标题的一部分或会话 id 指定；可一次给多个。',
  ];
  if (roster.length === 0) {
    base.push('', '当前没有可控制的目标：这个会话还没有连委派箭头。');
    return base.join('\n');
  }
  base.push('', '## 当前可控制的目标');
  for (let index = 0; index < roster.length; index += 1) {
    const item = roster[index];
    const note = item.note === undefined || item.note === ''
      ? '（用户还没写说明）'
      : item.note;
    base.push((index + 1) + ') ' + item.label + ' —— ' + note);
  }
  return base.join('\n');
}

/**
 * 把控制结果压成一段模型可读的文本。
 *
 * @param value - `stopBatch()` / `resumeBatch()` 的返回值。
 * @returns 一段文本。
 */
function renderControl(value) {
  const head = '控制结果：' + value.status
    + (value.stillRunning > 0 ? '（还有 ' + String(value.stillRunning) + ' 个在做）' : '');
  const lines = [head];
  for (const item of value.results) {
    let flag = '失败';
    if (item.status === 'paused') flag = '已暂停，未交付';
    else if (item.status === 'stopping') flag = '尚未确认停止';
    else if (item.status === 'resumed') flag = '已唤醒';
    else if (item.status === 'running') flag = '已在运行';
    else if (item.status === 'complete') flag = '已完成，去取结果';
    else if (item.status === 'blocked') flag = '受阻';
    lines.push('', '—— ' + item.target + '：' + item.status + '（' + flag + '）');
    if (item.note !== '') lines.push(item.note);
  }
  if (value.note !== '') lines.push('', value.note);
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * 构造面向模型的 `control_task` 工具。
 *
 * @param service - 绑定表。
 * @param ownerId - 发起方会话 id。
 * @returns 可以直接交给 `ctx.tools.register()` 的工具定义。
 */
export function createControlTool(service, ownerId) {
  return {
    name: CONTROL_TOOL_NAME,
    /*
     * 与 dispatch/report 一样用 getter：DSH 每次组装提示词都会重新读描述，
     * 绑定表一变，下一次 step 就能看到新的目标名单，不需要重新注册工具。
     */
    get description() {
      return controlDescription(service, ownerId);
    },
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [ACTION_STOP, ACTION_RESUME],
          description: 'stop = 停止目标当前任务并暂停；resume = 唤醒暂停的原目标继续。',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_BATCH_TARGETS,
          description: '要控制哪些目标，每项可以是界面上的序号、完整标题、标题的一部分或会话 id。'
            + '一次最多 ' + MAX_BATCH_TARGETS + ' 个。',
        },
      },
      required: ['action', 'targets'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                target: { type: 'string' },
                status: { type: 'string' },
                deliverable: { type: 'boolean' },
                reply: { type: 'string' },
                progress: { type: 'string' },
                interruptedBy: { type: 'string' },
                note: { type: 'string' },
              },
              required: ['target', 'status', 'deliverable', 'reply', 'progress', 'interruptedBy', 'note'],
              additionalProperties: false,
            },
          },
          stillRunning: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['status', 'results', 'stillRunning', 'note'],
        additionalProperties: false,
      },
      render(_args, value) {
        return renderControl(value);
      },
    },
    async execute(args, exec) {
      const action = args?.action;
      if (action !== ACTION_STOP && action !== ACTION_RESUME) {
        throw new Error('action 必须是 "stop" 或 "resume"。');
      }
      const callerId = exec?.agent?.id;
      if (typeof callerId !== 'string' || callerId === '') {
        throw new Error('这个工具只能在会话里由模型调用。');
      }
      const bindings = service.bindings.get(callerId) ?? [];
      if (bindings.length === 0) {
        throw new Error(explainNoTarget(service, callerId, bindings));
      }
      const rawTargets = Array.isArray(args?.targets) ? args.targets : [];
      if (rawTargets.length === 0) {
        throw new Error('请用 targets 指明要' + (action === ACTION_STOP ? '停止' : '唤醒') + '哪个目标：\n'
          + describeCandidates(bindings));
      }
      const requested = pickTargets(bindings, rawTargets, action === ACTION_STOP ? '停止' : '唤醒');
      /*
       * 自指箭头在客户端图上就被拒绝了；这里再兜一层。停止自己会把发起调用的
       * 这一轮直接 cancel 掉，属于不可逆的意外，不能只靠前端校验。
       */
      if (requested.some((item) => item.id === callerId)) {
        throw new Error('不能控制发起这次调用的会话自己：请换一个目标。');
      }
      if (requested.length > MAX_BATCH_TARGETS) {
        throw new Error('一次最多控制 ' + MAX_BATCH_TARGETS + ' 个目标，请分几批。');
      }
      return action === ACTION_STOP
        ? stopBatch({
          ctx: service.ctx,
          service,
          ownerId: callerId,
          bindings: requested,
          signal: exec.signal,
          timeoutMs: service.stopTimeoutMs ?? STOP_TIMEOUT_MS,
        })
        : resumeBatch({
          ctx: service.ctx,
          service,
          ownerId: callerId,
          bindings: requested,
          signal: exec.signal,
        });
    },
  };
}
