/**
 * 离线契约测试：多工作区平铺的两种**拖动**。
 *
 *   1. 拖动**分隔条**改尺寸（左右布局左右拖、上下布局上下拖、键盘微调、双击均分）；
 *   2. 拖动**窗格标题栏**到另一个窗格上松手，交换两格的位置。
 *
 * 第 2 条是这里最要紧的部分：交换位置必须靠「布局树里两个叶子的 key 互换」实现，
 * 一旦变成换窗格记录（工作区 / 会话）或者整棵树重建，两个窗格各自持有的会话引用就会
 * 成对松手重拿 —— 而 DSH 的会话引用契约是「最后一次释放就拆掉会话的本地作用域与历史」，
 * 于是两个对话都会白重开一遍。因此这里除了断言「换了位置」，还专门断言
 * **窗格记录一个字段都没动**。
 *
 * 拖动整套手势（按下 → 阈值 → 命中测试 → 松手交换）在这里真跑一遍，只用一个假
 * `document` 替掉两个只有浏览器答得上来的问题：`elementFromPoint` 回答「指针底下是哪个
 * 窗格」、`querySelector` 回答「被聚焦的输入框在哪个窗格」。真浏览器里那几条只有浏览器
 * 答得上的行为（指针捕获期间别的窗格收不到 `pointerover`、松开后拍过来的那次 `click`、
 * 以及**子树是被搬动的还是被重建的**）另有一次实测，见 `tools/swap-probe.mjs`。
 *
 *   node test/drag-contract.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReactStub, byData, byName, findAll, loadBundle, mount, settle } from './harness.mjs';
// 断言记录、棋盘挂载、颜色对比度与元素查找的小工具；另外三个契约测试用的是同一份。
import { check, report, renderBoard, paneDom, framesOf, frameOf, paneHeadOf, contrastRatio, mixWithWhite } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;
const { createPaneStore, leafNode, collectLeaves, swapLeaves, paneDragExceeded, nextRatio } = mods.model;

/** 造一个「左右分屏」节点，供纯函数断言使用。 */
const rowSplit = (id, a, b, ratio = 0.5) => ({ type: 'split', id, dir: 'row', ratio, a, b });

// --- 交换两个叶子：拖动窗格标题栏的落点 -----------------------------------------------

const pair = rowSplit('s1', leafNode('p1'), leafNode('p2'));
check('交换两个叶子的位置', collectLeaves(swapLeaves(pair, 'p1', 'p2')).join(',') === 'p2,p1');
check('交换不动分屏本身：层级、id、比例全在原地', (() => {
  const tree = swapLeaves(rowSplit('s1', leafNode('p1'), leafNode('p2'), 0.3), 'p1', 'p2');
  return tree.type === 'split' && tree.id === 's1' && tree.ratio === 0.3 && collectLeaves(tree).join(',') === 'p2,p1';
})());
check('跨层交换照样成立，没被碰到的分支仍是原来那个对象', (() => {
  const tree = rowSplit('s1', rowSplit('s2', leafNode('p1'), leafNode('p2')), leafNode('p3'));
  const swapped = swapLeaves(tree, 'p1', 'p2');
  return collectLeaves(swapped).join(',') === 'p2,p1,p3' && swapped.b === tree.b && swapped.a !== tree.a;
})());
check('交换同一个窗格是空操作', swapLeaves(pair, 'p1', 'p1') === pair);
check('交换不存在的窗格不改动整棵树', swapLeaves(pair, 'p1', 'nope') === pair && swapLeaves(pair, 'nope', 'nada') === pair);
check('三方里换两个，没参与的那一个原样留在原位', (() => {
  const tree = rowSplit('s1', rowSplit('s2', leafNode('p1'), leafNode('p2')), leafNode('p3'));
  const swapped = swapLeaves(tree, 'p1', 'p3');
  return collectLeaves(swapped).join(',') === 'p3,p2,p1';
})());

/*
 * 「多少算拖动」这条线：手抖一两像素仍然是单击（点亮窗格、送光标），
 * 越过阈值才把窗格拎起来。判据是曼哈顿距离 —— 这里把两个方向的边界都钉住。
 */
check('位移不到阈值仍然算单击', paneDragExceeded(100, 100, 102, 101) === false && paneDragExceeded(100, 100, 101, 101) === false);
check('任一方向走满阈值就算拖动', paneDragExceeded(100, 100, 104, 100) === true && paneDragExceeded(100, 100, 100, 104) === true);
check('斜着走要两个方向加起来才够（曼哈顿距离）', paneDragExceeded(100, 100, 102, 102) === true && paneDragExceeded(100, 100, 103, 100) === false);

// --- 存储层：交换两个窗格的位置 --------------------------------------------------------

const swapStore = createPaneStore();
swapStore.addPane('ws-a');
swapStore.addPane('ws-b');
swapStore.setSession('pane-1', 's-a');
swapStore.setSession('pane-2', 's-b');
const beforeSwap = swapStore.getSnapshot();
check('交换两个窗格的位置：布局树里两个叶子的 key 互换', swapStore.swapPanes('pane-1', 'pane-2') === true
  && collectLeaves(swapStore.getSnapshot().layout).join(',') === 'pane-2,pane-1');

/*
 * 这一条是「交换不该重开会话」的守门人：窗格记录（工作区、会话、暂存模式）必须
 * **原样不动**。记录一动，两边的 `useSessionReference` 就会成对重跑，而 DSH 的
 * `SessionReference.release` 契约是「最后一次释放会拆掉会话的本地作用域与历史」，
 * 于是两个对话都会重新打开一遍。
 */
check('交换只动布局树：窗格记录（工作区、会话）一个字段都没换', swapStore.getSnapshot().panes === beforeSwap.panes
  && swapStore.getSnapshot().panes[0].sessionId === 's-a');
check('交换后焦点不动（它记的是窗格 key，于是高亮跟着被拖的那一格走）', swapStore.getSnapshot().activeKey === beforeSwap.activeKey);
check('同一个窗格、或两方有一个不在树上时什么都不做', (() => {
  const store = createPaneStore();
  store.addPane('ws-a');
  store.addPane('ws-b');
  const snapshot = store.getSnapshot();
  return store.swapPanes('pane-1', 'pane-1') === false
    && store.swapPanes('pane-1', 'pane-9') === false
    && store.getSnapshot() === snapshot;
})());
check('跨层交换也成立（两方不在同一层分屏里时，布局树照样只换叶子）', (() => {
  const store = createPaneStore();
  store.addPane('ws-a');               // pane-1
  store.splitPane('pane-1', 'down');   // [pane-1 / pane-2]
  store.splitPane('pane-1', 'right');  // [[pane-1 | pane-3] / pane-2]
  const before = store.getSnapshot();
  const swapped = store.swapPanes('pane-1', 'pane-2');
  const after = store.getSnapshot();
  return swapped === true
    && collectLeaves(after.layout).join(',') === 'pane-2,pane-3,pane-1'
    && after.layout.dir === before.layout.dir
    && after.panes === before.panes;
})());

// --- 拖动分隔条改尺寸 ------------------------------------------------------------------

const sizeBoard = await renderBoard(mod);
const splitterEl = findAll(sizeBoard.render().tree, byData('data-split'))[0].children[1];
// 真实调用分隔条组件渲染出的指针事件，检查比例是否跟着走。
const divider = mount(splitterEl.type, splitterEl.props);
const container = { parentElement: { clientWidth: 1000, clientHeight: 600 }, setPointerCapture: () => {} };
divider.hooks[0].current = container;
divider.tree.props.onPointerDown({ pointerType: 'mouse', button: 0, pointerId: 7, clientX: 500, clientY: 300 });
divider.flush();
check('按下分隔条进入拖动状态', divider.tree.props.className.includes('dshSplitWs_splitterActive'));
divider.tree.props.onPointerMove({ pointerId: 99, clientX: 900, clientY: 300 });
check('无关指针的移动被忽略', sizeBoard.paneStore.getSnapshot().layout.ratio === 0.5);
divider.tree.props.onPointerMove({ pointerId: 7, clientX: 600, clientY: 300 });
check('左右拖动改变左右比例', sizeBoard.paneStore.getSnapshot().layout.ratio === 0.6);
divider.tree.props.onPointerUp({ pointerId: 7 });
divider.flush();
check('松开后退出拖动状态', divider.tree.props.className.includes('dshSplitWs_splitterActive') === false);

check('拖动结果立刻反映到渲染宽度', (() => {
  const split = findAll(sizeBoard.render().tree, byData('data-split'))[0];
  return split.children[0].props.grow === 0.6 && split.children[2].props.grow === 0.4;
})());
check('分隔条上的比例换算成像素仍然成立', nextRatio(0.5, 100, 1000) === 0.6 && nextRatio(0.5, -1000, 1000) === 0.16);

// 键盘微调与双击均分：真实渲染里父组件会因比例变化重渲染并给出新 props，
// 这里同样用刷新后的分隔条元素重新挂载，避免拿旧 props 做断言。
const freshSplitter = findAll(sizeBoard.render().tree, byData('data-split'))[0].children[1];
const keyboard = mount(freshSplitter.type, freshSplitter.props);
keyboard.hooks[0].current = container;
keyboard.tree.props.onKeyDown({ key: 'ArrowLeft', shiftKey: false, preventDefault: () => {} });
check('方向键微调比例', sizeBoard.paneStore.getSnapshot().layout.ratio === 0.58, String(sizeBoard.paneStore.getSnapshot().layout.ratio));
keyboard.tree.props.onDoubleClick();
check('双击分隔条恢复均分', sizeBoard.paneStore.getSnapshot().layout.ratio === 0.5);

// --- 拖动交换位置的视觉反馈 ------------------------------------------------------------

/*
 * 落点那一圈画在**棋盘底色**上（浅色主题就是白），因此必须是纯强调色：掺透明度之后
 * 浅色主题下只剩 1.6:1，白底上一圈淡蓝等于没画。下面按 WCAG 的「非文字 3:1」逐主题算。
 */
const dragCss = mods.styles.CSS;
check('被拖动的窗格淡出、落点窗格亮起强调色圈', /\.dshSplitWs_pane\[data-dragging=true\]\{opacity:\.6\}/.test(dragCss)
  && /\.dshSplitWs_pane\[data-drop=true\]\{border-color:var\(--dshSplitWs-accent\);box-shadow:0 0 0 2px var\(--dshSplitWs-accent\)\}/.test(dragCss));
check('落点圈不掺透明度', !/\[data-drop=true\][^{]*color-mix/.test(dragCss));
check('标题栏是拖动把手：光标是「抓住」、触摸不被滚动手势抢走、里面的文字不参与选择', /\.dshSplitWs_paneHead\{[^}]*cursor:grab[^}]*touch-action:none\}/.test(dragCss)
  && /\.dshSplitWs_paneHeading\{[^}]*user-select:none\}/.test(dragCss));
for (const [themeName, accent, boardBg] of [['深色主题', '#5686fe', '#151517'], ['浅色主题', '#4176e6', '#ffffff']]) {
  const ratio = contrastRatio(accent, boardBg);
  check(themeName + '下落点圈的对比度达到 3:1（实际 ' + ratio.toFixed(2) + ':1）', ratio >= 3, accent + ' vs ' + boardBg);
}
check('对照：强调色掺 45% 之后浅色主题下达不到 3:1（所以不能用透明度）',
  contrastRatio(mixWithWhite('#4176e6', 45), '#ffffff') < 3, contrastRatio(mixWithWhite('#4176e6', 45), '#ffffff').toFixed(2));

// --- 拖动标题栏交换两个窗格的位置 ------------------------------------------------------

/*
 * 拖动是**自己写的指针拖动**（不是 HTML5 拖放），所以离线测试能把整条链路真跑一遍：
 * 按下 → 位移不到阈值仍算单击 → 越过阈值进入拖动 → 命中测试找落点 → 松手交换位置。
 *
 * 只有 `document` 是替身：`elementFromPoint` 回答「指针底下是哪个窗格」，`querySelector`
 * 回答「被聚焦的输入框在哪个窗格」。其余全是真实实现 —— 标题栏上的指针处理、布局树
 * 交换、拖动状态的视觉标记、交换之后的光标安放。
 */
let pointTarget = 'pane-2';
const focusedPanes = [];
const dragDoc = {
  // 两个初始值写成空串：断言「撤掉了」时比较的就是空串本身，而不是「没赋过值」。
  body: { style: { userSelect: '', cursor: '' } },
  elementFromPoint() {
    if (pointTarget === null) return null;
    const key = pointTarget;
    return { closest: (selector) => (selector === '[data-pane]' ? { getAttribute: () => key } : null) };
  },
  querySelector(selector) {
    const matched = /^\[data-pane="([^"]+)"\]$/.exec(selector);
    if (matched === null) return null;
    const key = matched[1];
    return { querySelector: () => ({ getAttribute: () => 'true', focus: () => focusedPanes.push(key) }) };
  },
  getSelection: () => ({ isCollapsed: true }),
  createElement: () => ({ dataset: {}, remove: () => {} }),
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = dragDoc;

const dragBoard = await renderBoard(mod);
/** 保留这一个挂载：拖动状态是它的 React 状态，`render()` 重新挂载会把它清掉。 */
const panel = dragBoard.render();
/** 单独挂一个窗格，它的标题栏上就有真正在用的那套指针处理。 */
const dragPane = paneDom(panel.tree, 'pane-1');
const dragHead = paneHeadOf(dragPane.tree);
/** 指针捕获记录：正数 = 抓走，负数 = 松开。 */
const captured = [];
dragHead.props.ref.current = {
  setPointerCapture: (pointerId) => captured.push(pointerId),
  releasePointerCapture: (pointerId) => captured.push(-pointerId),
};
const layoutOrder = () => collectLeaves(dragBoard.paneStore.getSnapshot().layout).join(',');
const notAControl = { closest: () => null };
const control = { closest: () => ({}) };
const press = (target, x = 100, y = 100) => dragHead.props.onPointerDown({ pointerType: 'mouse', button: 0, pointerId: 5, clientX: x, clientY: y, target });
const move = (x, y) => dragHead.props.onPointerMove({ pointerId: 5, clientX: x, clientY: y });
const release = () => dragHead.props.onPointerUp({ pointerId: 5 });

check('棋盘一开始是 pane-1 在左、pane-2 在右', layoutOrder() === 'pane-1,pane-2');

// 1. 按在标题栏的控件上（按钮 / 下拉 / 菜单）：完全不参与拖动。
press(control);
check('按在标题栏的控件上不抓指针（那是按钮自己的交互）', captured.length === 0);
move(160, 140);
panel.flush();
check('控件上按下再拖也不会把窗格拖走', layoutOrder() === 'pane-1,pane-2' && frameOf(panel.tree, 'pane-1').props.dragging === false);

// 2. 按在标题栏空白处但几乎没动：仍然是单击语义，什么都不发生。
press(notAControl);
check('按下标题栏就抓走指针（拖动途中指针跑出窗格也收得到事件）', captured.join(',') === '5');
move(102, 101);
panel.flush();
check('位移不到阈值仍算单击：不进入拖动，也不换位置', frameOf(panel.tree, 'pane-1').props.dragging === false && layoutOrder() === 'pane-1,pane-2');
check('还没越过阈值时不给整页加拖动期间的临时约束', dragDoc.body.style.userSelect === '');
release();
panel.flush();

// 3. 越过阈值：进入拖动，并在同一次移动里就点出落点（高亮不慢半拍）。
press(notAControl);
move(140, 100);
panel.flush();
check('越过阈值才进入拖动：被拖的那一格标记为正在拖动', frameOf(panel.tree, 'pane-1').props.dragging === true);
check('指针底下的窗格成为落点，被拖的自己不会是落点', frameOf(panel.tree, 'pane-2').props.dropTarget === true
  && frameOf(panel.tree, 'pane-1').props.dropTarget === false);
check('拖动期间一格都不换（松手才交换）', layoutOrder() === 'pane-1,pane-2');
check('拖动期间给整页临时加上「不选中文字 + 抓住光标」', dragDoc.body.style.userSelect === 'none' && dragDoc.body.style.cursor === 'grabbing');

// 4. 指针移到所有窗格之外：落点高亮清掉，松手什么都不换。
pointTarget = null;
move(600, 400);
panel.flush();
check('指针离开所有窗格后落点高亮清掉', frameOf(panel.tree, 'pane-2').props.dropTarget === false);
release();
panel.flush();
check('落在空白处松手什么都不换', layoutOrder() === 'pane-1,pane-2');
check('松手后拖动状态与整页临时约束都撤掉', frameOf(panel.tree, 'pane-1').props.dragging === false
  && dragDoc.body.style.userSelect === '' && dragDoc.body.style.cursor === '');
check('松手时把指针捕获还回去', captured[captured.length - 1] === -5);

// 5. 真拖一把：落在另一个窗格上松手，两个窗格交换位置。
pointTarget = 'pane-2';
focusedPanes.length = 0;
press(notAControl);
move(140, 120);
move(170, 130);
panel.flush();
check('落到另一个窗格上时它亮起落点高亮', frameOf(panel.tree, 'pane-2').props.dropTarget === true);
release();
panel.flush();
check('松手交换两个窗格的位置', layoutOrder() === 'pane-2,pane-1');
check('渲染顺序跟着布局树走（左边的孩子换成了 pane-2）', framesOf(panel.tree).map((frame) => frame.props.pane.key).join(',') === 'pane-2,pane-1');
check('交换只动位置：两格各自的工作区与会话都没搬', dragBoard.paneStore.getSnapshot().panes.map((pane) => pane.workspaceId).join(',') === 'ws-a,ws-b'
  && dragBoard.paneStore.getSnapshot().panes.map((pane) => pane.key).join(',') === 'pane-1,pane-2');
check('交换后拖动状态与整页临时约束都清干净', framesOf(panel.tree).every((frame) => frame.props.dragging === false && frame.props.dropTarget === false)
  && dragDoc.body.style.userSelect === '');

// 6. 交换之后光标要等一帧才安放（DOM 搬家会丢焦点），并且随后那次 click 不再抢。
/*
 * 真实的先后次序是：pointerup → 随手指拍过来的那次 click → 下一帧（安放光标）。
 * 因此这里**先同步地**模拟那次 click：它必须被挡掉，不能抢在拖动收尾之前去 `focus()`
 * 一个正要被搬走的输入框。
 */
focusedPanes.length = 0;
dragPane.tree.props.onClickCapture({ target: notAControl });
check('刚拖完的那一次 click 不再抢光标（光标已经由拖动收尾安放好）', focusedPanes.length === 0);
await settle();
check('交换之后键盘光标等一帧落进被拖动的窗格', focusedPanes.join(',') === 'pane-1', JSON.stringify(focusedPanes));
/*
 * 「刚拖完」这个标记只活到那一帧结束。它必须自己作废：万一那次 click 压根没派发到窗格上
 * （松手时指针已经落在棋盘空白处），标记一直挂着就会把用户之后第一次点击的送光标吞掉。
 */
focusedPanes.length = 0;
dragPane.tree.props.onClickCapture({ target: notAControl });
check('下一帧之后恢复旧语义：点窗格内容照旧把光标送回它的输入框', focusedPanes.join(',') === 'pane-1');

// 7. 拖动被系统打断（指针取消）时不能留下「整页不能选文字」这种残留。
pointTarget = 'pane-2';
press(notAControl);
move(140, 100);
panel.flush();
check('取消前确实已经进入拖动', frameOf(panel.tree, 'pane-1').props.dragging === true);
dragHead.props.onLostPointerCapture({ pointerId: 5 });
panel.flush();
check('指针捕获被夺走时当作放弃：拖动状态与整页约束都撤掉、位置不换', frameOf(panel.tree, 'pane-1').props.dragging === false
  && frameOf(panel.tree, 'pane-2').props.dropTarget === false && layoutOrder() === 'pane-2,pane-1'
  && dragDoc.body.style.userSelect === '');

report();
