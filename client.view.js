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

    /**
     * 客户端构建标记。
     *
     * 每次改客户端就把它往后推一位。它是排障时的可靠锚点：页面跑的是不是最新代码，
     * 看一眼画布左下角那行自诊断就知道 —— 之前「刷新后箭头没了」查了两轮，卡住的
     * 正是「无法确认浏览器到底加载了哪一版」。
     */
    const CLIENT_BUILD = '2026-11-13h';

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
     * @param deps.views - 会话视图块（`createPaneBody`：带视图标签栏的窗格主体）。
     * @param deps.viewTabs - 会话视图清单源（入口块用 `createViewTabs` 建好）。
     */
    function createView({ css, cx, errorText, model, menu, pane, graph, views, viewTabs }) {
      const { Popover, MenuItem } = menu;
      // 设计模式画布：只画卡片和箭头，校验与布局都在 `client.graph.model.js` 里算好。
      const { GraphBoard } = graph;
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

      /**
       * 窗格主体：共享的 Conversation Factory，用 embedded 变体。
       *
       * 视图标签栏与“把选中的视图 id 传给平台”这两件事都在 `client.views.js` 里：
       * 本块只负责把清单源交过去。没有额外视图插件时它不会渲染标签栏，窗格行为
       * 与改造前一致。
       */
      const PaneBody = views.createPaneBody({ css, cx, viewTabs });

      /** 整块棋盘。 */
      function SplitPanel(props) {
        const { t, renderSlot, SessionProvider, paneStore, paneActions, presetStore, mcpStore, skillStore, sessions, sessionList, workspaces, uiWorkspace, openWorkspaceDirectory, requestSessionDelete, agentPresets, viewModeStore, graphStore, graphModel, dispatchStore, graphActions } = props;
        const paneState = useSource(paneStore);
        const workspaceState = useSource(workspaces.list);
        const sessionState = useSource(sessionList);
        const presetState = useSource(presetStore);
        const mcpState = useSource(mcpStore);
        const skillState = useSource(skillStore);
        const modeState = useSource(viewModeStore);
        const graphState = useSource(graphStore);
        const dispatchState = useSource(dispatchStore);
        const items = workspaceState.items;
        const archivedSessionIds = workspaceState.archivedSessionIds;
        const panes = paneState.panes;
        const presetOptions = presetState.options;
        const presetDefaultId = presetState.defaultId;

        /*
         * 这份组件实例是否已经用“保存的布局”接管过任务分派图。
         *
         * Host 自己也存着一份绑定表（`paneDispatch`）；没有保存布局时靠它恢复箭头。
         * 但用户一旦保存过布局，图就是那份快照的一部分：即使保存的是空图，也不能让
         * Host 上的旧绑定在下面那个兜底效果里把它填回来。用 ref 而不是 state，是因为
         * 读取发生在异步 loadDispatch 的回调里，只需要“当前值”，不需要触发渲染。
         */
        const savedGraphOwned = useRef(false);
        /*
         * Host 的绑定表是否已经真正读回来并处理完（不只是 dispatchStore 的状态变成
         * ready）。保存按钮靠它避免一个很窄的竞态：状态已经 ready、但“把绑定反推成边”
         * 的那段 `.then` 还没跑完时，graphStore 仍是空的；这时若把空图写进保存结构，
         * 下次恢复就会把 Host 上原本存在的箭头清掉。
         */
        const graphReadyForSave = useRef(false);
        const [savedLayoutAvailable, setSavedLayoutAvailable] = useState(false);
        /*
         * Host 布局是唯一的持久化来源，所以每次挂载都必须先异步问一次 Host；
         * 没查完之前不能播种，否则默认布局会先把棋盘占住。
         */
        const [layoutLookupDone, setLayoutLookupDone] = useState(false);
        /*
         * 模式花名册来自远端；正常几十毫秒就回来，但连接异常时不能让它把恢复流程
         * 永远卡在“正在恢复…”。4 秒后即使还没回来也继续恢复（保留保存时的模式 id），
         * 界面可用比死等一个清单更重要。
         */
        const [presetDeadlinePassed, setPresetDeadlinePassed] = useState(false);
        useEffect(() => {
          if (!savedLayoutAvailable) return undefined;
          const timer = setTimeout(() => setPresetDeadlinePassed(true), 4000);
          return () => clearTimeout(timer);
        }, [savedLayoutAvailable]);
        /*
         * Host 布局是一次异步读取；远端命名空间可能比面板晚挂上，所以短暂重试。
         * 6 秒还读不到就按“没有保存”继续播种，避免面板永远停在恢复态。
         */
        useEffect(() => {
          if (layoutLookupDone) return undefined;
          let cancelled = false;
          let timer = null;
          let attempts = 0;
          const load = () => {
            Promise.resolve(paneActions.loadSavedLayout())
              .then((found) => {
                if (cancelled) return;
                if (found === true) {
                  setSavedLayoutAvailable(true);
                  setLayoutLookupDone(true);
                  return;
                }
                if (found === false) {
                  setLayoutLookupDone(true);
                  return;
                }
                attempts += 1;
                if (attempts >= 5) {
                  setLayoutLookupDone(true);
                  return;
                }
                timer = setTimeout(load, 300);
              })
              .catch(() => {
                if (!cancelled) setLayoutLookupDone(true);
              });
          };
          load();
          return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
          };
        }, [layoutLookupDone, paneActions]);
        const [saveState, setSaveState] = useState('idle');
        const saveTimer = useRef(null);
        useEffect(() => () => {
          if (saveTimer.current !== null) clearTimeout(saveTimer.current);
        }, []);

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
          // 棋盘已经就位（当前页面里用过，或刚恢复/播种过）就不再覆盖。
          if (paneState.initialized || paneState.panes.length > 0) return;
          if (workspaceIds.length === 0) return;
          // Host 布局还没查完：先别播种，否则默认布局会抢在保存布局前面。
          if (!layoutLookupDone) return;
          /*
           * 没有保存过布局：保持原来的首次播种行为，不等待会话/模式清单。
           */
          if (!savedLayoutAvailable) {
            paneActions.ensureInitialized(currentWorkspaceId, workspaceIds);
            return;
          }
          /*
           * 有保存的布局：必须等会话表和模式清单就绪再恢复。
           *
           * 会话表没就绪时，无法区分「保存的会话已经不存在」与「只是还没加载」；
           * 这时抢先恢复会把仍然有效的会话误清空，或者让窗格钉在一个不存在的会话上
           * 一直显示“载入历史…”。模式清单同理：没就绪时无法判断保存的 Agent 模式
           * 是否还存在，恢复后再清空会造成一次可见闪烁。
           */
          if (sessionState.phase !== 'ready') return;
          const presetSettled = presetState.status !== 'idle' && presetState.status !== 'loading';
          if (!presetSettled && !presetDeadlinePassed) return;
          // 正常路径按花名册校验模式；超时仍在加载时传 null，保留保存时的模式 id。
          const validPresetIds = presetState.status === 'ready'
            ? presetState.options.map((option) => option.id)
            : (presetSettled ? [] : null);
          const validSession = (id, allowBlank) => {
            const summary = sessionState.byId[id];
            if (summary === undefined) return false;
            if (summary.origin === 'subagent') return false;
            if (archivedSessionIds.includes(id)) return false;
            if (allowBlank !== true && summary.blank === true) return false;
            return true;
          };
          let result;
          try {
            result = paneActions.restoreSavedLayout({
              workspaces: items.map((item) => ({ workspaceId: item.workspaceId, path: item.path })),
              isValidPaneSession: (id) => validSession(id, true),
              isValidGraphSession: (id) => validSession(id, false),
              presetIds: validPresetIds,
            });
          } catch {
            // 恢复是增益功能：任何意外都退回默认播种，绝不把面板卡死在恢复态。
            result = { panes: false, graph: false };
          }
          /*
           * 保存结构里带图（哪怕边被清空）时，这份快照拥有图：抑制下面“从 Host 绑定表
           * 反推箭头”的兜底，避免刚才保存的空图又被 Host 上的旧绑定填回来。
           */
          savedGraphOwned.current = result?.graph === true;
          // 保存结构里真的有图时，它本身就是可靠快照；不必再等 Host 绑定表。
          if (result?.graph === true) graphReadyForSave.current = true;
          // 没有可用窗格（例如保存的工作区全被删了）时，仍按原有规则播种默认布局。
          if (result?.panes !== true) paneActions.ensureInitialized(currentWorkspaceId, workspaceIds);
        }, [
          paneActions,
          paneState.initialized,
          paneState.panes.length,
          currentWorkspaceId,
          workspaceIds,
          items,
          sessionState,
          archivedSessionIds,
          presetState.status,
          presetState.options,
          presetDeadlinePassed,
          savedLayoutAvailable,
          layoutLookupDone,
        ]);

        useEffect(() => {
          paneActions.loadPresets();
        }, [paneActions]);

        useEffect(() => {
          paneActions.loadMcp();
        }, [paneActions]);

        /*
         * 技能清单也必须**挂载时就读一次**：标题栏那个 SKILL 按钮只在 store 已经不是
         * `idle` 时才渲染（没装技能库插件时整块消失），而它自己的「打开时重读」要靠
         * 按钮已经被渲染出来。少了这一句就成了先有鸡还是先有蛋 —— 按钮永远不出现。
         */
        useEffect(() => {
          paneActions.loadSkills();
        }, [paneActions]);

        /*
         * 绑定表也必须**挂载时读一次**：Host 那边的绑定活在它自己的内存里，Host 重启
         * 之后是空的，而页面上可能还画着箭头。读一次让同步器知道「已经推过什么」，
         * 然后由下面那个同步效果把两边对齐 —— 对齐的方向永远是「以页面上的箭头为准」。
         */
        useEffect(() => {
          /*
           * 读完把**上次画的那棵树**恢复出来。
           *
           * 绑定表存在 Host 上（`~/.dsh/storages/pane_dispatch_bindings.json`），所以
           * 刷新页面、甚至重启 Host 之后，箭头都还在。客户端要做的只是把它反推成边。
           *
           * 只在「本地一条边都没有」时采纳：否则会盖掉用户在这次会话里刚画的改动。
           */
          let cancelled = false;
          let timer = null;
          /*
           * 带重试：远端命名空间是异步挂载的，第一次读很可能还没挂上。
           * 只读到就停；读不到就隔一会儿再试，最多试 10 次（约 3 秒），之后放弃并让
           * 画布顶部的状态说明接管。
           */
          const attempt = (round) => {
            Promise.resolve(paneActions.loadDispatch())
              .then((loaded) => {
                if (cancelled) return;
                if (loaded === undefined || loaded === null) {
                  if (round < 10) timer = setTimeout(() => attempt(round + 1), 300);
                  return;
                }
                // 绑定表已经读回来并处理完，之后保存的图才是可靠快照。
                graphReadyForSave.current = true;
                /*
                 * 保存的布局里带了图：这份快照就是权威，即使它是空图也不让 Host 的旧绑定
                 * 填回来。保存的图会在同步效果里重新推给 Host。
                 */
                if (savedGraphOwned.current) return;
                if (graphStore.getSnapshot().edges.length > 0) return;
                const restored = graphModel.edgesFromBindings(loaded);
                if (restored.length > 0) graphStore.setEdges(restored);
              })
              .catch(() => undefined);
          };
          attempt(0);
          return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
          };
        }, [paneActions, graphStore, graphModel]);

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

        /**
         * 任务分派里的卡片 = **会话**，不是窗格。
         *
         * 候选范围是「当前铺开在棋盘上的那些工作区里的全部真实会话」（空白会话、归档、
         * 子代理会话都不算）。这样：
         *   - 同一个会话开在两格里只出现一张卡片；
         *   - 关掉窗格、换掉某格的会话，卡片与箭头都不受影响；
         *   - **没在棋盘上打开的会话也能被连上** —— 第一版把卡片绑在窗格上时，
         *     「A 没开在棋盘里就连不出箭头」是真实踩过的坑。
         *
         * `inPane` 只决定「点卡片能不能跳过去看」，与能不能连箭头无关。
         */
        const graphCards = useMemo(() => {
          const inPane = new Set();
          for (const pane of panes) {
            const plan = panePlan.get(pane.key);
            if (plan !== undefined && plan.sessionId !== undefined) inPane.add(plan.sessionId);
          }
          const seen = new Set();
          const rows = [];
          /*
           * 候选是**全部已存在的会话**，不再限于「当前铺在棋盘上的工作区」。
           *
           * 理由：委派关系是会话之间的事，跟哪个工作区现在开着没关系。真实需求里常见
           * 「A 在 dsh 目录、B 在 rea 目录，两个工作区都只开了其中一个会话」—— 按铺开的
           * 工作区过滤时，同目录下别的会话根本选不到。
           *
           * 仍然排除三类：空白会话（没有内容可派）、归档会话（用户已经收起来了）、
           * 子代理会话（不是给人用的对话）。
           */
          for (const workspace of items) {
            for (const row of model.selectableSessions(workspace, sessionState, archivedSessionIds)) {
              if (seen.has(row.id)) continue;
              seen.add(row.id);
              rows.push({ row, workspace });
            }
          }
          /*
           * 不属于任何已注册工作区的会话也要算进来（比如工作区被删了、会话还留着）。
           * 它们只出现在会话表里，所以从 `sessionState` 补一遍。
           */
          for (const id of sessionState.ids) {
            if (seen.has(id)) continue;
            const summary = sessionState.byId[id];
            if (summary === undefined || summary.origin === 'subagent') continue;
            if (summary.blank === true) continue;
            if (archivedSessionIds.includes(id)) continue;
            seen.add(id);
            const owner = items.find((item) => item.path === summary.cwd);
            rows.push({ row: summary, workspace: owner });
          }
          /*
           * 这个顺序只决定**树根**在布局里的先后（以及同一层无上级节点之间的次序）。
           *
           * 候选花名册不再用这个全局顺序：它按工作区分组、组内按会话名字母排（见
           * `graphLayout` 里的 `groupSessionsByWorkspace`）。这里保留「最近更新」
           * 是为了让树根的顺序稳定且贴近使用习惯。
           */
          rows.sort((left, right) => (right.row.updatedAt ?? 0) - (left.row.updatedAt ?? 0));
          return rows.map(({ row, workspace }) => {
            const title = row.displayTitle;
            return {
              key: row.id,
              label: title === undefined || title === '' ? t('pane.untitled') : title,
              // 分组用：同一个工作区的候选卡片聚在一起。会话不属于任何工作区时留空，
              // 由模型把它归入「未归属工作区」并固定排在最后。
              workspaceKey: workspace === undefined ? '' : workspace.workspaceId,
              workspaceTitle: workspace === undefined ? t('pane.unknownWorkspace') : workspace.title,
              running: row.running === true,
              inPane: inPane.has(row.id),
            };
          });
        }, [items, sessionState, archivedSessionIds, panes, panePlan, model, t]);

        /** 卡片（按会话 id）的索引，换算绑定表时用它取显示名。 */
        const graphCardById = useMemo(() => {
          const index = new Map();
          for (const card of graphCards) index.set(card.key, card);
          return index;
        }, [graphCards]);

        /**
         * 用户从左侧选择器拖进画布、但还没连线的会话。
         *
         * 这份状态**不落盘**：箭头（绑定表）才是需要持久化的授权关系；待连线卡片只是
         * 编辑过程中的暂存，刷新后重新从左侧拖一次即可。已连线的会话不在布局里用它
         * （见 `graphLayout` 的过滤），删掉箭头后它会自动回到「待连线」。
         */
        const [stagedSessions, setStagedSessions] = useState(() => new Set());

        /** 把一个真实会话加入画布；未知 id 直接忽略，避免画出一张查不到内容的空卡。 */
        const stageSession = useCallback((sessionId) => {
          if (typeof sessionId !== 'string' || sessionId === '') return;
          if (!graphCardById.has(sessionId)) return;
          setStagedSessions((current) => {
            if (current.has(sessionId)) return current;
            const next = new Set(current);
            next.add(sessionId);
            return next;
          });
        }, [graphCardById]);

        /** 把待连线会话移出画布；已连线的会话不在这里移除（那要删箭头）。 */
        const unstageSession = useCallback((sessionId) => {
          setStagedSessions((current) => {
            if (!current.has(sessionId)) return current;
            const next = new Set(current);
            next.delete(sessionId);
            return next;
          });
        }, []);

        /**
         * 画布布局：左边是**用户从选择器拖进来的待连线会话**，右边是已经连成树的会话。
         *
         * 画布不再平铺全部会话：谁出现在画布上由用户在选择器里决定。待连线卡片连上
         * 箭头之后自动从左侧列进入右侧的树；删掉箭头又回到待连线列。
         */
        const graphLayout = useMemo(() => {
          const connected = new Set();
          for (const edge of graphState.edges) {
            connected.add(edge.from);
            connected.add(edge.to);
          }
          const treeKeys = graphCards.filter((card) => connected.has(card.key)).map((card) => card.key);
          const stagedKeys = graphCards
            .filter((card) => stagedSessions.has(card.key) && !connected.has(card.key))
            .map((card) => card.key);
          return graphModel.layoutGraphWithStaged(graphState.edges, treeKeys, stagedKeys);
        }, [graphState.edges, graphCards, graphModel, stagedSessions]);

        /**
         * 左侧二级选择器的数据：工作区 → **还没加入画布**的会话。
         *
         * 一旦会话被拖进画布（待连线）或已经连进树，它就不再出现在左侧：列表里始终只有
         * 「还能加入的」，用户不用在已加入的条目里辨认状态。把它移出画布（卡片右上角 ×，
         * 或删掉箭头后回到待连线再移出）之后，它会重新出现在这里。
         *
         * 分组与字母排序交给模型（`groupSessionsByWorkspace`）；没有任何可选项的工作区
         * 整组隐藏，避免展开一个空组。
         */
        const pickerGroups = useMemo(() => {
          const connected = new Set();
          for (const edge of graphState.edges) {
            connected.add(edge.from);
            connected.add(edge.to);
          }
          return graphModel.groupSessionsByWorkspace(graphCards, { unknownLabel: t('pane.unknownWorkspace') })
            .map((group) => ({
              key: group.key,
              label: group.label,
              items: group.items
                .map((id) => graphCardById.get(id))
                .filter((card) => card !== undefined && !connected.has(card.key) && !stagedSessions.has(card.key))
                .map((card) => ({
                  key: card.key,
                  label: card.label,
                  workspaceTitle: card.workspaceTitle,
                  running: card.running === true,
                })),
            }))
            .filter((group) => group.items.length > 0);
        }, [graphCards, graphCardById, graphState.edges, stagedSessions, graphModel, t]);

        /**
         * 把画出来的箭头换算成 Host 的绑定表，并在它变化时同步过去。
         *
         * 边两端就是会话 id，所以这里只需要「这个会话还在不在册、叫什么名字」——
         * 不再有「窗格 → 会话」那一层解析，换会话、关窗格都不会影响结果。
         */
        const bindings = useMemo(() => graphModel.bindingsFromEdges(
          graphState.edges,
          (sessionId) => graphCardById.get(sessionId),
        ), [graphState.edges, graphCardById]);

        /*
         * 会话表到了没有。
         *
         * 刷新页面时，**箭头和会话表是两条各自异步的线**：箭头从 Host 读回来（快），
         * 会话表从会话服务读回来（慢一点）。如果箭头先回来、会话表还没到，算绑定表时
         * 两端都会「查无此会话」→ 算出来是空表 → 同步器以为用户把箭头全删了，于是把
         * Host 上存好的树清掉。**这就是「刷新一次就没了」的真正原因。**
         *
         * 所以在会话表到达之前，一次同步都不发。
         */
        const rosterReady = sessionState.ids.length > 0;

        useEffect(() => {
          if (!rosterReady) return;
          /*
           * `syncBindings` 返回 Promise。这里必须接住它：一个没人处理的 rejected
           * Promise 在浏览器里只会变成控制台的一条警告，界面上什么都不会发生 ——
           * 而这条链上任何一次失败都意味着「箭头没生效」，恰恰是最不该静默的。
           * 失败原因由同步器自己写进 `dispatchState.error`，这里只负责不丢。
           */
          Promise.resolve(graphActions.syncBindings(bindings)).catch(() => undefined);
        }, [bindings, graphActions, rosterReady]);

        /**
         * 任务分派里点一张卡片：切回平铺并聚焦「正在显示这个会话」的那一格。
         *
         * 一个会话可能同时开在好几格里，取第一格即可（用户想看的都是同一段对话）。
         * 这个会话没在任何窗格里打开时什么也不做 —— 画布那边不会给出可点的提示。
         */
        const openPaneFromGraph = useCallback((sessionId) => {
          for (const pane of panes) {
            const plan = panePlan.get(pane.key);
            if (plan !== undefined && plan.sessionId === sessionId) {
              viewModeStore.setMode(graphModel.MODE_TILES);
              paneActions.setActive(pane.key);
              return;
            }
          }
        }, [panes, panePlan, viewModeStore, graphModel, paneActions]);

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
            skillStatus: skillState.status,
            skills: skillState.skills,
            skillDir: skillState.dir,
            skillErrors: skillState.errors,
            skillError: skillState.error,
            skillByWorkspace: skillState.byWorkspace,
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

        /*
         * 顶部两个模式按钮。
         *
         * 用 `aria-pressed` 表达选中而不是换一套 class：读屏会念「已按下」，视觉上由
         * `.dshSplitWs_mode[aria-pressed=true]` 上色 —— 两件事同一个真值来源。
         */
        const modeSwitch = h('div', { className: css.modes, role: 'group', 'aria-label': t('mode.tilesHint') },
          h('button', {
            key: 'tiles',
            type: 'button',
            className: css.mode,
            'aria-pressed': modeState.mode === graphModel.MODE_TILES,
            title: t('mode.tilesHint'),
            onClick: () => viewModeStore.setMode(graphModel.MODE_TILES),
          }, t('mode.tiles')),
          h('button', {
            key: 'graph',
            type: 'button',
            className: css.mode,
            'aria-pressed': modeState.mode === graphModel.MODE_GRAPH,
            title: t('mode.graphHint'),
            onClick: () => viewModeStore.setMode(graphModel.MODE_GRAPH),
          }, t('mode.graph')));

        const graphBoard = h(GraphBoard, {
          key: 'graph',
          cards: graphCards,
          edges: graphState.edges,
          /*
           * 一行自诊断。用户报「箭头没了」时，这一行能直接分清是：
           *   构建没更新（build 标记对不上）/ 读不到 Host 绑定表（状态不是 ready）/
           *   读到了但没恢复出来（关系数是 0）。
           */
          diagnostic: 'build ' + CLIENT_BUILD
            + ' · 关系 ' + String(graphState.edges.length)
            + ' · 会话 ' + String(graphCards.length)
            + ' · 待连线 ' + String(stagedSessions.size)
            + ' · 同步 ' + dispatchState.status
            + (dispatchState.error === null || dispatchState.error === undefined ? '' : '（' + dispatchState.error + '）'),
          layout: graphLayout,
          graph: graphModel,
          pickerGroups,
          actions: {
            addEdge: graphActions.addEdge,
            removeEdge: graphActions.removeEdge,
            // 少了这一行：编辑器打开后点「保存」会调一个 undefined —— 什么都不发生。
            setNote: graphActions.setNote,
            openPane: openPaneFromGraph,
            stageSession,
            unstageSession,
          },
          t,
          css,
          cx,
          degraded: dispatchState.status === 'unavailable',
        });

        /**
         * 这次保存能不能带上一份可靠的分派图。
         *
         * 两个来源：
         *   - 保存结构里本来就有图，恢复后它仍是权威快照；
         *   - 或者 Host 绑定表已经成功读回、并且“反推成边”的处理已经跑完。
         */
        const graphSnapshotReady = savedGraphOwned.current
          || (dispatchState.status === 'ready' && graphReadyForSave.current);
        /**
         * 当前界面有没有值得保存的东西：至少一个窗格，或一条已经读回来的分派边。
         *
         * 图还在 loading 时不能只凭“暂时没有边”就判断没东西可存；相反，那时应该
         * 允许先保存棋盘，只是不要把不可靠的空图写进快照。
         */
        const canSaveLayout = panes.length > 0
          || (graphSnapshotReady && graphState.edges.length > 0);
        /**
         * 有保存的布局、但还在等会话/模式清单就绪时，棋盘会暂时为空。
         * 这时显示“正在恢复…”而不是误导性的“还没有打开的工作区”。
         */
        const awaitingSavedLayout = savedLayoutAvailable
          && !paneState.initialized
          && panes.length === 0
          && workspaceIds.length > 0;

        /**
         * 保存当前界面：棋盘 + 窗格会话/模式 + 任务分派图 + 当前面板模式。
         * 保存失败只在这条通用错误行里说一句，不弹窗、不阻塞界面。
         */
        const handleSaveLayout = async () => {
          if (!canSaveLayout || saveState === 'saving') return;
          if (saveTimer.current !== null) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
          }
          /*
           * 图只有在 Host 绑定表确实读回来、并且已经处理完（或保存的图本身就是权威）
           * 时才是可靠快照。还在 loading / unavailable / error 时传 null：保存结构里
           * 不写 graph 字段，下次加载就不会拿一份空图去覆盖 Host 上可能还存在的旧绑定。
           */
          const graphSnapshot = graphSnapshotReady ? graphState : null;
          /*
           * “跟随最新会话”的窗格记录里 `sessionId` 往往是 null，真正显示的是
           * `panePlan` 现场解析出来的那一条。保存时必须把**眼前这一段对话**的 id
           * 落下来，否则下次恢复只会重新跟一次“最新”，用户看到的可能已经是另一段。
           * `follow` 原样保留：保存的会话以后被删了，跟随型窗格仍会回退到最新会话。
           */
          const resolvedPanes = paneState.panes.map((pane) => {
            const resolved = panePlan.get(pane.key)?.sessionId;
            const sessionId = typeof resolved === 'string' && resolved !== ''
              ? resolved
              : (typeof pane.sessionId === 'string' && pane.sessionId !== '' ? pane.sessionId : null);
            return { ...pane, sessionId };
          });
          const snapshotForSave = { ...paneState, panes: resolvedPanes };
          setSaveState('saving');
          const result = await paneActions.saveLayout(snapshotForSave, workspaceById, graphSnapshot, modeState.mode);
          if (result?.ok === true) {
            setSavedLayoutAvailable(true);
            setAddError(null);
            setSaveState('saved');
            if (saveTimer.current !== null) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              saveTimer.current = null;
              setSaveState('idle');
            }, 1800);
            return;
          }
          setSaveState('idle');
          setAddError(t('panel.saveFailed') + (typeof result?.reason === 'string' && result.reason !== '' ? ': ' + result.reason : ''));
        };

        /** 清除保存记录：当前界面保持不变，下次页面加载回到默认播种。 */
        const handleClearSavedLayout = async () => {
          const cleared = await paneActions.clearSavedLayout();
          if (cleared === true) {
            setSavedLayoutAvailable(false);
            setAddError(null);
            return;
          }
          setAddError(t('panel.clearFailed'));
        };

        return h('div', { className: css.root, [BOARD_MARKER]: 'true' },
          h('header', { className: css.head },
            h('div', { className: css.headMain },
              h('h1', { className: css.title }, t('panel.title'))),
            h('div', { className: css.headActions },
              modeSwitch,
              h('button', {
                type: 'button',
                className: cx(css.iconButton, css.saveLayout),
                title: t('panel.saveHint'),
                'aria-label': saveState === 'saved'
                  ? t('panel.saved')
                  : saveState === 'saving' ? t('panel.saving') : t('panel.save'),
                'data-state': saveState,
                'data-action': 'save-layout',
                disabled: !canSaveLayout || saveState === 'saving',
                onClick: () => { void handleSaveLayout(); },
              }, saveState === 'saved'
                ? h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
                  h('path', {
                    d: 'M3.2 8.3l3.1 3.1 6.5-7',
                    stroke: 'currentColor',
                    strokeWidth: 1.5,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                  }))
                : saveState === 'saving'
                  ? h('svg', {
                    className: css.saveSpinner,
                    width: 14,
                    height: 14,
                    viewBox: '0 0 16 16',
                    fill: 'none',
                    'aria-hidden': true,
                  }, h('circle', {
                    cx: 8,
                    cy: 8,
                    r: 5.2,
                    stroke: 'currentColor',
                    strokeWidth: 1.5,
                    strokeLinecap: 'round',
                    strokeDasharray: '20 12',
                  }))
                  : h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
                    h('path', {
                      d: 'M3.5 2.5h7.2l1.8 1.8v9.2h-9v-11z',
                      stroke: 'currentColor',
                      strokeWidth: 1.3,
                      strokeLinejoin: 'round',
                    }),
                    h('path', {
                      d: 'M5.8 2.5v3.2h4.4V2.5M5.8 13.5V9.8h4.4v3.7',
                      stroke: 'currentColor',
                      strokeWidth: 1.3,
                      strokeLinejoin: 'round',
                    }))),
              // 只有确实保存过时才出现；点它只删保存记录，当前界面一个窗格都不动。
              savedLayoutAvailable
                ? h('button', {
                    type: 'button',
                    className: css.iconButton,
                    title: t('panel.clearSavedHint'),
                    'aria-label': t('panel.clearSaved'),
                    onClick: () => { void handleClearSavedLayout(); },
                  }, h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
                    h('path', {
                      d: 'M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8',
                      stroke: 'currentColor',
                      strokeWidth: 1.3,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                    })))
                : null,
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
                awaitingSavedLayout
                  ? [
                      h('strong', { key: 'restoring' }, t('board.restoring')),
                      h('span', { key: 'restoringHint' }, t('board.restoringHint')),
                    ]
                  : [
                      h('strong', { key: 'empty' }, t('board.emptyTitle')),
                      h('span', { key: 'emptyHint' }, t('board.emptyBody')),
                    ])
            : modeState.mode === graphModel.MODE_GRAPH
              ? graphBoard
              : h('div', { className: css.board },
                  h('div', { className: css.boardTree }, renderNode(paneState.layout))));
      }
      SplitPanel.displayName = 'SplitPanel';

      return { Splitter, PaneFrame, PaneBody, SplitPanel, installPaneKeys };
    }

    return { createView };
  },
});
