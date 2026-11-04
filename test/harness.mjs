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
  /** 是否真的执行 `useEffect`。默认 false，见下面那段的说明。 */
  effectsEnabled: false,
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: (callback) => callback,
  /**
   * `useEffect` 的替身：**真的会跑**。
   *
   * 原来这里是空实现，于是「挂载时读一次绑定表、把上次画的箭头恢复出来」这类行为
   * 在离线测试里根本没被执行过 —— 2026-11-02「重启后箭头没了」就是这么漏出去的。
   *
   * 语义按真实 React 的最小集实现：
   *   - 依赖数组按项比较，没变就不重跑；
   *   - 没有依赖数组（undefined）每次渲染都跑；
   *   - 返回的函数作为清理，在重跑之前与卸载时调用。
   * 卸载那条目前只有 `mount()` 暴露的 `unmount()` 会触发（组件树整体丢弃时才需要）。
   */
  useEffect: (effect, deps) => {
    /*
     * 默认**不执行**：很多既有用例的断言建立在「副作用没跑过」之上，一旦全跑会让
     * 那些用例进入渲染循环。需要验证「挂载时做了什么」的用例把 `effectsEnabled`
     * 打开即可。
     */
    if (ReactStub.effectsEnabled !== true) return;
    const owner = currentRender;
    const slot = owner.cursor++;
    const previous = owner.hooks[slot];
    const changed = previous === undefined
      || deps === undefined
      || previous.deps === undefined
      || deps.length !== previous.deps.length
      || deps.some((value, index) => !Object.is(value, previous.deps[index]));
    if (!changed) return;
    if (previous !== undefined && typeof previous.cleanup === 'function') {
      try {
        previous.cleanup();
      } catch {
        /* 清理抛错不该拦住新的副作用 */
      }
    }
    const record = { deps: deps === undefined ? undefined : deps.slice(), cleanup: undefined };
    owner.hooks[slot] = record;
    const cleanup = effect();
    if (typeof cleanup === 'function') record.cleanup = cleanup;
  },
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
 * 真实客户端里菜单用 `react-dom` 的 portal 挂到 body（否则会被窗格
 * `overflow:hidden` 裁掉）。离线测试不需要真正的 DOM 容器，直接返回 children
 * 即可 —— 菜单内容仍会出现在渲染树里，现有断言不用改。
 */
export const ReactDomStub = {
  createPortal: (children) => children,
};

/*
 * 组件里用了 `useLayoutEffect` 做菜单定位。离线替身没有布局阶段，复用
 * `useEffect` 的依赖比较即可；测试默认不执行 effect，所以不会碰 window。
 */
ReactStub.useLayoutEffect = ReactStub.useEffect;

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
  // `react-dom` 是菜单 portal 的依赖，所有用例都默认带上；调用方仍可覆盖。
  const merged = { 'react-dom': ReactDomStub, ...modules };
  return definition.factory(createChunkRequire({ ownerId: definition.id, dir, modules: merged }));
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
    /**
     * 换一份 props 后重渲染，模拟「父组件传下了新值」。
     *
     * 插件的注入面是每次注册时算一次的快照，因此测试要覆盖「一开始没有删除服务、
     * 后来有了」这类变化，就必须能像真实父组件那样再传一份 props 下来。
     */
    updateProps(next) {
      instance.props = next;
      instance.render();
      return instance.tree;
    },
    /** 卸载：按逆序调用所有 effect 的清理函数，模拟组件树被丢弃。 */
    unmount() {
      for (let index = instance.hooks.length - 1; index >= 0; index -= 1) {
        const record = instance.hooks[index];
        if (record !== null && typeof record === 'object' && typeof record.cleanup === 'function') {
          try {
            record.cleanup();
          } catch {
            /* ignore */
          }
          record.cleanup = undefined;
        }
      }
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
  /**
   * 远端命名空间的处理函数表：`{ paneDispatch: { list: () => ... } }`。
   * 用例在渲染前往里放，`$mount` 之后由服务表转发过去。
   */
  const remoteHandlers = {};
  /** 远端命名空间挂载记录（`ctx.remote.$mount` 的替身往里写）。 */
  const mounted = [];
  /** 卸载记录（disposer 被调用时写）。 */
  const unmounted = [];
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
      /**
       * `t(key)` / `t(key, params)`：把词典里那条文案取出来，并按真实框架的
       * `{name}` 语法替换参数。参数替换照做而不是忽略，是因为「会话名有没有跟着
       * 按钮走」正是删除这类逐行按钮要断言的东西；忽略参数会让那种断言变成空话。
       */
      bind: () => (key, params) => {
        const template = dictionary[key] === undefined ? key : dictionary[key];
        if (params === undefined || params === null) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
      },
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
    /*
     * 远端网关替身：`$mount` 记下这次挂载的描述符，测试据此断言
     * 「paneDispatch 命名空间真的挂上去了、方法就那两个」。
     * 返回的 disposer 也记下来，让卸载路径能被检查。
     */
    remote: {
      agentPresets,
      /*
       * 真实实现会在挂载后把命名空间登记成 `remote.<namespace>`，客户端随后用
       * `ctx.get('remote.<namespace>')` 拿到方法。替身照做 —— 否则「读一次绑定表」
       * 这类路径在测试里永远走到 `notMounted`，测不到真问题。
       */
      $mount: (options) => {
        mounted.push(options);
        const namespace = Array.isArray(options?.descriptors) && options.descriptors.length > 0
          ? options.descriptors[0].namespace
          : undefined;
        if (namespace !== undefined) {
          const service = {};
          for (const descriptor of options.descriptors) {
            service[descriptor.method] = async (request) => {
              const handler = remoteHandlers[namespace]?.[descriptor.method];
              if (typeof handler !== 'function') {
                return { ok: false, error: { code: 'gateway/invocation-unavailable', message: 'no handler' } };
              }
              return handler(request);
            };
          }
          services.set('remote.' + namespace, service);
        }
        return Promise.resolve(() => {
          unmounted.push(options);
          if (namespace !== undefined) services.delete('remote.' + namespace);
        });
      },
    },
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
  return { ctx, registered, calls, connection, fixedShortcuts, effects, services, mounted, unmounted, remoteHandlers };
}
