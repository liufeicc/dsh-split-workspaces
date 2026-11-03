/**
 * 多工作区平铺 —— 分派链路上的纯函数。
 *
 * 这里的函数不碰宿主、不发事件、不读磁盘：给什么算什么。因此它们可以在 Node 里
 * 直接喂断言，也是 `test/dispatch-contract.mjs` 覆盖最多的一块。
 *
 * @module @local/dsh-split-workspaces/host-message
 */

import { randomUUID } from 'node:crypto';

/**
 * 把任意抛出物转成一句能放进错误里的文字。
 * @param reason - 捕获到的异常。
 * @returns 字符串。
 */
export function errorText(reason) {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * 从一条助手消息里取出纯文本。
 *
 * 只拼 `type: 'text'` 的块：图片、工具调用块对「回传给分派方」没有意义，混进去只会
 * 让 A 的模型读到一堆 JSON。
 *
 * @param data - `assistant/message` 事件的数据。
 * @returns 拼好的文本；没有文本块时返回空字符串。
 */
export function assistantText(data) {
  const content = data?.message?.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.trim() === '') continue;
    parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * 把模型给出的任务正文包装成一条**自解释**的用户消息。
 *
 * 三个必须写进去的信息：
 *   1. 这条消息来自另一个会话（不然目标模型会以为用户在跟它说话，然后反问「你说的
 *      B 是谁」）；
 *   2. 直接做、别反问（反问会让「一轮结束」被当成任务完成，把问题当成结论回传）；
 *   3. 结束时给一段结论（这段结论就是回给分派方的东西）。
 *
 * @param task - 模型给出的任务正文。
 * @param sourceLabel - 发起方会话的显示名。
 * @returns 完整的用户消息文本。
 */
export function wrapTask(task, sourceLabel) {
  const from = sourceLabel === undefined || sourceLabel === null || sourceLabel === ''
    ? '另一个会话'
    : '会话「' + sourceLabel + '」';
  return [
    '[任务分派]',
    '这条任务由' + from + '通过平铺面板的委派箭头派给你，不是当前用户输入的。',
    '',
    task,
    '',
    '—— 请直接执行上面的任务。如果需要澄清，按最合理的假设继续做，不要停下来反问；',
    '完成后用一段话给出结论，这段结论会回传给派单的会话。',
  ].join('\n');
}

/**
 * 在绑定集合里找出这一次要派给谁。
 *
 * 匹配顺序是「先精确、后宽松」，每一步只在**唯一命中**时接受：
 *   1. 空值：只有一个绑定时直接用它；多个绑定返回 `null` 让调用方报错列候选；
 *   2. 精确的 label（界面上的显示名）或会话 id；
 *   3. 纯数字：按界面上勾选的顺序取第 n 个（从 1 开始）；
 *   4. label 的唯一子串。
 *
 * 为什么宽到「子串」：模型看到的是候选列表里的完整标题（形如「修复登录 / my-app」），
 * 它复述时经常只带其中一半；要求逐字相同会让它反复失败。
 *
 * @param bindings - 绑定数组。
 * @param raw - 模型给的 target 参数（可能是 undefined）。
 * @returns 命中的绑定，或 `null`（调用方负责报错）。
 */
export function matchBinding(bindings, raw) {
  if (!Array.isArray(bindings) || bindings.length === 0) return null;
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (text === '') return bindings.length === 1 ? bindings[0] : null;
  const exact = bindings.filter((item) => item.label === text || item.id === text);
  if (exact.length === 1) return exact[0];
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    if (index >= 0 && index < bindings.length) return bindings[index];
  }
  const partial = bindings.filter((item) => item.label.includes(text));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * 候选列表的展示文本（错误信息与工具结果共用）。
 * @param bindings - 绑定数组。
 * @returns 形如 `1) 标题` 的若干行；没有绑定时给一句说明。
 */
export function describeCandidates(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) return '当前没有绑定任何可派发的会话。';
  return bindings.map((item, index) => (index + 1) + ') ' + item.label).join('\n');
}

/**
 * 造一条「提醒」消息，用来在 A 收尾前把它拉回来。
 *
 * 为什么不用普通的 `prompt()` 投递：那会像用户说话一样插进 A 的对话；这里的语义是
 * 「系统提示你还有事没做完」，所以给一个独立的 `source.kind`，界面上与真人输入区分得开。
 *
 * `inject()` 不唤醒驱动，只在下一个 step 边界被认领 —— 而 `agent/turn-stopping`
 * 之后循环会重新检查一次 inbox，所以这条消息能让「本来要结束的回合」继续走一步。
 *
 * @param text - 提醒正文。
 * @param summary - 给界面用的一句话摘要。
 * @returns 冻结的消息对象（形状与 harness 的 createUserMessage 一致）。
 */
export function noticeMessage(text, summary) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'pane-dispatch', form: 'notice', summary }),
  });
}
