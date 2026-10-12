/**
 * 离线测试公用工具：不依赖浏览器与 Host，用替身驱动 `client.js`。
 *
 * 说明：
 *  - `loadBundle` 按浏览器模块加载器的方式装载插件入口，并模拟包内代码块
 *    （`require.async('./client.xxx.js')`）：真的去 import 同目录下的文件，还会校验
 *    代码块注册的 id 是否等于「入口 id + 文件名」，与宿主 loader 的规则一致；
 *  - `ReactStub` 用最小实现替代 React：元素只是普通对象树，Hook 只是槽位，
 *    因此可以像真实渲染那样反复重渲染并检查渲染结果。
 */
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 当前正在渲染的组件实例，供 Hook 替身定位槽位。 */
let currentRender;

/** React 替身：createElement 生成普通树，Hook 只做记录。 */
export const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: (callback) => callback,
  useEffect: () => {},
  useMemo: (compute) => compute(),
  useRef: (initial) => {
    const owner = currentRender;
    const slot = owner.cursor++;
    if (!(slot in owner.hooks)) owner.hooks[slot] = { current: initial };
    return owner.hooks[slot];
  },
  useState: (initial) => {
    const owner = currentRender;
    const slot = owner.cursor++;
    if (!(slot in owner.hooks)) owner.hooks[slot] = typeof initial === 'function' ? initial() : initial;
    return [owner.hooks[slot], (next) => {
      const value = typeof next === 'function' ? next(owner.hooks[slot]) : next;
      if (Object.is(value, owner.hooks[slot])) return;
      owner.hooks[slot] = value;
      owner.dirty = true;
    }];
  },
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

/**
 * 造一个工厂用的 `require`：种子模块（react 等）来自 `modules`，
 * 相对路径的 `require.async` 按 loader 的规则装载同目录代码块。
 */
export function createChunkRequire({ ownerId, dir, modules }) {
  const require = (spec) => {
    if (Object.prototype.hasOwnProperty.call(modules, spec)) return modules[spec];
    throw new Error('unexpected Client require: ' + spec);
  };
  require.async = async (spec) => {
    if (!spec.startsWith('./')) {
      if (Object.prototype.hasOwnProperty.call(modules, spec)) return modules[spec];
      throw new Error('unexpected Client async require: ' + spec);
    }
    const fileName = spec.slice(2);
    const definition = await loadDefinition(join(dir, fileName));
    const expected = ownerId + '/' + fileName;
    if (definition.id !== expected) {
      throw new Error('chunk registered as ' + definition.id + ', expected ' + expected);
    }
    return definition.factory(require);
  };
  return require;
}

/**
 * 装载一个浏览器包文件并取出它向 `__ModuleLoader__` 注册的定义。
 *
 * 真实的模块系统只有一个全局加载器；这里为了逐个捕获注册，需要临时替换
 * `window.__ModuleLoader__`，因此必须串行执行：并发替换会互相覆盖，
 * 后评估的代码块会把定义写进别人的闭包里。
 */
export function loadDefinition(path) {
  const run = importQueue.then(() => importWithStub(path));
  importQueue = run.then(() => {}, () => {});
  return run;
}

/** 串行队列尾指针。 */
let importQueue = Promise.resolve();

/** 替换加载器、import 目标文件，并取回它注册的定义。 */
async function importWithStub(path) {
  let definition;
  const hadWindow = 'window' in globalThis;
  const previous = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value; } } };
  try {
    await import(pathToFileURL(path).href);
  } finally {
    if (hadWindow) globalThis.window = previous;
    else delete globalThis.window;
  }
  if (definition === undefined) throw new Error('bundle did not register with __ModuleLoader__: ' + path);
  return definition;
}

/**
 * 装载插件入口，返回其 factory 的导出。
 * @param path - 入口文件（`client.js`）的绝对路径。
 * @param modules - 种子模块表，例如 `{ react: ReactStub }`。
 */
export async function loadBundle(path, modules) {
  const definition = await loadDefinition(path);
  const dir = dirname(path);
  return definition.factory(createChunkRequire({ ownerId: definition.id, dir, modules }));
}

/**
 * 挂载一个组件并保留它的 Hook 状态：这样由 Promise 回调触发的 setState
 * 也能像真实渲染那样被 flush 后检查。
 */
export function mount(component, props) {
  const instance = {
    component,
    props,
    hooks: [],
    cursor: 0,
    dirty: false,
    tree: null,
    render() {
      instance.cursor = 0;
      instance.dirty = false;
      currentRender = instance;
      try {
        instance.tree = component(instance.props);
      } finally {
        currentRender = undefined;
      }
      return instance.tree;
    },
    /** 在仍有挂起的状态变更时重渲染。 */
    flush() {
      let guard = 0;
      while (instance.dirty && guard < 20) {
        guard += 1;
        instance.render();
      }
      return instance.tree;
    },
  };
  instance.render();
  return instance;
}

/** 让排队的 Promise 与它们的 then 链跑完。 */
export async function settle() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 只读可观察源的替身，快照固定。 */
export function source(value) {
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

/** 收集渲染树中所有满足条件的元素。 */
export function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (node.type !== undefined && predicate(node)) found.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, found);
  return found;
}

/** 按组件函数名匹配元素。 */
export const byName = (name) => (node) => typeof node.type === 'function' && node.type.name === name;

/** 按 class 名匹配元素（class 是空格分隔的字符串）。 */
export const byClass = (token) => (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes(token);

/** 按自定义 data 属性匹配元素。 */
export const byData = (name) => (node) => node.props[name] !== undefined;

/** Client Context 替身：记录槽位注册、词典、固定快捷键与到达宿主命名空间的调用。 */
export function createStubContext({ presets = [], respond } = {}) {
  const registered = [];
  const calls = [];
  /** 插件通过 `registerFixed` 登记的固定快捷键（按登记顺序）。 */
  const fixedShortcuts = [];
  /** 装上的副作用（含标签与卸载函数）：`ctx.effect` 一调用就执行，并记在这里。 */
  const effects = [];
  /**
   * `ctx.get` 的替身表：测试往里放假的远端命名空间 / 服务，没放就是「这个部署没有它」。
   * 真实的 `ctx.get` 就是这么回答「有没有这个服务」的，因此插件的降级分支能被真的走到。
   */
  const services = new Map();
  let dictionary = {};
  const connection = { handler: undefined };
  const respondTo = respond ?? (() => ({ ok: true, value: { presets } }));
  const agentPresets = {
    list: () => {
      calls.push({ namespace: 'agentPresets', method: 'list' });
      return Promise.resolve(respondTo('list'));
    },
    select: (sessionId, presetId) => {
      calls.push({ namespace: 'agentPresets', method: 'select', sessionId, presetId });
      return Promise.resolve(respondTo('select', sessionId, presetId));
    },
  };
  const ctx = {
    effect: (callback, label) => {
      const dispose = callback();
      const clean = typeof dispose === 'function' ? dispose : () => {};
      effects.push({ label, dispose: clean });
      return clean;
    },
    on: (event, handler) => {
      if (event === 'connection/reset') connection.handler = handler;
      return () => {};
    },
    locale: {
      register: (_ns, dict) => {
        dictionary = dict.zh;
        return () => {};
      },
      bind: () => (key) => (dictionary[key] === undefined ? key : dictionary[key]),
    },
    slots: {
      inject: (_key, callback) => {
        callback();
      },
      register: (options, component) => {
        registered.push({ ...options, component });
        return () => {};
      },
    },
    remote: { agentPresets },
    /** 服务查找：只认测试往里放的替身（`ctx.get` 是 Cordis 的原生 API）。 */
    get: (key) => services.get(key),
    /**
     * `ctx.inject(deps, callback)` 的替身。
     *
     * 真实 Cordis 只在依赖齐全时才调用回调，并给一个作用域 ctx；替身里所有服务都当作
     * 已就绪，因此直接同步调用回调。这样「插件在缺服务时该不该降级」仍然由插件自己决定
     * （它可以选择不 inject），而测试不必模拟依赖解析。
     */
    inject: (_deps, callback) => {
      callback(ctx);
      return () => {};
    },
    shortcuts: {
      /** 只实现被用到的部分：把绑定转成可读键位。 */
      describeBinding: (binding) => ({ keys: [...binding.modifiers, binding.code] }),
      registerFixed: (command) => {
        fixedShortcuts.push(command);
        return () => {};
      },
    },
    sessions: { create: () => Promise.resolve('session-created'), retain: () => ({ release: () => {} }) },
    workspaces: { list: source({ items: [], archivedSessionIds: [] }) },
    uiWorkspace: { pickDirectory: () => Promise.resolve(null) },
  };
  return { ctx, registered, calls, connection, fixedShortcuts, effects, services };
}
