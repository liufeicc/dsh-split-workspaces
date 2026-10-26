/**
 * 平铺面板的视图块：整块棋盘的排布 —— 分隔条、按布局树渲染窗格、面板顶部动作。
 *
 * 单个窗格（PaneFrame）在 client.pane.js，弹出菜单与图标在 client.menu.js；
 * 三块都由入口 client.js 装载后注入，因为 DSH 的包内代码块之间不能互相 require。
 *
 * 组件分工：
 *   - Splitter：可拖动、可键盘微调的分隔条；
 *   - PaneBody：窗格里的对话本体（复用共享的 conversation.content Factory）；
 *   - SplitPanel：整块棋盘，按布局树渲染出窗格与分隔条；
 *   - installPaneKeys：装上 `Alt+方向键` 的焦点切换（文档级监听，入口在面板挂载期间装）。
 *
 * 加载方式：入口 client.js 用 require.async('./client.view.js') 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.view.js',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;
    const h = React.createElement;

    /** 稳定的 subscribe 函数缓存：每个可观察源只绑定一次，避免 uSES 反复订阅。 */
    const sourceSubscriptions = new WeakMap();

    /** 把一个裸可观察源的 subscribe 包成 uSES 需要的稳定函数。 */
    function subscribeTo(source) {
      let bound = sourceSubscriptions.get(source);
      if (bound === undefined) {
        bound = (listener) => source.subscribe(listener);
        sourceSubscriptions.set(source, bound);
      }
      return bound;
    }

    /** 订阅一个裸可观察源（快照 + 订阅）。 */
    function useSource(source) {
      return useSyncExternalStore(
        subscribeTo(source),
        () => source.getSnapshot(),
        () => source.getSnapshot(),
      );
    }

    /**
     * 组装视图组件。
     *
     * @param deps.css - class 名对照表（来自样式块）。
     * @param deps.cx - class 名拼接工具（来自样式块）。
     * @param deps.errorText - 把抛出物转成可读文本（来自入口块）。
     * @param deps.model - 纯模型块（布局树工具、分屏候选、`createPaneStore` 等）。
     * @param deps.menu - 菜单块（弹出菜单与菜单行）。
     * @param deps.pane - 窗格块（`PaneFrame` 与「把光标送进某个窗格输入框」的 `focusPaneInput`）。
     */
    function createView({ css, cx, errorText, model, menu, pane }) {
      const { Popover, MenuItem } = menu;
      // 窗格块同时给出「把光标送进某个窗格的输入框」这件事：键盘切窗格与窗格被点亮
      // 两条路用的是同一份实现，只有一份「找不到输入框 / 宿主不可编辑就放手」的守卫。
      const { PaneFrame, focusPaneInput } = pane;

      /** `Alt` + 方向键 → 要找的方向（这一组键只在窗格之间搬焦点）。 */
      const PANE_ARROW_KEYS = {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        ArrowUp: 'up',
        ArrowDown: 'down',
      };

      /**
       * 棋盘根节点上的标记：「它存在」就是「这个面板挂在屏幕上」的证据。
       *
       * 主面板是按 key 渲染的（`renderSlot('main', {}, { entryKey })`），切到别的面板时
       * 整块棋盘会卸载、标记随之消失 —— 键盘处理据此判断该不该管，不必额外记账。
       */
      const BOARD_MARKER = 'data-split-board';

      /** 「能打字的地方」：焦点落在棋盘之外的这些元素里时，方向键是别人的。 */
      const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

      /**
       * 浮层选择器，与平台 `ui-primitives` 的 `modalSelector` 同值：模态对话框与菜单都算。
       * 这里不引那个包 —— 只为一个字符串常量多一层依赖不值得；平台改了值，改这一行。
       */
      const OVERLAY_SELECTOR = '[role="dialog"][aria-modal="true"], [role="menu"]';

      /**
       * 把 `Alt+方向键` 的焦点切换装到一个文档上，返回卸载函数。
       *
       * **为什么是 Alt**：Chromium 的 contenteditable 里 `Shift+←/→` 是逐字选字、
       * `Shift+↑/↓` 是按行选字、`Ctrl+←/→` 是按词跳光标、`Ctrl+↑/↓` 是跳段首段尾，
       * 全被输入框占着；`Ctrl+Alt+方向键` 又会被桌面环境（GNOME/Unity 的切工作区）
       * 在窗口管理器那一层吃掉。只有 `Alt+方向键` 在输入框里没有任何原生含义，
       * 桌面也不占 —— 代价最小。
       *
       * **为什么挂在文档的捕获阶段**（而不是棋盘根节点的 `onKeyDownCapture`）：
       * 面板里的按键**不一定**以面板内的元素为事件目标 —— 点过棋盘空白之后焦点落到
       * `document.body`，刚用侧边栏图标切过来时焦点还在侧边栏按钮上，这两种情况下
       * 事件都不流经棋盘节点，React 的捕获处理收不到。用户要的是「只要这个面板在
       * 屏幕上，Alt+方向键就管用」，所以监听挂在文档上：捕获阶段仍然在输入框之前
       * 拿到事件，拿到后就 `stopPropagation`，输入框不会再见第二次。
       *
       * 拿走时同时 `preventDefault`，挡掉浏览器里 `Alt+←/→` 的前进后退这类默认动作；
       * 那个方向上没有窗格时**不拦**，让 Alt+方向键保留它原本的含义。
       *
       * **放行的情形**（一律什么都不做，也不拦事件）：
       *   1. 棋盘不在屏幕上（标记不在）—— 别的面板正开着，不该抢；
       *   2. 有浮层盖着 —— 模态对话框或 `[role="menu"]`，方向键在那里另有用途
       *      （「设置 → 快捷键」的按键录制也在浮层里）；
       *   3. 焦点在棋盘之外的输入框里 —— 那是别人的输入框（侧边栏搜索等）；
       *   4. 输入法组字中（`isComposing` / keyCode 229）、`AltGraph`（某些键盘布局用它
       *      打字符，在浏览器眼里就是 Ctrl+Alt），以及带了 Shift / Ctrl / Meta 的组合。
       *
       * @param doc - 文档对象；参数化是为了离线测试能塞一个假文档。
       * @param store - 窗格存储：读当前布局与焦点窗格，写新的焦点窗格。
       */
      function installPaneKeys(doc, store) {
        if (doc === null || doc === undefined || typeof doc.addEventListener !== 'function') return () => {};
        const query = typeof doc.querySelector === 'function' ? (selector) => doc.querySelector(selector) : () => null;

        const onKeyDown = (event) => {
          const direction = PANE_ARROW_KEYS[event.key];
          if (direction === undefined) return;
          if (event.altKey !== true || event.shiftKey === true || event.ctrlKey === true || event.metaKey === true) return;
          if (event.isComposing === true || event.keyCode === 229) return;
          if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph') === true) return;

          // 棋盘不在屏幕上：别的面板正开着，或者本面板已经卸载。
          const board = query('[' + BOARD_MARKER + ']');
          if (board === null || board === undefined) return;

          // 浮层（菜单 / 模态对话框）盖在上面时，方向键归它。
          if (query(OVERLAY_SELECTOR) !== null) return;

          // 焦点在棋盘之外的输入框里时不抢：用户是在那个框里打字。
          const active = doc.activeElement;
          const inBoard = active !== null && active !== undefined
            && typeof board.contains === 'function' && board.contains(active) === true;
          const editing = active !== null && active !== undefined
            && typeof active.closest === 'function' && active.closest(EDITABLE_SELECTOR) !== null;
          if (editing === true && inBoard !== true) return;

          const snapshot = store.getSnapshot();
          const next = model.neighborPane(snapshot.layout, snapshot.activeKey, direction);
          if (next === undefined) return;

          event.preventDefault();
          event.stopPropagation();
          store.setActive(next);
          focusPaneInput(doc, next);
        };

        doc.addEventListener('keydown', onKeyDown, true);
        return () => doc.removeEventListener('keydown', onKeyDown, true);
      }

      /**
       * 两个子块之间的分隔条。
       *
       * 拖动逻辑有两个关键点：
       *   1. 容器尺寸在「按下的一瞬间」从父元素现读，因此不依赖任何缓存测量；
       *   2. 对外报告的是「比例」而不是像素，窗口缩放后布局比例保持不变。
       * 指针捕获让拖动过程中指针移出分隔条也不会丢事件。
       */
      function Splitter({ dir, ratio, label, onRatio, onReset }) {
        const elementRef = useRef(null);
        const dragRef = useRef(null);
        const [dragging, setDragging] = useState(false);
        const horizontal = dir === 'row';

        /** 分隔条所在容器在拖动方向上的尺寸。 */
        const containerSize = () => {
          const element = elementRef.current;
          const parent = element === null || element === undefined ? null : element.parentElement;
          if (parent === null || parent === undefined) return 0;
          return horizontal ? parent.clientWidth : parent.clientHeight;
        };

        /** 结束拖动：清掉拖动状态与全局的文本选择屏蔽。 */
        const endDrag = () => {
          if (dragRef.current === null) return;
          dragRef.current = null;
          setDragging(false);
          if (typeof document !== 'undefined') document.body.style.userSelect = '';
        };

        /** 开始拖动：记下起点、起始比例与容器尺寸。 */
        const startDrag = (event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          const element = elementRef.current;
          if (element === null || element === undefined || typeof element.setPointerCapture !== 'function') return;
          dragRef.current = {
            pointerId: event.pointerId,
            from: horizontal ? event.clientX : event.clientY,
            ratio,
            size: containerSize(),
          };
          element.setPointerCapture(event.pointerId);
          setDragging(true);
          if (typeof document !== 'undefined') document.body.style.userSelect = 'none';
        };

        /** 拖动中：只认自己那一次指针，换算成新比例。 */
        const moveDrag = (event) => {
          const drag = dragRef.current;
          if (drag === null || drag.pointerId !== event.pointerId) return;
          const point = horizontal ? event.clientX : event.clientY;
          onRatio(model.nextRatio(drag.ratio, point - drag.from, drag.size));
        };

        /** 方向键微调，让分隔条不用鼠标也能用。 */
        const nudge = (event) => {
          const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
          const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
          if (event.key !== back && event.key !== forward) return;
          event.preventDefault();
          const size = containerSize();
          const step = (event.shiftKey ? 0.1 : 0.02) * (event.key === back ? -1 : 1);
          onRatio(model.nextRatio(ratio, step * size, size));
        };

        return h('div', {
          className: cx(css.splitter, dragging && css.splitterActive),
          role: 'separator',
          'aria-orientation': horizontal ? 'vertical' : 'horizontal',
          'aria-label': label,
          title: label,
          tabIndex: 0,
          'data-dir': dir,
          'data-splitter': '',
          ref: elementRef,
          onPointerDown: startDrag,
          onPointerMove: moveDrag,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onLostPointerCapture: endDrag,
          onKeyDown: nudge,
          onDoubleClick: onReset,
        }, h('span', { className: css.splitterLine, 'aria-hidden': true }));
      }

      /** 窗格里的对话只显示 Chat 视图，避免各窗格视图不一致。 */
      function FixedChatView(props) {
        return props.renderSlot('conversation.session', { view: 'chat' });
      }
      /** 固定的 Factory 选项对象：同一个引用才不会让 Factory 每次渲染都重建。 */
      const PANE_FACTORY_OPTIONS = { slots: { views: FixedChatView } };

      /** 窗格主体：共享的 Conversation Factory，用 embedded 变体。 */
      function PaneBody(props) {
        const session = props.useSession((value) => value);
        const settling = session === undefined || session.openState === 'loading';
        return props.renderFactorySlot('conversation.content', {
          variant: 'embedded',
          phase: settling ? 'settling' : 'active',
          hero: false,
        }, PANE_FACTORY_OPTIONS);
      }

      /** 整块棋盘。 */
      function SplitPanel(props) {
        const { t, renderSlot, SessionProvider, paneStore, paneActions, presetStore, mcpStore, sessions, sessionList, workspaces, uiWorkspace, openWorkspaceDirectory, requestSessionDelete, agentPresets } = props;
        const paneState = useSource(paneStore);
        const workspaceState = useSource(workspaces.list);
        const sessionState = useSource(sessionList);
        const presetState = useSource(presetStore);
        const mcpState = useSource(mcpStore);
        const items = workspaceState.items;
        const archivedSessionIds = workspaceState.archivedSessionIds;
        const panes = paneState.panes;
        const presetOptions = presetState.options;
        const presetDefaultId = presetState.defaultId;

        const workspaceById = useMemo(() => {
          const index = new Map();
          for (const item of items) index.set(item.workspaceId, item);
          return index;
        }, [items]);

        const workspaceIds = useMemo(() => items.map((item) => item.workspaceId), [items]);

        /** 当前主视图正在看的会话所在工作区，用作播种时的第一个窗格。 */
        const currentWorkspaceId = useMemo(() => {
          for (const id of sessionState.ids) {
            const summary = sessionState.byId[id];
            if (summary === undefined || (summary.retainedBy.mainView ?? 0) === 0) continue;
            const owned = items.find((item) => item.sessionIds.includes(summary.id));
            if (owned !== undefined) return owned.workspaceId;
            const byPath = items.find((item) => item.path === summary.cwd);
            if (byPath !== undefined) return byPath.workspaceId;
          }
          return undefined;
        }, [items, sessionState]);

        useEffect(() => {
          paneActions.ensureInitialized(currentWorkspaceId, workspaceIds);
        }, [paneActions, currentWorkspaceId, workspaceIds]);

        useEffect(() => {
          paneActions.loadPresets();
        }, [paneActions]);

        useEffect(() => {
          paneActions.loadMcp();
        }, [paneActions]);

        const openWorkspaceIds = useMemo(() => panes.map((pane) => pane.workspaceId), [panes]);
        /*
         * 「还没铺开的工作区」：面板顶部的「添加工作区」与每个窗格标题栏的「替换工作区」
         * 用的是同一份候选（`model.unopenedWorkspaces`），因此两处菜单的排序与措辞天然一致。
         */
        const addable = useMemo(() => model.unopenedWorkspaces(items, openWorkspaceIds), [items, openWorkspaceIds]);

        /** 分屏菜单第二步的候选：未铺开的在前，已铺开的标「已打开」。 */
        const splitChoices = useMemo(() => model.splitCandidates(items, openWorkspaceIds), [items, openWorkspaceIds]);

        const [addBusy, setAddBusy] = useState(false);
        const [addError, setAddError] = useState(null);

        /**
         * 拖动窗格标题栏交换位置的状态：`{ from, over }`。
         *   - `from`：正在被拖动的窗格（松手时参与交换的那一个）；
         *   - `over`：指针当前落在的窗格（`null` = 没落在任何窗格上，松手即放弃）。
         *
         * 这**只是视觉状态**：拖动过程中一格都不换，真正的位置交换发生在松手那一刻
         * （由窗格块调用 `paneActions.swapPanes`）。因此指针扫过一串窗格不会连锁换位，
         * 中途后悔只要把指针移到空白处松开。
         */
        const [drag, setDrag] = useState(null);
        const dragFrom = drag === null ? null : drag.from;
        const dragOver = drag === null ? null : drag.over;

        /** 进入拖动（指针已越过阈值）：记下被拖的窗格，落点先清空。 */
        const startPaneDrag = useCallback((key) => setDrag({ from: key, over: null }), []);

        /** 指针换到了另一个窗格上（或离开了所有窗格）：只改落点高亮。 */
        const hoverPane = useCallback((over) => setDrag((current) => (current === null || current.over === over
          ? current
          : { ...current, over })), []);

        /** 拖动结束（松手 / 取消）：落点高亮一律清掉，交换本身由窗格块完成。 */
        const endPaneDrag = useCallback(() => setDrag(null), []);

        /** 真正显示焦点环的窗格：存储里的选择还在就用它，否则退回第一个窗格。 */
        const activeKey = useMemo(() => {
          const leaves = model.collectLeaves(paneState.layout);
          if (leaves.length === 0) return null;
          return leaves.includes(paneState.activeKey) ? paneState.activeKey : leaves[0];
        }, [paneState.layout, paneState.activeKey]);

        /** 把一个工作区铺到棋盘上（不会创建会话）。 */
        const adoptWorkspace = useCallback((workspaceId) => {
          paneActions.addPane(workspaceId);
        }, [paneActions]);

        /**
         * 文件夹选择器的失败带一个标记，好让调用方说清是「选择器打不开」还是
         * 「工作区建不出来」——这两种失败用户能做的事不一样。
         */
        const pickerFailure = (reason) => {
          const error = new Error(errorText(reason));
          error.pickerFailed = true;
          return error;
        };

        /** 添加流程的报错文案：选择器本身的失败单独说。 */
        const describeAddError = useCallback((reason) => {
          const headline = reason !== null && typeof reason === 'object' && reason.pickerFailed === true
            ? t('panel.pickerFailed')
            : t('panel.addFailed');
          return headline + ': ' + errorText(reason);
        }, [t]);

        /**
         * 打开文件夹选择器，把选中的目录注册成工作区。
         *
         * 面板顶部的「添加工作区」与窗格分屏菜单第二步的「新建工作区…」共用这一段，
         * 于是 Desktop 的 preload 桥、web 的选择器、失败处理都只有一份实现。
         *
         * @returns 新工作区的 id；用户取消时返回 undefined。
         */
        const createWorkspaceFromDirectory = useCallback(async () => {
          const desktop = typeof globalThis === 'undefined' ? undefined : globalThis.__DSH_DIRECTORY_PICKER__;
          const external = desktop !== undefined && desktop !== null && typeof desktop.pick === 'function' ? desktop.pick() : undefined;
          let picked;
          if (external === undefined) {
            try {
              picked = await uiWorkspace.pickDirectory();
            } catch (reason) {
              throw pickerFailure(reason);
            }
          } else {
            picked = await external;
          }
          if (picked === null || picked === undefined || picked === '') return undefined;
          const created = await workspaces.create({ path: picked });
          return created.workspaceId;
        }, [uiWorkspace, workspaces]);

        /** 统一处理「忙碌 + 报错」的添加动作。 */
        const runAdd = useCallback((task) => {
          setAddError(null);
          setAddBusy(true);
          Promise.resolve().then(task)
            .catch((reason) => {
              setAddError(describeAddError(reason));
            })
            .finally(() => {
              setAddBusy(false);
            });
        }, [describeAddError]);

        /** 选一个文件夹注册成新工作区，并铺到棋盘上。 */
        const pickWorkspace = useCallback(() => {
          runAdd(async () => {
            const createdId = await createWorkspaceFromDirectory();
            if (createdId === undefined) return;
            adoptWorkspace(createdId);
          });
        }, [runAdd, createWorkspaceFromDirectory, adoptWorkspace]);

        /** 每个窗格该显示哪个会话、有哪些可选会话、可复用哪个空白会话，一次算好。 */
        const panePlan = useMemo(() => {
          const index = new Map();
          for (const pane of panes) {
            const workspace = workspaceById.get(pane.workspaceId);
            const rows = model.selectableSessions(workspace, sessionState, archivedSessionIds);
            const sessionId = model.resolvePaneSessionId(pane, rows, sessionState, archivedSessionIds);
            /*
             * 「可复用的空白会话」要把**别的**窗格钉住的会话排除掉：那些会话正在
             * 另一格里显示，抢过来会把它悄悄换掉。当前窗格自己钉住的不排除 ——
             * 那一格本来就是空会话时，再建一条毫无意义（见 reusableBlankSession）。
             */
            const occupiedByOthers = panes
              .filter((other) => other.key !== pane.key && other.sessionId !== null && other.sessionId !== undefined)
              .map((other) => other.sessionId);
            index.set(pane.key, {
              rows,
              sessionId,
              summary: sessionId === undefined ? undefined : sessionState.byId[sessionId],
              reusableBlankId: model.reusableBlankSession(workspace, sessionState, archivedSessionIds, occupiedByOthers),
            });
          }
          return index;
        }, [panes, workspaceById, sessionState, archivedSessionIds]);

        /** 渲染一个窗格元素；`grow` 是它在分屏里占的比例（整块棋盘上只有一个窗格时为空）。 */
        const renderPane = (pane, grow) => {
          const plan = panePlan.get(pane.key);
          return h(PaneFrame, {
            key: pane.key,
            pane,
            grow,
            workspace: workspaceById.get(pane.workspaceId),
            workspaceChoices: splitChoices,
            /*
             * 替换菜单的候选：还没铺开的工作区（`addable`），加上「一共注册了几个工作区」
             * 这个数 —— 菜单要分开说「还没有工作区」与「别的工作区都铺开了」。
             */
            replaceChoices: addable,
            workspaceCount: items.length,
            rows: plan === undefined ? [] : plan.rows,
            sessionId: plan === undefined ? undefined : plan.sessionId,
            summary: plan === undefined ? undefined : plan.summary,
            reusableBlankId: plan === undefined ? undefined : plan.reusableBlankId,
            active: pane.key === activeKey,
            dragging: dragFrom === pane.key,
            dropTarget: dragOver === pane.key && dragFrom !== pane.key,
            onPaneDragStart: startPaneDrag,
            onPaneDragOver: hoverPane,
            onPaneDragEnd: endPaneDrag,
            t,
            paneActions,
            sessions,
            uiWorkspace,
            createWorkspaceFromDirectory,
            describeAddError,
            openWorkspaceDirectory,
            requestSessionDelete,
            agentPresets,
            presetOptions,
            presetDefaultId,
            mcpServers: mcpState.servers,
            mcpStatus: mcpState.status,
            mcpError: mcpState.error,
            mcpByWorkspace: mcpState.byWorkspace,
            SessionProvider,
            renderSlot,
          });
        };

        /**
         * 按布局树渲染：叶子是窗格，分屏是「子块 + 分隔条 + 子块」。
         *
         * 两块用 `flex-grow` 分配空间（比例 0.3/0.7 就写 0.3 与 0.7），
         * 分隔条固定宽度，于是拖动只需改比例，浏览器自己完成布局。
         *
         * **叶子窗格直接当孩子渲染，不再套一层占位 div**，这是「拖动标题栏交换位置」
         * 能做干净的关键：React 按 key 匹配兄弟节点，只有两个窗格彼此是兄弟时，交换
         * 布局树里那两个叶子的 key 才会让它**整体搬动**这两棵子树，而不是卸载重建 ——
         * 后者会让会话引用松手（DSH 的契约：最后一次释放拆掉会话的本地作用域与历史），
         * 两边的对话都重新打开一遍。占比改由窗格自己的 `flexGrow` 承担：它本来就是
         * `flex:1 1 0`，与套一层 div 的效果完全一样。
         *
         * 分屏自己的子树仍然要套一层：那一层是 `flex` 容器，负责把这个子块撑满分给它的
         * 份额，比例写在它的 `flexGrow` 上。
         */
        const renderChild = (node, key, grow) => {
          if (node.type === 'leaf') {
            const pane = panes.find((candidate) => candidate.key === node.paneKey);
            return pane === undefined ? null : renderPane(pane, grow);
          }
          return h('div', {
            key,
            className: css.splitChild,
            style: { flexGrow: grow },
          }, renderNode(node));
        };

        /**
         * 这里返回的是普通元素树，只有分隔条是有自己 Hook 的组件，
         * 因此分屏出现/消失时窗格内部的 Hook 顺序不会被打乱。
         */
        const renderNode = (node) => {
          if (node === null || node === undefined) return null;
          if (node.type === 'leaf') {
            const pane = panes.find((candidate) => candidate.key === node.paneKey);
            return pane === undefined ? null : renderPane(pane);
          }
          const horizontal = node.dir !== 'col';
          const label = horizontal ? t('splitter.row') : t('splitter.col');
          return h('div', {
            key: node.id,
            className: cx(css.split, horizontal ? css.splitRow : css.splitCol),
            'data-split': node.id,
            'data-dir': horizontal ? 'row' : 'col',
          },
            renderChild(node.a, node.id + '-a', node.ratio),
            h(Splitter, {
              key: node.id + '-divider',
              dir: horizontal ? 'row' : 'col',
              ratio: node.ratio,
              label,
              onRatio: (ratio) => paneActions.setRatio(node.id, ratio),
              onReset: () => paneActions.setRatio(node.id, model.SPLIT_EVEN_RATIO),
            }),
            renderChild(node.b, node.id + '-b', 1 - node.ratio));
        };

        return h('div', { className: css.root, [BOARD_MARKER]: 'true' },
          h('header', { className: css.head },
            h('div', { className: css.headMain },
              h('h1', { className: css.title }, t('panel.title'))),
            h('div', { className: css.headActions },
              h(Popover, {
                label: addBusy ? t('panel.adding') : t('panel.add'),
                title: t('panel.add'),
                align: 'end',
                disabled: addBusy,
              }, (close) => [
                h(MenuItem, {
                  key: 'new',
                  label: t('panel.newWorkspace'),
                  hint: t('panel.newWorkspaceHint'),
                  onClick: () => {
                    close();
                    pickWorkspace();
                  },
                }),
                ...(items.length === 0
                  ? [h('div', { key: 'none', className: css.menuNote }, t('panel.noWorkspace'))]
                  : addable.length === 0
                    ? [h('div', { key: 'all', className: css.menuNote }, t('panel.addAllOpen'))]
                    : addable.map((item) => h(MenuItem, {
                        key: item.workspaceId,
                        label: item.title,
                        hint: item.path,
                        onClick: () => {
                          close();
                          runAdd(() => adoptWorkspace(item.workspaceId));
                        },
                      }))),
              ]))),
          addError === null ? null : h('div', { className: css.headError, role: 'alert' },
            h('span', { className: css.headErrorText }, addError),
            h('button', {
              type: 'button',
              className: css.iconButton,
              title: t('panel.dismiss'),
              'aria-label': t('panel.dismiss'),
              onClick: () => setAddError(null),
            }, h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
              h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })))),
          panes.length === 0
            ? h('div', cx(css.board, css.boardEmpty),
                h('strong', null, t('board.emptyTitle')),
                h('span', null, t('board.emptyBody')))
            : h('div', { className: css.board },
                h('div', { className: css.boardTree }, renderNode(paneState.layout))));
      }
      SplitPanel.displayName = 'SplitPanel';

      return { Splitter, PaneFrame, PaneBody, SplitPanel, installPaneKeys };
    }

    return { createView };
  },
});
