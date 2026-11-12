/**
 * 「任务分派」的批处理契约测试：一次派给多个目标、`wait: all | any | none`、
 * 后台监视、以及回合收尾前的自动提醒。
 *
 * 跑法：`node test/dispatch-batch-contract.mjs`
 */
import {
  assistantEvent, boot, check, fakeMultiGoals, host, report, settle, turnEndEvent, twoTargets,
} from './dispatch-harness.mjs';

// ────────────────────── 一次派给多个目标（批处理） ──────────────────────



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
   * 给一个「还在跑上件事」的目标再给 task → 当成**纠正**：先停止当前轮，
   * 再把纠正作为一条新用户消息重新提交，并重新启动目标；不新建目标。
   *
   * 旧行为是直接拒绝。上一版改成排队到下一轮 —— 当前轮仍会按错的方向跑完。
   * 现在按用户要求走「停止按钮 + 再次输入」的语义。
   */
  const goals = fakeMultiGoals();
  let seq = 0;
  const agentStatus = { status: 'idle' };
  const { tool, ctx, emit, promptCalls, agentCancelCalls, order } = boot({
    goals,
    agents: new Map([['s-b', agentStatus]]),
    /*
     * 模拟真实停止：`agent.cancel` 会让当前轮以 aborted 收尾。
     * 这个用例同时验证 A 自己的等待不会把插件的停止误读成「用户接管」。
     */
    onCancel: (request) => {
      seq += 1;
      emit(request.sessionId, turnEndEvent(seq, 'aborted', request.cause));
    },
  });
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  const controller = new AbortController();
  const running = tool.execute({ task: '第一件事' }, { agent: { id: 's-a' }, signal: controller.signal });
  await settle();
  // 派单后目标进入运行态：纠正应当先停下这一轮，再重发。
  agentStatus.status = 'running';

  const redirected = await tool.execute({ task: '第二件事' }, { agent: { id: 's-a' }, signal: controller.signal });
  check('给正在跑的目标带 task 会被当成纠正，而不是拒绝',
    redirected.status === 'redirected' && redirected.results[0]?.status === 'redirected',
    JSON.stringify(redirected));
  check('纠正没有新建第二个目标', goals.created.length === 1, String(goals.created.length));
  check('纠正先停止目标的当前轮（abort 当前轮并保留 inbox）',
    agentCancelCalls.length === 1
    && agentCancelCalls[0].sessionId === 's-b'
    && agentCancelCalls[0].cause?.kind === 'hook'
    && agentCancelCalls[0].options?.keepInbox === true,
    JSON.stringify(agentCancelCalls));
  check('停止原因不是 user（插件不能冒充用户接管）',
    agentCancelCalls[0]?.cause?.kind !== 'user',
    JSON.stringify(agentCancelCalls[0]));
  check('顺序是「先停止、再重新输入」', order.join(',') === 'cancel,prompt', order.join(','));
  check('纠正以普通用户消息投递（mode: queue）',
    promptCalls.length === 1 && promptCalls[0].request.mode === 'queue', JSON.stringify(promptCalls));
  check('纠正消息说明上一轮是被停止的、不是新任务',
    promptCalls[0].request.content[0].text.includes('停止了你上一轮的推进')
    && promptCalls[0].request.content[0].text.includes('不是新任务'),
    promptCalls[0].request.content[0].text);
  check('停止前先挂起自动推进、重发后重新启动',
    goals.calls.disarm.join(',') === 's-b' && goals.calls.resume.join(',') === 's-b',
    JSON.stringify(goals.calls));
  check('重新启动后目标回到 active + armed',
    goals.get({ session: { id: 's-b' } })?.phase === 'active'
    && goals.get({ session: { id: 's-b' } })?.activation === 'armed',
    JSON.stringify(goals.get({ session: { id: 's-b' } })));
  check('插件自己的停止不会被当成用户接管（第一单仍在等）',
    redirected.results[0]?.interruptedBy === '',
    JSON.stringify(redirected.results[0]));

  goals.done('s-b', 'complete');
  emit('s-b', assistantEvent(2, '第一件事做完了'));
  const first = await running;
  check('第一单照常拿到结论，没有被纠正的中间停止打断',
    first.status === 'complete' && first.results[0]?.reply === '第一件事做完了',
    JSON.stringify(first));
  controller.abort();
}

{
  /*
   * 停止真的把目标暂停了：纠正流程必须把它重新启动，而不是留在 paused。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx } = boot({
    goals,
    onCancel: (request) => goals.pause(request.sessionId),
  });
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  const controller = new AbortController();
  const running = tool.execute({ task: '第一件事' }, { agent: { id: 's-a' }, signal: controller.signal });
  await settle();
  const redirected = await tool.execute({ task: '第二件事' }, { agent: { id: 's-a' }, signal: controller.signal });

  const view = goals.get({ session: { id: 's-b' } });
  check('停止把目标暂停时，纠正会把它重新启动',
    redirected.status === 'redirected' && view?.phase === 'active' && view?.activation === 'armed',
    JSON.stringify({ redirected, view }));
  check('被暂停后确实走了 resume', goals.calls.pause.join(',') === 's-b' && goals.calls.resume.join(',') === 's-b',
    JSON.stringify(goals.calls));

  controller.abort();
  await running.catch(() => undefined);
}

{
  /*
   * 停止之后投递失败：目标不能留在「已 disarm、没人接着推」的半路状态。
   * 这时整次调用按失败处理，并把自动推进恢复回去。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, promptCalls } = boot({ goals, promptThrowsAt: 1 });
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  const controller = new AbortController();
  const running = tool.execute({ task: '第一件事' }, { agent: { id: 's-a' }, signal: controller.signal });
  await settle();
  let failure;
  try {
    await tool.execute({ task: '第二件事' }, { agent: { id: 's-a' }, signal: controller.signal });
  } catch (reason) {
    failure = reason;
  }

  const view = goals.get({ session: { id: 's-b' } });
  check('纠正投递失败时整次调用报错', failure instanceof Error && failure.message.includes('拒绝接收'),
    failure === undefined ? 'no error' : failure.message);
  check('投递失败后自动推进被恢复（不留在 disarm）',
    goals.calls.resume.join(',') === 's-b' && view?.phase === 'active' && view?.activation === 'armed',
    JSON.stringify({ calls: goals.calls, view }));
  check('投递失败没有再塞第二条消息', promptCalls.length === 1, String(promptCalls.length));

  controller.abort();
  await running.catch(() => undefined);
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

// ────────────────── 派完就走（wait: none）与收尾前的自动检测 ──────────────────

{
  /*
   * 主路径：给了 task + wait: none → 立刻返回，不阻塞。
   * 这是「A 先做自己的事，等结束再收」的第一步。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: twoTargets() });

  const started = Date.now();
  const value = await tool.execute(
    { task: '分头办事', targets: ['乙会话', '丙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  const elapsed = Date.now() - started;

  check('wait: none 不阻塞，立刻返回', elapsed < 200, String(elapsed) + 'ms');
  check('派完就走的状态是 dispatched', value.status === 'dispatched', JSON.stringify(value));
  check('两个目标都真的建了目标', goals.created.length === 2, String(goals.created.length));
  check('两个目标都在 pending 里等着被取', service.pending.size === 2, String(service.pending.size));
  check('返回值里说明还有 2 个在做', value.stillRunning === 2, String(value.stillRunning));
  check('note 告诉模型怎么收尾', value.note.includes('省略 task'), value.note);
}

{
  /*
   * 后半段：后台监视把结论记下来，A 回来查时能直接取走，且**取一次就不再重复给**。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: twoTargets() });

  await tool.execute(
    { task: '分头办事', targets: ['乙会话', '丙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );

  // 乙先完成；后台监视应当在事件到达时就把结论记进 pending。
  goals.done('s-b', 'complete');
  emit('s-b', assistantEvent(1, '乙的结论'));
  await settle();

  const peek = await tool.execute(
    { wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  const done = peek.results.find((item) => item.target === '乙会话');
  const running = peek.results.find((item) => item.target === '丙会话');
  check('查询能拿到已完成后台任务的结论', done?.reply === '乙的结论', JSON.stringify(peek.results));
  check('查询不会阻塞：还在跑的那个标成 running', running?.status === 'running', JSON.stringify(peek.results));
  check('领取之后结清，不会重复给同一段结论', service.pending.size === 1, String(service.pending.size));

  // 查的时候不带 targets：只返回「还在 pending 里」的那些，已领取的自然就不在了。
  const again = await tool.execute(
    { wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  check('再查一次时已领取的目标不再出现',
    again.results.every((item) => item.target !== '乙会话'),
    JSON.stringify(again.results));
}

{
  /*
   * 阻塞路径也要能用上后台已经记下的结论 —— 否则「先派了再回来等」会白等一段切片。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  await tool.execute(
    { task: '分头办事', targets: ['乙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  goals.done('s-b', 'complete');
  emit('s-b', assistantEvent(1, '乙的结论'));
  await settle();

  const started = Date.now();
  const value = await tool.execute({}, { agent: { id: 's-a' }, signal: new AbortController().signal });
  check('阻塞续等能立刻拿到后台已记下的结论',
    value.status === 'complete' && value.results[0].reply === '乙的结论', JSON.stringify(value));
  check('不会为了一条已有结论白等一段切片', Date.now() - started < 200, String(Date.now() - started) + 'ms');
}

{
  /*
   * 收尾前的自动检测：A 正要结束回合时，如果还有派出去没取结果的，把它拉回来一次。
   * 同一回合只提醒一次（按 turn 去重），取完之后不再提醒。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, fire, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  await tool.execute(
    { task: '分头办事', targets: ['乙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );

  const injected = [];
  const stopping = (turn) => fire('agent/turn-stopping', {
    agent: { id: 's-a', inject: (message) => injected.push(message) },
    turn,
  });

  stopping(7);
  check('收尾前有未结清的派单时会注入一次提醒', injected.length === 1, String(injected.length));
  check('提醒里点名还有几个、是哪几个',
    injected[0]?.content?.[0]?.text.includes('1 个') && injected[0].content[0].text.includes('乙会话'),
    injected[0]?.content?.[0]?.text);
  check('提醒自带独立来源，不伪装成用户输入', injected[0]?.source?.kind === 'pane-dispatch');

  stopping(7);
  check('同一个回合不会重复提醒', injected.length === 1, String(injected.length));

  // 收掉结果之后就不该再提醒了。
  goals.done('s-b', 'complete');
  emit('s-b', assistantEvent(1, '乙的结论'));
  await settle();
  await tool.execute({ wait: 'none' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  stopping(8);
  check('取完结果后不再提醒', injected.length === 1, String(injected.length));
}

{
  /*
   * 这一幕正是「跨段攒」当初要解决的问题，单订阅之后它应该天然成立：
   * 结论在很早的时候说完，之后很久没有任何助手消息，最后才由一条**不带文本**的
   * 状态事件宣告结束。结算时必须仍然拿着那句结论，而不是空串。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  await tool.execute(
    { task: '分头办事', targets: ['乙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );

  // 1) 早就说完了结论
  emit('s-b', assistantEvent(1, '结论：新增三节规格'));
  await settle();

  // 2) 之后很长一段时间只有「干活」类的噪音，没有任何助手文本
  emit('s-b', { type: 'tool/result', seq: 2, time: 2, data: { callId: 'c1', name: 'run', ok: true } });
  emit('s-b', { type: 'step/start', seq: 3, time: 3, data: { turn: 1, step: 2 } });
  await settle();

  // 3) 最后才由一条不带文本的状态事件宣告结束
  goals.done('s-b', 'complete');
  emit('s-b', { type: 'goal/change', seq: 4, time: 4, data: {} });
  await settle();

  const value = await tool.execute({ wait: 'none' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  check('终态由不带文本的事件宣告时，仍然拿得到早先那句结论',
    value.results[0]?.reply === '结论：新增三节规格', JSON.stringify(value.results));
  check('状态是 complete', value.results[0]?.status === 'complete', JSON.stringify(value.results));
}

{
  /*
   * 老部署没有目标服务，「派完就走」走不通（后台监视要读 goal 的 phase）。
   * 这里必须当场拒绝 —— 曾经少判这一条，会返回 status: dispatched 而一条消息都没投出去。
   */
  const { tool, promptCalls, ctx } = boot();
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });
  let message = null;
  try {
    await tool.execute(
      { task: '干活', targets: ['乙会话'], wait: 'none' },
      { agent: { id: 's-a' }, signal: new AbortController().signal },
    );
  } catch (error) {
    message = error.message;
  }
  check('没有目标服务时明确拒绝「派完就走」，而不是假装派成了',
    typeof message === 'string' && message.includes('派完就走'), message);
  check('被拒时一条消息都没投出去', promptCalls.length === 0, String(promptCalls.length));
}

{
  /*
   * 回归：后台监视已经攒到结论之后，A 用**阻塞方式**回来续等。
   *
   * 目标在阻塞期间结束，而且宣告结束的事件不带文本 —— 阻塞那次等待自己什么都看不到。
   * 这时必须采用后台监视攒下的那句结论，否则会交出一个空结论并顺手把监视掐掉。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  await tool.execute(
    { task: '分头办事', targets: ['乙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );

  // 结论早说完了
  emit('s-b', assistantEvent(1, '结论：新增三节规格'));
  await settle();

  // A 回来用阻塞方式等（此时目标还没结束）
  const blocking = tool.execute({}, { agent: { id: 's-a' }, signal: new AbortController().signal });
  await settle();

  // 目标结束，但宣告结束的事件不带任何文本
  goals.done('s-b', 'complete');
  emit('s-b', { type: 'goal/change', seq: 2, time: 2, data: {} });

  const value = await blocking;
  check('阻塞续等结束时，采用后台监视攒下的结论而不是空串',
    value.results[0]?.reply === '结论：新增三节规格', JSON.stringify(value.results));
  check('并且状态是 complete', value.status === 'complete', JSON.stringify(value));
}

{
  /*
   * 回归：会话被重新唤醒后，派单时拿到的那个 agent 引用已经失效（goals.get 会抛）。
   * 读状态必须改用当前活着的那个 agent，否则明明做完的目标要等满兜底时长。
   */
  const views = new Map();
  let current = { id: 's-b', session: { id: 's-b' } };
  const goals = {
    created: [],
    create(agent, request) {
      this.created.push({ id: agent.session.id, objective: request.objective });
      const view = { phase: 'active', objective: request.objective, blockedReason: undefined };
      views.set('s-b', view);
      return view;
    },
    get(agent) {
      // 照真实实现：只认当前活着的那个实例。
      if (agent !== current) throw new Error('agent is not live');
      return views.get('s-b');
    },
    done(phase) {
      views.set('s-b', { ...views.get('s-b'), phase, blockedReason: undefined });
    },
  };

  const agents = new Map();
  const { tool, ctx, emit } = boot({ agents, goals });
  const service = ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  await tool.execute(
    { task: '分头办事', targets: ['乙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );

  // 会话被重新唤醒：旧引用失效，registry 里换成了新实例
  current = { id: 's-b', session: { id: 's-b' } };
  agents.set('s-b', current);

  goals.done('complete');
  emit('s-b', assistantEvent(1, '重连之后才给出的结论'));
  await settle();

  const value = await tool.execute({ wait: 'none' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  check('会话重新唤醒后仍能读到目标状态并结算',
    value.results[0]?.reply === '重连之后才给出的结论' && value.results[0]?.status === 'complete',
    JSON.stringify(value.results));
}

// ────────────────── 受阻之后还能不能再派 ──────────────────

/**
 * 按真实 `goals` 契约实现的替身：
 *   - `create` 只在「没有目标」或「旧目标已 complete」时成功，其余阶段必须 clear；
 *   - `clear` 之后当前目标消失；
 *   - `blockedReason` 用真实的 `{ code, message }` 形状。
 */
function realishGoals() {
  const views = new Map();
  return {
    created: [],
    cleared: [],
    create(agent, request) {
      const id = agent.session.id;
      const current = views.get(id);
      if (current !== undefined && current.phase !== 'complete') {
        throw new Error('goal create rejected: current phase is ' + current.phase);
      }
      this.created.push({ id, objective: request.objective });
      const view = {
        id: 'g-' + String(this.created.length),
        revision: 1,
        phase: 'active',
        objective: request.objective,
        blockedReason: undefined,
      };
      views.set(id, view);
      return view;
    },
    get(agent) {
      return views.get(agent.session.id);
    },
    clear(agent, ref) {
      this.cleared.push({ id: ref.id, revision: ref.revision });
      views.delete(agent.session.id);
      return { id: ref.id, revision: ref.revision + 1 };
    },
    block(id, message) {
      const current = views.get(id);
      views.set(id, { ...current, phase: 'blocked', blockedReason: { code: 'needs-input', message }, revision: 2 });
    },
    complete(id) {
      const current = views.get(id);
      views.set(id, { ...current, phase: 'complete', revision: 2 });
    },
  };
}

{
  /*
   * 真机反馈：A 派给 B，B 的目标受阻之后，A 再也派不进去了。
   * 根因是 `goals.create` 只允许替换 complete 的旧目标；blocked 必须先 clear。
   */
  const goals = realishGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  const first = tool.execute({ task: '第一件事', targets: ['乙会话'] }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  await settle();
  goals.block('s-b', '连续三轮卡在同一个权限问题上');
  emit('s-b', assistantEvent(1, '卡在权限上了'));
  emit('s-b', { type: 'goal/change', seq: 2, time: 2, data: {} });
  const blocked = await first;

  check('受阻时状态是 blocked', blocked.results[0]?.status === 'blocked', JSON.stringify(blocked.results));
  check('卡住原因取的是 message（那句人话），不是 code',
    blocked.results[0]?.reply.includes('连续三轮卡在同一个权限问题上'), JSON.stringify(blocked.results[0]?.reply));
  check('不会把 code 当成原因显示出来', !blocked.results[0]?.reply.includes('needs-input'), blocked.results[0]?.reply);

  // 关键：受阻之后 A 应该还能再派
  const second = await tool.execute(
    { task: '第二件事', targets: ['乙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  check('B 受阻之后 A 仍然可以再派', goals.created.length === 2, String(goals.created.length));
  check('派单前清掉了那个受阻的旧目标', goals.cleared.length === 1, String(goals.cleared.length));
  check('结果里说明了清掉受阻旧目标这件事',
    typeof second.results[0]?.note === 'string' && second.results[0].note.includes('受阻'), second.results[0]?.note);
}

{
  /*
   * 「还在跑」与「结果还没取」是两件事：后者不该被说成前者。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  await tool.execute(
    { task: '第一件事', targets: ['乙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  goals.done('s-b', 'complete');
  emit('s-b', assistantEvent(1, '第一件事的结论'));
  await settle();

  let message = null;
  try {
    await tool.execute({ task: '第二件事', targets: ['乙会话'] }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    message = error.message;
  }
  check('结果还没取时，明确说是「结果还没取」而不是「还在跑」',
    typeof message === 'string' && message.includes('结果还没取'), message);
  check('并且告诉模型先取再派', typeof message === 'string' && message.includes('先省略 task'), message);
}

// ────────────────── 过程稿、用户手停、纠正 ──────────────────

{
  /*
   * 纯函数：整批都被用户接管时，不能报成 partial（那会让 A 以为还有半成品可复核）。
   */
  check('全部目标都被用户接管时，整批状态是 interrupted',
    host.batchStatus([{ status: 'interrupted' }], false) === 'interrupted');
  check('部分被接管、部分完成时，整批状态是 partial',
    host.batchStatus([{ status: 'interrupted' }, { status: 'complete' }], false) === 'partial');
}

{
  /*
   * 用户手动停止（阻塞等待中）：
   * A 必须知道「是用户停的、这一单没交付」；过程稿只能当参考，不能当结论。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  const waiting = tool.execute(
    { task: '做件事', targets: ['乙会话'] },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  await settle();
  emit('s-b', assistantEvent(1, '我初步判断是 X，还在验证'));
  emit('s-b', turnEndEvent(2, 'aborted', { kind: 'user' }));
  const value = await waiting;
  const item = value.results[0];

  check('用户手动停止后整批状态是 interrupted', value.status === 'interrupted', JSON.stringify(value));
  check('单个目标标成 interrupted，并注明是用户停的',
    item?.status === 'interrupted' && item?.interruptedBy === 'user', JSON.stringify(item));
  check('用户停止不算交付：reply 只有说明，中间话单独放 progress',
    item?.deliverable === false
      && item?.reply.includes('用户')
      && item?.progress.includes('我初步判断是 X'),
    JSON.stringify(item));
  check('note 让 A 继续做不依赖 B 的部分，且不要越过用户去纠正',
    item?.note.includes('继续做不依赖') && item?.note.includes('不要越过用户'), item?.note);
  check('用户停止后 pending 结清', service.pending.size === 0, String(service.pending.size));

  let again = null;
  try {
    await tool.execute({ wait: 'none' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  } catch (error) {
    again = error.message;
  }
  check('中断说明交付一次后，不会假装还有结果可等',
    typeof again === 'string' && again.includes('没有可接着等'), again);
}

{
  /*
   * 用户手动停止（wait:none + 后台监视）：
   * 中途查询要能看到过程稿；停止后查询要拿到 interrupted，而不是永远 running。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  await tool.execute(
    { task: '做件事', targets: ['乙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  emit('s-b', assistantEvent(1, '先给一版中间稿'));
  await settle();

  const peek = await tool.execute({ wait: 'none' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  check('wait:none 中途查询能看到过程稿',
    peek.results[0]?.status === 'running' && peek.results[0]?.progress.includes('先给一版中间稿'),
    JSON.stringify(peek.results));
  check('中途查询也明确标成未交付', peek.results[0]?.deliverable === false, JSON.stringify(peek.results));

  emit('s-b', turnEndEvent(2, 'aborted', { kind: 'user' }));
  await settle();
  const value = await tool.execute({ wait: 'none' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  check('后台监视也能识别用户手停',
    value.status === 'interrupted' && value.results[0]?.interruptedBy === 'user', JSON.stringify(value));
  check('领取中断说明后 pending 结清', service.pending.size === 0, String(service.pending.size));
}

{
  /*
   * 用户手停之后，A 不能越过用户去「纠正」目标；但可以先把中断说明取走。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  const service = ctx.get('paneDispatch');
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [{ id: 's-b', label: '乙会话' }] });

  await tool.execute(
    { task: '做件事', targets: ['乙会话'], wait: 'none' },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  emit('s-b', turnEndEvent(2, 'aborted', { kind: 'user' }));
  await settle();

  let message = null;
  try {
    await tool.execute(
      { task: '你应该改成 Y', targets: ['乙会话'] },
      { agent: { id: 's-a' }, signal: new AbortController().signal },
    );
  } catch (error) {
    message = error.message;
  }
  check('用户手停后 A 再带 task 会被拒绝，不越过用户去纠正',
    typeof message === 'string' && message.includes('接管') && message.includes('先省略 task'), message);

  const taken = await tool.execute({ wait: 'none' }, { agent: { id: 's-a' }, signal: new AbortController().signal });
  check('拒绝之后可以先把中断说明取走', taken.status === 'interrupted', JSON.stringify(taken));
}

{
  /*
   * 一个被用户接管、一个正常完成：整批是 partial，且两个目标的交付状态必须分开看。
   */
  const goals = fakeMultiGoals();
  const { tool, ctx, emit } = boot({ goals });
  ctx.get('paneDispatch').set({ owner: 's-a', ownerLabel: '甲', targets: twoTargets() });

  const waiting = tool.execute(
    { task: '分头办事', targets: ['乙会话', '丙会话'] },
    { agent: { id: 's-a' }, signal: new AbortController().signal },
  );
  await settle();
  goals.done('s-c', 'complete');
  emit('s-c', assistantEvent(1, '丙做完了'));
  emit('s-b', turnEndEvent(2, 'aborted', { kind: 'user' }));
  const value = await waiting;
  const yi = value.results.find((item) => item.target === '乙会话');
  const bing = value.results.find((item) => item.target === '丙会话');

  check('一个被接管、一个完成时，整批状态是 partial', value.status === 'partial', JSON.stringify(value));
  check('完成的目标标成已交付', bing?.deliverable === true && bing?.reply === '丙做完了', JSON.stringify(bing));
  check('被用户接管的目标标成未交付',
    yi?.deliverable === false && yi?.interruptedBy === 'user', JSON.stringify(yi));
  check('partial 的 note 提醒只有 deliverable 才是结论',
    value.note.includes('deliverable'), value.note);
}

report();
