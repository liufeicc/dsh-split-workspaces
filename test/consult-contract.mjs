/**
 * `consult_task` 的契约测试。
 *
 * 重点不是「回答得对不对」，而是这几条不能退化的边界：
 *   - 真的投递进目标会话（`prompt`），而不是旁注请求；
 *   - 不创建 goal、不写 pending / reviews；
 *   - 目标忙时跳过，不排队、不污染它正在做的事；
 *   - 多目标并行，一个忙/失败不影响其他目标；
 *   - 超时/用户停止/取消都如实返回，不把半截回答冒充结论；
 *   - `report_task` / `dispatch_task` 的描述把「咨询」指向 consult_task。
 *
 * 跑法：`node test/consult-contract.mjs`
 */

import {
  assistantEvent,
  boot,
  check,
  fakeMultiGoals,
  report,
  settle,
  turnEndEvent,
  userEvent,
} from './dispatch-harness.mjs';

const host = await import('../index.js');
const OWNER = 's-a';

/**
 * 布景：一个发起方、两个可咨询目标。
 *
 * @param options - `{ agents, promptThrows, promptThrowsAt, goals }`
 * @returns 布景
 */
function setup(options = {}) {
  const agents = options.agents ?? new Map();
  const goals = options.goals ?? fakeMultiGoals();
  const harness = boot({
    agents,
    goals,
    promptThrows: options.promptThrows === true,
    promptThrowsAt: options.promptThrowsAt ?? null,
  });
  const service = harness.ctx.get('paneDispatch');
  // refresh() 是从 agents 表里取 agent 的；把发起方补进去才会注册作用域工具。
  agents.set(OWNER, { id: OWNER, ctx: { tools: harness.ctx.tools } });
  service.set({
    owner: OWNER,
    ownerLabel: '发起方',
    targets: [
      { id: 's-b', label: '技术专家', note: '二进制与逆向，需要查底层实现时问它' },
      { id: 's-c', label: '前端专家', note: 'Web UI 与交互' },
    ],
  });
  const consultTool = harness.registered.find((definition) => definition.name === host.CONSULT_TOOL_NAME);
  return { ...harness, service, goals, consultTool };
}

/**
 * 调一次 consult_task。
 * @param context - setup 的返回值
 * @param args - 工具参数
 * @param signal - 取消信号
 * @returns 工具结果
 */
function call(context, args, signal = new AbortController().signal) {
  return context.consultTool.execute(args, { agent: { id: OWNER }, signal });
}

// ────────────────────────── 纯函数与描述 ──────────────────────────

check('工具名就是 consult_task', host.CONSULT_TOOL_NAME === 'consult_task');
check('咨询包装点明「来自另一个会话」和「这是咨询不是派活」', (() => {
  const text = host.wrapConsult('MMC5 的寄存器映射在哪？', 'A 会话');
  return text.includes('A 会话')
    && text.includes('MMC5 的寄存器映射在哪？')
    && text.includes('[任务分派 · 咨询]')
    && text.includes('这是咨询，不是派活');
})());
check('咨询包装允许读文件/改文件，但要求说明改了什么', (() => {
  const text = host.wrapConsult('查一下', 'A 会话');
  return text.includes('读文件') && text.includes('修改文件') && text.includes('为什么改');
})());
check('咨询包装要求给依据、不许反问', (() => {
  const text = host.wrapConsult('查一下', '');
  return text.includes('另一个会话') && text.includes('依据') && text.includes('不要反问');
})());

{
  const context = setup();
  check('consult_task 已注册', context.consultTool !== undefined);
  check('描述给出咨询对象判定规则',
    context.consultTool.description.includes('以下是全部连接线')
    && context.consultTool.description.includes('专家')
    && context.consultTool.description.includes('顾问')
    && context.consultTool.description.includes('连接线'),
    context.consultTool.description);
  check('描述强调没有明确信息不能咨询',
    context.consultTool.description.includes('一定不能去咨询'),
    context.consultTool.description);
  check('描述列出判定依据（标题 + 连接线描述）',
    context.consultTool.description.includes('1) 技术专家 —— 二进制与逆向'),
    context.consultTool.description);
  check('描述写明最多 8 个目标', context.consultTool.description.includes('最多 8 个'));
  check('描述明确「不创建 goal、不进入待审核」',
    context.consultTool.description.includes('不创建 goal')
    && context.consultTool.description.includes('不进入待审核'));
  check('描述把「派活」指向 dispatch_task', context.consultTool.description.includes('dispatch_task'));
  check('描述把「审阅历史」指向 report_task', context.consultTool.description.includes('report_task'));
}

{
  const context = setup();
  const service = context.service;
  check('dispatch_task 的描述把「只问问题」指向 consult_task',
    host.dispatchDescription(service, OWNER).includes('consult_task'));
  check('report_task 的描述把「查文件回答」指向 consult_task',
    host.reportDescription(service, OWNER).includes('consult_task'));
}

// ────────────────────────── 真投递与回答 ──────────────────────────

{
  const context = setup();
  const promise = call(context, {
    targets: ['技术专家'],
    question: 'MMC5 的寄存器映射在哪？请给出文件与行号。',
  });
  await settle();

  check('真的投递了一条消息（不是旁注请求）', context.promptCalls.length === 1);
  const request = context.promptCalls[0].request;
  check('投递到指定目标的会话', request.sessionId === 's-b', request.sessionId);
  check('投递内容是包装后的咨询',
    request.content[0].text.includes('[任务分派 · 咨询]')
    && request.content[0].text.includes('MMC5 的寄存器映射在哪？'),
    request.content[0].text);
  check('咨询不创建 goal', context.goals.created.length === 0, JSON.stringify(context.goals.created));

  const rpcId = request.requestId;
  context.emit('s-b', userEvent(1, rpcId));
  context.emit('s-b', assistantEvent(2, '在 0x401000 的映射表里，见 src/mapper.ts:42。'));
  context.emit('s-b', turnEndEvent(3, 'completed'));
  const value = await promise;

  check('返回 ok 与目标的回答',
    value.status === 'ok'
    && value.results[0].status === 'ok'
    && value.results[0].reply.includes('0x401000'),
    JSON.stringify(value));
  check('咨询不写 pending', context.service.pending.size === 0);
  check('咨询不写 reviews', context.service.reviews.size === 0);
}

// ────────────────────────── 忙目标跳过 ──────────────────────────

{
  const agents = new Map([['s-b', { status: 'running' }]]);
  const context = setup({ agents });
  const value = await call(context, { targets: ['技术专家'], question: '在吗？' });

  check('目标正在跑回合时标成 busy 并跳过',
    value.status === 'busy' && value.results[0].status === 'busy',
    JSON.stringify(value));
  check('忙目标一条消息都没投出去', context.promptCalls.length === 0);
  check('结果里说明「跳过」', value.results[0].note.includes('跳过'), value.results[0].note);
}

{
  const agents = new Map([['s-c', { status: 'running' }]]);
  const context = setup({ agents });
  const promise = call(context, {
    targets: ['技术专家', '前端专家'],
    question: '这个改动会影响哪些模块？',
  });
  await settle();

  check('多目标时只给空闲目标投递',
    context.promptCalls.length === 1 && context.promptCalls[0].request.sessionId === 's-b',
    JSON.stringify(context.promptCalls.map((item) => item.request.sessionId)));
  const rpcId = context.promptCalls[0].request.requestId;
  context.emit('s-b', userEvent(1, rpcId));
  context.emit('s-b', assistantEvent(2, '影响 mapper 与 renderer。'));
  context.emit('s-b', turnEndEvent(3, 'completed'));
  const value = await promise;

  check('空闲目标正常回答、忙目标保持 busy',
    value.results[0].status === 'ok' && value.results[1].status === 'busy',
    JSON.stringify(value.results));
  check('整批状态是 partial', value.status === 'partial', value.status);
  check('整批 note 汇总了跳过数量', value.note.includes('1 个目标正忙'), value.note);
}

// ────────────────────────── 超时、用户停止、取消 ──────────────────────────

{
  const context = setup();
  context.service.consultTimeoutMs = 20;
  const promise = call(context, { targets: ['技术专家'], question: '要跑很久吗？' });
  await settle();
  const rpcId = context.promptCalls[0].request.requestId;
  context.emit('s-b', userEvent(1, rpcId));
  context.emit('s-b', assistantEvent(2, '已经查到一半。'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const value = await promise;

  check('超时返回 timeout，而不是把半截回答当结论',
    value.results[0].status === 'timeout' && value.results[0].reply === '',
    JSON.stringify(value.results[0]));
  check('超时时已收到的内容进 progress',
    value.results[0].progress.includes('已经查到一半'), value.results[0].progress);
  check('超时 note 说明内容可能不完整', value.results[0].note.includes('不完整'), value.results[0].note);
}

{
  const context = setup();
  const promise = call(context, { targets: ['技术专家'], question: '在吗？' });
  await settle();
  const rpcId = context.promptCalls[0].request.requestId;
  context.emit('s-b', userEvent(1, rpcId));
  context.emit('s-b', assistantEvent(2, '说到一半'));
  context.emit('s-b', turnEndEvent(3, 'aborted', { kind: 'user' }));
  const value = await promise;

  check('用户停止时状态是 interrupted',
    value.results[0].status === 'interrupted', JSON.stringify(value.results[0]));
  check('用户停止时半截文本进 progress，不进 reply',
    value.results[0].reply === '' && value.results[0].progress.includes('说到一半'),
    JSON.stringify(value.results[0]));
}

{
  const context = setup();
  const controller = new AbortController();
  const promise = call(context, { targets: ['技术专家'], question: '在吗？' }, controller.signal);
  await settle();
  controller.abort();
  const value = await promise;

  check('调用方取消时状态是 cancelled',
    value.results[0].status === 'cancelled', JSON.stringify(value.results[0]));
}

// ────────────────────────── 拒绝路径 ──────────────────────────

{
  const context = setup();
  let message = null;
  try {
    await call(context, { targets: ['技术专家'], question: '   ' });
  } catch (error) {
    message = error.message;
  }
  check('空问题被拒绝，并说明该怎么写', typeof message === 'string' && message.includes('question'), message);
}

{
  const context = setup();
  let message = null;
  try {
    await call(context, { targets: [], question: '在吗？' });
  } catch (error) {
    message = error.message;
  }
  check('没给 targets 时列出候选', typeof message === 'string' && message.includes('技术专家'), message);
}

{
  const context = setup();
  let message = null;
  try {
    await call(context, { targets: ['不存在的目标'], question: '在吗？' });
  } catch (error) {
    message = error.message;
  }
  check('认不出的目标整批拒绝并列出候选', typeof message === 'string' && message.includes('技术专家'), message);
}

{
  /*
   * 没有箭头时，作用域工具根本不会被注册（index.js 只在有绑定时挂）。
   * 这里直接构造工具，验证「误调到时」的拒绝文案仍然成立。
   */
  const { ctx } = boot();
  const consultTool = host.createConsultTool(ctx.get('paneDispatch'), OWNER);
  let message = null;
  try {
    await consultTool.execute(
      { targets: ['技术专家'], question: '在吗？' },
      { agent: { id: OWNER }, signal: new AbortController().signal },
    );
  } catch (error) {
    message = error.message;
  }
  check('没有箭头时明确说没有可咨询目标', typeof message === 'string' && message.includes('箭头'), message);
}

{
  const context = setup({ promptThrows: true });
  const value = await call(context, { targets: ['技术专家'], question: '在吗？' });
  check('投递失败时结果里如实说明', value.results[0].status === 'error'
    && value.results[0].note.includes('投递咨询失败'), JSON.stringify(value.results[0]));
}

report();