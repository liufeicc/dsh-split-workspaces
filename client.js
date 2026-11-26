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
 * 每个窗格的「对话内容区」还会分到一层半透明的渐变色（按会话稳定、同一屏不重复），
 * 像一块带色温的玻璃：左上角有柔光、向下淡出，一眼就能分清哪一格是哪段对话；
 * 标题栏保持原样。
 *
 * 平铺面板的标题/按钮/菜单使用自带的「站酷快乐体」（字体文件在 `fonts/`，Host 半边用
 * `/split-workspaces-fonts` 路由提供）；会话正文保持系统原字体。主界面与平铺面板的
 * 助手正文按段落/列表项逐块淡入上浮（每块 2 秒），用户消息/工具行/思考过程保持静态。
 *
 * 派单时还会播放青金色流星：主窗格边框亮 → 带柔光/尾迹的流星直线飞向目标窗格内的
 * 随机落点（约 2.4 秒）→ 目标边框亮、窗格抖动、半透明白光同时发生并缓慢消失；多目标串行发射，
 * 不画轨迹线。实现见 `client.fx.js`。Host 热重载会让视觉事件序号归零，轮询侧会
 * 检测到序号回退并重置水位，避免新派单被旧的已读位置过滤掉。
 * 分配在 `client.model.js` 的 `assignPaneTints`，染色在 `client.styles.js` 的
 * `.dshSplitWs_paneBody`。
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
      './client.layout.js',
      './client.presets.js',
      './client.mcp.js',
      './client.skill.js',
      './client.dispatch.js',
      './client.targets.js',
      './client.graph.model.js',
      './client.graph.view.js',
      './client.menu.js',
      './client.pane.js',
      './client.views.js',
      './client.fx.js',
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
        .then(([styles, dicts, model, layout, presets, mcp, skill, dispatch, targets, graphModel, graphView, menu, pane, views, fx, view]) => ({
          styles, dicts, model, layout, presets, mcp, skill, dispatch, targets, graphModel, graphView, menu, pane, views, fx, view,
        }));
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
        skill: mods.skill,
        paneSlot: PANE_SLOT,
      });
      /*
       * 会话视图清单：每个窗格的标签栏都从这一个源读取。它只订阅注册表 / 语言 /
       * 开发者工具开关，不持有任何插件自己的组件；没有额外视图插件时清单里只有
       * Chat（或为空），窗格行为与改造前一致。
       */
      const viewTabs = mods.views.createViewTabs(ctx);
      const view = mods.view.createView({
        css,
        cx,
        errorText: mods.presets.errorText,
        model: mods.model,
        menu,
        pane,
        graph: mods.graphView,
        views: mods.views,
        fx: mods.fx,
        viewTabs,
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
      /*
       * 技能库服务同理，由 @local/dsh-skill-workspace 的客户端半边挂载。惰性解析：
       * 没装那个插件时这里取到 undefined，窗格里的 SKILL 按钮就整体不显示 ——
       * 与「本来就没有技能库」是同一种静默处理。
       */
      const skillStore = mods.skill.createSkillStore(() => ctx.get(mods.skill.SKILL_REMOTE_KEY));
      /*
       * 设计模式的三个零件，各自的职责边界很清楚：
       *   - `viewModeStore`  当前看的是「平铺」还是「设计」；
       *   - `graphStore`     箭头本身（只存窗格 key 对，不认识会话）；
       *   - `dispatchSync`   把箭头换算出来的绑定表推给 Host。
       * 之所以拆成三个而不是一个：模式与图是两种完全不同的状态，绑定的去向又是第三种
       * （远端），混在一起会让每个改动都牵连一片重算。
       */
      const viewModeStore = mods.graphModel.createViewModeStore();
      const graphStore = mods.graphModel.createGraphStore();
      /*
       * 「视频逐帧查看」浮窗的调用入口，由 @local/dsh-video-frame-viewer 的客户端
       * 半边用 ctx.provide 发布 `{ open(), close(), toggle() }`。
       *
       * 与删除会话服务同一套规矩：不能写进本插件的 inject 列表（那会把另一个
       * 插件的加载顺序变成自己的前置条件），点击时惰性 ctx.get；取不到就
       * 不渲染按钮（见下方 store 与 GraphBoard 的条件渲染），而不是假装打开了。
       *
       * 可用性单独用一个小 store 镜像：按钮要能实时从禁用变可用（两个插件谁先
       * 加载不确定），而 ctx.inject 恰好在服务出现/消失时回调，正好用来更新它。
       */
      const VIDEO_VIEWER_SERVICE_KEY = 'videoFrameViewer';
      const videoViewerStore = (() => {
        let available = false;
        const listeners = new Set();
        return {
          getSnapshot: () => available,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          set(next) {
            if (next === available) return;
            available = next;
            for (const listener of [...listeners]) listener();
          },
        };
      })();
      ctx.inject([VIDEO_VIEWER_SERVICE_KEY], (scope) => {
        scope.effect(() => {
          videoViewerStore.set(true);
          return () => videoViewerStore.set(false);
        }, 'split-workspaces: video viewer availability');
      });
      /**
       * 打开视频逐帧查看浮窗。
       * @returns 是否已经交给视频插件；服务不在时返回 false。
       */
      const openVideoViewer = () => {
        const service = ctx.get(VIDEO_VIEWER_SERVICE_KEY);
        if (service === undefined || service === null || typeof service.open !== 'function') return false;
        return service.open() !== false;
      };
      /*
       * 「图片编辑」浮窗的调用入口，由 @local/dsh-image-editor 的客户端半边
       * 用 ctx.provide 发布 `{ open(), close(), toggle(), isOpen(), subscribe }`。
       *
       * 规则与上面的视频查看完全一致：服务不进本插件的 inject 列表（避免把另一个
       * 插件的加载顺序变成自己的前置条件），点击时惰性 ctx.get；服务不在时按钮
       * 不渲染。可用性用一个独立的小 store 镜像，ctx.inject 负责在服务出现/消失
       * 时回调 —— 两个插件谁先加载都不影响按钮最终可用。
       */
      const IMAGE_EDITOR_SERVICE_KEY = 'imageEditor';
      const imageEditorStore = (() => {
        let available = false;
        const listeners = new Set();
        return {
          getSnapshot: () => available,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          set(next) {
            if (next === available) return;
            available = next;
            for (const listener of [...listeners]) listener();
          },
        };
      })();
      ctx.inject([IMAGE_EDITOR_SERVICE_KEY], (scope) => {
        scope.effect(() => {
          imageEditorStore.set(true);
          return () => imageEditorStore.set(false);
        }, 'split-workspaces: image editor availability');
      });
      /**
       * 打开图片编辑浮窗。
       * @returns 是否已经交给图片编辑插件；服务不在时返回 false。
       */
      const openImageEditor = () => {
        const service = ctx.get(IMAGE_EDITOR_SERVICE_KEY);
        if (service === undefined || service === null || typeof service.open !== 'function') return false;
        return service.open() !== false;
      };
      const dispatchSync = mods.dispatch.createDispatchSync(() => ctx.get(mods.dispatch.DISPATCH_REMOTE_KEY));
      /*
       * 派单目标记录：Host 落盘、客户端镜像。目标创建即存在，不靠保存画布；
       * 空白目标因此能在任务分派和平铺菜单里显示为「未命名目标」。
       */
      const targetStore = mods.targets.createTargetStore({
        load: () => dispatchSync.loadTargets(),
        add: (sessionId, workspaceId) => dispatchSync.addTarget(sessionId, workspaceId),
        remove: (sessionId) => dispatchSync.removeTarget(sessionId),
      });
      Promise.resolve(targetStore.load()).catch(() => {});

      /*
       * 布局保存/恢复的存储层。
       *
       * 只有 Host 磁盘这一份持久化。桌面版每次启动端口可能变，浏览器的
       * localStorage 按 origin 隔离，存两份反而会出现“Ctrl+R 能恢复、关掉重开
       * 读的是另一份”的不一致；所以浏览器完全不存，Host 是唯一事实来源。
       *
       * 读 Host 是异步的，自动恢复流程会等它一次；保存也等待 Host 确认后再显示
       * “已保存”，避免只写进内存/浏览器就以为持久化成功了。
       */
      /** Host 布局缓存：undefined = 还没读过，null = 读过但没有。 */
      let remoteSavedLayout;
      let remoteLayoutLoaded = false;
      let remoteLayoutLoading = null;
      const readSavedLayout = () => (remoteLayoutLoaded ? remoteSavedLayout : null);
      /**
       * 读一次 Host 布局。
       *
       * @returns true 有保存过；false 明确没有；undefined Host 暂时不可达（调用方可重试）。
       */
      const loadSavedLayout = async () => {
        if (remoteLayoutLoaded) return remoteSavedLayout !== null;
        if (remoteLayoutLoading === null) {
          remoteLayoutLoading = Promise.resolve(dispatchSync.loadLayout())
            .then((payload) => {
              if (payload === undefined) return undefined;
              remoteLayoutLoaded = true;
              remoteSavedLayout = mods.layout.isSavedPayload(payload) ? payload : null;
              return remoteSavedLayout !== null;
            })
            .catch(() => undefined)
            .finally(() => {
              remoteLayoutLoading = null;
            });
        }
        return remoteLayoutLoading;
      };
      /**
       * 保存当前面板模式对应的那一部分。
       *
       * 平铺模式只写棋盘布局，任务分派模式只写分派图；另一部分沿用 Host 上**上一次**
       * 保存的值，不会被这次保存清空。因此保存前必须先读回完整记录，读不回来就不写，
       * 免得把另一部分覆盖掉。
       *
       * 等 Host 写盘确认后才返回成功；失败时把原因交给按钮旁边那行错误提示。
       *
       * @param scope - `tiles` / `graph`：这次保存哪一部分。
       * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
       */
      const persistLayout = async (snapshot, workspaceById, graph, scope) => {
        const loaded = await loadSavedLayout();
        if (loaded === undefined) return { ok: false, reason: 'could not read the saved layout' };
        const payload = mods.layout.serialize(snapshot, workspaceById, graph, {
          scope: scope === 'graph' ? 'graph' : 'tiles',
          previous: readSavedLayout(),
        });
        if (payload === null) return { ok: false, reason: 'nothing to save' };
        const saved = await dispatchSync.saveLayout(payload);
        if (!saved.ok) return { ok: false, reason: saved.reason };
        remoteSavedLayout = payload;
        remoteLayoutLoaded = true;
        return { ok: true };
      };
      /**
       * 恢复保存的界面。窗格与任务分派图分别落位；任何一部分坏掉都只是
       * 不恢复那一部分，不抛异常。
       *
       * 面板模式**不跟随保存记录**：刷新后固定从平铺模式开始（模式 store 的默认值），
       * 保存时是平铺还是任务分派，只影响这次写了哪一部分。
       *
       * @returns `{ panes: boolean, graph: boolean }`：panes 表示棋盘是否被替换；
       *   graph 表示保存结构里是否有图（即使边被清空也算“这份保存拥有图”，
       *   调用方据此阻止 Host 旧绑定覆盖已保存的空图）。
       */
      const restorePersistedLayout = (context) => {
        const saved = readSavedLayout();
        if (saved === null) return { panes: false, graph: false };
        let restored;
        try {
          restored = mods.layout.restore(saved, context);
        } catch {
          return { panes: false, graph: false };
        }
        if (restored === null) return { panes: false, graph: false };
        let panes = false;
        if (restored.paneState !== null) {
          try {
            panes = paneStore.restore(restored.paneState);
          } catch {
            panes = false;
          }
        }
        let graph = false;
        let staged = [];
        if (restored.graph !== null) {
          try {
            const edges = mods.graphModel.sanitizeEdges(restored.graph.edges, context?.isValidGraphSession);
            graphStore.setEdges(edges);
            graph = true;
            // 恢复「已拖入画布、还没连线」的节点；没有这个字段的旧布局按空处理。
            staged = Array.isArray(restored.graph.staged) ? restored.graph.staged : [];
          } catch {
            graph = false;
            staged = [];
          }
        }
        return { panes, graph, staged };
      };

      /*
       * 挂载 `remote.paneDispatch` 命名空间（Host 那一半由 index.js 提供）。
       *
       * 与 MCP / SKILL 两个服务一样**不能**写进 inject：那样插件激活会依赖远端挂载完成，
       * 而远端挂载又发生在本插件 apply 之后，形成死锁。所以这里自己挂、自己卸，
       * 调用点再用 `ctx.get` 惰性解析。
       */
      ctx.effect(() => {
        let disposed = false;
        let unmount;
        Promise.resolve(ctx.remote.$mount({ package: PLUGIN_ID, descriptors: mods.dispatch.REMOTE_DESCRIPTORS }))
          .then((dispose) => {
            if (disposed) void dispose();
            else unmount = dispose;
          }, (error) => {
            console.error('[split-workspaces] 挂载 paneDispatch 命名空间失败:', error);
          });
        return () => {
          disposed = true;
          if (unmount !== undefined) void unmount();
        };
      }, 'split-workspaces: paneDispatch namespace');

      /**
       * 在指定工作区里**真正新建**一条空白会话（不复用）。
       *
       * 「复用空白会话」是视图层的决定：任务分派图标点「创建会话」时，视图先看本工作区
       * 有没有可复用的空白会话，有就直接用；只有没有时才调到这里。因此这里必须绕过
       * 平台的复用分支 —— `connectWorkspace` 默认会挑一个空白会话复用，而目标（员工）
       * 也是空白会话，一旦被挑走，画布上已经连好的节点就会悄悄换成别的对话。
       *
       * `connectBlank(workspaceId, undefined)` 是平台服务里无复用地 `sessions.create`
       * 的运行时入口（类型里标了 private），所以先探测，旧版本没有时才退回公开方法。
       *
       * @param workspaceId - 目标工作区 id。
       * @param workspaceApi - 工作区导航服务；省略时用 ctx.uiWorkspace。
       * @returns `{ ok: true, sessionId }` 或 `{ ok: false, reason }`。
       */
      const createBlankSessionInWorkspace = async (workspaceId, workspaceApi) => {
        if (typeof workspaceId !== 'string' || workspaceId === '') {
          return { ok: false, reason: 'no workspace' };
        }
        const api = workspaceApi !== undefined && workspaceApi !== null ? workspaceApi : ctx.uiWorkspace;
        if (api === undefined || api === null || (typeof api.connectBlank !== 'function' && typeof api.connectWorkspace !== 'function')) {
          return { ok: false, reason: 'workspace service unavailable' };
        }
        try {
          const createdId = typeof api.connectBlank === 'function'
            ? await api.connectBlank(workspaceId, undefined)
            : await api.connectWorkspace(workspaceId);
          if (typeof createdId !== 'string' || createdId === '') {
            return { ok: false, reason: 'empty session id' };
          }
          /*
           * 会话表可能还没收到新会话；主动刷一次，让任务分派/平铺菜单立即看到它。
           * 刷新失败不影响会话本身，界面最多晚一个事件周期。
           */
          if (ctx.sessions !== undefined && ctx.sessions !== null && typeof ctx.sessions.refresh === 'function') {
            Promise.resolve(ctx.sessions.refresh()).catch(() => {});
          }
          return { ok: true, sessionId: createdId };
        } catch (reason) {
          return { ok: false, reason: reason instanceof Error ? reason.message : String(reason) };
        }
      };

      /** 交给组件层的动作集合：组件只调这里，不直接碰存储内部。 */
      const paneActions = {
        addPane: (workspaceId, sessionId) => paneStore.addPane(workspaceId, sessionId),
        splitPane: (key, dir, workspaceId) => paneStore.splitPane(key, dir, workspaceId),
        replaceWorkspace: (key, workspaceId) => paneStore.replaceWorkspace(key, workspaceId),
        replaceWorkspaceWithSession: (key, workspaceId, sessionId) => (
          paneStore.replaceWorkspaceWithSession(key, workspaceId, sessionId)
        ),
        swapPanes: (keyA, keyB) => paneStore.swapPanes(keyA, keyB),
        /*
         * 关窗格**不动箭头**。
         *
         * 节点是会话不是窗格：窗口关掉并不改变「谁能派给谁」。第一版在这里清边，结果
         * 用户关掉一格就把委派关系一起弄没了 —— 而那条关系跟他开不开窗格毫无关系。
         */
        removePane: (key) => paneStore.removePane(key),
        setSession: (key, sessionId) => paneStore.setSession(key, sessionId),
        /*
         * 会话被**删除**时才清掉它牵涉的箭头 —— 这时那条边真的失去意义了。
         * （关窗格是另一回事，见上面 removePane。）
         */
        forgetSession: (sessionId) => {
          paneStore.forgetSession(sessionId);
          graphStore.removeSession(sessionId);
        },
        setPreset: (key, preset) => paneStore.setPreset(key, preset),
        setActive: (key) => paneStore.setActive(key),
        setRatio: (splitId, ratio) => paneStore.setRatio(splitId, ratio),
        ensureInitialized: (currentWorkspaceId, workspaceIds) => paneStore.ensureInitialized(currentWorkspaceId, workspaceIds),
        addFloatingPane: (workspaceId, sessionId) => paneStore.addFloatingPane(workspaceId, sessionId),
        removeFloatingPane: (key) => paneStore.removeFloatingPane(key),
        saveLayout: (snapshot, workspaceById, graph, scope) => persistLayout(snapshot, workspaceById, graph, scope),
        restoreSavedLayout: (context) => restorePersistedLayout(context),
        hasSavedLayout: () => readSavedLayout() !== null,
        loadSavedLayout: () => loadSavedLayout(),
        loadPresets: () => presetStore.load(),
        loadMcp: () => mcpStore.load(),
        setMcpSelection: (workspacePath, selected) => mcpStore.setSelection(workspacePath, selected),
        loadSkills: () => skillStore.load(),
        setSkillSelection: (workspacePath, selected) => skillStore.setSelection(workspacePath, selected),
        loadDispatch: () => dispatchSync.load(),
        pullDispatchVisual: (since) => mods.dispatch.pullDispatchVisual(() => ctx.get(mods.dispatch.DISPATCH_REMOTE_KEY), since),
        readDispatchStates: (sessionIds) => mods.dispatch.readDispatchStates(() => ctx.get(mods.dispatch.DISPATCH_REMOTE_KEY), sessionIds),
        loadTargets: () => targetStore.load(),
        /**
         * 新建一个普通会话：真正创建一条新的空白会话。
         *
         * **复用由视图层负责**：点「创建会话」时先查本工作区有没有可复用的空白会话，
         * 有就直接用现有的，只有没有时才调到这里。这样「反复点新建最多只多一个空壳」
         * 的规则不变，也不会因为平台侧的复用分支把目标会话抢走。
         *
         * 创建成功后不切换当前窗格/模式：任务分派只让新卡片出现在左侧列表里。
         *
         * @param workspaceId - 会话所属工作区。
         * @param workspaceApi - 工作区导航服务；省略时用 ctx.uiWorkspace。
         * @returns `{ ok, sessionId?, reason? }`。
         */
        createSession: (workspaceId, workspaceApi) => createBlankSessionInWorkspace(workspaceId, workspaceApi),
        /**
         * 新建一个派单目标（员工）：强制创建一个新的空白会话，再登记目标记录。
         *
         * 不走「复用空白会话」逻辑 —— 每次点「创建员工」都必须得到一个新的会话 id，
         * 否则 B/C/D 会指向同一个会话，派单无法区分。
         *
         * @param workspaceId - 目标所属工作区。
         * @returns `{ ok, sessionId?, reason? }`。
         */
        createTarget: async (workspaceId, workspaceApi) => {
          const created = await createBlankSessionInWorkspace(workspaceId, workspaceApi);
          if (created.ok !== true) return created;
          const registered = await targetStore.addTarget(created.sessionId, workspaceId);
          if (registered.ok !== true) {
            return { ok: false, sessionId: created.sessionId, reason: registered.reason };
          }
          return created;
        },
        removeTarget: (sessionId) => targetStore.removeTarget(sessionId),
      };

      /**
       * 设计模式的动作。
       *
       * `syncBindings` 直接透传给同步器：它自己做「只发变了的那些发起方」的差量，
       * 视图层每渲染一次都调它也没关系（没变化就一个请求都不发）。
       */
      const graphActions = {
        addEdge: (from, to) => graphStore.addEdge(from, to),
        removeEdge: (from, to) => graphStore.removeEdge(from, to),
        setNote: (from, to, note) => graphStore.setNote(from, to, note),
        syncBindings: (bindings) => dispatchSync.sync(bindings),

        /**
         * 改一张卡片的名称（= 改这个会话的标题）。
         *
         * 走平台**官方**的重命名路径：借一个会话引用，再调 `session.rename(title)`。
         * 这样做的三个理由：
         *   1. Host 会归一化标题（去首尾空白、限长），并把「用户显式命名」钉住，
         *      不让自动标题生成再把它覆盖掉；
         *   2. 成功后会写进 title 投影，会话列表自动刷新 —— 画布卡片、左侧选择器、
         *      平铺窗格的标题栏都会跟着变成新名字，插件不需要另写一套刷新逻辑；
         *   3. 失败（会话已删除、连接断了、旧部署没有重命名能力）会带着具体原因回来，
         *      界面可以原样显示，而不是静默吞掉。
         *
         * @param sessionId - 要改名的会话 id（画布卡片的 key）。
         * @param title - 新名称；两端空白会被去掉，空名称直接拒绝。
         * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
         */
        renameSession: async (sessionId, title) => {
          if (typeof sessionId !== 'string' || sessionId === '') {
            return { ok: false, reason: t('graph.renameInvalid') };
          }
          const text = typeof title === 'string' ? title.trim() : '';
          if (text === '') return { ok: false, reason: t('graph.renameEmpty') };
          const sessions = ctx.sessions;
          if (sessions === undefined || sessions === null || typeof sessions.using !== 'function') {
            return { ok: false, reason: t('graph.renameUnavailable') };
          }
          /*
           * 未命名的会话（还没有标题的空白会话 / 未命名员工）不允许改名。
           *
           * 界面已经不给这类卡片渲染铅笔，这里再挡一层：调用方绕过来时也只会得到
           * 一句人话，而不是「改完还是未命名」。判定看会话列表里的 `title` ——
           * 它存在才说明这个会话已经有名字。
           */
          const list = sessions.list;
          const snapshot = list !== undefined && list !== null && typeof list.getSnapshot === 'function'
            ? list.getSnapshot()
            : undefined;
          const summary = snapshot === undefined || snapshot === null || snapshot.byId === undefined
            ? undefined
            : snapshot.byId[sessionId];
          if (summary === undefined) return { ok: false, reason: t('graph.renameInvalid') };
          if (typeof summary.title !== 'string' || summary.title === '') {
            return { ok: false, reason: t('graph.renameUntitled') };
          }
          try {
            await sessions.using(sessionId, { source: mods.model.SESSION_SOURCE }, async (reference) => {
              const result = await reference.binding.session.rename(text);
              if (result === undefined || result === null || result.ok !== true) {
                const message = result === undefined || result === null ? undefined : result.error?.message;
                throw new Error(typeof message === 'string' && message !== '' ? message : 'rename failed');
              }
              return result;
            });
            return { ok: true };
          } catch (reason) {
            return { ok: false, reason: mods.presets.errorText(reason) };
          }
        },
      };

      // 连接重建后 Host 的模式清单可能变了，重新读一次（技能库同理：目录可能刚被改过）。
      // 绑定表也要重读：Host 重启后内存里的绑定是空的，而页面上还画着箭头 ——
      // 不重读的话「箭头在、工具说没绑定」会一直卡到下次改边。
      ctx.effect(() => ctx.on('connection/reset', () => {
        presetStore.load();
        mcpStore.load();
        skillStore.load();
        dispatchSync.load();
        targetStore.load();
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
          /*
           * 删成功之后两个 store 都要收尾：窗格松手 + 清掉这个会话牵涉的委派箭头。
           * 这里必须走 `paneActions.forgetSession`（它带 graphStore 清理），而不是直接
           * 调 `paneStore.forgetSession` —— 后者会把箭头留在图里，成为一个指向已删会话
           * 的悬空节点。
           */
          onDeleted: (deletedId) => {
            const id = deletedId === undefined ? sessionId : deletedId;
            paneActions.forgetSession(id);
            // 目标记录也要跟着删，否则任务分派会一直留着一张指向已删会话的空卡。
            if (targetStore.isTarget(id)) {
              Promise.resolve(targetStore.removeTarget(id)).catch(() => {});
            }
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
          skillStore,
          agentPresets,
          sessions: ctx.sessions,
          sessionList: ctx.sessions.list,
          workspaces: ctx.workspaces,
          uiWorkspace: ctx.uiWorkspace,
          openWorkspaceDirectory,
          requestSessionDelete,
          viewModeStore,
          videoViewerStore,
          openVideoViewer,
          imageEditorStore,
          openImageEditor,
          graphStore,
          graphModel: mods.graphModel,
          dispatchStore: dispatchSync,
          targetStore,
          graphActions,
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

/*
 * 2026-10-26：会话菜单不再列空白会话（建了会话但一条消息都没发过的「新会话」）；
 * 「新建会话」会先复用本工作区已有的空白会话，不再每点一次就在 Host 里多留一条空壳。
 * 改动落在 client.model.js / client.view.js / client.pane.js，同样用这条注释推进入口
 * 产物的 revision（理由同上）。
 */

/*
 * 2026-10-26（二）：SKILL 弹层从「状态不健康才重读」改成**每次打开都重读**。
 * 起因是实测：在「设置 → 技能」里换了技能目录之后，点开弹层仍是旧清单，必须刷新页面
 * 才更新 —— 设置页和棋盘是两个客户端模块，那边改目录不会通知这边，而缓存看起来很正常。
 * 改动落在 client.skill.js；按惯例用这条注释推进入口产物的 revision，已打开的页面
 * 才会重新拉取新的代码块。
 */

/*
 * 2026-11-20：按用户要求把「新建目标 / 未命名目标」两个界面称谓改成
 * 「新建员工 / 未命名员工」。改动落在 client.dicts.js；按惯例用这条注释推进入口
 * 产物的 revision，已打开的页面才会重新拉取新的代码块。
 */

/*
 * 2026-11-20（二）：任务分派画布卡片最左侧加一块静态像素小人（先用来看布局效果）。
 * 改动落在 client.graph.view.js 与 client.styles.js；同样用这条注释推进入口产物的
 * revision，已打开的页面才会重新拉取新的代码块。
 */

/*
 * 2026-11-25：任务分派左侧工作区行右侧加「创建会话 / 创建员工」两个图标；展开后
 * 普通空白会话也显示为「未命名会话」卡片（每个工作区只留最近更新的一条，复用规则
 * 不变）；左侧所有会话卡片都带删除按钮。改动落在 client.view.js / client.graph.view.js /
 * client.graph.model.js / client.styles.js / client.dicts.js；入口 revision 同样靠这条
 * 注释推进，已打开的页面才会重新拉取新的代码块。
 */

/*
 * 2026-11-26：任务分派画布与左侧选择器增加「改卡片名称」。
 *   - 卡片与选择器条目右上角各一个铅笔，点开**同一个**弹层（由 GraphBoard 托管）；
 *   - 改名走平台官方路径 `sessions.using(...).binding.session.rename(title)`，
 *     成功后标题投影更新，左侧、画布、平铺窗格标题栏一起变；
 *   - **未命名会话 / 未命名员工没有铅笔**：没有标题的占位卡改了也显示不出来；
 *     动作层同样拒绝（`graph.renameUntitled`），防止绕过界面调用；
 *   - 空白会话有显式标题时优先显示标题（否则改完名仍显示「未命名会话」）。
 * 改动落在 client.js / client.view.js / client.graph.view.js / client.styles.js /
 * client.dicts.js / test/board.mjs / test/harness.mjs；新增 test/rename-contract.mjs
 * 与 tools/rename-probe.mjs。入口 revision 靠这条注释推进。
 */

/*
 * 2026-11-25（三）：修复任务分派「未连线卡片保存」在普通空白会话上的一个口子。
 * 同一工作区有多张空白会话时，`graphCards` 只保留最新一张；用户先把旧的那张拖进
 * 画布、之后再新建空白会话，旧卡片会被「空白名额」过滤掉 —— 画布少一张、保存时
 * 也丢。现在：已进入 `stagedSessions` 的会话不受名额限制；`stageSession` 按会话表
 * 判断存在性；保存也按会话表过滤，不看显示层。改动落在 client.view.js /
 * test/board.mjs；新增 test/staged-save-contract.mjs。入口 revision 靠这条注释推进。
 */
