/**
 * 平铺面板的窗格块：一个窗格的标题栏，以及它内部对话的挂载点。
 *
 * 从 client.view.js 拆出来，是因为视图块一度超过 800 行，而「一个窗格自己怎么显示」
 * 与「整块棋盘怎么排布」本来就是两件事。标题栏里的图标与弹出菜单来自菜单块，
 * 这里不再重复实现。
 *
 * 本块同时持有「把键盘光标送进某个窗格的输入框」这件 DOM 小事（`focusPaneInput`）：
 * 它的两个调用方都在这里或从这里出发 —— 窗格被点亮时（本文件），以及 `Alt+方向键`
 * 切窗格时（视图块通过入口注入的 `pane.focusPaneInput` 取用）。
 *
 * 「拖动标题栏交换两个窗格的位置」也在这里：手势属于标题栏，落点判定（命中测试）
 * 与交换后的光标安放也都跟着它，视图块只负责把共用的拖动状态（谁在被拖、指针在谁
 * 上面）传下来做视觉反馈。
 *
 * 「替换工作区」同样属于标题栏：每格一个图标，菜单里是「新建工作区…」与还没铺开的
 * 工作区（`replaceChoices` 由视图块算好传下来），选中后调 `replaceWorkspace` ——
 * 那一格的**位置**不动，只换里面的工作区与对话。
 *
 * 「切换会话」下拉里除了「新建会话」与会话列表，每一行末尾还有一个「删除会话」按钮。
 * 删除本身不在这里实现：入口块惰性解析 `@local/dsh-session-delete` 的客户端服务入口，
 * 把「哪一行、叫什么名字」交给它那扇确认弹窗（见 `requestSessionDelete`）。删成功后
 * 窗格怎么收场也由入口块决定 —— 把钉着这个会话的窗格全部松开。
 *
 * 依赖由入口块注入（DSH 的包内代码块之间不能互相 require）：
 * createPane({ css, cx, errorText, model, presets, menu, paneSlot })。
 *
 * 加载方式：入口 client.js 用 require.async('./client.pane.js') 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.pane.js',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    /**
     * 组装窗格组件。
     *
     * @param deps.css - class 名对照表（来自样式块）。
     * @param deps.cx - class 名拼接工具（来自样式块）。
     * @param deps.errorText - 把抛出物转成可读文本（来自入口块）。
     * @param deps.model - 纯模型块（分屏方向表、会话引用来源标记等）。
     * @param deps.presets - 模式块（读模式名、应用模式）。
     * @param deps.menu - 菜单块（弹出菜单与图标）。
     * @param deps.paneSlot - 本插件声明的窗格子槽位名（对话本体挂在这里）。
     */
    function createPane({ css, cx, errorText, model, presets, menu, skill, paneSlot }) {
      const { SplitGlyph, FolderGlyph, ReplaceGlyph, Popover, MenuItem, MenuDeleteButton, McpGlyph } = menu;
      /*
       * 技能勾选列表由 `client.skill.js` 造。依赖从外面递进去（而不是那个块自己去 require
       * 菜单块）：DSH 的包内代码块之间不能互相 require，只能由入口装配。
       */
      const skillControl = skill.createSkillControl({ css, cx, menu });
      /** 分屏方向 → 词典键，四行菜单的文案。 */
      const SPLIT_LABEL_KEYS = {
        left: 'pane.splitLeft',
        right: 'pane.splitRight',
        up: 'pane.splitUp',
        down: 'pane.splitDown',
      };

      /**
       * 「这次交互的落点是不是控件」的判定用选择器。
       *
       * 三类元素算控件：
       *   1. 原生可聚焦元素 —— 按钮、有地址的链接、表单控件；
       *   2. 把自己声明成控件的 ARIA 角色 —— 菜单项、标签页、复选框之类；
       *   3. 可编辑区 `[contenteditable]` —— 它把**对话输入框本身**也覆盖了，这正是
       *      想要的：用户点在输入框的某个字上时，插入点该落在他点的那个字上，
       *      我们再去 `focus()` 一次反而会把插入点挪走。
       *
       * `[tabindex]` 刻意不在列表里：会话滚动区、代码块这类容器常常带 `tabindex`
       * （很多是 `-1`，只为能被程序聚焦），把它们当控件会把「点消息区就把光标送回
       * 输入框」这个主要场景整个废掉 —— 那正是用户报回来的痛点。
       */
      const CONTROL_SELECTOR = 'button, a[href], input, select, textarea, [contenteditable], '
        + '[role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], '
        + '[role="tab"], [role="textbox"], [role="checkbox"], [role="radio"], [role="switch"], '
        + '[role="combobox"], [role="slider"]';

      /** 这次交互的落点是不是控件；拿不到 `closest` 的怪东西一律当「不是控件」。 */
      function isControlTarget(target) {
        if (target === null || target === undefined) return false;
        if (typeof target.closest !== 'function') return false;
        return target.closest(CONTROL_SELECTOR) !== null;
      }

      /**
       * 标题栏上「按下也不拖动窗格」的落点：控件（按钮 / 下拉 / 菜单行 / 输入框），
       * 外加**展开的菜单面板本身** —— 点在菜单的留白上（例如那句提示文字）是想读它，
       * 不是想把窗格拖走。
       */
      const DRAG_EXCLUDE_SELECTOR = CONTROL_SELECTOR + ', [role="menu"], [role="dialog"]';

      /** 这个落点是不是「不参与拖动」的位置；拿不到 `closest` 时按不参与处理。 */
      function isDragExcluded(target) {
        if (target === null || target === undefined) return true;
        if (typeof target.closest !== 'function') return true;
        return target.closest(DRAG_EXCLUDE_SELECTOR) !== null;
      }

      /**
       * 指针底下是哪个窗格 —— 拖动中的落点判定。
       *
       * 为什么用命中测试而不是 `pointerover`：拖动期间指针被 `setPointerCapture` 抓在
       * 起始窗格的标题栏上，别的窗格根本收不到指针事件（这正是捕获要解决的问题：
       * 指针跑到哪儿事件都还在我们手里）。命中测试不受捕获影响，`elementFromPoint`
       * 回答的始终是「指针底下真实的那个元素」。
       *
       * 不在任何窗格上（分隔条、棋盘留白、面板之外）时返回 null。
       */
      function paneKeyAtPoint(doc, x, y) {
        if (doc === null || doc === undefined || typeof doc.elementFromPoint !== 'function') return null;
        const hit = doc.elementFromPoint(x, y);
        if (hit === null || hit === undefined || typeof hit.closest !== 'function') return null;
        const host = hit.closest('[data-pane]');
        if (host === null || host === undefined || typeof host.getAttribute !== 'function') return null;
        return host.getAttribute('data-pane');
      }

      /**
       * 拖动期间给整个文档加的临时约束：不选中文字、光标是「抓住」。
       *
       * 选中文字这一条不是洁癖：拖动时指针会扫过对话正文，不拦住的话整段消息会被
       * 拖成一片蓝色选区，松手后还留在那儿。光标那条是为了让指针移出标题栏之后
       * （此时它在别的窗格上）仍然看得出「还在拖」。
       */
      function setDragChrome(on) {
        if (typeof document === 'undefined' || document === null || document.body === undefined || document.body === null) return;
        document.body.style.userSelect = on === true ? 'none' : '';
        document.body.style.cursor = on === true ? 'grabbing' : '';
      }

      /** 当前文档；没有 DOM 的环境（离线契约测试、精简宿主）返回 undefined，聚焦自然成为空操作。 */
      function currentDocument() {
        return typeof document === 'undefined' ? undefined : document;
      }

      /**
       * 用户是不是正在用鼠标选文字。
       *
       * 这一条是**实测**出来的硬约束（真实 Chrome + CDP 可信鼠标输入）：在 `click` 里
       * 对一个 contenteditable 调 `focus()`，会把刚拖出来的选区整段抹掉 —— 选区从
       * `ectable text here` 直接变成空、折叠。所以「点哪都送光标」必须给这一种交互让路：
       * 只要选区不是折叠的，就说明用户刚拖选（或双击选词）了一段文字要复制，这时一个字
       * 都不碰；单击（选区折叠）照旧送光标。
       *
       * 不会因为「页面上某处留着一个陈年选区」而永久失效：单击时先到的那一次 mousedown
       * 已经把旧选区清掉了（同一探针里验证过）。拿不到选区 API 的环境（离线测试的假文档、
       * 精简宿主）当作「没有在选文字」。
       */
      function isSelectingText(doc) {
        if (doc === null || doc === undefined || typeof doc.getSelection !== 'function') return false;
        const selection = doc.getSelection();
        if (selection === null || selection === undefined) return false;
        return selection.isCollapsed !== true;
      }

      /**
       * 把键盘光标送进目标窗格的输入框。
       *
       * 为什么走 DOM 而不调接口：DSH 没有「聚焦某个会话的输入框」的公开服务
       * （对话插件自己也只在内部 `editor.focus()`），而输入框宿主带一个稳定的
       * `data-composer-input` 标记，找它比猜类名可靠。
       *
       * 目标窗格还没有会话时，它里面要么没有输入框，要么那层 DOM 虽然存在但
       * `contenteditable` 是 `false`（inert 的宿主）—— 两种情况都只切高亮、
       * 不动当前的键盘焦点：没有可打字的地方，就不该把光标从别人手里抢走。
       *
       * @param doc - 文档对象（浏览器里就是 `document`）。
       * @param paneKey - 目标窗格的 key。
       */
      function focusPaneInput(doc, paneKey) {
        if (doc === null || doc === undefined || typeof doc.querySelector !== 'function') return;
        const host = doc.querySelector('[data-pane=' + JSON.stringify(paneKey) + ']');
        if (host === null || host === undefined) return;
        const input = host.querySelector('[data-composer-input]');
        if (input === null || input === undefined || typeof input.focus !== 'function') return;
        if (input.getAttribute('contenteditable') === 'false') return;
        input.focus({ preventScroll: true });
      }

      /**
       * 把一件事推到「当前这一轮同步工作做完之后」再执行。
       *
       * 有 `requestAnimationFrame` 就用它；没有的环境（jsdom、精简宿主）退回 `setTimeout`，
       * 语义相同：两者都在当前这一轮渲染与事件处理收尾之后才跑。
       *
       * @param callback - 要延后执行的事。
       */
      function afterFrame(callback) {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
        else setTimeout(callback, 0);
      }

      /**
       * 等一帧再聚焦。
       *
       * 关掉一个窗格时，接手焦点的窗格会**重新挂载**：它原来嵌在被折叠掉的那层分屏里，
       * 布局树塌陷后 React 按 key 找不到原来那棵子树，只能重建。此刻立刻 `focus()`
       * 只会聚焦到一个马上就要被丢掉的旧输入框上，重排一结束光标就没了。等一帧，
       * React 已经提交完新的 DOM，聚焦才落在真实存在、且会继续存在的输入框上。
       *
       * @param doc - 文档对象；在**这一刻**取好，回调里不再依赖全局。
       * @param paneKey - 要聚焦的窗格 key。
       */
      function focusAfterCommit(doc, paneKey) {
        afterFrame(() => focusPaneInput(doc, paneKey));
      }

      /** 每个窗格持有的会话引用，只在窗格显示这个会话期间存在。 */
      function useSessionReference(sessions, sessionId) {
        const [reference, setReference] = useState(null);
        useEffect(() => {
          if (sessionId === undefined) {
            setReference(null);
            return undefined;
          }
          let owned;
          try {
            owned = sessions.retain(sessionId, { source: model.SESSION_SOURCE });
          } catch (error) {
            console.error('[split-workspaces] 无法持有会话引用:', error);
            setReference(null);
            return undefined;
          }
          if (owned.ready !== undefined && typeof owned.ready.catch === 'function') {
            owned.ready.catch((error) => {
              console.error('[split-workspaces] 打开会话失败:', error);
            });
          }
          setReference(owned);
          return () => {
            setReference(null);
            owned.release();
          };
        }, [sessions, sessionId]);
        return reference;
      }

      /** 一个窗格：标题栏 + 共享的 Conversation Factory。 */
      function PaneFrame({ pane, grow, workspace, workspaceChoices = [], replaceChoices = [], workspaceCount = 0, rows, sessionId, summary, reusableBlankId, active, dragging = false, dropTarget = false, t, paneActions, sessions, uiWorkspace, createWorkspaceFromDirectory, describeAddError, openWorkspaceDirectory, requestSessionDelete, agentPresets, presetOptions, presetDefaultId, mcpServers = [], mcpStatus, mcpError, mcpByWorkspace, skillStatus, skills = [], skillDir, skillErrors = [], skillError, skillByWorkspace, SessionProvider, renderSlot, onPaneDragStart, onPaneDragOver, onPaneDragEnd }) {
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(null);
        /** 「打开工作区目录」正在等 Host 回话（按钮在这期间禁用，免得连点弹出两扇窗）。 */
        const [openBusy, setOpenBusy] = useState(false);
        /**
         * 分屏菜单的两段状态：`splitOpen` 是菜单开关（受控，见 Popover），
         * `splitDirection` 是第二步里已经选定的方向，`null` 表示还停在第一步。
         * 关闭菜单时方向一起清掉，下次打开永远是干净的四个方向。
         */
        const [splitOpen, setSplitOpen] = useState(false);
        const [splitDirection, setSplitDirection] = useState(null);
        /** 第二步里「新建工作区…」是否正在等文件夹选择器 / 建工作区。 */
        const [workspaceBusy, setWorkspaceBusy] = useState(false);
        /** 「替换工作区 → 新建工作区…」是否正在等文件夹选择器 / 建工作区。 */
        const [replaceBusy, setReplaceBusy] = useState(false);
        const reference = useSessionReference(sessions, sessionId);
        const current = summary;
        /**
         * 正在进行的标题栏拖动；`null` 表示没在拖。字段含义：
         * `pointerId` 只认发起这次拖动的那根手指 / 那支笔，`x`/`y` 是按下时的起点
         * （用来判定「这是单击还是拖动」），`over` 是当前落点窗格的 key（null = 不在
         * 任何窗格上），`started` 表示位移是否已经越过阈值（越过之前棋盘一无所知，
         * 于是「按一下就松」仍然是原来的单击语义）。
         */
        const dragRef = useRef(null);
        /** 刚拖完的那一次 click 不再抢键盘光标（光标已由拖动收尾在下一帧安放好）。 */
        const draggedRef = useRef(false);
        /** 标题栏元素本身：指针捕获要有一个具体的元素可抓。 */
        const headRef = useRef(null);

        /** 窗格显示的模式：会话自己的记录优先，其次本窗格暂存的，最后才是 Host 默认。 */
        const sessionPreset = presets.presetOfSession(summary);
        const stagedPresetId = pane.preset === null || pane.preset === undefined ? undefined : pane.preset;
        const shownPresetId = sessionPreset ?? stagedPresetId ?? presetDefaultId;
        const shownPreset = presetOptions.find((option) => option.id === shownPresetId);
        const presetLabel = shownPreset !== undefined ? presets.presetName(shownPreset, t) : shownPresetId;
        /** Host 只允许给还没跑过回合的会话换模式。 */
        const presetLocked = summary !== undefined && summary.blank !== true;
        /** 分屏新开、还没选会话的窗格。 */
        const awaitingPick = pane.follow === false && sessionId === undefined;

        /**
         * 选一个模式：先暂存在窗格上；如果眼前的会话还是空白的，顺手应用上去。
         * 已经开始过的会话保持原有组合，暂存的模式留给该窗格的下一个会话。
         */
        const pickPreset = useCallback((presetId) => {
          paneActions.setPreset(pane.key, presetId);
          if (summary === undefined || summary.blank !== true) return;
          setError(null);
          presets.selectPreset(agentPresets, summary.id, presetId).then((result) => {
            if (!result.ok) setError(t('pane.presetFailed') + ': ' + result.reason);
          });
        }, [summary, paneActions, pane.key, agentPresets, t]);

        /**
         * 在这个窗格里新建一个会话，并把暂存的模式带上。
         *
         * 「新建」分两种情况，关键差别是**要不要让 Host 真的创建一条记录**：
         *   1. 本工作区已有可复用的空白会话（`reusableBlankId`）—— 直接切过去，
         *      仍应用暂存模式。这样反复点「新建会话」最多只回到同一个空会话，
         *      不会在 Host 的会话表里堆出一串没人用的空壳；
         *   2. 没有可复用的 —— 才调 `uiWorkspace.connectWorkspace` 真正新建。
         *
         * 当前这一格本来就是一个空白会话时（`reusable === sessionId`）直接收手：
         * 它已经是一个「新会话」，再建一条或再切回自己都不会产生任何可见变化。
         */
        const createSession = useCallback(() => {
          if (workspace === undefined || busy) return;
          const staged = pane.preset;
          /**
           * 把暂存的模式应用到目标会话上；没有暂存值就什么都不做。
           * 包一层 `Promise.resolve()`：`selectPreset` 同步抛错时也能走同一条 `.catch`。
           */
          const applyStagedPreset = (targetId) => {
            if (staged === null || staged === undefined || staged === '') return Promise.resolve();
            return Promise.resolve()
              .then(() => presets.selectPreset(agentPresets, targetId, staged))
              .then((result) => {
                if (!result.ok) setError(t('pane.presetFailed') + ': ' + result.reason);
              });
          };
          const reusable = reusableBlankId;
          if (reusable !== undefined && reusable !== null) {
            if (reusable === sessionId) return;
            setBusy(true);
            setError(null);
            applyStagedPreset(reusable)
              .then(() => {
                paneActions.setSession(pane.key, reusable);
              })
              .catch((reason) => {
                setError(t('pane.failed') + ': ' + errorText(reason));
              })
              .finally(() => {
                setBusy(false);
              });
            return;
          }
          setBusy(true);
          setError(null);
          uiWorkspace.connectWorkspace(workspace.workspaceId)
            .then(async (createdId) => {
              await applyStagedPreset(createdId);
              paneActions.setSession(pane.key, createdId);
            })
            .catch((reason) => {
              setError(t('pane.failed') + ': ' + errorText(reason));
            })
            .finally(() => {
              setBusy(false);
            });
        }, [workspace, busy, uiWorkspace, paneActions, pane.key, pane.preset, agentPresets, t, reusableBlankId, sessionId]);

        /**
         * 删除会话列表里的某一项 —— 不必是当前显示的那一个。
         *
         * 真正动手的是 `@local/dsh-session-delete` 的确认弹窗（入口块惰性解析后把入口
         * 当成 `requestSessionDelete` 交下来）：永久删除是不可恢复的破坏性操作，确认、
         * 「运行中先停止」、删完通知会话列表这几件事都在那一份实现里，这里只负责把
         * 「哪一行、叫什么名字」告诉它。删成功之后怎么收场由入口块那边决定
         * （把钉着这个会话的窗格全部松开），窗格这一层不需要知道。
         *
         * 服务不在（没装那个插件、或它的客户端半边没挂上）时**不假装删掉了**：在窗格
         * 自己的错误行里说清楚 —— 与「打开工作区目录」那条路同一个处理方式。
         *
         * @param targetId - 要删除的会话 id。
         * @param displayTitle - 它的显示名，用于确认框；可以是 undefined。
         */
        const requestDeleteSession = useCallback((targetId, displayTitle) => {
          if (targetId === undefined || targetId === null) return;
          setError(null);
          if (typeof requestSessionDelete === 'function' && requestSessionDelete(targetId, displayTitle) === true) return;
          setError(t('pane.deleteUnavailable'));
        }, [requestSessionDelete, t]);

        /**
         * 用系统文件管理器打开这个窗格的工作区目录。
         *
         * 这里只管「忙碌 + 报错」这两件属于窗格的事；真正把路径交出去的实现在入口块里
         * （`openWorkspaceDirectory`，走 dsh 自带的 Session 远端命名空间）。失败原因由入口块
         * 翻成**一整句话**，直接进错误行 —— 与「切换模式失败」共用一个位置，
         * 因此两边给的都必须是完整句子。
         */
        const openWorkspace = useCallback(() => {
          if (workspace === undefined || openBusy) return;
          setOpenBusy(true);
          setError(null);
          Promise.resolve()
            .then(() => openWorkspaceDirectory(workspace.path))
            .then((result) => {
              if (result !== undefined && result.ok !== true) setError(result.reason);
            })
            .catch((reason) => {
              setError(t('pane.openFailed') + ': ' + errorText(reason));
            })
            .finally(() => {
              setOpenBusy(false);
            });
        }, [workspace, openBusy, openWorkspaceDirectory, t]);

        const sessionLabel = current === undefined
          ? (sessionId === undefined ? t('pane.noSession') : String(sessionId))
          : (current.displayTitle === undefined || current.displayTitle === '' ? t('pane.untitled') : current.displayTitle);

        /** 没有会话时窗格里的兜底内容：跟随不到会话就给「新建」，分屏新开就提示先选。 */
        const emptyBody = sessionId !== undefined
          ? () => h('div', { className: css.paneEmpty }, h('span', null, t('pane.loading')))
          : () => h('div', { className: css.paneEmpty },
              h('span', null, awaitingPick ? t('pane.chooseSession') : t('pane.noSession')),
              h('button', {
                type: 'button',
                className: cx(css.button, css.primary),
                disabled: busy || workspace === undefined,
                onClick: createSession,
              }, busy ? t('pane.creating') : t('pane.createSession')));

        /**
         * 第二步里选「新建工作区…」：选出目录、注册成工作区，再把它切进新窗格。
         *
         * 方向必须**先**抓在局部变量里：调用方会顺手关菜单，而关菜单会把
         * `splitDirection` 复位成 null，等选择器回来时已经读不到了。
         * 用户取消（返回 undefined）时什么也不做，棋盘保持原样。
         */
        const splitIntoNewWorkspace = useCallback(() => {
          const direction = splitDirection;
          if (direction === null || workspaceBusy) return;
          setWorkspaceBusy(true);
          setError(null);
          Promise.resolve()
            .then(() => createWorkspaceFromDirectory())
            .then((createdId) => {
              if (createdId === undefined) return;
              paneActions.splitPane(pane.key, direction, createdId);
            })
            .catch((reason) => {
              setError(describeAddError(reason));
            })
            .finally(() => {
              setWorkspaceBusy(false);
            });
        }, [splitDirection, workspaceBusy, createWorkspaceFromDirectory, paneActions, pane.key, describeAddError]);

        /**
         * 替换流程的报错文案。
         *
         * 「选择器打不开」与「工作区换不过去」是两件不同的事，用户能做的也不一样，
         * 因此分别说 —— 判定方式与面板顶部的添加流程一致（`createWorkspaceFromDirectory`
         * 会给选择器本身的失败打上 `pickerFailed`）。
         */
        const describeReplaceError = useCallback((reason) => {
          const headline = reason !== null && typeof reason === 'object' && reason.pickerFailed === true
            ? t('panel.pickerFailed')
            : t('pane.replaceFailed');
          return headline + ': ' + errorText(reason);
        }, [t]);

        /**
         * 「替换工作区 → 新建工作区…」：选出目录、注册成工作区，再用它替掉这一格。
         *
         * 与分屏菜单那条路共用 `createWorkspaceFromDirectory`（Desktop 的 preload 桥、
         * web 的选择器、失败处理因此都只有一份实现）。用户取消（返回 undefined）时
         * 什么也不做，棋盘保持原样。
         */
        const replaceWithNewWorkspace = useCallback(() => {
          if (replaceBusy) return;
          setReplaceBusy(true);
          setError(null);
          Promise.resolve()
            .then(() => createWorkspaceFromDirectory())
            .then((createdId) => {
              if (createdId === undefined) return;
              paneActions.replaceWorkspace(pane.key, createdId);
            })
            .catch((reason) => {
              setError(describeReplaceError(reason));
            })
            .finally(() => {
              setReplaceBusy(false);
            });
        }, [replaceBusy, createWorkspaceFromDirectory, paneActions, pane.key, describeReplaceError]);

        /**
         * 「替换工作区」菜单的内容：与面板顶部的「添加工作区」**同一份候选** ——
         * `新建工作区…`，外加还没铺开的工作区（`replaceChoices` 由视图块用
         * `model.unopenedWorkspaces` 算好传下来）。
         *
         * 已经铺开的工作区刻意不在候选里：它已经在别的格子上，真要对调用「拖动标题栏
         * 交换位置」那条路 —— 那条路不重开对话，而「替换」必然要换一个会话。
         *
         * @param close - Popover 给的关闭函数；选中后先关菜单再替换。
         */
        const renderReplaceMenu = (close) => {
          const createNew = h(MenuItem, {
            key: 'new-workspace',
            label: replaceBusy ? t('pane.replacing') : t('panel.newWorkspace'),
            hint: t('panel.newWorkspaceHint'),
            onClick: () => {
              close();
              replaceWithNewWorkspace();
            },
          });
          if (replaceChoices.length === 0) {
            /*
             * 两种「没得选」要分开说：一个工作区都没注册过（棋盘是靠文件夹选择器刚长出来的
             * 那一格），与「别的工作区都铺在棋盘上了」——用户面对的是完全不同的情况。
             */
            const note = workspaceCount === 0 ? t('panel.noWorkspace') : t('pane.replaceAllOpen');
            return [createNew, h('div', { key: 'note', className: css.menuNote }, note)];
          }
          return [createNew, ...replaceChoices.map((choice) => h(MenuItem, {
            key: choice.workspaceId,
            label: choice.title,
            hint: choice.path,
            onClick: () => {
              close();
              paneActions.replaceWorkspace(pane.key, choice.workspaceId);
            },
          }))];
        };

        /**
         * 分屏菜单的两段内容。
         *
         * 第一步只有四个方向；点方向**不立刻分屏**（那等于默认把当前工作区再开一
         * 格），而是切到第二步去选工作区。真正的分屏发生在选中某个工作区那一刻。
         * 关掉菜单时方向由 `onOpenChange` 复位，所以下次打开总是干净的四个方向。
         *
         * @param close - Popover 给的关闭函数；选中工作区后先关菜单再分屏。
         */
        const renderSplitMenu = (close) => {
          if (splitDirection === null) {
            return model.SPLIT_DIRECTIONS.map((direction) => h(MenuItem, {
              key: direction,
              label: t(SPLIT_LABEL_KEYS[direction]),
              onClick: () => setSplitDirection(direction),
            }));
          }
          // 「返回」把方向当提示挂在右边，于是第二步里也看得见自己选的是哪个方向。
          const back = h(MenuItem, {
            key: 'back',
            label: t('pane.splitBack'),
            hint: t(SPLIT_LABEL_KEYS[splitDirection]),
            onClick: () => setSplitDirection(null),
          });
          // 「新建工作区…」刻意排在返回之后、工作区列表之前：它是一条动作，
          // 其余行是数据。一个工作区都没注册过时它照样在，于是棋盘仍能长出第一格。
          const createNew = h(MenuItem, {
            key: 'new-workspace',
            label: workspaceBusy ? t('panel.adding') : t('panel.newWorkspace'),
            hint: t('panel.newWorkspaceHint'),
            onClick: () => {
              close();
              splitIntoNewWorkspace();
            },
          });
          const note = h('div', { key: 'note', className: css.menuNote }, t('pane.splitPickWorkspace'));
          if (workspaceChoices.length === 0) {
            return [note, back, createNew, h('div', { key: 'none', className: css.menuNote }, t('panel.noWorkspace'))];
          }
          return [note, back, createNew, ...workspaceChoices.map((choice) => h(MenuItem, {
            key: choice.workspaceId,
            label: choice.title,
            hint: choice.open ? t('pane.workspaceOpen') : choice.path,
            onClick: () => {
              // 先关菜单、再复位到第一步，最后才分屏：复位不依赖 Popover 的内部约定，
              // 读这段代码的人一眼就能看出「选完工作区，菜单回到第一步」。
              close();
              setSplitDirection(null);
              paneActions.splitPane(pane.key, splitDirection, choice.workspaceId);
            },
          }))];
        };

        /*
         * ## 拖动标题栏交换窗格位置
         *
         * 为什么自己写指针拖动、不用 HTML5 的 dragstart/drop：
         *   1. 标题栏里全是按钮与下拉，HTML5 拖放要求元素 `draggable`，会把「选中标题栏
         *      文字」和「点按钮」一起搅进来；
         *   2. 我们需要一个**中间态**：位移没越过阈值就还是单击（点亮窗格、送光标），
         *      越过阈值才算拖动。原生 `dragstart` 没有这个中间态，一点就拖。
         *
         * 指针捕获在**按下的那一刻**就抓在这个标题栏上，理由与分隔条相同：拖动途中指针
         * 一定会跑到别的窗格、甚至棋盘之外，事件必须一直送到我们手里。代价是别的窗格
         * 收不到 `pointerover`，所以「指针底下是谁」改用命中测试回答（见 `paneKeyAtPoint`）。
         */

        /** 松开这次拖动：释放指针捕获，撤掉拖动期间给整个文档加的临时约束。 */
        const stopDrag = () => {
          const drag = dragRef.current;
          dragRef.current = null;
          const head = headRef.current;
          if (drag !== null && head !== null && head !== undefined && typeof head.releasePointerCapture === 'function') {
            try {
              head.releasePointerCapture(drag.pointerId);
            } catch (error) {
              // 指针早就被系统或浏览器自己释放了（例如窗口失去焦点），忽略即可。
            }
          }
          setDragChrome(false);
          return drag;
        };

        /**
         * 在标题栏上按下：记下起点，等位移告诉我们这是单击还是拖动。
         *
         * 落点是控件或展开的菜单面板时**完全不参与**拖动：那是用户在按那个按钮 /
         * 在读那段菜单文字，抢过来会把标题栏的键盘可达性与弹出菜单一起毁掉。
         */
        const onHeadPointerDown = (event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          if (isDragExcluded(event.target)) return;
          const head = headRef.current;
          if (head === null || head === undefined || typeof head.setPointerCapture !== 'function') return;
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            over: null,
            started: false,
          };
          head.setPointerCapture(event.pointerId);
        };

        /**
         * 拖动中：越过阈值才通知棋盘「开始拖了」，此后一路更新落点高亮。
         *
         * 越过阈值的那一次移动顺手就把落点算出来，于是第一次高亮不会慢半拍。
         */
        const onHeadPointerMove = (event) => {
          const drag = dragRef.current;
          if (drag === null || drag.pointerId !== event.pointerId) return;
          if (drag.started !== true) {
            if (model.paneDragExceeded(drag.x, drag.y, event.clientX, event.clientY) !== true) return;
            drag.started = true;
            setDragChrome(true);
            onPaneDragStart(pane.key);
          }
          const hit = paneKeyAtPoint(currentDocument(), event.clientX, event.clientY);
          // 落在自己身上等于没有落点：松手时什么都不会发生，也不该给自己画一圈高亮。
          const over = hit === null || hit === pane.key ? null : hit;
          if (over === drag.over) return;
          drag.over = over;
          onPaneDragOver(over);
        };

        /**
         * 松手：落在**另一个**窗格上就交换两个窗格的位置。
         *
         * 交换之后必须**等一帧**再把键盘光标送进被拖动的窗格：DOM 刚被 React 搬到新位置，
         * 立刻 `focus()` 只会聚焦到一个正在被搬走的输入框上，搬完就没了（与关窗格那条路
         * 是同一个理由，见 `focusAfterCommit`）。紧随其后的那次 click 因此也一律挡掉
         * （`draggedRef`），否则它会在同一个任务里抢着聚焦一次。
         *
         * 没越过阈值（只是按了一下）时什么都不做：让后面那次 click 走原来的语义。
         */
        const onHeadPointerUp = (event) => {
          const drag = dragRef.current;
          if (drag === null || drag.pointerId !== event.pointerId) return;
          stopDrag();
          if (drag.started !== true) return;
          const target = drag.over;
          onPaneDragEnd();
          if (target === null) return;
          if (paneActions.swapPanes(pane.key, target) !== true) return;
          draggedRef.current = true;
          focusAfterCommit(currentDocument(), pane.key);
          /*
           * 「刚拖完」这个标记只活到这一帧结束。紧随其后的那次 click 一定在它之前到，
           * 但万一下一次 click 压根没派发到窗格上（松手时指针已经落在棋盘空白处，
           * `click` 会派发给按下与松开的共同祖先），也绝不能让它一直挂着，把用户
           * 之后第一次点击本该有的「送光标」吞掉。
           */
          afterFrame(() => { draggedRef.current = false; });
        };

        /** 拖动被系统打断（`pointercancel` / 指针捕获被夺走）：当作放弃落点。 */
        const onHeadPointerCancel = (event) => {
          const drag = dragRef.current;
          if (drag === null || drag.pointerId !== event.pointerId) return;
          stopDrag();
          if (drag.started === true) onPaneDragEnd();
        };

        /**
         * 窗格在拖动途中被卸载（关窗格、切主面板）：把给文档加的临时约束撤掉，
         * 否则「整页不能选文字、光标一直是抓住」会留在页面上。
         */
        useEffect(() => () => {
          dragRef.current = null;
          setDragChrome(false);
        }, []);

        /**
         * 点亮这个窗格，并在用户是「点到窗格上」时把键盘光标送进它的输入框。
         *
         * 这里守着一条不变量：**蓝色标题栏与键盘光标永远在同一个窗格**。
         * 只切高亮不搬光标会出一种很难自查的错：用户点开右边窗格的消息区，
         * 以为在跟它说话，打出来的字却进了别的地方。
         *
         * **为什么挂在 `click` 而不是 `pointerdown`**（真实 Chrome 实测）：单击一个
         * 不可聚焦的元素（消息段落就是）时，`mousedown` 的默认动作会把当前焦点抹成
         * `body` —— 在 `pointerdown` 里 `focus()` 出来的光标，紧接着就被这一步擦掉。
         * 挂到 `click` 上才留得住（`click` 之后没有会改焦点的默认动作）。
         *
         * 两种情形**只切高亮**：
         *   1. 落点是控件（按钮、链接、菜单项、输入框、可编辑区）—— 用户正在操作它，
         *      抢焦点会毁掉标题栏的键盘可达性（Tab 刚落到按钮上就被拽走）、让弹出菜单
         *      失焦，也会把用户点在输入框里那一下的插入点挪走；
         *   2. 用户刚拖选/双击选了一段文字（选区非折叠）—— 实测此时 `focus()`
         *      会把那段选区整段抹掉，等于把「选中复制」这个动作废掉。
         *
         * 窗格没有可打字的输入框时（还没会话、宿主 inert）由 `focusPaneInput` 自己放手，
         * 于是「只切高亮」这套旧语义完整保留。
         *
         * @param event - 点击事件；只用到它的落点。
         */
        const activate = (event) => {
          paneActions.setActive(pane.key);
          /*
           * 刚拖完的那一次 click 不抢键盘光标：光标已经由拖动收尾在下一帧安放进这个
           * 窗格（那时 DOM 才搬到新位置）。不挡的话，它会在同一个任务里对**还没搬走**
           * 的那个输入框聚焦一次，白做一遍，还可能把焦点丢给搬运动作。
           */
          if (draggedRef.current === true) {
            draggedRef.current = false;
            return;
          }
          const target = event === null || event === undefined ? null : event.target;
          if (isControlTarget(target)) return;
          const doc = currentDocument();
          if (isSelectingText(doc)) return;
          focusPaneInput(doc, pane.key);
        };

        /*
         * 标题栏里每个孩子都带固定 key。
         *
         * 这不是洁癖：焦点变化、模式清单载入都会让「可选孩子」出现或消失。
         * React 对没有 key 的兄弟节点是按位置匹配的，位置一错位，它会把用户
         * 刚按下鼠标的那个按钮复用成别的控件，`click` 于是落到错误的处理函数上。
         * 之前的症状就是「点『向下分屏』却变成向右分屏、点『向右分屏』没反应」。
         */
        const headChildren = [
          h('div', { key: 'heading', className: css.paneHeading },
            h('span', { key: 'name', className: css.wsName, title: workspace === undefined ? undefined : workspace.title },
              workspace === undefined ? t('pane.unknownWorkspace') : workspace.title),
            h('span', { key: 'path', className: css.wsPath, title: workspace === undefined ? undefined : workspace.path },
              workspace === undefined ? '' : workspace.path)),
          /*
           * 打开工作区目录：紧跟工作区名 / 路径的一个图标按钮，把这一格显示的目录
           * 交给系统文件管理器（`remote.session.openWorkspacePath`）。
           *
           * 工作区还不知道是哪个（`workspace === undefined`）时禁用：没有路径可开，
           * 报一句「路径无效」还不如按钮直接是灰的。远端命名空间没挂上时不禁用 ——
           * 那种情况下点一下会明确说出「功能没准备好」，比一个永远点不动的按钮好。
           */
          h('button', {
            key: 'open',
            type: 'button',
            className: css.iconButton,
            title: openBusy ? t('pane.openingWorkspace') : t('pane.openWorkspace'),
            'aria-label': t('pane.openWorkspace'),
            disabled: workspace === undefined || openBusy,
            onClick: openWorkspace,
          }, h(FolderGlyph, null)),
          /*
           * 替换工作区：把**这一格**换成另一个还没铺开的工作区。
           *
           * 为什么做成「每格一个图标」而不是面板顶部的一个按钮：替换是一格自己的事，
           * 按钮就在那一格身上，于是永远不必再回答「替哪一格」——省掉一层
           * 「先选窗格」的菜单，也不会点错格子。位置语义见 renderReplaceMenu。
           */
          h(Popover, {
            key: 'replace',
            icon: h(ReplaceGlyph, null),
            title: t('pane.replaceHint'),
            align: 'end',
          }, renderReplaceMenu),
          /*
           * 分屏：一个图标按钮弹出两段菜单（方向 → 工作区）。
           *
           * 触发器上的图标跟着已选方向走，第二步里一眼能看出这次是往哪边切。
           */
          h(Popover, {
            key: 'split',
            icon: h(SplitGlyph, { direction: splitDirection ?? 'right' }),
            title: t('pane.splitHint'),
            align: 'end',
            open: splitOpen,
            onOpenChange: (next) => {
              setSplitOpen(next);
              if (next !== true) setSplitDirection(null);
            },
          }, renderSplitMenu),
        ];
        if (presetOptions.length > 0) {
          headChildren.push(h(Popover, {
            key: 'preset',
            label: presetLabel,
            title: t('pane.presetHint'),
            align: 'end',
          }, (close) => [
            ...(presetLocked
              ? [h('div', { key: 'locked', className: css.menuNote }, t('pane.presetLocked'))]
              : []),
            ...presetOptions.map((option) => h(MenuItem, {
              key: option.id,
              label: presets.presetName(option, t),
              hint: option.id === sessionPreset
                ? t('pane.presetCurrent')
                : (option.id === stagedPresetId ? t('pane.presetStaged') : undefined),
              active: option.id === shownPresetId,
              onClick: () => {
                close();
                pickPreset(option.id);
              },
            })),
          ]));
        }
        /*
         * MCP 工具开关：**按工作区**共享。
         *
         * 与上面那个「模式」控件的区别是本质的：模式是每窗格暂存、每会话生效；
         * MCP 可见性是宿主按会话 cwd 施加的策略，所以同一工作区的所有窗格读的是
         * 同一份选择 —— 在这里勾一下，别的工作区窗格不受影响、同工作区的立刻跟着变。
         *
         * 点击**不关闭**菜单：多选要能连着勾几项。
         */
        if (mcpStatus === 'ready' || mcpStatus === 'empty' || mcpStatus === 'error') {
          const workspacePath = workspace === undefined ? undefined : workspace.path;
          const mcpMap = mcpByWorkspace === undefined || mcpByWorkspace === null ? {} : mcpByWorkspace;
          const selectedMcp = workspacePath === undefined || !Array.isArray(mcpMap[workspacePath]) ? [] : mcpMap[workspacePath];
          headChildren.push(h(Popover, {
            key: 'mcp',
            /*
             * 纯图标：标题栏里已经排了「分屏 / 模式 / 会话」几个控件，MCP 再占一段文字就把
             * 窗格标题挤没了。选中数量放 `title`（悬停提示）里，不丢信息。
             */
            icon: h(McpGlyph, null),
            title: selectedMcp.length === 0
              ? t('pane.mcpHint')
              : t('pane.mcpHint') + '（' + t('pane.mcpSelected') + ' ' + selectedMcp.length + '）',
            align: 'end',
            onOpenChange: (next) => {
              /*
               * 打开时若状态不健康就重读一次：让「面板启动那一刻策略服务还没挂上」
               * 或一次瞬时失败能够自愈。否则这块面板会一直挂着错误，用户只能刷新页面。
               * 已经 ready/empty 时不重读，免得每次开菜单都打一次远端。
               */
              if (next === true && mcpStatus !== 'ready' && mcpStatus !== 'empty') paneActions.loadMcp();
            },
          }, () => [
            h('div', { key: 'note', className: css.menuNote }, t('pane.mcpNote')),
            ...(mcpStatus === 'error' && mcpError !== null && mcpError !== undefined
              ? [h('div', { key: 'err', className: css.menuNote }, t('pane.mcpFailed') + ': ' + mcpError)]
              : []),
            ...(mcpServers.length === 0
              ? [h('div', { key: 'empty', className: css.menuNote }, t('pane.mcpEmpty'))]
              : mcpServers.map((server) => {
                  const on = selectedMcp.includes(server.name);
                  return h(MenuItem, {
                    key: server.name,
                    label: server.name,
                    /*
                     * 与全局 server 一样只显示工具数。会话级 server 的工具数由宿主从
                     * 挂载了它的活会话里数出来；如果一个都没有（刚重启、还没勾选过），
                     * 宿主报 null —— 这时**不显示**这一个数，而不是显示 "null"。
                     */
                    hint: server.tools === null || server.tools === undefined ? undefined : String(server.tools),
                    checked: on,
                    onClick: () => {
                      if (workspacePath === undefined) return;
                      const next = on
                        ? selectedMcp.filter((name) => name !== server.name)
                        : [...selectedMcp, server.name];
                      setError(null);
                      Promise.resolve(paneActions.setMcpSelection(workspacePath, next)).then((result) => {
                        if (result !== undefined && result !== null && result.ok === false) {
                          setError(t('pane.mcpFailed') + ': ' + result.reason);
                        }
                      });
                    },
                  });
                })),
          ]));
        }
        /*
         * SKILL 开关：与 MCP 完全同构 —— **按工作区**共享的一份宿主策略。
         *
         * 两个入口分工要记清楚（用户容易问「为什么设置里没有勾选」）：
         *   - 「设置 → 技能」管**目录**：技能文件放在哪儿；
         *   - 这里管**本工作区用哪些**：目录里勾上的才进模型目录，没勾的连上下文都不占。
         *
         * 只有技能库插件的客户端半边挂上来了（`skillStatus` 有值）才渲染这个按钮：
         * 没装那个插件时，窗格标题栏看起来与从前完全一样，不会多出一个点不动的图标。
         *
         * 按钮与弹层本身在 `client.skill.js`（`skillPopover`），这里只负责接线。
         */
        if (skillStatus !== undefined && skillStatus !== 'idle' && skillStatus !== 'unavailable') {
          const workspacePath = workspace === undefined ? undefined : workspace.path;
          const skillMap = skillByWorkspace === undefined || skillByWorkspace === null ? {} : skillByWorkspace;
          headChildren.push(skillControl.skillPopover({
            workspacePath,
            skills,
            byWorkspace: skillMap,
            status: skillStatus,
            error: skillError,
            dir: skillDir,
            fileErrors: skillErrors,
            t,
            onToggle: (path, next) => {
              setError(null);
              Promise.resolve(paneActions.setSkillSelection(path, next)).then((result) => {
                if (result !== undefined && result !== null && result.ok === false) {
                  setError(t('pane.skillFailed') + ': ' + result.reason);
                }
              });
            },
            onReload: () => paneActions.loadSkills(),
          }));
        }
        headChildren.push(h(Popover, {
          key: 'session',
          label: sessionLabel,
          title: t('pane.switchSession'),
          align: 'end',
          disabled: rows.length === 0 && sessionId === undefined,
        }, (close) => [
          h(MenuItem, {
            key: 'new',
            label: busy ? t('pane.creating') : t('pane.createSession'),
            onClick: () => {
              close();
              createSession();
            },
          }),
          ...rows.map((row) => {
            const label = row.displayTitle === undefined || row.displayTitle === '' ? t('pane.untitled') : row.displayTitle;
            /*
             * 每个会话一行，行尾一个垃圾桶按钮：左边那半还是「切到这个会话」，
             * 右边那半是「永久删掉它」。
             *
             * 为什么删除做在**每一行**上，而不是菜单底部一个「删除会话」：菜单里摆的就是
             * 一列会话，「删哪一个」在那一行上问最直接。底部放一个按钮，用户得先自己
             * 推出「它删的是我正看着的那一个」—— 而他想清的往往正是**别的**那一行。
             *
             * 两个按钮必须平级：`MenuItem` 自己就是 <button>，把图标按钮塞进去是无效
             * HTML（浏览器会把内层拆到外面），点击落到谁身上就说不准了。
             */
            return h('div', { key: row.id, className: css.menuRow },
              h(MenuItem, {
                label,
                // 列表里只会有真实对话（空白会话被 selectableSessions 过滤掉了），
                // 因此行尾只提示「运行中」这一种状态。
                hint: row.running === true ? t('pane.running') : undefined,
                active: row.id === sessionId,
                onClick: () => {
                  close();
                  paneActions.setSession(pane.key, row.id);
                },
              }),
              // 会话名进按钮的提示语：一列里好几个垃圾桶，只靠位置分不清删的是哪一个。
              h(MenuDeleteButton, {
                label: t('pane.deleteSessionNamed', { title: label }),
                onClick: () => {
                  close();
                  requestDeleteSession(row.id, row.displayTitle);
                },
              }));
          }),
        ]));
        headChildren.push(h('button', {
          key: 'close',
          type: 'button',
          className: css.iconButton,
          title: t('pane.close'),
          'aria-label': t('pane.close'),
          onClick: () => {
            /*
             * 关掉的是当前窗格时，焦点会交给顶替它位置的窗格（存储算好并返回），
             * 光标也要跟过去 —— 但必须等一帧，理由见 `focusAfterCommit`。
             * 关掉的不是当前窗格时没有接手者，光标原地不动。
             */
            const survivor = paneActions.removePane(pane.key);
            if (survivor === undefined || survivor === null) return;
            focusAfterCommit(currentDocument(), survivor);
          },
        }, h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))));

        /*
         * 出错提示与对话本体同样带 key，出错提示出现/消失也不会挪动对话本体的位置。
         *
         * 错误行显示的是**生产错误的那一处给的一整句话**：这里不再统一加前缀。
         * 三个来源（新建会话、切模式、加工作区）本来就会说清自己是什么失败，
         * 统一加「打开会话失败」会把它们一律说成别人的错。
         */
        const paneChildren = [h('div', {
          key: 'head',
          className: css.paneHead,
          ref: headRef,
          /*
           * 标题栏的指针处理就是「拖动交换位置」那一整套，见上面那段说明。
           * `pointercancel` 与 `lostpointercapture` 都当「放弃这次拖动」：
           * 前者是系统收回指针（触摸被手势接管），后者是指针捕获被夺走，
           * 两种情况下都不该留下半截拖动状态。
           */
          onPointerDown: onHeadPointerDown,
          onPointerMove: onHeadPointerMove,
          onPointerUp: onHeadPointerUp,
          onPointerCancel: onHeadPointerCancel,
          onLostPointerCapture: onHeadPointerCancel,
        }, headChildren)];
        if (error !== null) paneChildren.push(h('div', { key: 'error', className: css.paneError }, error));
        paneChildren.push(h('div', { key: 'body', className: css.paneBody },
          h(SessionProvider, {
            session: reference ?? undefined,
            empty: emptyBody,
          }, renderSlot(paneSlot, { paneKey: pane.key, workspaceId: pane.workspaceId }))));

        return h('section', {
          className: css.pane,
          'data-pane': pane.key,
          'data-active': active === true ? 'true' : 'false',
          /*
           * 两个视觉标记只管拖动这一件事：
           *   - `data-dragging`：这一格正被搬动（整格淡下去，看得出「被拎起来了」）；
           *   - `data-drop`：松手就落在这里（亮一圈强调色）。被拖的那一格自己不会同时
           *     是落点 —— 落在自己身上等于没拖，落点判定里已经把它排除了。
           */
          'data-dragging': dragging === true ? 'true' : 'false',
          'data-drop': dropTarget === true ? 'true' : 'false',
          /*
           * 分屏里占的比例。整块棋盘上只有一个窗格时没有分屏，这个值不传，
           * 窗格靠自己的 `flex:1 1 0` 撑满。
           */
          style: grow === undefined ? undefined : { flexGrow: grow },
          /*
           * 三个焦点相关的处理，分工是明确的：
           *   - `pointerdown`：按下就点亮（高亮要跟手，不能等到松开）；
           *   - `click`：点亮 + 送光标（只有这里送得住，见 activate 的说明）；
           *   - `focus`：Tab 或程序把焦点送进这个窗格时点亮。**这里不搬光标**：
           *     Tab 的落点是浏览器的地盘，落到标题栏按钮上是用户想用键盘走一遍标题栏，
           *     落到会话区里别的可聚焦元素上也可能是有意为之，抢走等于毁掉键盘可达性。
           */
          onPointerDownCapture: () => paneActions.setActive(pane.key),
          onClickCapture: activate,
          onFocusCapture: () => paneActions.setActive(pane.key),
        }, paneChildren);
      }
      PaneFrame.displayName = 'PaneFrame';

      return { PaneFrame, focusPaneInput };
    }

    return { createPane };
  },
});
