/**
 * 平铺面板的「委派绑定」块：把设计模式里画出来的箭头同步给 Host。
 *
 * ## 它在整条链路里的位置
 *
 *   1. **画箭头** —— `client.graph.view.js`（设计模式画布）；
 *   2. **把箭头换算成绑定并发给 Host** —— 本文件；
 *   3. **真正投递、等待、取回复** —— Host 半边 `index.js` 的 `dispatch_task` 工具。
 *
 * 界面上没有任何「选择目标」的菜单了：**边就是选择**。这一层因此只剩两件事 ——
 * 挂载自己的远端命名空间，以及在边变化时把完整的一张表推上去。
 *
 * ## 为什么每次都推整张表
 *
 * 客户端是选择的唯一权威：用户删掉一条箭头，客户端立刻知道「某人的目标少了一个」；
 * 而 Host 如果只收到「删一条」的增量，就必须自己维护「哪条」的语义（箭头没有 id，
 * 谁来标识它？）。整表替换把这个问题从结构上消掉：Host 收到的就是当前的真相，
 * 收完直接覆盖。代价是每次改边都发一次，但边是人工一条条画的，这个频率可以忽略。
 *
 * ## 远端命名空间为什么是手写的
 *
 * 手写 bundle 不能 `import '@deepseek-ai/*'`（Node 会按软链的真实路径解析，而 dsh
 * 安装目录不在解析路径上），所以生成式 `TypertRemoteService` 通常会带的东西都得
 * 手工写：本文件的描述符 + 宿主侧的 `typertRemote` 绑定与原型方法标记。范式来自同
 * 仓库的 `dsh-session-delete` 与 `dsh-mcp-workspace-policy`。
 *
 * 两条客户端规则（照抄既有实现，别改）：
 *   - `ctx.remote.$mount` 要求每个输入 codec 都是 `strict`；
 *   - 客户端 Typert 注册表又要求 strict codec 同时暴露 `create()` schema 工厂，
 *     所以输入带一个「原样通过」的工厂。它不会被用来校验参数：参数原样送到宿主，
 *     由宿主方法自己检查输入。
 *
 * 加载方式：入口 `client.js` 用 `require.async('./client.dispatch.js')` 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.dispatch.js',
  factory() {
    /** 远端命名空间键（也是 Host 服务键）。 */
    const DISPATCH_REMOTE_KEY = 'remote.paneDispatch';

    /** 包身份，用于构造远端描述符的 id。 */
    const PLUGIN_ID = '@local/dsh-split-workspaces';

    /** 服务键，与 Host 半边的 `SERVICE_KEY` 必须逐字相同。 */
    const SERVICE_KEY = 'paneDispatch';

    /**
     * 造一条方法描述符。
     * @param method - 宿主服务上的方法名。
     * @param typeSymbol - 该输入类型的标识串（只用于标识，不做校验）。
     * @returns 一条远端描述符。
     */
    function descriptorFor(method, typeSymbol) {
      return {
        id: PLUGIN_ID + '#' + SERVICE_KEY + '/' + method,
        service: SERVICE_KEY,
        namespace: SERVICE_KEY,
        method,
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: PLUGIN_ID + '#' + typeSymbol,
            create: () => ({ parse: (value) => value }),
          },
        }],
        result: { mode: 'src-json' },
      };
    }

    /** 本包暴露的方法：绑定 list/set，以及 Host 侧布局的 read/write/clear。 */
    const REMOTE_DESCRIPTORS = [
      descriptorFor('list', 'PaneDispatchListRequest'),
      descriptorFor('set', 'PaneDispatchSetRequest'),
      descriptorFor('readLayout', 'PaneLayoutReadRequest'),
      descriptorFor('writeLayout', 'PaneLayoutWriteRequest'),
      descriptorFor('clearLayout', 'PaneLayoutClearRequest'),
    ];

    /** 把任意抛出物转成一句人能读的话。 */
    function errorText(reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }

    /**
     * 从远端结果里取出绑定表。
     *
     * 服务没挂上**不是故障**：那说明 Host 半边没加载（旧版本、或者被禁用），与
     * 「本来就没有分派功能」在界面上应当是同一种静默处理，因此单独用 `notMounted`
     * 理由区分开，不当作错误上报。
     *
     * @param service - 惰性取到的远端命名空间，可能仍是 undefined。
     * @returns `{ ok: true, byOwner }` 或 `{ ok: false, reason }`。
     */
    async function readBindings(service) {
      if (service === undefined || service === null) return { ok: false, reason: 'notMounted' };
      let result;
      try {
        result = await service.list({});
      } catch (reason) {
        return { ok: false, reason: errorText(reason) };
      }
      if (result === undefined || result === null) return { ok: false, reason: 'notMounted' };
      if (!result.ok) {
        const code = result.error === undefined || result.error === null ? undefined : result.error.code;
        if (code === 'gateway/invocation-unavailable') return { ok: false, reason: 'notMounted' };
        return { ok: false, reason: result.error === undefined || result.error === null ? 'list failed' : result.error.message };
      }
      const value = result.value === undefined || result.value === null ? {} : result.value;
      const rows = Array.isArray(value.targets) ? value.targets : [];
      const byOwner = new Map();
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue;
        if (typeof row.owner !== 'string' || row.owner === '') continue;
        const targets = [];
        for (const item of Array.isArray(row.items) ? row.items : []) {
          if (item === null || typeof item !== 'object') continue;
          if (typeof item.id !== 'string' || item.id === '') continue;
          const target = { id: item.id, label: typeof item.label === 'string' && item.label !== '' ? item.label : item.id };
          if (typeof item.note === 'string' && item.note !== '') target.note = item.note;
          targets.push(target);
        }
        if (targets.length > 0) {
          byOwner.set(row.owner, {
            label: typeof row.ownerLabel === 'string' && row.ownerLabel !== '' ? row.ownerLabel : row.owner,
            targets,
          });
        }
      }
      return { ok: true, byOwner };
    }

    /**
     * 等远端命名空间挂上来。
     *
     * 为什么需要它：`ctx.remote.$mount` 是异步的（在入口的 effect 里发起），而主面板挂载
     * 时就会读一次绑定。两者赛跑，读早了会拿到 `notMounted` —— 第一版就是在这里直接放弃，
     * 于是**刷新页面后箭头全没了**（Host 磁盘上明明存着）。
     *
     * 有界等待：等不到就如实返回 undefined，交给调用方决定重试还是降级，绝不死循环。
     *
     * @param getService - 惰性解析远端命名空间的函数。
     * @param attempts - 最多尝试次数（默认 16 次 × 120ms ≈ 2 秒）。
     * @param delayMs - 每次间隔。
     * @returns 命名空间，或 undefined。
     */
    async function waitForService(getService, attempts = 16, delayMs = 120) {
      for (let index = 0; index < attempts; index += 1) {
        let service;
        try {
          service = getService();
        } catch {
          service = undefined;
        }
        if (service !== undefined && service !== null) return service;
        if (index === attempts - 1) return undefined;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return undefined;
    }

    /**
     * 把某个发起方的绑定集合整体写给宿主。
     * @param service - 远端命名空间。
     * @param owner - 发起方会话 id。
     * @param items - 目标数组 `[{ id, label }]`；空数组表示「这个人不再能派给谁」。
     * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
     */
    async function writeBindings(service, owner, entry) {
      if (service === undefined || service === null) return { ok: false, reason: 'notMounted' };
      const targets = Array.isArray(entry) ? entry : (entry === undefined || entry === null ? [] : entry.targets ?? []);
      const ownerLabel = entry === undefined || entry === null || Array.isArray(entry) ? undefined : entry.label;
      // 说明要原样送上去：Host 用它生成目标会话工具里的分工说明。
      let result;
      try {
        result = await service.set({ owner, ownerLabel, targets });
      } catch (reason) {
        return { ok: false, reason: errorText(reason) };
      }
      if (result === undefined || result === null) return { ok: false, reason: 'notMounted' };
      if (result.ok) return { ok: true };
      return { ok: false, reason: result.error === undefined || result.error === null ? 'set failed' : result.error.message };
    }

    /**
     * 绑定同步器。
     *
     * 只保留**上一次成功推上去的那张表**，用它和这次算出来的表做差：没变的发起方一个
     * 请求都不发（画一条边只该产生一两个来回，而不是整表重发）。这既省往返，也让
     * 「Host 挂掉后疯狂重试」不会把连接打满。
     *
     * @param getService - 惰性解析远端命名空间的函数。
     * @returns `{ getSnapshot, subscribe, load, sync }`。
     */
    function createDispatchSync(getService) {
      /** 状态只用于界面提示：`idle` / `loading` / `ready` / `unavailable` / `error`。 */
      let snapshot = { status: 'idle', error: null };
      const listeners = new Set();
      /** 上一次**成功**推上去的绑定表；失败时不更新，于是下次还会重试。 */
      let lastSent = new Map();
      /** 串行化：两次改动靠得近时，后一次必须等前一次落定再读 `lastSent`。 */
      let queue = Promise.resolve();
      /**
       * 最近一次视图交给我们的「期望表」。
       *
       * 为什么必须记着它：`load()` 是异步的，而视图的同步效果可能在它之前就跑过一次
       * （那时 `lastSent` 还是空，于是什么都没发）。等 `load()` 把 Host 的旧绑定读进
       * `lastSent` 之后，必须**拿这份期望表再算一次差**，否则 Host 上那些「页面里已经
       * 没有对应箭头」的残留绑定永远清不掉 —— 用户看到的就是「刷新之后箭头没了，
       * 但工具还在往老会话派活」。
       */
      let desired = new Map();
      /**
       * 首次读取是否已经完成。
       *
       * 必须等它才能推：页面刚挂载时视图的绑定表还是空的，此时推上去会把 Host 里
       * **上次保存的树**整张清掉 —— 用户刷新一次页面就丢了全部箭头。
       */
      let ready = false;
      const publish = (next) => {
        /*
         * 内容没变就不发新快照。
         *
         * 同步器在每次「绑定表重算」时都会被调一次，而 `useSyncExternalStore` 是按
         * **对象引用**判断变化的 —— 每次都换一个新对象，整块棋盘就会跟着白重渲染一遍。
         */
        if (snapshot.status === next.status && snapshot.error === next.error) return;
        snapshot = next;
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },

        /**
         * 读一次 Host 当前的绑定表。
         *
         * 返回值是**关键**：调用方拿它重建画布上的箭头（见 `client.view.js` 的采纳逻辑）。
         * 这里刻意**不自己 push** —— 因为「谁重建箭头」必须发生在调用方那边：本模块不
         * 认识图，它只认识绑定。
         *
         * @returns 成功时是 `Map<ownerId, { label, targets }>`；失败时 undefined。
         */
        async load() {
          if (snapshot.status !== 'loading') publish({ status: 'loading', error: null });
          /*
           * `getService()` 本身也可能抛（远端注册表还没就绪时）。它抛在 try 之外的话，
           * `load()` 会直接 reject —— 而调用方（视图的 effect）只 catch 不处理，于是
           * 「读一次」这件事就悄悄没发生过，后续同步却以为自己 ready 了。
           */
          let read;
          try {
            read = await readBindings(await waitForService(getService));
          } catch (reason) {
            read = { ok: false, reason: errorText(reason) };
          }
          if (!read.ok) {
            const notMounted = read.reason === 'notMounted';
            /*
             * 读失败**不置 ready**。
             *
             * 置了会出两件事：一是同步器以为自己知道「已经推过什么」，二是视图拿不到
             * 绑定表、也就恢复不出箭头 —— 而 Host 上其实存着用户画好的树。保持未就绪，
             * 调用方（视图）可以重试；重试期间也不会把空表推上去把存好的树清掉。
             */
            publish({ status: notMounted ? 'unavailable' : 'error', error: notMounted ? null : read.reason });
            return undefined;
          }
          lastSent = read.byOwner;
          ready = true;
          publish({ status: 'ready', error: null });
          return read.byOwner;
        },

        /**
         * 把一张完整的绑定表推上去。
         *
         * 差异的两个方向都要处理：新增/变更的发起方发一次 `set`；**从表里消失的**
         * 发起方也要发一次空集合 —— 否则用户删光某人的箭头之后，Host 那边还留着他
         * 原来的目标，「删了没效果」就是这么来的。
         *
         * @param desired - `Map<ownerSessionId, Array<{ id, label }>>`。
         * @returns `{ ok, error }`；`ok` 为真表示这一次已经和 Host 一致。
         */
        sync(next) {
          desired = next;
          // 首次读取还没回来：先记下期望，等 `load()` 完成后由它那一轮接手（见 `ready`）。
          if (!ready) return Promise.resolve({ ok: true, deferred: true });
          /*
           * 队列必须**抗一次异常**。
           *
           * `queue = queue.then(fn)` 这种写法有个隐蔽的后果：只要 `fn` 抛过一次，
           * `queue` 就永久变成 rejected，之后每一次 `.then(fn)` 都会跳过 `fn` 直接把
           * 拒绝传下去 —— 于是「画箭头不再生效」，而且没有任何可见报错。
           * 所以在链尾接一个 catch 把链路复位，并把这次失败当成普通返回值。
           */
          const run = async () => {
            const service = getService();
            if (service === undefined || service === null) {
              publish({ status: 'unavailable', error: null });
              return { ok: false, error: null };
            }
            const wantedTable = desired;
            const owners = new Set([...wantedTable.keys(), ...lastSent.keys()]);
            let failure = null;
            /* 绑定项现在是 `{ label, targets }`；比较只看目标集合，名字变了不算变化。 */
            const listOf = (entry) => (Array.isArray(entry)
              ? entry
              : (entry === undefined || entry === null ? [] : entry.targets ?? []));
            for (const owner of owners) {
              const wanted = wantedTable.get(owner);
              const current = lastSent.get(owner);
              const wantedList = listOf(wanted);
              const currentList = listOf(current);
              /*
               * 比较的签名必须**带上说明**。
               *
               * 只比 id 的话，「只改了说明、没改目标」会被判定成没变化而不推送 ——
               * 用户在箭头上写完分工说明、Host 那边却永远是旧的（或者干脆没有）。
               */
              const signature = (list) => list
                .map((item) => item.id + '\u0001' + (item.note ?? ''))
                .sort()
                .join('\u0000');
              if (signature(wantedList) === signature(currentList)) continue;
              const written = await writeBindings(service, owner, wanted);
              if (!written.ok) {
                if (written.reason === 'notMounted') {
                  publish({ status: 'unavailable', error: null });
                  return { ok: false, error: null };
                }
                failure = written.reason;
                break;
              }
              if (wantedList.length === 0) lastSent.delete(owner);
              else lastSent.set(owner, wanted);
            }
            publish(failure === null ? { status: 'ready', error: null } : { status: 'error', error: failure });
            return { ok: failure === null, error: failure };
          };
          queue = queue.then(run).catch((reason) => {
            const message = errorText(reason);
            publish({ status: 'error', error: message });
            return { ok: false, error: message };
          });
          return queue;
        },

        /**
         * 从 Host 读回保存的布局。
         *
         * @returns 保存结构；没有保存过时是 null；远端还没挂上时是 undefined
         *   （调用方可以重试，不能把 undefined 当成“没有保存”而直接清掉布局）。
         */
        async loadLayout() {
          let service;
          try {
            service = await waitForService(getService, 6, 100);
          } catch {
            return undefined;
          }
          if (service === undefined || service === null) return undefined;
          try {
            const result = await service.readLayout({});
            if (result === undefined || result === null) return undefined;
            if (!result.ok) {
              const code = result.error === undefined || result.error === null ? undefined : result.error.code;
              // 老版本 Host 没有布局方法：当作“没有保存过”，让界面回到默认播种，
              // 不要每 300ms 重试到超时。
              if (code === 'gateway/invocation-unavailable') return null;
              return undefined;
            }
            return result.value ?? null;
          } catch {
            return undefined;
          }
        },

        /**
         * 把布局写到 Host。
         *
         * @param {object} payload - 客户端保存结构。
         * @returns {{ok: boolean, reason?: string}}
         */
        async saveLayout(payload) {
          let service;
          try {
            service = await waitForService(getService);
          } catch (reason) {
            return { ok: false, reason: errorText(reason) };
          }
          if (service === undefined || service === null) return { ok: false, reason: 'notMounted' };
          try {
            const result = await service.writeLayout({ layout: payload });
            if (result === undefined || result === null) return { ok: false, reason: 'notMounted' };
            if (!result.ok) {
              return { ok: false, reason: result.error === undefined || result.error === null ? 'writeLayout failed' : result.error.message };
            }
            // Host 方法没有抛错、远程 result.ok 为真，就已经完成落盘。
            // 不再额外要求 value 必须是某个具体形状：Typert 的 src-json 对原始
            // 布尔值/对象包装的返回不完全一致，按 value 判断会把已经写成功的保存
            // 误报成失败。
            return { ok: true };
          } catch (reason) {
            return { ok: false, reason: errorText(reason) };
          }
        },

        /**
         * 删除 Host 上的布局记录。
         *
         * @returns {{ok: boolean, reason?: string}}
         */
        async clearLayout() {
          let service;
          try {
            service = await waitForService(getService);
          } catch (reason) {
            return { ok: false, reason: errorText(reason) };
          }
          if (service === undefined || service === null) return { ok: false, reason: 'notMounted' };
          try {
            const result = await service.clearLayout({});
            if (result === undefined || result === null) return { ok: false, reason: 'notMounted' };
            if (!result.ok) {
              return { ok: false, reason: result.error === undefined || result.error === null ? 'clearLayout failed' : result.error.message };
            }
            return { ok: true };
          } catch (reason) {
            return { ok: false, reason: errorText(reason) };
          }
        },
      };
    }

    return {
      DISPATCH_REMOTE_KEY,
      REMOTE_DESCRIPTORS,
      errorText,
      readBindings,
      writeBindings,
      waitForService,
      createDispatchSync,
    };
  },
});