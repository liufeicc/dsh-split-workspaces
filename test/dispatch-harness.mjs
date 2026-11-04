/**
 * 「任务分派」Host 半边的离线测试脚手架：宿主上下文替身、目标服务替身、事件注入，
 * 以及 `check` / `report` 这套断言记录。
 *
 * 三个用例文件共用它：
 *   - `dispatch-contract.mjs` —— 单目标、投递与等待、拒绝路径；
 *   - `dispatch-batch-contract.mjs` —— 批量、`wait: none`、后台监视、收尾提醒；
 *   - `dispatch-restart-contract.mjs` —— Host 重启后把派出去没取回的单子认回来。
 *
 * **DSH_HOME 必须在 import 插件之前指到临时目录**：Host 半边会把绑定表落到
 * `$DSH_HOME/storages/`，跑在真实目录上会吃到这台机器的在线配置。
 */import { mkdtempSync } from 'node:fs';
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

export const host = await import('../index.js');

const failures = [];
export function check(label, condition, detail) {
  if (condition) {
    console.log('ok   ' + label);
    return;
  }
  failures.push(label);
  console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}
export function report() {
  if (failures.length > 0) {
    console.error('\n' + String(failures.length) + ' check(s) failed');
    process.exitCode = 1;
    return;
  }
  console.log('\nall checks passed');
}

/** 让排队的 Promise 与它们的 then 链跑完。 */
export async function settle() {
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
  const otherListeners = new Map();
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
      if (event === 'session/event') {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      }
      // 其余事件（目前只有 agent/turn-stopping）也要能注册，否则「收尾提醒」测不到。
      const set = otherListeners.get(event) ?? new Set();
      set.add(handler);
      otherListeners.set(event, set);
      return () => {
        set.delete(handler);
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

  /** 往任意宿主事件派一条（`agent/turn-stopping` 这类钩子用）。 */
  const fire = (event, payload) => {
    for (const handler of [...(otherListeners.get(event) ?? [])]) handler(payload);
  };

  return { ctx, promptCalls, resolveCalls, registered, emit, fire, services };
}

/** 每个用例一个全新的 DSH_HOME —— 绑定表会落盘，共用一个目录会互相污染。 */
let homeSeq = 0;
/** 每个用例一个全新的 DSH_HOME（绑定表会落盘，共用目录会互相污染）。 */
export function freshHome() {
  homeSeq += 1;
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-dispatch-' + String(homeSeq) + '-'));
}

/** 装好插件，返回工具、服务与派事件的入口。 */
export function boot(options) {
  freshHome();
  const harness = createHostContext(options);
  host.apply(harness.ctx);
  const tool = harness.registered.find((definition) => definition.name === host.TOOL_NAME);
  return { ...harness, tool };
}

/**
 * 在**同一个 DSH_HOME** 下再装一次插件 —— 模拟 Host 进程重启。
 *
 * 与 `boot` 的唯一区别就是不换目录：绑定表必须从磁盘读回来，而内存里的派单状态
 * （`pending`）会像真实重启那样归零。`options.goals` 要传**同一个目标服务实例**，
 * 因为它代表「不在本进程里、重启也不会消失」的 DSH 目标服务。
 *
 * @param options - 同 `boot`。
 * @returns 同 `boot`。
 */
export function reboot(options) {
  const harness = createHostContext(options);
  host.apply(harness.ctx);
  const tool = harness.registered.find((definition) => definition.name === host.TOOL_NAME);
  return { ...harness, tool };
}

/** 我们自己投进去的那条用户消息。 */
export const userEvent = (seq, rpcId) => ({
  type: 'user/message',
  seq,
  time: 1,
  data: { id: 'm-' + seq, role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId } },
  surfaceOp: 'append',
});

/** 助手回复。 */
export const assistantEvent = (seq, text) => ({
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

/**
 * 一轮结束。
 *
 * 第三个参数是取消原因：用户按停止时是 `{ kind: 'user' }`，会写进
 * `reason.reason`（真实形状见 dsh-session 的 `TurnEndReasonMap`）。
 *
 * @param seq - 事件序号。
 * @param kind - `completed` / `aborted` / `blocked` / `error` 等。
 * @param cause - 可选，取消原因。
 */
export const turnEndEvent = (seq, kind, cause) => ({
  type: 'turn/end',
  seq,
  time: 3,
  data: { turn: 1, reason: cause === undefined ? { kind } : { kind, reason: cause } },
});

/** 造一个目标服务替身：记录创建请求，phase 由用例直接改。 */
export function fakeGoals({ failCreate = false } = {}) {
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
      // 真实形状是 { code, message }；早先的替身误写成了 explanation，把 bug 一起藏住了。
      this.view = { ...this.view, phase, blockedReason: explanation === undefined ? undefined : { code: 'round-limit', message: explanation } };
    },
  };
}

/**
 * 多目标版的目标服务替身：每个会话一个独立的 goal 视图。
 *
 * 单目标那版只有一个 `view`，两个目标会互相覆盖 —— 多目标用例必须按会话分开。
 *
 * @param options.failFor - 这些会话在创建目标时抛错，用来验证「部分失败」。
 */
export function fakeMultiGoals({ failFor = new Set() } = {}) {
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
        blockedReason: explanation === undefined ? undefined : { code: 'round-limit', message: explanation },
      });
    },
  };
}

/** 两个可派目标的公共布景。 */
export const twoTargets = () => [
  { id: 's-b', label: '乙会话' },
  { id: 's-c', label: '丙会话' },
];
