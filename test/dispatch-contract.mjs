/**
 * 「任务分派」Host 半边的离线契约测试。
 *
 * 覆盖浏览器看不见的那一半：`dispatch_task` 真的被注册、真的用**正确的参数**调了会话
 * 服务、真的能等到目标那一轮结束并取回回复，以及各条拒绝路径各自说了什么。
 *
 * 为什么这一层必须单独测：`signal.throwIfAborted is not a function` 这个 bug 就是从这里
 * 漏出去的 —— 客户端与纯模型的测试全绿，可工具一调就炸，因为
 * `SessionController.prompt(request, signal)` 的第二个参数要的是 **AbortSignal**，
 * 而当时传的是消息来源对象。下面那条「第二个参数是 AbortSignal」的断言就是为它写的。
 *
 * 跑法：`node test/dispatch-contract.mjs`
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * **必须在 import 之前把 DSH_HOME 指到临时目录。**
 *
 * Host 半边现在会把绑定表落到 `$DSH_HOME/storages/pane_dispatch_bindings.json`，并在
 * 构造时读回来。测试如果跑在真实 DSH_HOME 上，就会吃到这台机器上线上配置的绑定 ——
 * 于是「没有绑定应该报错」这类断言会因为「碰巧有别人的绑定」而变得时灵时不灵。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-dispatch-test-'));

const host = await import('../index.js');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log('ok   ' + label);
    return;
  }
  failures.push(label);
  console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}
function report() {
  if (failures.length > 0) {
    console.error('\n' + String(failures.length) + ' check(s) failed');
    process.exitCode = 1;
    return;
  }
  console.log('\nall checks passed');
}

/** 让排队的 Promise 与它们的 then 链跑完。 */
async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 造一份宿主上下文替身。
 *
 * `sessionController.prompt(request, signal)` 刻意**照真实契约**实现：第二参数不是
 * AbortSignal 就直接抛 —— 让「传错参数」这件事在测试里同样炸掉，而不是被宽容放过。
 *
 * @param options.agents - `Map<sessionId, { status }>`，用于「目标是否空闲」的判定。
 * @param options.promptThrows - 让投递本身失败，用来检查失败路径的措辞。
 */
function createHostContext({ agents = new Map(), promptThrows = false, goals = null } = {}) {
  const listeners = new Set();
  const promptCalls = [];
  const resolveCalls = [];
  const registered = [];
  const services = new Map();

  services.set('agents', { get: (id) => agents.get(id) });
  if (goals !== null) services.set('goals', goals);
  services.set('sessionController', {
    /**
     * 唤醒目标的入口（真实实现会按预设与子代理归属策略恢复冷会话）。
     * 替身只需给出一个带 `session.id` 的 agent —— `waitForGoal` 靠它筛事件。
     */
    async resolveAgent(sessionId) {
      resolveCalls.push(sessionId);
      return { agent: { id: sessionId, session: { id: sessionId } } };
    },
    async prompt(request, signal) {
      promptCalls.push({ request, signal });
      if (signal === undefined || signal === null || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError('signal.throwIfAborted is not a function');
      }
      signal.throwIfAborted();
      if (promptThrows) throw new Error('目标会话拒绝接收');
      return { accepted: true };
    },
  });

  const ctx = {
    get: (key) => services.get(key),
    // `ctx.provide` 要真的落进服务表，测试才能像真实调用方那样 `ctx.get('paneDispatch')`。
    provide: (key, value) => services.set(key, value),
    logger: { info: () => {} },
    // 真实 Cordis 会立刻执行 effect 回调；替身照做，否则工具根本不会注册。
    effect: (fn) => {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    on: (event, handler) => {
      if (event !== 'session/event') return () => {};
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    tools: {
      register: (definition) => {
        registered.push(definition);
        return () => {
          const index = registered.indexOf(definition);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
  };

  /** 往 `session/event` 派一条事件（模拟真实会话追加事件）。 */
  const emit = (sessionId, event) => {
    const session = { id: sessionId };
    for (const listener of [...listeners]) listener(session, event);
  };

  return { ctx, promptCalls, resolveCalls, registered, emit, services };
}

/** 每个用例一个全新的 DSH_HOME —— 绑定表会落盘，共用一个目录会互相污染。 */
let homeSeq = 0;
function freshHome() {
  homeSeq += 1;
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-dispatch-' + String(homeSeq) + '-'));
}

/** 装好插件，返回工具、服务与派事件的入口。 */
function boot(options) {
  freshHome();
  const harness = createHostContext(options);
  host.apply(harness.ctx);
  const tool = harness.registered.find((definition) => definition.name === host.TOOL_NAME);
  return { ...harness, tool };
}

/** 我们自己投进去的那条用户消息。 */
const userEvent = (seq, rpcId) => ({
  type: 'user/message',
  seq,
  time: 1,
  data: { id: 'm-' + seq, role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId } },
  surfaceOp: 'append',
});

/** 助手回复。 */
const assistantEvent = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: 2,
  data: {
    turn: 1,
    step: 1,
    message: { id: 'a-' + seq, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
    stream: [],
  },
  surfaceOp: 'append',
});

/** 一轮结束。 */
const turnEndEvent = (seq, kind) => ({ type: 'turn/end', seq, time: 3, data: { turn: 1, reason: { kind } } });

// ────────────────────────────── 纯函数 ──────────────────────────────

check('工具名就是 dispatch_task', host.TOOL_NAME === 'dispatch_task');
check('任务包装点明了「来自另一个会话」和「别反问」', (() => {
  const text = host.wrapTask('把日志清理一下', 'A 会话');
  return text.includes('A 会话') && text.includes('把日志清理一下') && text.includes('不要停下来反问');
})());
check('发起方没有名字时不会写出空引号', host.wrapTask('做事', '').includes('另一个会话'));
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
  check('返回里带着目前的进度', firstValue.results[0].reply.includes('已经拆到第三个结构'), JSON.stringify(firstValue));
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

/** 造一个目标服务替身：记录创建请求，phase 由用例直接改。 */
function fakeGoals({ failCreate = false } = {}) {
  return {
    created: [],
    view: null,
    create(_agent, request) {
      if (failCreate) throw new Error('an active goal already exists');
      this.created.push(request);
      this.view = { phase: 'active', objective: request.objective, blockedReason: undefined };
      return this.view;
    },
    get() {
      return this.view ?? undefined;
    },
    done(phase, explanation) {
      this.view = { ...this.view, phase, blockedReason: explanation === undefined ? undefined : { code: 'round-limit', explanation } };
    },
  };
}

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

// ────────────────────── 一次派给多个目标（批处理） ──────────────────────

/**
 * 多目标版的目标服务替身：每个会话一个独立的 goal 视图。
 *
 * 单目标那版只有一个 `view`，两个目标会互相覆盖 —— 多目标用例必须按会话分开。
 *
 * @param options.failFor - 这些会话在创建目标时抛错，用来验证「部分失败」。
 */
function fakeMultiGoals({ failFor = new Set() } = {}) {
  const views = new Map();
  return {
    created: [],
    create(agent, request) {
      const id = agent.session.id;
      if (failFor.has(id)) throw new Error('an active goal already exists');
      this.created.push({ id, objective: request.objective });
      views.set(id, { phase: 'active', objective: request.objective, blockedReason: undefined });
      return views.get(id);
    },
    get(agent) {
      return views.get(agent.session.id);
    },
    done(id, phase, explanation) {
      views.set(id, {
        ...views.get(id),
        phase,
        blockedReason: explanation === undefined ? undefined : { code: 'round-limit', explanation },
      });
    },
  };
}

/** 两个可派目标的公共布景。 */
const twoTargets = () => [
  { id: 's-b', label: '乙会话' },
  { id: 's-c', label: '丙会话' },
];

{
  /*
   * 主路径：一次调用派两个目标。要求「两个都真的建了目标」且「两个同时在等」，
   * 而不是派完第一个才开始第二个。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.set({ owner: 's-a', ownerLabel: '甲', targets: twoTargets() });

  let returned = false;
  const running = tool
    .execute({ task: '分头办事', targets: ['乙会话', '丙会话'] }, { agent: { id: 's-a' }, signal: new AbortController().signal })
    .then((value) => { returned = true; return value; });
  await settle();

  check('一次调用给两个目标都建了目标', goals.created.length === 2, JSON.stringify(goals.created.map((x) => x.id)));
  check('两个目标同时进入等待（pending 有两条）', service.pending.size === 2, String(service.pending.size));

  // 只让乙完成：默认 all 语义下整批不该返回。
  goals.done('s-b', 'complete');
  emit('s-b', assistantEvent(1, '乙做完了'));
  await settle();
  check('默认 wait=all：一个目标完成时整批还没返回', returned === false);

  // 丙也完成，整批收尾。
  goals.done('s-c', 'complete');
  emit('s-c', assistantEvent(1, '丙也做完了'));
  const value = await running;

  check('两个目标都到终态后整批状态是 complete', value.status === 'complete', JSON.stringify(value));
  check('结果里两个目标都在', value.results.length === 2);
  check('结果按用户请求的顺序排列', value.results[0].target === '乙会话' && value.results[1].target === '丙会话');
  check('每个目标各自带回自己的结论',
    value.results[0].reply === '乙做完了' && value.results[1].reply === '丙也做完了', JSON.stringify(value.results));
  check('全部结束后没有还在跑的目标', value.stillRunning === 0);
  check('全部结束后 pending 清空', service.pending.size === 0);
}

{
  /*
   * wait=any：第一个有结论就返回，其余留到下一次续等。
   * 同时要验证「留下的那条 pending 没被清掉」—— 不然续等会变成「新派一单」。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.set({ owner: 's-a', ownerLabel: '甲', targets: twoTargets() });

  const running = tool.execute(
    { task: '分头办事', wait: 'any', targets: ['乙会话', '丙会话'] },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  await settle();
  check('wait=any 同样是两个目标一起开工', goals.created.length === 2);

  goals.done('s-b', 'complete');
  emit('s-b', assistantEvent(1, '乙先回来了'));
  const first = await running;

  check('wait=any 在第一个目标有结论时就返回', first.status === 'running', JSON.stringify(first));
  check('返回里点明还有几个在做', first.stillRunning === 1, String(first.stillRunning));
  check('已完成的那个带着结论',
    first.results.find((item) => item.target === '乙会话')?.reply === '乙先回来了', JSON.stringify(first.results));
  check('没完成的那个标成 running',
    first.results.find((item) => item.target === '丙会话')?.status === 'running', JSON.stringify(first.results));
  check('没完成的目标保留 pending，可以接着等', service.pending.size === 1, String(service.pending.size));
  check('running 时 note 告诉模型继续调用', first.note.includes('继续调用'), first.note);

  // 续等：省略 task 与 targets，只等还没结束的那个。
  const second = tool.execute({}, { agent: { id: 's-a' }, signal: new AbortController().signal });
  await settle();
  check('续等不会给已完成的目标重建目标', goals.created.length === 2, String(goals.created.length));

  goals.done('s-c', 'complete');
  emit('s-c', assistantEvent(1, '丙也做完了'));
  const rest = await second;
  check('续等等到了剩下那个目标的结论',
    rest.status === 'complete' && rest.results[0].target === '丙会话' && rest.results[0].reply === '丙也做完了',
    JSON.stringify(rest));
  check('全部结束后 pending 清空', service.pending.size === 0, String(service.pending.size));
}

{
  /*
   * 预检：有一个目标在忙，就**一个都不派**。
   * 少了这条会出现「派出去一半」—— 模型拿着半截状态，还得自己猜哪些生效了。
   */
  const agents = new Map([['s-c', { status: 'running' }]]);
  const goals = fakeMultiGoals();
  const { tool, ctx } = boot({ agents, goals });
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲', targets: twoTargets() });

  let message = null;
  try {
    await tool.execute({ task: '分头办事', targets: ['乙会话', '丙会话'] }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    message = error.message;
  }
  check('批量派单里有一个目标在忙时整批被拒', typeof message === 'string' && message.includes('正在跑'), message);
  check('被拒时一个目标都没建（不会派出去一半）', goals.created.length === 0, String(goals.created.length));
}

{
  /*
   * 部分失败：丙的目标建不出来（对方已有未结束目标），乙必须照常跑完。
   * 整批不抛 —— 抛了就把已经跑起来的乙也一起丢了。
   */
  const goals = fakeMultiGoals({ failFor: new Set(['s-c']) });
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.set({ owner: 's-a', ownerLabel: '甲', targets: twoTargets() });

  const running = tool.execute({ task: '分头办事', targets: ['乙会话', '丙会话'] }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  await settle();
  goals.done('s-b', 'complete');
  emit('s-b', assistantEvent(1, '乙做完了'));
  const value = await running;

  check('部分目标没派出去时整批不抛异常', value !== undefined && Array.isArray(value.results), JSON.stringify(value));
  check('整批状态是 partial', value.status === 'partial', JSON.stringify(value));
  check('派出去的那个照常带回结论',
    value.results.find((item) => item.target === '乙会话')?.reply === '乙做完了', JSON.stringify(value.results));
  const failed = value.results.find((item) => item.target === '丙会话');
  check('没派出去的那个标成 failed 并说明原因',
    failed?.status === 'failed' && failed.reply.includes('没法替换'), JSON.stringify(failed));
  check('没派出去的目标不会留下 pending', service.pending.size === 0, String(service.pending.size));
}

{
  /*
   * 给一个「还在跑上件事」的目标再派新任务 → 明确拒绝。
   * 猜错的代价是模型以为新任务派出去了，而对方其实还在做上一件。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  const running = tool.execute({ task: '第一件事' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  await settle();

  let message = null;
  try {
    await tool.execute({ task: '第二件事' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    message = error.message;
  }
  check('给正在跑的目标再派新任务会被明确拒绝',
    typeof message === 'string' && message.includes('还在跑'), message);
  check('被拒时没有建第二个目标', goals.created.length === 1, String(goals.created.length));

  goals.done('s-b', 'complete');
  emit('s-b', assistantEvent(1, '第一件事做完了'));
  await running;
}

{
  /*
   * 删除箭头 = 撤回授权：还在等这个目标的那条记录必须一起作废，
   * 否则模型下次「接着等」会等一个用户已经撤销的目标。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.set({ owner: 's-a', ownerLabel: '甲', targets: twoTargets() });

  const controller = new AbortController();
  const running = tool.execute({ task: '分头办事', targets: ['乙会话', '丙会话'] }, { agent: { id: 's-a' }, signal: controller.signal });
  await settle();
  check('两个目标都已挂起', service.pending.size === 2, String(service.pending.size));

  service.set({ owner: 's-a', label: '甲', targets: [{ id: 's-b', label: '乙会话' }] });
  check('删掉一条箭头后，对应目标的待等记录被清掉', service.pending.size === 1, String(service.pending.size));

  controller.abort();
  await running.catch(() => undefined);
}

report();
