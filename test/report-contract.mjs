/**
 * `report_task` 的契约测试。
 *
 * 重点不是「模型答得好不好」（那没法离线断言），而是这几条不会退化的边界：
 *   - 最多 8 个目标；
 *   - 多目标真的是并行，而不是排队；
 *   - 一个目标失败/超时不影响其他目标；
 *   - 汇报请求带上当前 goal objective 和 A 的 ask；
 *   - 只读：不碰 pending / reviews / goal 状态；
 *   - 不依赖 BTW 插件。
 */

import { readFileSync } from 'node:fs';
import {
  boot,
  check,
  fakeMultiGoals,
  report,
  settle,
} from './dispatch-harness.mjs';

const OWNER = 's-a';

/**
 * 造一个目标会话替身：汇报需要 `deriveMessages()` 与 `requestHeader()`。
 *
 * @param id - 会话 id
 * @param text - 历史里最后一段助手文本
 * @returns session 替身
 */
function makeSession(id, text = '我已经完成 A 阶段，测试通过。') {
  return {
    id,
    requestHeader: () => ({ config: { provider: 'fake', model: 'fake-model' } }),
    deriveMessages: () => [
      { role: 'system', content: [{ type: 'text', text: '你是 ' + id + ' 的执行 agent。' }] },
      { role: 'user', content: [{ type: 'text', text: '任务正文：检查 MMC5 银行。' }] },
      { role: 'assistant', content: [{ type: 'text', text }] },
    ],
  };
}

/**
 * 造一个可控的假 LLM。
 *
 * `maxActive` 用来断言并行；`failFor` 用来模拟单目标失败；`delays` 用来模拟慢目标。
 *
 * @param options - `{ delays, failFor }`
 * @returns 假 LLM 服务
 */
function createFakeLlm({ delays = new Map(), failFor = new Set() } = {}) {
  let active = 0;
  let maxActive = 0;
  const requests = [];
  return {
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    requests,
    async *stream(request) {
      requests.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (failFor.has(request.sessionId)) {
          throw new Error('fake llm failed for ' + request.sessionId);
        }
        await waitWithAbort(delays.get(request.sessionId) ?? 5, request.signal);
        yield { type: 'text-delta', index: 0, text: '## 汇报\n' + request.sessionId + '：测试通过。' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        active -= 1;
      }
    },
  };
}

/**
 * 等待 ms 毫秒；带 abort 时立刻 reject，模拟真实流对取消信号的响应。
 * @param ms - 毫秒
 * @param signal - AbortSignal
 * @returns Promise
 */
function waitWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });
}

/**
 * 布景：一个新的宿主、一个发起方、若干目标、一个假 LLM。
 *
 * @param options - `{ count, goals, llm, sessions, historyMessages, timeoutMs }`
 * @returns 可供工具调用的布景
 */
function setup(options = {}) {
  const count = options.count ?? 1;
  const ids = Array.from({ length: count }, (_, index) => 's-' + String(index + 1));
  const goals = options.goals ?? fakeMultiGoals();
  const llm = options.llm === undefined ? createFakeLlm() : options.llm;
  const sessions = options.sessions ?? new Map(ids.map((id) => [id, makeSession(id)]));
  const agents = new Map();
  const harness = boot({ goals, sessions, llm, agents });
  const service = harness.ctx.get('paneDispatch');
  // `refresh()` 是从 agents 表里取 agent 的；测试里把发起方补进去，才会注册作用域工具。
  agents.set(OWNER, { id: OWNER, ctx: { tools: harness.ctx.tools } });
  service.set({
    owner: OWNER,
    ownerLabel: '发起方',
    targets: ids.map((id, index) => ({ id, label: '目标' + String(index + 1) })),
  });
  if (options.historyMessages !== undefined) service.reportHistoryMessages = options.historyMessages;
  if (options.timeoutMs !== undefined) service.reportTimeoutMs = options.timeoutMs;
  const reportTool = harness.registered.find((definition) => definition.name === host.REPORT_TOOL_NAME);
  return { ...harness, service, goals, llm, sessions, reportTool };
}

/**
 * 调一次 report_task。
 * @param context - setup 的返回值
 * @param args - 工具参数
 * @param signal - 取消信号
 * @returns 工具结果或抛出的错误
 */
async function callReport(context, args, signal = new AbortController().signal) {
  return context.reportTool.execute(args, { agent: { id: OWNER }, signal });
}

const host = await import('../index.js');

// ---------------------------------------------------------------------------
// 1. 注册、基本汇报、prompt 内容、只读
// ---------------------------------------------------------------------------
{
  const goals = fakeMultiGoals();
  goals.create({ session: { id: 's-1' } }, { objective: '[任务分派] 检查 MMC5 银行与武器层坐标' });
  const context = setup({ count: 1, goals });
  // `service.set` 会异步触发重启认领；先让它落定，再看汇报有没有改 pending。
  await settle();
  check('report_task 已注册', context.reportTool !== undefined);
  check('描述里列出可汇报目标', context.reportTool.description.includes('目标1'), context.reportTool.description);
  check('描述里写明最多 8 个', context.reportTool.description.includes('最多 8 个'), context.reportTool.description);

  const before = {
    pending: context.service.pending.size,
    reviews: context.service.reviews.size,
    created: context.goals.created.length,
    calls: JSON.stringify(context.goals.calls),
  };
  const result = await callReport(context, {
    targets: ['1'],
    ask: '汇报当前进度、已完成证据、是否偏离验收标准；区分事实/自述/推断/未知。',
  });
  check('基本汇报成功', result.status === 'reported', JSON.stringify(result));
  check('目标结果是 ok', result.results[0].status === 'ok', JSON.stringify(result.results[0]));
  check('汇报正文回来了', result.results[0].report.includes('测试通过'));
  check('返回 goalPhase', result.results[0].goalPhase === 'active', result.results[0].goalPhase);
  check('返回 asOf', typeof result.results[0].asOf === 'string' && result.results[0].asOf.length > 0);
  check('结果字段与 output schema 一致',
    Object.keys(result.results[0]).sort().join(',') === 'asOf,goalPhase,note,report,status,target,truncated',
    Object.keys(result.results[0]).sort().join(','));

  const request = context.llm.requests[0];
  check('system 里带只读汇报规则', request.system.includes('只读汇报模式'), request.system.slice(0, 200));
  check('system 里要求区分事实', request.system.includes('事实'), request.system.slice(0, 400));
  const lastText = request.messages.at(-1).content[0].text;
  check('请求里带 A 的 ask', lastText.includes('区分事实/自述/推断/未知'), lastText);
  check('请求里带 goal objective', lastText.includes('检查 MMC5 银行'), lastText);

  check('汇报没有改 pending', context.service.pending.size === before.pending);
  check('汇报没有改 reviews', context.service.reviews.size === before.reviews);
  check('汇报没有改 goal 状态', context.goals.created.length === before.created
    && JSON.stringify(context.goals.calls) === before.calls);
  check('一次调用只发一次汇报请求', context.llm.requests.length === 1, String(context.llm.requests.length));
}

// ---------------------------------------------------------------------------
// 2. 最多 8 个
// ---------------------------------------------------------------------------
{
  const context = setup({ count: 9 });
  let error;
  try {
    await callReport(context, {
      targets: Array.from({ length: 9 }, (_, index) => String(index + 1)),
      ask: '汇报进度。',
    });
  } catch (reason) {
    error = reason;
  }
  check('第 9 个目标被拒绝', error !== undefined && /最多汇报 8 个/.test(error.message), error?.message);
  check('被拒绝时没有发起模型请求', context.llm.requests.length === 0);
}

// ---------------------------------------------------------------------------
// 3. 8 个目标并行，而不是排队
// ---------------------------------------------------------------------------
{
  const llm = createFakeLlm({ delays: new Map(Array.from({ length: 8 }, (_, index) => ['s-' + String(index + 1), 40])) });
  const context = setup({ count: 8, llm });
  const result = await callReport(context, {
    targets: Array.from({ length: 8 }, (_, index) => String(index + 1)),
    ask: '汇报进度。',
  });
  check('8 个目标全部汇报成功', result.status === 'reported' && result.results.length === 8, JSON.stringify(result));
  check('8 个汇报请求确实并行', llm.maxActive === 8, 'maxActive=' + String(llm.maxActive));
}

// ---------------------------------------------------------------------------
// 4. 单目标失败不影响其他目标
// ---------------------------------------------------------------------------
{
  const llm = createFakeLlm({ failFor: new Set(['s-2']) });
  const context = setup({ count: 3, llm });
  const result = await callReport(context, {
    targets: ['1', '2', '3'],
    ask: '汇报进度。',
  });
  check('有一个失败时整批是 partial', result.status === 'partial', result.status);
  check('失败目标标成 error', result.results[1].status === 'error', JSON.stringify(result.results[1]));
  check('成功目标仍然是 ok', result.results[0].status === 'ok' && result.results[2].status === 'ok');
  check('失败原因写进 note', result.results[1].note.includes('fake llm failed'), result.results[1].note);
}

// ---------------------------------------------------------------------------
// 5. 单目标超时不影响其他目标
// ---------------------------------------------------------------------------
{
  const llm = createFakeLlm({ delays: new Map([['s-1', 120]]) });
  const context = setup({ count: 2, llm, timeoutMs: 20 });
  const result = await callReport(context, {
    targets: ['1', '2'],
    ask: '汇报进度。',
  });
  check('超时目标标成 timeout', result.results[0].status === 'timeout', JSON.stringify(result.results[0]));
  check('未超时目标仍然是 ok', result.results[1].status === 'ok', JSON.stringify(result.results[1]));
  check('整批是 partial', result.status === 'partial', result.status);
}

// ---------------------------------------------------------------------------
// 6. 没有 LLM 服务时逐目标报错，而不是把工具打崩
// ---------------------------------------------------------------------------
{
  const context = setup({ count: 1, llm: null });
  const result = await callReport(context, { targets: ['1'], ask: '汇报进度。' });
  check('没有 LLM 时返回 failed', result.status === 'failed', result.status);
  check('note 说明没有 LLM 服务', result.results[0].note.includes('LLM 服务'), result.results[0].note);
}

// ---------------------------------------------------------------------------
// 7. 历史被截断时把 truncated 带给 A
// ---------------------------------------------------------------------------
{
  const session = makeSession('s-1');
  const long = {
    ...session,
    deriveMessages: () => [
      { role: 'system', content: [{ type: 'text', text: 'system' }] },
      { role: 'user', content: [{ type: 'text', text: '旧任务 1' }] },
      { role: 'assistant', content: [{ type: 'text', text: '中间进度 1' }] },
      { role: 'user', content: [{ type: 'text', text: '旧任务 2' }] },
      { role: 'assistant', content: [{ type: 'text', text: '中间进度 2' }] },
      { role: 'user', content: [{ type: 'text', text: '最新任务' }] },
      { role: 'assistant', content: [{ type: 'text', text: '最新进度' }] },
    ],
  };
  const context = setup({ count: 1, sessions: new Map([['s-1', long]]), historyMessages: 2 });
  const result = await callReport(context, { targets: ['1'], ask: '汇报。' });
  check('历史截断时返回 truncated', result.results[0].truncated === true, JSON.stringify(result.results[0]));
  check('截断时 note 说明历史较长', result.results[0].note.includes('历史较长'), result.results[0].note);
}

// ---------------------------------------------------------------------------
// 8. 没连箭头的会话看不到 report_task
// ---------------------------------------------------------------------------
{
  const bare = boot({ goals: fakeMultiGoals(), sessions: new Map(), llm: createFakeLlm() });
  check('没有绑定时不注册 report_task',
    bare.registered.every((definition) => definition.name !== host.REPORT_TOOL_NAME));
}

// ---------------------------------------------------------------------------
// 9. 不依赖 BTW：实现文件里不能出现 BTW 的引用
// ---------------------------------------------------------------------------
{
  const source = readFileSync(new URL('../host.report.js', import.meta.url), 'utf8');
  check('host.report.js 不引用 BTW 插件', !/dsh-btw-command/i.test(source) && !/\bbtw\b/i.test(source));
  const toolSource = readFileSync(new URL('../host.tool.js', import.meta.url), 'utf8');
  check('host.tool.js 不引用 BTW 插件', !/dsh-btw-command/i.test(toolSource) && !/\bbtw\b/i.test(toolSource));
}

report();
