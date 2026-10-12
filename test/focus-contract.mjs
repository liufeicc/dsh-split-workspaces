/**
 * 离线契约测试：窗格几何与 `Alt+方向键` 的焦点切换。
 *
 * 拆成独立文件是因为这些断言和平铺/菜单的断言长在一起会超过 800 行
 * （见 `~/.dsh/AGENTS.md`）：平铺、拖动、分屏菜单在 `layout-contract.mjs`，
 * 这里只管「哪个方向上是哪个窗格」以及「按下去之后存储与 DOM 发生了什么」。
 * 测试台（断言记录、棋盘挂载、元素查找）在 `board.mjs`，两个文件共用。
 *
 *   1. `layoutRects` 把布局树换算成矩形（归一化坐标）；
 *   2. `neighborPane` 按矩形找「相应位置」的邻居：方向之外、垂直有重叠、
 *      距离近的优先 → 重叠多的优先 → 中心更对齐的优先，走到边上不循环；
 *   3. 固定快捷键的登记（`Alt+方向键` 出现在「设置 → 快捷键」里，并被记为已占用）；
 *   4. 键盘路径：捕获阶段抢下按键、切焦点、把光标送进目标窗格的输入框，
 *      以及各种该放行的情形（输入法组字中、AltGraph、带了别的修饰键、方向上没有窗格）。
 *   5. 点亮窗格时的光标归属：点/聚焦落在窗格内容上就把光标送进它的输入框，
 *      落在标题栏控件上只切高亮；关掉当前窗格时由接手的窗格在下一次重排之后接管。
 *
 *   node test/focus-contract.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReactStub, findAll, loadBundle } from './harness.mjs';
import { check, paneDom, report, renderBoard } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const {
  leafNode,
  createPaneStore,
  collectLeaves,
  PANE_DIRECTIONS,
  layoutRects,
  neighborPane,
} = (await mod.test.chunks).model;

/** 造一个「左右分屏」节点，供纯函数断言使用。 */
const rowSplit = (id, a, b, ratio = 0.5) => ({ type: 'split', id, dir: 'row', ratio, a, b });
const pair = rowSplit('s1', leafNode('p1'), leafNode('p2'));

// --- 窗格几何：矩形与「相应位置」的邻居（Alt+方向键的判定基础） ----------------------

const pairRects = layoutRects(pair);
check('左右并排按比例切成两个矩形', JSON.stringify(pairRects.get('p1')) === JSON.stringify({ x: 0, y: 0, w: 0.5, h: 1 })
  && JSON.stringify(pairRects.get('p2')) === JSON.stringify({ x: 0.5, y: 0, w: 0.5, h: 1 }), JSON.stringify(pairRects.get('p2')));

const colPair = { type: 'split', id: 'c1', dir: 'col', ratio: 0.25, a: leafNode('p1'), b: leafNode('p2') };
check('上下叠放按比例切分，下面那格从上面那格的下边缘开始', (() => {
  const rects = layoutRects(colPair);
  const top = rects.get('p1');
  const bottom = rects.get('p2');
  return top.x === 0 && top.y === 0 && top.w === 1 && top.h === 0.25 && bottom.y === 0.25 && bottom.h === 0.75;
})());

/** 四宫格：左列 40%（上 p1 / 下 p2），右列 60%（上 p3 / 下 p4）。 */
const quad = rowSplit('q1', colPair, { type: 'split', id: 'q2', dir: 'col', ratio: 0.5, a: leafNode('p3'), b: leafNode('p4') }, 0.4);
check('嵌套分屏的子矩形落在父矩形里', (() => {
  const rects = layoutRects(quad);
  return rects.get('p1').w === 0.4 && rects.get('p1').h === 0.25
    && rects.get('p2').h === 0.75 && rects.get('p2').w === 0.4
    && rects.get('p3').x === 0.4 && rects.get('p3').w === 0.6 && rects.get('p3').h === 0.5
    && rects.get('p4').y === 0.5 && rects.get('p4').h === 0.5;
})());
check('空布局没有矩形', layoutRects(null).size === 0 && layoutRects(leafNode('p1')).size === 1);
check('四个方向都有定义', Object.keys(PANE_DIRECTIONS).sort().join(',') === 'down,left,right,up');

check('并排两格：向右走到另一格，走到头上就不动（不绕回对面）', neighborPane(pair, 'p1', 'right') === 'p2' && neighborPane(pair, 'p2', 'right') === undefined);
check('并排两格：向左同理', neighborPane(pair, 'p2', 'left') === 'p1' && neighborPane(pair, 'p1', 'left') === undefined);
check('并排两格：上下都没有邻居', neighborPane(pair, 'p1', 'up') === undefined && neighborPane(pair, 'p1', 'down') === undefined);
check('上下两格：上下互为邻居，左右没有', neighborPane(colPair, 'p1', 'down') === 'p2'
  && neighborPane(colPair, 'p2', 'up') === 'p1'
  && neighborPane(colPair, 'p1', 'right') === undefined);

/*
 * 「相应位置」的核心一条：垂直方向重叠为 0 的窗格不算邻居。
 * 四宫格里 p1 在左上、p4 在右下，p4 确实在 p1 的右边，但两格一行重叠都没有。
 */
check('四宫格向右只落到同一行的窗格（另一行重叠为 0）', neighborPane(quad, 'p1', 'right') === 'p3' && neighborPane(quad, 'p2', 'right') === 'p4');
check('四宫格向左也只落到同一行', neighborPane(quad, 'p3', 'left') === 'p1' && neighborPane(quad, 'p4', 'left') === 'p2');
check('四宫格向下落到同一列的窗格', neighborPane(quad, 'p1', 'down') === 'p2' && neighborPane(quad, 'p3', 'down') === 'p4');

// 距离优先：p1 | p2 | p3 三连排时，p1 往右先到紧挨着的 p2，而不是跳过它直奔 p3。
const triple = rowSplit('t1', rowSplit('t2', leafNode('p1'), leafNode('p2')), leafNode('p3'), 0.4);
check('三连排里向右先到紧挨着的那一格', neighborPane(triple, 'p1', 'right') === 'p2' && neighborPane(triple, 'p2', 'right') === 'p3');
check('未知方向与未知窗格都不产生邻居', neighborPane(pair, 'p1', 'sideways') === undefined && neighborPane(pair, 'p9', 'right') === undefined);

// --- 「相应位置」在真实布局树上也成立 -----------------------------------------------

/*
 * 用存储真的摆出一个四宫格，检查「相应位置」的判定在真实布局树上也成立 ——
 * 上面的纯函数断言用的是手写的树，这里走的是分屏菜单背后的同一条路径。
 */
const gridStore = createPaneStore();
gridStore.ensureInitialized('ws-a', ['ws-a', 'ws-b']);
gridStore.splitPane('pane-1', 'down', 'ws-c'); // 左上角向下分成 [pane-1 / pane-3]
gridStore.splitPane('pane-2', 'down', 'ws-d'); // 右上角向下分成 [pane-2 / pane-4]
const gridLayout = gridStore.getSnapshot().layout;
check('四宫格的叶子顺序是「左列自上而下，再右列自上而下」', collectLeaves(gridLayout).join(',') === 'pane-1,pane-3,pane-2,pane-4', collectLeaves(gridLayout).join(','));
check('真实四宫格里，左上角向右落到右上角（不是右下角）', neighborPane(gridLayout, 'pane-1', 'right') === 'pane-2');
check('真实四宫格里，左下角向右落到右下角', neighborPane(gridLayout, 'pane-3', 'right') === 'pane-4');
check('真实四宫格里，右下角向左落到左下角', neighborPane(gridLayout, 'pane-4', 'left') === 'pane-3');
check('真实四宫格里，右上角向上没有邻居', neighborPane(gridLayout, 'pane-2', 'up') === undefined && neighborPane(gridLayout, 'pane-1', 'up') === undefined);

/*
 * 键盘路径。
 *
 * 入口在装载插件时就把键盘处理装到**文档**的捕获阶段（真实客户端也是如此），
 * 所以这里先摆好一个假文档再 `renderBoard`，装的时机才对得上；敲键就是直接调用
 * 装上的那个处理函数，事件对象是手写的替身 —— 断言的是「按下之后存储与 DOM 发生了什么」，
 * 不依赖真实键盘，也不依赖浏览器。
 *
 * 假文档只认插件真正会查的几种选择器，并把装上的监听器记下来：
 *   - `[data-split-board]` → 棋盘标记，null 表示面板没在屏幕上；
 *   - 浮层选择器 → 菜单 / 模态对话框，非 null 表示有东西盖着；
 *   - `[data-pane="…"]` → 窗格宿主，其中 pane-2 的输入框可编辑（应该被聚焦）、
 *     pane-4 的输入框是 inert 的（`contenteditable="false"`，还没会话 → 不该抢光标）、
 *     其余窗格没有输入框（只切高亮）。
 * 另外两个（查旧样式标签、插新样式标签）是插件装载样式表时会碰的，给个空实现就够。
 */
const focused = [];
const listeners = [];
/** 棋盘里的输入框：`contains` 认它，`closest` 也认它（两者都真 → 这个键该管）。 */
const boardInput = { closest: () => ({}) };
/** 棋盘之外的输入框（例如侧边栏的搜索框）：`closest` 认它 → 这个键不该管。 */
const outsideInput = { closest: () => ({}) };
/** 棋盘之外的普通元素（例如侧边栏图标按钮）：不是输入框 → 这个键该管。 */
const outsideButton = { closest: () => null };
const inputFor = (paneKey) => ({
  getAttribute: (name) => (name === 'contenteditable' ? (paneKey === 'pane-4' ? 'false' : 'true') : null),
  focus: (options) => focused.push({ paneKey, options }),
});
const fakeDocument = {
  activeElement: null,
  board: { contains: (node) => node === boardInput },
  overlay: null,
  querySelector(selector) {
    if (selector === '[data-split-board]') return this.board;
    if (selector === '[role="dialog"][aria-modal="true"], [role="menu"]') return this.overlay;
    const matched = /^\[data-pane="([^"]+)"\]$/.exec(selector);
    if (matched === null) return null;
    const paneKey = matched[1];
    return { querySelector: () => ((paneKey === 'pane-2' || paneKey === 'pane-4') ? inputFor(paneKey) : null) };
  },
  createElement: () => ({ dataset: {}, remove: () => {} }),
  head: { appendChild: () => {} },
  addEventListener: (type, handler, capture) => { listeners.push({ type, handler, capture }); },
  removeEventListener: (type, handler, capture) => {
    const index = listeners.findIndex((row) => row.type === type && row.handler === handler && row.capture === capture);
    if (index >= 0) listeners.splice(index, 1);
  },
};
globalThis.document = fakeDocument;

const focusBoard = await renderBoard(mod);
focusBoard.paneStore.splitPane('pane-1', 'down', 'ws-c'); // 左上角向下分成 [pane-1 / pane-3]
focusBoard.paneStore.splitPane('pane-2', 'down', 'ws-d'); // 右上角向下分成 [pane-2 / pane-4]
focusBoard.paneStore.setActive('pane-1');

/** 敲一下这个键：监听是文档级的，直接调用装上的处理函数。 */
const pressKey = (event) => {
  for (const row of listeners.filter((item) => item.type === 'keydown')) row.handler(event);
};

/** 造一个键盘事件替身，并记录 preventDefault / stopPropagation 有没有被调用。 */
function keyEvent(overrides) {
  const event = {
    key: 'ArrowRight',
    altKey: true,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    getModifierState: () => false,
    prevented: 0,
    stopped: 0,
    preventDefault() { event.prevented += 1; },
    stopPropagation() { event.stopped += 1; },
    ...overrides,
  };
  return event;
}

check('棋盘根节点带上了「面板在屏幕上」的标记', focusBoard.render().tree.props['data-split-board'] === 'true');
check('入口把键盘处理装成文档级 keydown 捕获监听', listeners.length === 1 && listeners[0].type === 'keydown' && listeners[0].capture === true,
  JSON.stringify(listeners.map((row) => row.type + '/' + String(row.capture))));

check('四个方向的焦点键都登记成了固定快捷键', focusBoard.stub.fixedShortcuts.map((row) => row.id).join(',')
  === 'fixed.split-pane-left,fixed.split-pane-right,fixed.split-pane-up,fixed.split-pane-down', focusBoard.stub.fixedShortcuts.map((row) => row.id).join(','));
check('固定键位是 Alt+方向键，归到应用组，标签来自词典', focusBoard.stub.fixedShortcuts.every((row) => row.group === 'application'
  && row.bindings.length === 1
  && row.bindings[0].modifiers.join(',') === 'alt'
  && /^Arrow(Left|Right|Up|Down)$/.test(row.bindings[0].code)
  && row.label().startsWith('把焦点移到')), JSON.stringify(focusBoard.stub.fixedShortcuts.map((row) => row.label())));
check('固定键位的可读键名交给框架生成（不自己拼字符串）', focusBoard.stub.fixedShortcuts.every((row) => row.keys.join(',') === 'alt,' + row.bindings[0].code));

const rightEvent = keyEvent({});
pressKey(rightEvent);
check('Alt+→ 把焦点交给右侧的窗格', focusBoard.paneStore.getSnapshot().activeKey === 'pane-2', String(focusBoard.paneStore.getSnapshot().activeKey));
check('Alt+→ 把这个键抢下来（既阻止默认动作也阻止继续传播）', rightEvent.prevented === 1 && rightEvent.stopped === 1);
check('Alt+→ 顺手把键盘光标送进目标窗格的输入框', focused.length === 1 && focused[0].paneKey === 'pane-2' && focused[0].options.preventScroll === true, JSON.stringify(focused));

const downEvent = keyEvent({ key: 'ArrowDown' });
pressKey(downEvent);
check('Alt+↓ 从右上角落到右下角', focusBoard.paneStore.getSnapshot().activeKey === 'pane-4', String(focusBoard.paneStore.getSnapshot().activeKey));
check('目标窗格的输入框还不可编辑时不抢光标（只切高亮）', downEvent.prevented === 1 && focused.length === 1);

const edgeEvent = keyEvent({});
pressKey(edgeEvent);
check('最右边再按 Alt+→ 不动', focusBoard.paneStore.getSnapshot().activeKey === 'pane-4');
check('那个方向没有窗格时不拦事件，Alt+方向键保留原本含义', edgeEvent.prevented === 0 && edgeEvent.stopped === 0);

const plainEvent = keyEvent({ altKey: false });
pressKey(plainEvent);
check('不带 Alt 的方向键一律不理（留给输入框与页面）', plainEvent.prevented === 0 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-4');
const composingEvent = keyEvent({ key: 'ArrowUp', isComposing: true });
pressKey(composingEvent);
check('输入法组字中的 Alt+方向键放行', composingEvent.prevented === 0 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-4');
const shiftEvent = keyEvent({ key: 'ArrowUp', shiftKey: true });
pressKey(shiftEvent);
check('Alt+Shift+方向键是别人的键位，不碰', shiftEvent.prevented === 0 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-4');
const altGraphEvent = keyEvent({ key: 'ArrowUp', getModifierState: (name) => name === 'AltGraph' });
pressKey(altGraphEvent);
check('AltGraph（某些布局用它打字符）按下时放行', altGraphEvent.prevented === 0 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-4');

const upEvent = keyEvent({ key: 'ArrowUp' });
pressKey(upEvent);
check('Alt+↑ 从右下角回到右上角', focusBoard.paneStore.getSnapshot().activeKey === 'pane-2');
check('回到有输入框的窗格时又接上了光标', focused.length === 2 && focused[1].paneKey === 'pane-2', JSON.stringify(focused));

const letterEvent = keyEvent({ key: 'KeyA' });
pressKey(letterEvent);
check('Alt+字母不是焦点键，直接放行', letterEvent.prevented === 0 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-2');

/*
 * 下面这组是用户实测报回来的问题：以前处理挂在棋盘节点上，只有焦点正好在窗格里的
 * 输入框 / 按钮上时才收得到 —— 点过棋盘空白（焦点落到 body）、刚用侧边栏图标切过来
 * （焦点还在侧边栏按钮上）都没反应。挂在文档上之后，这些情形一律要管用。
 */
fakeDocument.activeElement = null;
const bodyEvent = keyEvent({ key: 'ArrowLeft' });
pressKey(bodyEvent);
check('焦点落在 body 上时照样切窗格（点过空白之后就是这样）', bodyEvent.prevented === 1 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-1', String(focusBoard.paneStore.getSnapshot().activeKey));

fakeDocument.activeElement = outsideButton;
const sidebarEvent = keyEvent({});
pressKey(sidebarEvent);
check('焦点还在侧边栏按钮上时照样切（刚用图标切过来的情形）', sidebarEvent.prevented === 1 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-2', String(focusBoard.paneStore.getSnapshot().activeKey));

fakeDocument.activeElement = boardInput;
const inPaneEvent = keyEvent({ key: 'ArrowLeft' });
pressKey(inPaneEvent);
check('焦点在窗格里的输入框时照样切（棋盘里的输入框不挡这个键）', inPaneEvent.prevented === 1 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-1');

fakeDocument.activeElement = outsideInput;
const outsideEvent = keyEvent({});
pressKey(outsideEvent);
check('焦点在棋盘之外的输入框里时放行（那是别人的输入框）', outsideEvent.prevented === 0 && outsideEvent.stopped === 0 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-1');

fakeDocument.overlay = { role: 'menu' };
const overlayEvent = keyEvent({});
pressKey(overlayEvent);
check('有菜单 / 对话框盖着时放行（方向键归浮层，快捷键录制也在里面）', overlayEvent.prevented === 0 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-1');

fakeDocument.overlay = null;
fakeDocument.board = null;
const hiddenEvent = keyEvent({});
pressKey(hiddenEvent);
check('面板没在屏幕上时放行（别的面板正开着，不该抢）', hiddenEvent.prevented === 0 && focusBoard.paneStore.getSnapshot().activeKey === 'pane-1');

fakeDocument.board = { contains: (node) => node === boardInput };
const installEffect = focusBoard.stub.effects.find((row) => row.label === 'split-workspaces: pane focus keys');
check('键盘处理的副作用带标签，方便排错与卸载', installEffect !== undefined, JSON.stringify(focusBoard.stub.effects.map((row) => row.label)));
installEffect.dispose();
const disposedEvent = keyEvent({});
pressKey(disposedEvent);
check('卸载后监听被摘掉，按键不再被接管', listeners.length === 0 && disposedEvent.prevented === 0);

/*
 * --- 点亮窗格 = 高亮 + 光标（用户报回来的错位） --------------------------------------
 *
 * 症状：点开右边窗格的消息区，蓝色标题栏过去了、键盘光标却还留在原来那个窗格的
 * 输入框里 —— 以为在跟右边说话，打出来的字全进了别处。
 *
 * 判定完全由**事件的落点**决定（`target.closest(…)` 认不认得出控件）加上「有没有
 * 正在选文字」，因此离线测试给两个替身落点、一个假选区就够：`contentTarget` 是消息区 /
 * 空白，`controlTarget` 是标题栏的按钮或菜单项。假文档里 pane-2 的输入框可编辑、
 * pane-4 的 inert、pane-1 / pane-3 根本没有输入框（三种情形各有断言）。
 *
 * 两条真实浏览器实测出来的、离线测试必须照着守的约束（见 README「踩过的坑」）：
 *   - 送光标挂在 `click` 上，不挂在 `pointerdown` 上：单击不可聚焦元素时 `mousedown`
 *     的默认动作会把焦点抹成 `body`，`pointerdown` 里的 `focus()` 留不住；
 *   - 用户刚拖出选区时一个字都不碰：实测此时 `focus()` 会把选区整段抹掉。
 */
const boardTree = focusBoard.render().tree;
const contentTarget = { closest: () => null };
const controlTarget = { closest: () => ({ tagName: 'BUTTON' }) };
/** 假文档的选区：默认折叠；`selecting` 为 true 时模拟「用户刚拖选了一段文字」。 */
const selection = { isCollapsed: true };
fakeDocument.getSelection = () => selection;

focusBoard.paneStore.setActive('pane-1');
const beforePointerDown = focused.length;
paneDom(boardTree, 'pane-2').tree.props.onPointerDownCapture({ target: contentTarget });
check('按下鼠标只切高亮（不在这里送光标：mousedown 的默认动作会把它擦掉）',
  focusBoard.paneStore.getSnapshot().activeKey === 'pane-2' && focused.length === beforePointerDown,
  JSON.stringify(focused.slice(beforePointerDown)));

const beforeContentClick = focused.length;
paneDom(focusBoard.render().tree, 'pane-1').tree.props.onClickCapture({ target: contentTarget });
check('点没有会话的窗格：只切高亮（它里面没有可打字的输入框）',
  focusBoard.paneStore.getSnapshot().activeKey === 'pane-1' && focused.length === beforeContentClick,
  JSON.stringify(focused.slice(beforeContentClick)));

const beforeEditableClick = focused.length;
paneDom(focusBoard.render().tree, 'pane-2').tree.props.onClickCapture({ target: contentTarget });
check('点有会话的窗格内容区：高亮与光标一起过去（挂 click 才留得住）',
  focusBoard.paneStore.getSnapshot().activeKey === 'pane-2' && focused.length === beforeEditableClick + 1
  && focused[beforeEditableClick].paneKey === 'pane-2'
  && focused[beforeEditableClick].options.preventScroll === true,
  JSON.stringify(focused.slice(beforeEditableClick)));

const beforeControlClick = focused.length;
paneDom(focusBoard.render().tree, 'pane-1').tree.props.onClickCapture({ target: controlTarget });
check('点标题栏控件：只切高亮，不抢控件的键盘焦点（否则 Tab 与弹出菜单都会被拽走）',
  focusBoard.paneStore.getSnapshot().activeKey === 'pane-1' && focused.length === beforeControlClick,
  JSON.stringify(focused.slice(beforeControlClick)));

selection.isCollapsed = false;
const beforeSelectingClick = focused.length;
paneDom(focusBoard.render().tree, 'pane-2').tree.props.onClickCapture({ target: contentTarget });
check('刚拖选了一段文字：只切高亮，绝不 focus（实测 focus 会把选区整段抹掉）',
  focusBoard.paneStore.getSnapshot().activeKey === 'pane-2' && focused.length === beforeSelectingClick,
  JSON.stringify(focused.slice(beforeSelectingClick)));
selection.isCollapsed = true;

const beforeInertClick = focused.length;
paneDom(focusBoard.render().tree, 'pane-4').tree.props.onClickCapture({ target: contentTarget });
check('窗格还没会话（输入框 inert）时只切高亮，不把光标从别人手里抢走',
  focusBoard.paneStore.getSnapshot().activeKey === 'pane-4' && focused.length === beforeInertClick,
  JSON.stringify(focused.slice(beforeInertClick)));

/*
 * 焦点进到窗格里（Tab / 程序）只切高亮，**不搬光标**：Tab 的落点是浏览器的地盘，
 * 标题栏按钮与会话区里别的可聚焦元素都要能 Tab 得到，抢走等于毁掉键盘可达性。
 */
const beforeFocusIn = focused.length;
paneDom(focusBoard.render().tree, 'pane-2').tree.props.onFocusCapture({ target: contentTarget });
check('焦点落进窗格时只切高亮，不抢 Tab 的落点', focusBoard.paneStore.getSnapshot().activeKey === 'pane-2'
  && focused.length === beforeFocusIn, JSON.stringify(focused.slice(beforeFocusIn)));

const beforeControlFocus = focused.length;
paneDom(focusBoard.render().tree, 'pane-1').tree.props.onFocusCapture({ target: controlTarget });
check('Tab 落到标题栏按钮上时同样只切高亮', focusBoard.paneStore.getSnapshot().activeKey === 'pane-1'
  && focused.length === beforeControlFocus, JSON.stringify(focused.slice(beforeControlFocus)));
delete fakeDocument.getSelection;

/*
 * 关窗格：顶替它位置的窗格接手光标，但要**等一帧** —— 窗格原来嵌在被折叠掉的那层
 * 分屏里，布局树塌陷后 React 只能重建它，此刻立刻聚焦只会落在马上被丢掉的旧输入框上。
 * 这里把 `requestAnimationFrame` 换成一个只记账、不执行的替身，于是能分别断言
 * 「点下去那一刻没聚焦」与「那一帧到了才聚焦」。
 */
const frames = [];
const previousRaf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
focusBoard.paneStore.setActive('pane-3');
const beforeClose = focused.length;
const closeButton = findAll(paneDom(focusBoard.render().tree, 'pane-3').tree, (node) => node.props.title === '关闭窗格')[0];
check('窗格标题栏上的关闭按钮能找到', closeButton !== undefined && typeof closeButton.props.onClick === 'function');
closeButton.props.onClick();
check('关掉当前窗格后，顶替它位置的窗格拿到高亮（四宫格里 pane-3 的接手者是 pane-2）',
  focusBoard.paneStore.getSnapshot().activeKey === 'pane-2', String(focusBoard.paneStore.getSnapshot().activeKey));
check('关窗格那一刻先不聚焦', focused.length === beforeClose);
check('顶替者的光标安排在下一帧', frames.length === 1 && focused.length === beforeClose);
frames[0]();
check('下一帧把光标送进顶替上来的窗格', focused.length === beforeClose + 1 && focused[beforeClose].paneKey === 'pane-2',
  JSON.stringify(focused.slice(beforeClose)));

// 没有 requestAnimationFrame 的环境退回 setTimeout：语义相同，仍然是「这一轮之后」。
globalThis.requestAnimationFrame = undefined;
focusBoard.paneStore.setActive('pane-1');
const beforeFallback = focused.length;
const fallbackClose = findAll(paneDom(focusBoard.render().tree, 'pane-1').tree, (node) => node.props.title === '关闭窗格')[0];
fallbackClose.props.onClick();
check('没有 requestAnimationFrame 时改用 setTimeout，同样是延后一拍', focused.length === beforeFallback
  && focusBoard.paneStore.getSnapshot().activeKey === 'pane-2');
await new Promise((resolve) => setTimeout(resolve, 0));
check('延后的一拍结束后照样把光标送到顶替者',
  focused.length === beforeFallback + 1 && focused[beforeFallback].paneKey === 'pane-2',
  JSON.stringify(focused.slice(beforeFallback)));
if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
else globalThis.requestAnimationFrame = previousRaf;

/*
 * 存储层的契约：`removePane` 只在**被关掉的正是当前焦点窗格**时才报出接手者。
 * 关掉一个不相干的窗格时焦点没变，光标必须原地不动 —— 那是「无人接手」。
 */
const nonActiveClose = createPaneStore();
nonActiveClose.addPane('ws-a');
nonActiveClose.addPane('ws-b');
nonActiveClose.setActive('pane-2');
check('关掉不是当前焦点的窗格：没有接手者（光标原地不动）', nonActiveClose.removePane('pane-1') === undefined
  && nonActiveClose.getSnapshot().activeKey === 'pane-2');
const activeClose = createPaneStore();
activeClose.addPane('ws-a');
activeClose.addPane('ws-b');
activeClose.setActive('pane-1');
check('关掉当前焦点窗格：报出接手它的窗格', activeClose.removePane('pane-1') === 'pane-2'
  && activeClose.getSnapshot().activeKey === 'pane-2');
const lastClose = createPaneStore();
lastClose.addPane('ws-a');
check('关掉最后一个窗格：没有人接手', lastClose.removePane('pane-1') === undefined
  && lastClose.getSnapshot().activeKey === null);

delete globalThis.document;
const headlessBoard = await renderBoard(mod);
check('没有 document 的环境里照样装载（监听自然不装）', headlessBoard.paneStore.getSnapshot().panes.length === 2);

report();
