/**
 * `control_task` 的契约测试：停止（含超时、已完成、非本会话目标）与唤醒
 * （含 paused、active + disarmed、complete、blocked、用户手停、还在收尾）。
 *
 * 跑法：`node test/control-contract.mjs`
 */

import {
  boot as bootHost,
  check,
  fakeMultiGoals,
  host,
  report,
  settle,
  turnEndEvent,
} from './dispatch-harness.mjs';

const OWNER = 's-a';
const TARGET = 's-b';
const KEY = OWNER + '\u0000' + TARGET;

/**
 * 装插件并补一个「发起方」agent。
 *
 * 作用域工具只注册给带 `ctx` 的活 agent；测试里的 agents 表通常只放目标的
 * `{ status }` 占位，所以这里把发起方补进去，否则 `service.set` 之后拿不到
 * `control_task`。
 */
function makeContext(options = {}) {
  const agents = options.agents ?? new Map();
  const context = bootHost({ ...options, agents });
  agents.set(OWNER, { id: OWNER, ctx: { tools: context.ctx.tools } });
  return context;
}

/** 把「甲 → 乙」这条箭头推给 Host，并取回作用域里的 control_task。 */
function bind(context, targets = [{ id: TARGET, label: '乙会话' }]) {
  context.ctx.get('paneDispatch').set({
    owner: OWNER,
    ownerLabel: '甲',
    targets,
  });
  return context.registered.find((definition) => definition.name === host.CONTROL_TOOL_NAME);
}

/** 用 `wait: none` 派一单，让目标上有一张未结清的票。 */
async function dispatch(context, task = '做一件事', targets = ['乙会话']) {
  return context.tool.execute(
    { task, targets, wait: 'none' },
    { agent: { id: OWNER }, signal: new AbortController().signal },
  );
}

/** 调一次 control_task。 */
async function control(tool, action, targets = ['乙会话']) {
  return tool.execute(
    { action, targets },
    { agent: { id: OWNER }, signal: new AbortController().signal },
  );
}

// ────────────────────── 停止：正常路径 ──────────────────────

{
  /*
   * 目标正在跑：停止要 disarm → cancel(hook) → 等 idle → pause，最后结清 pending。
   * 这是主路径，任何一步顺序错了都会留下「半停」或把停止记成用户接管。
   */
  const goals = fakeMultiGoals();
  const agents = new Map([[TARGET, { status: 'idle' }]]);
  const context = makeContext({
    goals,
    agents,
    onCancel: ({ sessionId }) => {
      // 模拟 cancel 真的让当前轮收尾。
      agents.get(sessionId).status = 'idle';
    },
  });
  const tool = bind(context);
  const service = context.ctx.get('paneDispatch');
  await dispatch(context);
  agents.get(TARGET).status = 'running';

  const result = await control(tool, 'stop');
  const view = goals.get({ session: { id: TARGET } });

  check('停止正在跑的目标返回 paused',
    result.status === 'paused' && result.results[0]?.status === 'paused',
    JSON.stringify(result));
  check('停止用 hook 原因，保留目标队列里的用户输入',
    context.agentCancelCalls.length === 1
    && context.agentCancelCalls[0].cause?.kind === 'hook'
    && context.agentCancelCalls[0].cause?.reason === 'pane-dispatch-stop'
    && context.agentCancelCalls[0].options?.keepInbox === true,
    JSON.stringify(context.agentCancelCalls));
  check('停止先 disarm，等 idle 后再 pause',
    goals.calls.disarm.includes(TARGET) && goals.calls.pause.includes(TARGET),
    JSON.stringify(goals.calls));
  check('停止后目标进入 paused',
    view?.phase === 'paused' && view?.activation === 'disarmed',
    JSON.stringify(view));
  check('停止后这单结清，不会留下未取结果',
    service.pending.has(KEY) === false,
    JSON.stringify([...service.pending.keys()]));
  check('停止不会重发任何消息（不是纠正）',
    context.promptCalls.length === 0,
    JSON.stringify(context.promptCalls));
  check('停止结果里说明可以 resume 或派新任务',
    result.results[0]?.note.includes('resume') && result.results[0]?.note.includes('未交付'),
    result.results[0]?.note);
}

{
  /* 目标本来就空闲：不用 cancel，直接 disarm + pause。 */
  const goals = fakeMultiGoals();
  const context = makeContext({ goals, agents: new Map([[TARGET, { status: 'idle' }]]) });
  const tool = bind(context);
  await dispatch(context);
  const cancelsBefore = context.agentCancelCalls.length;

  const result = await control(tool, 'stop');
  check('空闲目标停止是 paused', result.status === 'paused', JSON.stringify(result));
  check('空闲目标不需要 cancel', context.agentCancelCalls.length === cancelsBefore,
    JSON.stringify(context.agentCancelCalls));
  check('空闲目标也会 pause',
    goals.get({ session: { id: TARGET } })?.phase === 'paused',
    JSON.stringify(goals.get({ session: { id: TARGET } })));
}

{
  /* 重复 stop 必须幂等：第二次不能再 cancel / pause，也不能把状态改坏。 */
  const goals = fakeMultiGoals();
  const agents = new Map([[TARGET, { status: 'idle' }]]);
  const context = makeContext({
    goals,
    agents,
    onCancel: ({ sessionId }) => { agents.get(sessionId).status = 'idle'; },
  });
  const tool = bind(context);
  await dispatch(context);
  agents.get(TARGET).status = 'running';
  await control(tool, 'stop');
  const cancels = context.agentCancelCalls.length;
  const pauses = goals.calls.pause.length;

  const again = await control(tool, 'stop');
  check('重复停止返回 paused', again.status === 'paused' && again.results[0]?.status === 'paused',
    JSON.stringify(again));
  check('重复停止不再 cancel', context.agentCancelCalls.length === cancels,
    JSON.stringify(context.agentCancelCalls));
  check('重复停止不再 pause', goals.calls.pause.length === pauses,
    JSON.stringify(goals.calls));
}

// ────────────────────── 停止：超时与竞态 ──────────────────────

{
  /*
   * 目标卡在工具里不响应 cancel：30 秒上限必须能压短，超时返回 stopping，
   * 不能谎报 paused；目标已经 disarm，所以不会再自动开新轮。
   */
  const goals = fakeMultiGoals();
  const agents = new Map([[TARGET, { status: 'idle' }]]);
  const context = makeContext({ goals, agents, onCancel: () => {} });
  const tool = bind(context);
  const service = context.ctx.get('paneDispatch');
  service.stopTimeoutMs = 60;
  await dispatch(context);
  agents.get(TARGET).status = 'running';

  const result = await control(tool, 'stop');
  const view = goals.get({ session: { id: TARGET } });

  check('超时返回 stopping，不是 paused',
    result.status === 'stopping' && result.results[0]?.status === 'stopping',
    JSON.stringify(result));
  check('超时告诉主会话「还没确认」，不要当成已停止',
    result.results[0]?.note.includes('没确认') && result.note.includes('stopping'),
    JSON.stringify(result));
  check('超时后目标已 disarm，不会再自动推进',
    view?.phase === 'active' && view?.activation === 'disarmed',
    JSON.stringify(view));
  check('超时后票还留着，后台监视继续等它真停',
    service.pending.has(KEY) === true,
    JSON.stringify([...service.pending.keys()]));
  check('超时没有调用 pause（agent 还在 running）', goals.calls.pause.length === 0,
    JSON.stringify(goals.calls));
}

{
  /* 停止晚了一步：目标已经完成，不能 pause，票要留给 A 取结果。 */
  const goals = fakeMultiGoals();
  const context = makeContext({ goals, agents: new Map([[TARGET, { status: 'idle' }]]) });
  const tool = bind(context);
  const service = context.ctx.get('paneDispatch');
  await dispatch(context);
  goals.done(TARGET, 'complete');
  const cancels = context.agentCancelCalls.length;

  const result = await control(tool, 'stop');
  check('目标已完成时 stop 返回 complete',
    result.status === 'complete' && result.results[0]?.status === 'complete',
    JSON.stringify(result));
  check('已完成就不 cancel', context.agentCancelCalls.length === cancels,
    JSON.stringify(context.agentCancelCalls));
  check('已完成时保留票，让 A 去取结果', service.pending.has(KEY) === true,
    JSON.stringify([...service.pending.keys()]));
  check('已完成时结果指向 dispatch_task',
    result.results[0]?.note.includes('dispatch_task'),
    result.results[0]?.note);
}

// ────────────────────── 停止：安全边界 ──────────────────────

{
  /* 不是本插件创建的目标：不能停，避免掐掉用户自己在目标窗格里跑的任务。 */
  const goals = fakeMultiGoals();
  goals.create({ session: { id: TARGET } }, { objective: '用户自己设的目标' });
  const context = makeContext({ goals, agents: new Map([[TARGET, { status: 'running' }]]) });
  const tool = bind(context);

  const result = await control(tool, 'stop');
  check('非任务分派目标拒绝停止',
    result.status === 'failed' && result.results[0]?.status === 'failed',
    JSON.stringify(result));
  check('拒绝时没有 cancel', context.agentCancelCalls.length === 0,
    JSON.stringify(context.agentCancelCalls));
  check('拒绝原因说清楚是「不是任务分派创建的目标」',
    result.results[0]?.note.includes('不是任务分派'),
    result.results[0]?.note);
}

{
  /* 另一个主会话正在用这个目标：不能越过它停。 */
  const goals = fakeMultiGoals();
  const context = makeContext({ goals, agents: new Map([[TARGET, { status: 'idle' }]]) });
  const tool = bind(context);
  const service = context.ctx.get('paneDispatch');
  await dispatch(context);
  service.pending.set('s-x\u0000' + TARGET, {
    replaced: null,
    settled: null,
    controller: null,
    progress: '',
  });

  const result = await control(tool, 'stop');
  check('另一个会话派的任务不能停',
    result.status === 'failed' && result.results[0]?.note.includes('另一个会话'),
    JSON.stringify(result));
  check('越权拒绝时没有 cancel', context.agentCancelCalls.length === 0,
    JSON.stringify(context.agentCancelCalls));
}

// ────────────────────── 唤醒：正常路径 ──────────────────────

{
  /*
   * 停止之后再唤醒：必须恢复原目标，不新建 goal、不重发任务正文，
   * 并重新开一张票，A 之后才能用 dispatch_task 续等。
   */
  const goals = fakeMultiGoals();
  const agents = new Map([[TARGET, { status: 'idle' }]]);
  const context = makeContext({
    goals,
    agents,
    onCancel: ({ sessionId }) => { agents.get(sessionId).status = 'idle'; },
  });
  const tool = bind(context);
  const service = context.ctx.get('paneDispatch');
  await dispatch(context);
  agents.get(TARGET).status = 'running';
  await control(tool, 'stop');
  const createdBefore = goals.created.length;

  const result = await control(tool, 'resume');
  const view = goals.get({ session: { id: TARGET } });
  const entry = service.pending.get(KEY);

  check('唤醒返回 resumed',
    result.status === 'resumed' && result.results[0]?.status === 'resumed',
    JSON.stringify(result));
  check('唤醒恢复的是 active + armed',
    view?.phase === 'active' && view?.activation === 'armed',
    JSON.stringify(view));
  check('唤醒没有新建目标', goals.created.length === createdBefore,
    String(goals.created.length));
  check('唤醒没有重发任务正文', context.promptCalls.length === 0,
    JSON.stringify(context.promptCalls));
  check('唤醒重新开了一张票',
    entry !== undefined && entry.settled === null,
    JSON.stringify(entry));
  check('唤醒后挂了后台监视',
    entry?.controller !== null && entry?.controller !== undefined,
    String(entry?.controller));
  check('唤醒结果说明之后用 dispatch_task 等',
    result.results[0]?.note.includes('dispatch_task'),
    result.results[0]?.note);
}

{
  /* 目标停在 active + disarmed + idle（Host 重启后的停止态）也能唤醒。 */
  const goals = fakeMultiGoals();
  const context = makeContext({ goals, agents: new Map([[TARGET, { status: 'idle' }]]) });
  const tool = bind(context);
  await dispatch(context);
  goals.disarm({ session: { id: TARGET } });

  const result = await control(tool, 'resume');
  check('active + disarmed + idle 也能唤醒',
    result.status === 'resumed'
    && goals.get({ session: { id: TARGET } })?.phase === 'active'
    && goals.get({ session: { id: TARGET } })?.activation === 'armed',
    JSON.stringify({ result, view: goals.get({ session: { id: TARGET } }) }));
}

{
  /* 已经 active + armed：唤醒是幂等 no-op，不能再 resume 一次。 */
  const goals = fakeMultiGoals();
  const agents = new Map([[TARGET, { status: 'idle' }]]);
  const context = makeContext({ goals, agents });
  const tool = bind(context);
  await dispatch(context); // 先派单；派单时目标必须空闲，否则预检会拒绝
  agents.get(TARGET).status = 'running';
  const resumes = goals.calls.resume.length;

  const result = await control(tool, 'resume');
  check('已经运行的目标唤醒返回 running',
    result.status === 'running' && result.results[0]?.status === 'running',
    JSON.stringify(result));
  check('已经运行的目标不会重复 resume', goals.calls.resume.length === resumes,
    JSON.stringify(goals.calls));
}

// ────────────────────── 唤醒：拒绝路径 ──────────────────────

{
  /* 已完成 / 已受阻 / 用户手停：都不能自动唤醒。 */
  const cases = [
    {
      label: '已完成',
      prepare: (goals) => goals.done(TARGET, 'complete'),
      expected: '完成',
    },
    {
      label: '已受阻',
      prepare: (goals) => goals.done(TARGET, 'blocked', '轮数用完了'),
      expected: '受阻',
    },
  ];
  for (const item of cases) {
    const goals = fakeMultiGoals();
    const context = makeContext({ goals, agents: new Map([[TARGET, { status: 'idle' }]]) });
    const tool = bind(context);
    await dispatch(context);
    item.prepare(goals);
    const resumes = goals.calls.resume.length;
    const result = await control(tool, 'resume');
    check(item.label + '的目标不能唤醒',
      result.status === 'failed' && result.results[0]?.status === 'failed',
      JSON.stringify(result));
    check(item.label + '的目标没有调用 resume', goals.calls.resume.length === resumes,
      JSON.stringify(goals.calls));
    check(item.label + '的拒绝原因可读',
      result.results[0]?.note.includes(item.expected),
      result.results[0]?.note);
  }
}

{
  /* 用户手动停止过的目标：按约定不越过用户自动唤醒。 */
  const goals = fakeMultiGoals();
  const context = makeContext({ goals, agents: new Map([[TARGET, { status: 'idle' }]]) });
  const tool = bind(context);
  const service = context.ctx.get('paneDispatch');
  await dispatch(context);
  goals.pause(TARGET);
  const entry = service.pending.get(KEY);
  entry.settled = {
    status: 'interrupted',
    deliverable: false,
    reply: '',
    progress: '',
    reason: '用户手动停止了目标会话。',
    interruptedBy: 'user',
  };
  const resumes = goals.calls.resume.length;

  const result = await control(tool, 'resume');
  check('用户手停的目标不能自动唤醒',
    result.status === 'failed' && result.results[0]?.note.includes('用户'),
    JSON.stringify(result));
  check('用户手停时没有调用 resume', goals.calls.resume.length === resumes,
    JSON.stringify(goals.calls));
}

{
  /*
   * 用户手停的证据不能只活在 pending 里：A 取走中断结果之后，pending 会被删掉，
   * 之后照样不能自动唤醒。这里用一次真实的 `aborted.user` 事件走完整条链路。
   */
  const goals = fakeMultiGoals();
  const context = makeContext({ goals, agents: new Map([[TARGET, { status: 'idle' }]]) });
  const tool = bind(context);
  const service = context.ctx.get('paneDispatch');
  await dispatch(context);

  context.emit(TARGET, turnEndEvent(1, 'aborted', { kind: 'user' }));
  await settle();
  goals.pause(TARGET);
  check('用户手停会记进后台中断结果',
    service.pending.get(KEY)?.settled?.interruptedBy === 'user',
    JSON.stringify(service.pending.get(KEY)));
  check('用户手停会留下跨 pending 的标记',
    service.humanStopped.has(KEY),
    JSON.stringify([...service.humanStopped]));

  const collected = await context.tool.execute(
    {},
    { agent: { id: OWNER }, signal: new AbortController().signal },
  );
  check('取走中断结果后 pending 被清掉',
    service.pending.has(KEY) === false,
    JSON.stringify([...service.pending.keys()]));
  check('取走中断结果时仍然保留了用户手停标记',
    service.humanStopped.has(KEY) === true,
    JSON.stringify([...service.humanStopped]));
  check('取走的是 interrupted 结果',
    collected.results[0]?.status === 'interrupted'
    && collected.results[0]?.interruptedBy === 'user',
    JSON.stringify(collected));

  const resumes = goals.calls.resume.length;
  const refused = await control(tool, 'resume');
  check('结果被取走后，用户手停的目标仍然不能自动唤醒',
    refused.status === 'failed' && refused.results[0]?.note.includes('用户'),
    JSON.stringify(refused));
  check('结果被取走后也没有调用 resume', goals.calls.resume.length === resumes,
    JSON.stringify(goals.calls));
}

{
  /* 目标还在停止收尾（paused 但 agent 仍 running）：不能在这个节骨眼上 resume。 */
  const goals = fakeMultiGoals();
  const agents = new Map([[TARGET, { status: 'idle' }]]);
  const context = makeContext({ goals, agents });
  const tool = bind(context);
  await dispatch(context);
  goals.pause(TARGET);
  agents.get(TARGET).status = 'running';
  const resumes = goals.calls.resume.length;

  const result = await control(tool, 'resume');
  check('还在收尾的目标不能唤醒',
    result.status === 'failed' && result.results[0]?.note.includes('收尾'),
    JSON.stringify(result));
  check('还在收尾时没有调用 resume', goals.calls.resume.length === resumes,
    JSON.stringify(goals.calls));
}

{
  /* 不是任务分派创建的目标：不能替用户恢复它自己的 goal。 */
  const goals = fakeMultiGoals();
  goals.create({ session: { id: TARGET } }, { objective: '用户自己的目标' });
  const context = makeContext({ goals, agents: new Map([[TARGET, { status: 'idle' }]]) });
  const tool = bind(context);

  const result = await control(tool, 'resume');
  check('非任务分派目标拒绝唤醒',
    result.status === 'failed' && result.results[0]?.note.includes('不是任务分派'),
    JSON.stringify(result));
}

// ────────────────────── 批量与工具面 ──────────────────────

{
  /*
   * 一批里一个能停、一个卡住：整批必须是 stopping，不能因为有一个停了就
   * 宣称全部停住。stillRunning 要点名还有几个没确认。
   */
  const goals = fakeMultiGoals();
  const agents = new Map([
    ['s-b', { status: 'idle' }],
    ['s-c', { status: 'idle' }],
  ]);
  const context = makeContext({ goals, agents, onCancel: () => {} });
  const tool = bind(context, [
    { id: 's-b', label: '乙会话' },
    { id: 's-c', label: '丙会话' },
  ]);
  const service = context.ctx.get('paneDispatch');
  service.stopTimeoutMs = 60;
  await dispatch(context, '分头办事', ['乙会话', '丙会话']);
  agents.get('s-c').status = 'running';

  const result = await control(tool, 'stop', ['乙会话', '丙会话']);
  check('一批里只要有一个没确认停下，整批就是 stopping',
    result.status === 'stopping' && result.stillRunning === 1,
    JSON.stringify(result));
  check('已停的那个仍然是 paused',
    result.results.find((item) => item.target === '乙会话')?.status === 'paused',
    JSON.stringify(result.results));
  check('没停的那个是 stopping',
    result.results.find((item) => item.target === '丙会话')?.status === 'stopping',
    JSON.stringify(result.results));
}

{
  /* 工具面：没连箭头就没有 control_task；连了之后描述里列出目标。 */
  const context = makeContext({ goals: fakeMultiGoals() });
  const before = context.registered.find((definition) => definition.name === host.CONTROL_TOOL_NAME);
  check('没有委派箭头时不注册 control_task', before === undefined, String(before));

  const tool = bind(context);
  check('连了箭头后 control_task 已注册', tool !== undefined);
  check('描述里列出可控制目标', tool.description.includes('乙会话'), tool.description);
  check('描述里写了 stop / resume 的边界',
    tool.description.includes('stop') && tool.description.includes('resume'),
    tool.description);
}

report();
