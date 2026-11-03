/**
 * 「Host 重启后，派出去的单子还要认得回来」的离线契约测试。
 *
 * ## 为什么单独一个文件
 *
 * 这条契约守的是**跨进程边界**：`pending`（谁派给了谁、结论收没收到）只活在内存里，
 * 而目标会话的 goal 活在 DSH 的目标服务里 —— 后者重启不丢，前者重启就没了。两者一旦
 * 脱节，结果就成了谁也认不出的孤儿。
 *
 * 这类用例需要「同一个 DSH_HOME 装两次插件」，与其它用例的布景不同，所以独立成文件。
 *
 * ## 辨认依据
 *
 * 本插件派出去的任务，goal 的 objective 一定以 `[任务分派]` 开头（`wrapTask` 写死的）。
 * 重启后凭这个前缀把单子认回来 —— 不另存一份状态，goal 本身就是真相。
 *
 * 运行：`node test/dispatch-restart-contract.mjs`
 */
import {
  assistantEvent,
  boot,
  check,
  fakeMultiGoals,
  reboot,
  report,
  settle,
} from './dispatch-harness.mjs';

/** 发起方调用工具时的执行上下文。 */
const caller = () => ({ agent: { id: 's-a' }, signal: new AbortController().signal });

/** 一个可派目标的公共形状。 */
const yi = { id: 's-b', label: '乙会话' };

/** 调工具并吞掉异常，返回 `{ value }` 或 `{ error }` —— 拒绝路径也要能断言。 */
async function attempt(tool, args) {
  try {
    return { value: await tool.execute(args, caller()) };
  } catch (reason) {
    return { error: reason instanceof Error ? reason.message : String(reason) };
  }
}

/** 布景：装插件、连一条箭头、派一单（`wait: none`，派完就走），返回重启前的一切。 */
async function dispatchThenStop() {
  const goals = fakeMultiGoals();
  const first = boot({ goals });
  const service = first.ctx.get('paneDispatch');
  service.asyncRecheckMs = 20;
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [yi] });
  const started = await attempt(first.tool, { task: '补部署章节', targets: ['乙会话'], wait: 'none' });
  return { goals, first, firstService: service, started };
}

{
  /*
   * 主路径：重启时目标还在跑，重启后 A 回来接着等，最后拿到结论。
   * 这是最常见的情形 —— 重启时活还没干完。
   */
  const { goals, firstService, started } = await dispatchThenStop();
  check('派单本身成功', started.value?.status === 'dispatched', JSON.stringify(started));
  check('重启前内存里记着这一单', firstService.pending.size === 1, String(firstService.pending.size));

  // —— 模拟 Host 重启：同一个 DSH_HOME，同一个目标服务，内存状态归零 ——
  const second = reboot({ goals });
  const secondService = second.ctx.get('paneDispatch');
  check('重启后绑定表从磁盘读回（箭头还在）',
    secondService.bindings.get('s-a')?.length === 1,
    JSON.stringify(secondService.bindings.get('s-a')));
  check('重启后内存里的派单记录确实清零了（这是复现的前提）',
    secondService.pending.size === 0,
    String(secondService.pending.size));

  // 重启后第一件事：A 想看看那单怎么样了
  const peek = await attempt(second.tool, { wait: 'none' });
  check('重启后能接着等，而不是报「没有可接着等的派单」',
    peek.error === undefined,
    peek.error);
  check('还在跑的目标被恢复成 running',
    peek.value?.results?.[0]?.status === 'running',
    JSON.stringify(peek.value?.results));
  check('派单记录被重建，收尾提醒才有得数',
    secondService.pending.size === 1,
    String(secondService.pending.size));

  // 目标做完了，结论要能取回来
  goals.done('s-b', 'complete');
  second.emit('s-b', assistantEvent(1, '结论：补了三节'));
  await settle();
  const got = await attempt(second.tool, { wait: 'none' });
  check('重启后仍然能拿到目标最后的结论',
    got.value?.results?.[0]?.reply === '结论：补了三节',
    JSON.stringify(got.value?.results));
  check('取完之后结清，不会重复给',
    secondService.pending.size === 0,
    String(secondService.pending.size));
}

{
  /*
   * 另一种情形：目标在重启**之前**就做完了，只是 A 还没来得及取。
   * 这时 goal 已经是 complete，认回来之后要如实说「结论没能自动恢复」，
   * 而不是假装什么都没有发生、也不是报一句让人摸不着头脑的错。
   */
  const { goals, firstService } = await dispatchThenStop();
  goals.done('s-b', 'complete');
  check('重启前这一单还挂着没取', firstService.pending.size === 1, String(firstService.pending.size));

  const second = reboot({ goals });
  const got = await attempt(second.tool, { wait: 'none' });
  check('重启后仍能认回一个已完成、没取走的单子',
    got.error === undefined && got.value?.results?.[0]?.status === 'complete',
    got.error ?? JSON.stringify(got.value?.results));
  check('并明确说明：结论没能自动恢复，去目标会话看',
    typeof got.value?.results?.[0]?.reply === 'string'
      && got.value.results[0].reply.includes('重启')
      && got.value.results[0].reply.includes('乙会话'),
    JSON.stringify(got.value?.results?.[0]?.reply));
}

{
  /*
   * 反例：用户在目标会话里自己用 `/goal` 设的目标，objective 不以 `[任务分派]` 开头，
   * 绝不能被误认成派单 —— 认错了会让 A 去取一件它从没派过的事。
   */
  const goals = fakeMultiGoals();
  const first = boot({ goals });
  const service = first.ctx.get('paneDispatch');
  service.set({ owner: 's-a', ownerLabel: '甲', targets: [yi] });
  // 用户自己给乙会话设的目标，跟本插件无关。
  goals.create({ session: { id: 's-b' } }, { objective: '把登录流程重构成 OAuth' });

  const second = reboot({ goals });
  const peek = await attempt(second.tool, { wait: 'none' });
  check('不是本插件派的 goal 不会被误认成派单',
    peek.error !== undefined && peek.error.includes('没有可接着等的派单'),
    peek.error ?? JSON.stringify(peek.value?.results));
  check('也不会凭空在内存里造出一条派单记录',
    second.ctx.get('paneDispatch').pending.size === 0,
    String(second.ctx.get('paneDispatch').pending.size));
}

{
  /*
   * 反例：箭头已经被删掉（授权撤回），重启后不该再把那条边上的单子认回来。
   * 绑定表是「谁还能派给谁」的唯一权威，认领必须服从它。
   */
  const { goals, firstService } = await dispatchThenStop();
  check('重启前有一单在等着', firstService.pending.size === 1, String(firstService.pending.size));
  // 用户在设计模式里把箭头删了 —— 客户端会推一份空的目标集合上来。
  firstService.set({ owner: 's-a', ownerLabel: '甲', targets: [] });
  check('删箭头会同时作废还在等的记录（既有行为）',
    firstService.pending.size === 0,
    String(firstService.pending.size));

  const second = reboot({ goals });
  const peek = await attempt(second.tool, { wait: 'none' });
  check('箭头没了，重启后也不该把那条边上的单子认回来',
    peek.error !== undefined,
    peek.error ?? JSON.stringify(peek.value?.results));
  check('内存里没有凭空多出记录',
    second.ctx.get('paneDispatch').pending.size === 0,
    String(second.ctx.get('paneDispatch').pending.size));
}

{
  /*
   * 重启后 A 不主动查、直接想结束回合时，收尾提醒也要能响。
   *
   * 收尾提醒数的是 `pending`，所以会话重建时就得先把孤儿认回来 —— 光靠「调用工具时
   * 才认领」不够：A 可能一直没再调 `dispatch_task`，回合就静静结束了。
   */
  const { goals } = await dispatchThenStop();
  const agents = new Map([['s-a', { id: 's-a', status: 'idle', ctx: { tools: { register: () => () => {} } } }]]);
  const second = reboot({ goals, agents });

  // 模拟 A 的会话在重启后重新创建（真实环境里 `agent/created` 就是这么来的）。
  second.fire('agent/created', { agent: agents.get('s-a') });
  await settle();
  check('会话重建时就把孤儿单子认回来',
    second.ctx.get('paneDispatch').pending.size === 1,
    String(second.ctx.get('paneDispatch').pending.size));

  let injected = null;
  second.fire('agent/turn-stopping', {
    agent: { id: 's-a', inject: (message) => { injected = message; } },
    turn: 1,
  });
  check('重启后收尾提醒照常响，A 不会悄悄忘掉这一单',
    injected !== null && String(JSON.stringify(injected)).includes('没取结果'),
    JSON.stringify(injected));
}

report();
