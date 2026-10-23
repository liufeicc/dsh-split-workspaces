/**
 * 多工作区平铺 —— 客户端入口块。
 *
 * 它在 Web 界面里提供三样东西：
 *   1. 侧边栏的一行图标（`sidebar.panellist`），点开把主区切到本面板；
 *   2. 主面板本身（`main`，key = `split-workspaces`）：一块可以上下左右平铺、
 *      拖动分隔条改大小的棋盘，每个窗格是一个工作区的对话；
 *   3. 每个窗格里的对话本体（`split-workspaces.pane` 子槽位）：在显式的
 *      `SessionProvider` 绑定下复用共享的 `conversation.content` Factory。
 *
 * 每个窗格各自持有一个会话引用（`ctx.sessions.retain`，来源标记 `splitWorkspaces`），
 * 所以侧边栏的主选择不受影响，多个会话可以同时开着。
 *
 * 另外它给面板提供一个 `openWorkspaceDirectory(path)`：窗格标题栏上的文件夹按钮用它
 * 把该窗格的工作区目录交给系统文件管理器。实现走已经装好的 Session 命名空间
 * （`canOpenWorkspacePath` + `openWorkspacePath`），Host 半边不需要任何新代码，
 * 理由见下面那组常量的注释。
 *
 * ## 代码分块
 * DSH 的浏览器模块系统支持「包内代码块」：入口用 `require.async('./client.xxx.js')`
 * 请求同目录下的文件，宿主按 `/plugins/<包名>/client.xxx.js?rev=<版本>` 提供。
 * 于是这个插件的源码被拆成职责单一的几个文件：
 *   - `client.styles.js`  样式表与 class 名；
 *   - `client.dicts.js`   中英文案；
 *   - `client.model.js`   布局树、面板存储、会话解析（纯逻辑，可脱浏览器测试）；
 *   - `client.presets.js` Agent 模式（预设）的读取与应用；
 *   - `client.view.js`    React 组件；
 *   - 本文件             装载以上各块、注册插槽、注入样式。
 * 由于代码块之间不能互相 require，本文件负责把样式、模型、模式工具注入视图块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces',
  factory(require) {
    /** 主面板 key，同时也是侧边栏那一行的 id（两者必须一致：那一行就是选它）。 */
    const PANEL_ID = 'split-workspaces';
    /** 本面板声明、由每个窗格占用的子槽位。 */
    const PANE_SLOT = 'split-workspaces.pane';
    /** 本插件拥有的词典命名空间。 */
    const NS = 'split-workspaces';
    /** 注入样式表的身份标记。 */
    const CSS_ID = '@local/dsh-split-workspaces/client.css';
    const PLUGIN_ID = '@local/dsh-split-workspaces';

    /*
     * 「用文件管理器打开目录」用的是 dsh 自带的 Session 远端命名空间
     * （`@deepseek-ai/dsh-api-session-controller`，它的客户端半边本来就在本插件的注入
     * 列表里）那两个方法：
     *   - `canOpenWorkspacePath()` —— 这个部署能不能把路径交给桌面（没有图形环境的
     *     Linux 容器会答 false，那正是「你面前没有文件管理器」的意思）；
     *   - `openWorkspacePath({ path })` —— 先在组合文件系统里**校验**这个路径确实是
     *     Host 上的一个目录，再按操作系统的关联打开它；目录的关联就是文件管理器
     *     （Linux `xdg-open`、macOS Finder、Windows 资源管理器）。
     * 所以本插件不需要自己的 Host 半边，也不需要猜「这台机器上该跑哪条命令」。
     */
    const SESSION_REMOTE_KEY = 'remote.session';

    /**
     * 「删除一个会话」的客户端服务键，由 `@local/dsh-session-delete` 的客户端半边用
     * `ctx.provide` 发布，形状是 `{ request({ sessionId, displayTitle, onDeleted }) }`。
     *
     * 与上面那个 Session 命名空间、以及 MCP 策略服务一样，它**不能**写进本插件的
     * inject 列表：inject 是「本插件激活的前置条件」，而提供方是另一个插件的客户端
     * 半边，写进去就成了先有鸡还是先有蛋。因此只在用户真的点了「删除会话」时用
     * `ctx.get` 惰性解析一次；取不到就明说「删除功能还没准备好」，而不是假装删掉了。
     *
     * 为什么删除要绕道那个插件的服务、而不是本插件直接调 `remote.sessionDelete`：
     * 永久删除不是一次远端调用就完了 —— 确认、运行中先停止、删完通知会话列表都在那扇
     * 窗后面。这是一条不可恢复的破坏性操作，实现只该有一份。
     */
    const SESSION_DELETE_UI_KEY = 'sessionDeleteUi';

    /**
     * `openWorkspacePath` 的失败码 → 词典键。
     *
     * 三个码是网关/控制器自己给的：路径验不过（`bad-request`）、底层打开命令失败
     * （`internal`）、这次调用被取消（`cancelled`）。本地化说法在前，Host 的原文当
     * 细节附在后面：用户先看到自己认得的语言，需要深究时细节也在。
     */
    const OPEN_ERROR_KEYS = {
      'gateway/bad-request': 'pane.openBadPath',
      'gateway/internal': 'pane.openLaunchFailed',
      'gateway/cancelled': 'pane.openCancelled',
    };

    /**
     * 把一次打开的失败翻成**一整句**给用户看的话。
     *
     * 返回整句而不是半句，是因为窗格的错误行直接显示这句话：那句行上同时会出现
     * 「新建会话失败」「切换模式失败」等别的失败，前缀必须由各自的生产者给，
     * 不能由渲染处统一加（否则「打开会话失败: 目录不存在」这种张冠李戴的句子就出来了）。
     *
     * @param error - 远端结果的 `error`（`{ code, message }`）。
     * @param t - 本插件的翻译函数。
     * @returns 可直接显示的文案。
     */
    function openFailureText(error, t) {
      const code = error === null || error === undefined ? undefined : error.code;
      const message = error === null || error === undefined ? undefined : error.message;
      const key = OPEN_ERROR_KEYS[code];
      const headline = t('pane.openFailed') + (key === undefined ? '' : ': ' + t(key));
      return headline + (typeof message === 'string' && message !== '' ? ' (' + message + ')' : '');
    }

    /**
     * `Alt+方向键` 的四条固定快捷键声明：id、词典键、物理键码。
     *
     * 键位本身由棋盘自己的键盘处理实现（见 `client.view.js` 的 `onKeyDownCapture`）；
     * 这里把它们登记进框架的快捷键名册，是为了让用户在「设置 → 快捷键」里**看得见**
     * 这组键，同时让框架把它们记为已占用 —— 谁想把 Alt+方向键配给别的命令都会看到冲突。
     */
    const PANE_FOCUS_SHORTCUTS = [
      { id: 'fixed.split-pane-left', label: 'pane.focusLeft', code: 'ArrowLeft' },
      { id: 'fixed.split-pane-right', label: 'pane.focusRight', code: 'ArrowRight' },
      { id: 'fixed.split-pane-up', label: 'pane.focusUp', code: 'ArrowUp' },
      { id: 'fixed.split-pane-down', label: 'pane.focusDown', code: 'ArrowDown' },
    ];

    /** 各代码块的文件名；顺序与 `loadChunks` 里解构的一致。 */
    const CHUNK_FILES = [
      './client.styles.js',
      './client.dicts.js',
      './client.model.js',
      './client.presets.js',
      './client.mcp.js',
      './client.menu.js',
      './client.pane.js',
      './client.view.js',
    ];

    /**
     * 装载本插件的全部代码块，按名字打包返回。
     *
     * 加载在校验阶段就开始（不等到 `apply`），因此面板第一次渲染时通常已经就绪。
     * 任何一个块加载失败都会让整块棋盘不可用，所以失败时要让错误浮出来，
     * 而不是留下一个永远转圈的面板。
     */
    function loadChunks(require) {
      if (typeof require.async !== 'function') {
        return Promise.reject(new Error('client module loader 不支持包内代码块（require.async 缺失）'));
      }
      return Promise.all(CHUNK_FILES.map((file) => require.async(file)))
        .then(([styles, dicts, model, presets, mcp, menu, pane, view]) => ({ styles, dicts, model, presets, mcp, menu, pane, view }));
    }

    /** 本次插件实例的代码块装载（每个 factory 执行一次）。 */
    const chunks = loadChunks(require);

    /**
     * 客户端主流程。
     *
     * 这是一个 async 函数：插件注册插槽前先等代码块到位，这样插槽的 `inject`
     * 面里拿到的就是已经建好的面板存储与模式存储（框架会按 registration 缓存
     * inject 结果，所以这里必须一次给对）。
     */
    async function apply(ctx) {
      const mods = await chunks;
      const css = mods.styles.css;
      const cx = mods.styles.cx;
      // 三个块各自只认自己需要的依赖：菜单零件不碰模型，窗格不碰布局树，
      // 棋盘（view）再把另外两块用在它需要的地方。
      const menu = mods.menu.createMenu({ css, cx });
      const pane = mods.pane.createPane({
        css,
        cx,
        errorText: mods.presets.errorText,
        model: mods.model,
        presets: mods.presets,
        menu,
        paneSlot: PANE_SLOT,
      });
      const view = mods.view.createView({
        css,
        cx,
        errorText: mods.presets.errorText,
        model: mods.model,
        menu,
        pane,
      });

      // 样式表：同一个页面重复加载时只插一次。
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']');
        if (existing !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = CSS_ID;
        tag.textContent = mods.styles.CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'split-workspaces: styles');

      ctx.effect(() => ctx.locale.register(NS, { zh: mods.dicts.zh, en: mods.dicts.en }), 'split-workspaces: dictionaries');
      const t = ctx.locale.bind(NS);

      const paneStore = mods.model.createPaneStore();
      const agentPresets = ctx.remote.agentPresets;
      const presetStore = mods.presets.createPresetStore(agentPresets);
      /*
       * MCP 策略服务由 @local/dsh-mcp-workspace-policy 的客户端半边挂载，**不能**写进
       * 本插件的 inject 列表（那时它还没挂上，会形成先有鸡还是先有蛋）；因此惰性解析：
       * 每次需要时才 ctx.get 一次，取不到就按「没就绪」静默处理。
       */
      const mcpStore = mods.mcp.createMcpStore(() => ctx.get(mods.mcp.MCP_REMOTE_KEY));
      /** 交给组件层的动作集合：组件只调这里，不直接碰存储内部。 */
      const paneActions = {
        addPane: (workspaceId, sessionId) => paneStore.addPane(workspaceId, sessionId),
        splitPane: (key, dir, workspaceId) => paneStore.splitPane(key, dir, workspaceId),
        replaceWorkspace: (key, workspaceId) => paneStore.replaceWorkspace(key, workspaceId),
        swapPanes: (keyA, keyB) => paneStore.swapPanes(keyA, keyB),
        removePane: (key) => paneStore.removePane(key),
        closeAll: () => paneStore.closeAll(),
        setSession: (key, sessionId) => paneStore.setSession(key, sessionId),
        forgetSession: (sessionId) => paneStore.forgetSession(sessionId),
        setPreset: (key, preset) => paneStore.setPreset(key, preset),
        setActive: (key) => paneStore.setActive(key),
        setRatio: (splitId, ratio) => paneStore.setRatio(splitId, ratio),
        balance: () => paneStore.balance(),
        ensureInitialized: (currentWorkspaceId, workspaceIds) => paneStore.ensureInitialized(currentWorkspaceId, workspaceIds),
        loadPresets: () => presetStore.load(),
        loadMcp: () => mcpStore.load(),
        setMcpSelection: (workspacePath, selected) => mcpStore.setSelection(workspacePath, selected),
      };

      // 连接重建后 Host 的模式清单可能变了，重新读一次。
      ctx.effect(() => ctx.on('connection/reset', () => {
        presetStore.load();
        mcpStore.load();
      }), 'split-workspaces: preset roster refresh');

      /**
       * 「这个部署能不能把路径交给桌面」——一次读、一直用。
       *
       * 它是部署级的事实（Host 上有没有图形环境），不是路径级的，因此每个插件实例
       * 只问一次。读失败**不记住**（下面那个 catch 会把缓存清掉），于是网络抖一下
       * 之后下一次点击还有机会。
       */
      let canOpenPath = null;
      const readCanOpenPath = async (service) => {
        if (canOpenPath === null) {
          canOpenPath = service.canOpenWorkspacePath()
            .then((result) => result.ok === true && result.value === true);
        }
        try {
          return await canOpenPath;
        } catch (error) {
          canOpenPath = null;
          throw error;
        }
      };

      /**
       * 用系统文件管理器打开一个工作区目录。
       *
       * 与模式选择那条路一样：**不抛异常**，一律返回 `{ ok: true }` 或
       * `{ ok: false, reason }`，其中 `reason` 是已经翻好的一整句人话，
       * 由窗格直接显示在它自己的错误行里。
       *
       * @param path - 工作区目录路径。
       * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
       */
      const openWorkspaceDirectory = async (path) => {
        const service = ctx.get(SESSION_REMOTE_KEY);
        if (service === undefined || typeof service.openWorkspacePath !== 'function') {
          return { ok: false, reason: t('pane.openFailed') + ': ' + t('pane.openNoService') };
        }
        let available;
        try {
          available = await readCanOpenPath(service);
        } catch (error) {
          return { ok: false, reason: t('pane.openFailed') + ': ' + mods.presets.errorText(error) };
        }
        // 没有图形环境的部署：说清是「这个部署不行」，而不是让底层报一句 ENOENT。
        if (available !== true) {
          return { ok: false, reason: t('pane.openFailed') + ': ' + t('pane.openNoDesktop') };
        }
        let result;
        try {
          result = await service.openWorkspacePath({ path });
        } catch (error) {
          return { ok: false, reason: t('pane.openFailed') + ': ' + mods.presets.errorText(error) };
        }
        if (result.ok === true) return { ok: true };
        return { ok: false, reason: openFailureText(result.error, t) };
      };

      /**
       * 请求删除一个会话：交给 `@local/dsh-session-delete` 已经装好的确认弹窗。
       *
       * 这里只做三件事，而且都是**同步**的（点一下按钮就出确认框，不该有一次远端往返的
       * 等待）：惰性取一次服务入口、把请求转给它、顺手挂上「删成功之后」的收尾。
       *
       * 收尾为什么是 `paneStore.forgetSession` 而不是「清掉发起删除的那一格」：同一个
       * 会话可能同时显示在好几格上（跟随型窗格会自动选中本工作区最新的会话），而
       * `resolvePaneSessionId` 对「钉住的会话已经不在会话表里」照样返回它。按会话 id
       * 一次松开所有窗格，删除之后才不会有格子卡在「正在打开会话…」。
       *
       * @param sessionId - 要删除的会话 id。
       * @param displayTitle - 它的显示名，给确认框用；可以是 undefined。
       * @returns 确认框是否已经弹出；服务不在时返回 false，由窗格在自己的错误行里说明。
       */
      const requestSessionDelete = (sessionId, displayTitle) => {
        const ui = ctx.get(SESSION_DELETE_UI_KEY);
        if (ui === undefined || ui === null || typeof ui.request !== 'function') return false;
        return ui.request({
          sessionId,
          displayTitle,
          onDeleted: (deletedId) => {
            paneStore.forgetSession(deletedId === undefined ? sessionId : deletedId);
          },
        }) === true;
      };

      /*
       * 把 Alt+方向键登记成「固定快捷键」。
       *
       * 固定键位不可改绑，但会出现在「设置 → 快捷键」的参考列表里；框架同时把它们
       * 记成已占用，于是别的命令不会被悄悄绑到同一组键上。
       *
       * 这里用 `ctx.inject` 而不是把 `shortcuts` 写进插件的 inject 列表：少了快捷键
       * 服务的部署（离线契约测试、精简宿主）照样能用这组键 —— 键位是下面那个
       * `installPaneKeys` 自己实现的 —— 只是「设置 → 快捷键」里少一行参考，
       * 而不是整个面板加载不出来。
       */
      ctx.inject(['shortcuts'], (scope) => {
        for (const row of PANE_FOCUS_SHORTCUTS) {
          scope.effect(() => scope.shortcuts.registerFixed({
            id: row.id,
            label: () => t(row.label),
            keys: scope.shortcuts.describeBinding({ code: row.code, modifiers: ['alt'] }).keys,
            bindings: [{ code: row.code, modifiers: ['alt'] }],
            group: 'application',
          }), 'split-workspaces: ' + row.id);
        }
      });

      /*
       * 真正干活的键盘处理：在文档的**捕获**阶段接住 Alt+方向键，把焦点搬到那个方向上
       * 「相应位置」的窗格。
       *
       * 为什么在文档上而不是棋盘节点上：面板里的按键不一定以面板内的元素为事件目标 ——
       * 点过棋盘空白之后焦点落到 `document.body`，刚用侧边栏图标切过来时焦点还在侧边栏
       * 按钮上，这两种情况下事件都不流经棋盘节点，挂在那里的处理收不到。用户要的是
       * 「只要这个面板在屏幕上，Alt+方向键就管用」；面板没在屏幕上时，处理函数凭棋盘
       * 根节点的标记判断出来，安静放行（见 view 里的 `installPaneKeys`）。
       *
       * 与上面那组固定键位是同一件事的两半：那边让它在「设置 → 快捷键」里有名分，
       * 这边让它真的动起来 —— 所以少了快捷键服务的部署照样能用这组键。
       */
      ctx.effect(() => view.installPaneKeys(
        typeof document === 'undefined' ? undefined : document,
        paneStore,
      ), 'split-workspaces: pane focus keys');

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => t('panel.title'),
      }, menu.PanelIcon)), 'split-workspaces: sidebar row');

      ctx.effect(() => ctx.slots.inject(PANE_SLOT, () => ctx.slots.register({
        name: PANE_SLOT,
        locale: NS,
      }, view.PaneBody)), 'split-workspaces: pane body');

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        children: { [PANE_SLOT]: { kind: 'single', scope: 'session-maybe' } },
        inject: () => ({
          paneStore,
          paneActions,
          presetStore,
          mcpStore,
          agentPresets,
          sessions: ctx.sessions,
          sessionList: ctx.sessions.list,
          workspaces: ctx.workspaces,
          uiWorkspace: ctx.uiWorkspace,
          openWorkspaceDirectory,
          requestSessionDelete,
        }),
      }, view.SplitPanel)), 'split-workspaces: main panel');
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'remote', 'remote.agentPresets'],
      apply,
      /** 离线契约测试用的入口：`chunks` 解析出各代码块，其余是可直接断言的对象。 */
      test: {
        chunks,
        CHUNK_FILES,
        PANEL_ID,
        PANE_SLOT,
        NS,
        PANE_FOCUS_SHORTCUTS,
        loadChunks,
        SESSION_REMOTE_KEY,
        SESSION_DELETE_UI_KEY,
        OPEN_ERROR_KEYS,
        openFailureText,
      },
    };
  },
});

/*
 * 2026-10-23：MCP 菜单支持「会话级」server（cc-computer-use 按会话各挂一份进程）。
 * 清单每项多了 scope 字段，hint 统一显示工具数（不再显示「会话级」字样）。
 * 改动实际落在 client.pane.js / client.dicts.js —— 这两个是包内代码块，
 * 而宿主的客户端 HMR 只按**入口产物**的 mtime/size 推 revision，
 * 所以这里留一条注释：它让入口的 revision 前进，已打开的页面才会重新拉取新的代码块。
 */
