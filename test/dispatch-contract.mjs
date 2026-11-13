/**
 * 「任务分派」Host 半边的离线契约测试（单目标、投递与等待、拒绝路径）。
 *
 * 跑法：`node test/dispatch-contract.mjs`
 */
import {
  assistantEvent, boot, check, fakeGoals, freshHome, host, report, settle, turnEndEvent, userEvent,
} from './dispatch-harness.mjs';

// ────────────────────────────── 纯函数 ──────────────────────────────

check('工具名就是 dispatch_task', host.TOOL_NAME === 'dispatch_task');
check('任务包装点明了「来自另一个会话」和「别反问」', (() => {
  const text = host.wrapTask('把日志清理一下', 'A 会话');
  return text.includes('A 会话') && text.includes('把日志清理一下') && text.includes('不要停下来反问');
})());
check('发起方没有名字时不会写出空引号', host.wrapTask('做事', '').includes('另一个会话'));
check('任务包装要求对方给证据，而不是只说「已完成」', (() => {
  const text = host.wrapTask('做事', 'A 会话');
  return text.includes('证据') && text.includes('不要宣布完成') && text.includes('不算完成');
})());
check('任务包装要求结论可复现', host.wrapTask('做事', 'A 会话').includes('能复现'));

{
  /*
   * 「B 偷懒」的根子是：完成与否由 B 自评，且没有任何证据要求。
   * 这两段提示词是唯一的抓手，用断言钉住，免得以后被顺手删掉。
   */
  const description = host.dispatchDescription({ bindings: new Map() }, undefined);
  check('工具描述要求把验收标准写成可检验的条款', description.includes('可检验'), '');
  check('工具描述要求拿到结论后先复核再转述', description.includes('拿到结论之后'), '');
  check('工具描述要求不达标时按具体缺口重派', description.includes('具体缺口'), '');
}

check('从助手消息里只取文本块', host.assistantText({
  message: { content: [{ type: 'text', text: '结论' }, { type: 'image', data: 'x' }, { type: 'text', text: '   ' }] },
}) === '结论');
check('没有文本块时返回空串而不是 undefined', host.assistantText({ message: { content: [] } }) === '');
/*
 * Typert 网关按**宿主方法的签名**校验调用参数名。
 *
 * 真机上踩过：客户端描述符里声明了 `request` 参数、实际也发 `{ request: {} }`，
 * 而宿主 `list()` 没有形参，于是每次读取都报
 *   args fields do not match the descriptor: unexpected "request"
 * 结果就是「箭头能存下来、却永远读不回去」—— 刷新或重启后看着像丢了。
 * `set` 一直正常，正是因为它有 `request` 形参。
 */
check('远程方法都带 request 形参（否则网关会拒绝客户端发来的 args）',
  host.PaneDispatchService.prototype.list.length === 1
  && host.PaneDispatchService.prototype.set.length === 1,
  'list=' + String(host.PaneDispatchService.prototype.list.length)
  + ' set=' + String(host.PaneDispatchService.prototype.set.length));

/*
 * 工具描述必须是「每次读取都反映最新绑定」的 getter。
 *
 * 用户新增一条箭头后，如果描述还是注册那一刻算好的字符串，主会话的模型下一轮
 * 只会说得出旧目标 —— 之前必须刷新页面才认识新连接。dsh-tools 每次组装提示词
 * 都会重新读 `definition.description`，所以 getter 能在下一次 step 看到新名单。
 */
check('工具描述是动态 getter：新增目标后同一个工具对象立即反映出来', (() => {
  freshHome();
  const service = new host.PaneDispatchService({});
  const tool = host.createDispatchTool(service, 's-a');
  service.set({ owner: 's-a', targets: [{ id: 's-b', label: 'B 会话' }] });
  const before = tool.description;
  service.set({ owner: 's-a', targets: [{ id: 's-b', label: 'B 会话' }, { id: 's-c', label: 'C 会话' }] });
  return before.includes('B 会话')
    && !before.includes('C 会话')
    && tool.description.includes('C 会话');
})());
check('没有绑定时描述明确说「还没有连箭头」', (() => {
  freshHome();
  const service = new host.PaneDispatchService({});
  const tool = host.createDispatchTool(service, 's-a');
  return tool.description.includes('还没有连任何委派箭头');
})());

check('绑定表去掉重复、自派与空 id', (() => {
  freshHome();
  const service = new host.PaneDispatchService({});
  service.set({ owner: 's-a', targets: [{ id: 's-b' }, { id: 's-b' }, { id: 's-a' }, { id: '' }] });
  const items = service.list().targets[0].items;
  return items.length === 1 && items[0].id === 's-b';
})());
check('清空目标等于解除绑定', (() => {
  freshHome();
  const service = new host.PaneDispatchService({});
  service.set({ owner: 's-a', targets: [{ id: 's-b' }] });
  service.set({ owner: 's-a', targets: [] });
  return service.list().targets.length === 0;
})());

// ────────────────────── 落盘与读回 ──────────────────────

/*
 * 这是「刷新页面 / 重启 Host 之后箭头还在」的底层保证。
 * 服务构造时会读一遍，所以新实例能看见上一个实例写下的绑定。
 */
{
  freshHome();
  const first = new host.PaneDispatchService({});
  const written = first.set({
    owner: 's-a',
    ownerLabel: '甲会话',
    targets: [{ id: 's-b', label: 'B 会话', note: '专做二进制逆向，需要分析 EXE 时派给它' }],
  });
  check('写入时同时落盘', written.saved === true);
  const second = new host.PaneDispatchService({});
  const restored = second.list().targets;
  check('新实例能把绑定表读回来（重启 Host 不丢箭头）',
    restored.length === 1 && restored[0].owner === 's-a' && restored[0].items[0].id === 's-b', JSON.stringify(restored));
  check('读回来的还有派出方显示名', restored[0].ownerLabel === '甲会话', JSON.stringify(restored[0]));
  /*
   * 说明必须活着穿过「落盘 → 读盘 → 装表 → list」这四道手。
   * 真机上踩过：装表那一步只取了 id 和 label，于是箭头回来了、线上的说明没了，
   * 而且下一次落盘会把说明永久抹掉。
   */
  check('说明也要穿过整个读写链路回到客户端',
    restored[0].items[0].note === '专做二进制逆向，需要分析 EXE 时派给它',
    JSON.stringify(restored[0].items[0]));
  second.set({ owner: 's-a', targets: [] });
  check('清空后会从盘里消失', new host.PaneDispatchService({}).list().targets.length === 0);
}

// ────────────────────── 工具：正常一次完整派单 ──────────────────────

{
  const { tool, promptCalls, emit, ctx } = boot();
  const service = ctx.get('paneDispatch');
  service.set({ owner: 's-a', targets: [{ id: 's-b', label: 'B 会话' }] });

  const controller = new AbortController();
  const running = tool.execute({ task: '把 build 目录清一下' }, { agent: { id: 's-a' }, signal: controller.signal });
  await settle();

  check('投递把包装好的任务发给了目标会话', (() => {
    const call = promptCalls[0];
    return call !== undefined
      && call.request.sessionId === 's-b'
      && call.request.content[0].text.includes('把 build 目录清一下');
  })());
  check('投递的第二个参数是 AbortSignal（当初那个 bug 就出在这里）', (() => {
    const call = promptCalls[0];
    return call !== undefined && typeof call.signal?.throwIfAborted === 'function';
  })());
  check('requestId 由宿主生成并写进请求（认领消息要靠它）',
    typeof promptCalls[0].request.requestId === 'string' && promptCalls[0].request.requestId !== '');

  const requestId = promptCalls[0].request.requestId;
  // 认领之前先来一条别人那一轮的回复：它必须被忽略。
  emit('s-b', assistantEvent(5, '这是上一轮的旧结论'));
  emit('s-b', userEvent(10, requestId));
  emit('s-b', assistantEvent(11, '已经清完了，删了 42 个文件'));
  emit('s-b', turnEndEvent(12, 'completed'));

  const value = await running;
  check('目标那一轮结束后工具返回它的回复', value.results[0].reply === '已经清完了，删了 42 个文件', JSON.stringify(value));
  check('不会误取目标会话上一轮的回复', !value.results[0].reply.includes('旧结论'));
  check('返回里带着目标显示名与结束状态',
    value.results[0].target === 'B 会话' && value.results[0].status === 'completed');
  check('工具的渲染结果里有目标与结论', (() => {
    const blocks = tool.output.render({}, value);
    return blocks[0].type === 'text' && blocks[0].text.includes('B 会话') && blocks[0].text.includes('42 个文件');
  })());
}

{
  /*
   * 真机踩过：派单消息里写的是「会话 session-xxxx 派给你」—— 一串 id 对目标模型
   * 毫无信息量。发起方的**显示名**要随绑定同步上来，并写进那句话。
   */
  const { tool, promptCalls, emit, ctx } = boot();
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲会话', targets: [{ id: 's-b', label: 'B' }] });
  const running = tool.execute({ task: '做事' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  await settle();
  const text = promptCalls[0]?.request.content[0].text ?? '';
  check('派单消息里写的是发起方的显示名，而不是会话 id', text.includes('甲会话') && !text.includes('s-a'), text.slice(0, 80));
  emit('s-b', userEvent(1, promptCalls[0].request.requestId));
  emit('s-b', turnEndEvent(2, 'completed'));
  await running;
}

// ────────────────────────── 5 分钟一段：不超时、报进度 ──────────────────────────

/*
 * 真机问题：任务做了 20 分钟还在跑，派单方却报超时失败。
 * 现在每次调用最多等 5 分钟，到点带着进度返回 running，模型再调一次接着等。
 * 测试把一段压到 30 毫秒。
 */
{
  const agents = new Map();
  const goals = fakeGoals();
  const { tool, ctx, emit } = boot({ agents, goals });
  const service = ctx.get('paneDispatch');
  service.sliceMs = 30;
  service.set({ owner: 's-a', ownerLabel: '主会话', targets: [{ id: 's-b', label: '逆向会话' }] });

  const first = tool.execute({ task: '把整份规格跑完' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  await settle();
  emit('s-b', assistantEvent(1, '已经拆到第三个结构'));
  /*
   * 这里的定时器是 `unref` 过的（生产里避免吊住进程），所以测试要自己撑住事件循环 ——
   * 否则 Node 会认为"没事可做"直接退出，await 永远不落定。
   */
  await new Promise((resolve) => setTimeout(resolve, 80));
  const firstValue = await first;

  check('到一段的尽头还没做完时，状态是 running 而不是超时失败', firstValue.status === 'running', JSON.stringify(firstValue));
  check('running 时的文本进的是「过程稿」，不是结论 reply',
    firstValue.results[0].reply === '' && firstValue.results[0].progress.includes('已经拆到第三个结构'),
    JSON.stringify(firstValue.results[0]));
  check('过程稿明确标注「可能被推翻」，并标成未交付',
    firstValue.results[0].progress.includes('过程稿') && firstValue.results[0].deliverable === false,
    JSON.stringify(firstValue.results[0]));
  check('note 告诉模型接着等怎么做', firstValue.note.includes('接着等') && firstValue.note.includes('省略 task'), firstValue.note);

  /*
   * 续等：目标会话此刻当然是忙的 —— 如果续等还查「对方忙不忙」，这条路就永远走不通。
   */
  agents.set('s-b', { status: 'running' });
  // 第二段拉长到 5 秒：这一段由我们手动推进终态，不该被切片定时器抢先。
  service.sliceMs = 5000;
  const second = tool.execute({}, { agent: { id: 's-a' }, signal: new AbortController().signal });
  await settle();
  check('续等不会因为「对方正忙」被拒', true);
  check('续等不会重复创建目标', goals.created.length === 1, String(goals.created.length));

  emit('s-b', assistantEvent(2, '全部跑完了，结论在 spec.md'));
  goals.done('complete');
  emit('s-b', assistantEvent(3, '完成：新增三节规格'));
  const secondValue = await second;
  check('接着等到了终态就返回完整结论',
    secondValue.status === 'complete' && secondValue.results[0].reply === '完成：新增三节规格', JSON.stringify(secondValue));
  check('终态之后 note 是空的（不再让人等）', secondValue.note === '');

  // 终态之后 pending 被清掉，下次调用回到「新派一单」
  check('终态后清理了进行中的派单记录', service.pending.size === 0);
}

// ────────────────────────── 以「目标」模式投递 ──────────────────────────


{
  const goals = fakeGoals();
  const { tool, ctx, emit, resolveCalls } = boot({ goals });
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲会话', targets: [{ id: 's-b', label: 'B 会话' }] });

  const running = tool.execute({ task: '把 build 目录清一下' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  await settle();

  check('投递前先唤醒目标会话（冷会话也能派）', resolveCalls[0] === 's-b', JSON.stringify(resolveCalls));
  check('任务是以「目标」的形式创建的，不是普通消息', goals.created.length === 1 && typeof goals.created[0].objective === 'string');
  check('目标里写着任务正文与发起方显示名', (() => {
    const objective = goals.created[0].objective;
    return objective.includes('把 build 目录清一下') && objective.includes('甲会话');
  })());

  emit('s-b', assistantEvent(10, '清了一部分，还剩 dist'));
  goals.done('complete');
  emit('s-b', assistantEvent(11, '已经清完了，删了 42 个文件'));
  const value = await running;
  check('目标达成后工具返回 complete 与最后一轮结论',
    value.status === 'complete' && value.results[0].reply === '已经清完了，删了 42 个文件', JSON.stringify(value));
  check('不会把中途那一轮的半成品当成结论', !value.results[0].reply.includes('还剩 dist'));
}

{
  const goals = fakeGoals();
  const { tool, ctx, emit } = boot({ goals });
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: 'B' }] });
  const running = tool.execute({ task: '做事' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  await settle();
  emit('s-b', assistantEvent(1, '卡在权限上'));
  goals.done('blocked', '连续三轮卡在同一个权限问题上');
  emit('s-b', { type: 'goal/change', seq: 2, time: 3, data: {} });
  const value = await running;
  check('目标卡住时，它自己的状态是 blocked', value.results[0].status === 'blocked', JSON.stringify(value));
  check('整批状态是 partial（有结论，但不算做成）', value.status === 'partial', JSON.stringify(value));
  check('卡住原因会附在结论里', value.results[0].reply.includes('连续三轮卡在同一个权限问题上'), value.results[0].reply);
}

{
  const goals = fakeGoals({ failCreate: true });
  const { tool, ctx } = boot({ goals });
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: 'B' }] });
  let message = null;
  try {
    await tool.execute({ task: '做事' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    message = error.message;
  }
  check('对方已有未结束目标时，明确让人先去处理它',
    typeof message === 'string' && message.includes('没法替换') && message.includes('B'), message);
}

// ────────────────────────── 四条拒绝路径 ──────────────────────────

{
  const { tool } = boot();
  let message = null;
  try {
    await tool.execute({ task: '做事' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    message = error.message;
  }
  check('一条同步都没收到时，先怀疑界面那半边没接上（而不是让用户白找箭头）',
    typeof message === 'string' && message.includes('一次都还没收到过界面的绑定同步'), message);
}

{
  /*
   * 真机踩过的第二种病因：界面同步没问题，但箭头画给了**别的会话**。
   * 这时必须点名现有的派出方，否则用户会一直在「我明明画了」里打转。
   */
  const { tool, ctx } = boot();
  ctx.get('paneDispatch').set({ owner: 's-other', ownerLabel: '别的会话', targets: [{ id: 's-b', label: 'rea' }] });
  let message = null;
  try {
    await tool.execute({ task: '做事' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    message = error.message;
  }
  check('同步过、但不是你自己 → 把现有关系按「派出方 → 目标」的正确方向列出来',
    typeof message === 'string' && message.includes('「别的会话」→「rea」'), message);
  check('并且提醒核对「发起调用的会话是不是箭头起点那张卡片」',
    typeof message === 'string' && message.includes('起点'), message);
}

{
  const { tool, ctx } = boot();
  ctx.get('paneDispatch').set({ owner: 's-a', targets: [{ id: 's-b', label: 'B' }, { id: 's-c', label: 'C' }] });
  let message = null;
  try {
    await tool.execute({ task: '做事' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    message = error.message;
  }
  check('绑定了多个目标却没说派给谁时，列出候选让人选',
    typeof message === 'string' && message.includes('B') && message.includes('C'), message);
}

{
  const agents = new Map([['s-b', { status: 'running' }]]);
  const { tool, promptCalls, ctx } = boot({ agents });
  ctx.get('paneDispatch').set({ owner: 's-a', targets: [{ id: 's-b', label: 'B' }] });
  let message = null;
  try {
    await tool.execute({ task: '做事' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    message = error.message;
  }
  check('目标正在跑回合时直接拒绝，不排队', typeof message === 'string' && message.includes('正在跑'), message);
  check('被拒绝时一条消息都没投出去', promptCalls.length === 0);
}

{
  const { tool, ctx } = boot({ promptThrows: true });
  ctx.get('paneDispatch').set({ owner: 's-a', targets: [{ id: 's-b', label: 'B' }] });
  let message = null;
  try {
    await tool.execute({ task: '做事' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    message = error.message;
  }
  check('投递本身失败时如实说明是投递失败', typeof message === 'string' && message.includes('投递'), message);
}

{
  const { tool, ctx } = boot();
  ctx.get('paneDispatch').set({ owner: 's-a', targets: [{ id: 's-b', label: 'B' }] });
  let message = null;
  try {
    await tool.execute({ task: '   ' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    message = error.message;
  }
  check('空任务正文被拒绝', typeof message === 'string' && message.includes('必须给出 task'), message);
}

// ────────────────────── 取消与按序号/标题匹配 ──────────────────────

{
  const { tool, promptCalls, ctx } = boot();
  ctx.get('paneDispatch').set({ owner: 's-a', targets: [{ id: 's-b', label: '修登录 / web' }, { id: 's-c', label: '跑测试 / web' }] });

  const controller = new AbortController();
  const running = tool.execute({ task: '做事', targets: ['2'] }, { agent: { id: 's-a' }, signal: controller.signal });
  await settle();
  check('绑定多个目标时可以用界面上的序号指定', promptCalls[0]?.request.sessionId === 's-c');
  controller.abort();
  const value = await running;
  check('调用方取消后等待立刻结束，状态记为 cancelled', value.status === 'cancelled');
}

{
  const { tool, promptCalls, ctx } = boot();
  ctx.get('paneDispatch').set({ owner: 's-a', targets: [{ id: 's-b', label: '修登录 / web' }, { id: 's-c', label: '跑测试 / web' }] });
  // 这一条只关心「投给了谁」，所以投完就取消，别让等待挂在那里。
  const controller = new AbortController();
  const running = tool.execute({ task: '做事', targets: ['跑测试'] }, { agent: { id: 's-a' }, signal: controller.signal });
  await settle();
  check('也可以用标题的一部分指定（模型复述标题时不会逐字照抄）', promptCalls[0]?.request.sessionId === 's-c');
  controller.abort();
  await running;
}


report();
