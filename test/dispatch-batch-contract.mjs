/**
 * 「任务分派」的批处理契约测试：一次派给多个目标、`wait: all | any | none`、
 * 后台监视、以及回合收尾前的自动提醒。
 *
 * 跑法：`node test/dispatch-batch-contract.mjs`
 */
import {
  assistantEvent, boot, check, fakeMultiGoals, host, report, settle, twoTargets,
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

report();

report();
