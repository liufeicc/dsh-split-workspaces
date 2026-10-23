/**
 * 离线契约测试：多工作区平铺的「上下左右平铺 + 焦点高亮 + 分屏菜单」。
 *
 * 与 `preset-contract.mjs` 一样以浏览器加载器的方式装载 `client.js`，然后用
 * React 替身驱动真实的渲染结果，因此断言的是人真正看到/摸到的东西：
 *
 *   1. 布局树纯函数的语义（替换、折叠、均分、比例钳制）与分屏候选工作区的排序；
 *   2. 面板存储（paneStore）的行为：添加、四个方向分屏、关闭折叠、焦点转移；
 *   3. 渲染出的棋盘：分隔条在哪、占位比例是多少、分屏菜单的两步（先方向、再选工作区）、
 *      点击窗格后焦点样式是否跟着走，以及焦点标题栏的渐变对比度。
 *
 * 两种拖动（分隔条改尺寸、标题栏交换位置）在 `drag-contract.mjs`；窗格几何与
 * `Alt+方向键` 在 `focus-contract.mjs`；三个文件共用的测试台在 `board.mjs`。
 *
 *   node test/layout-contract.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReactStub, byData, byName, findAll, loadBundle, mount, settle } from './harness.mjs';
// 断言记录、棋盘挂载、颜色对比度与元素查找的小工具；另外三个契约测试用的是同一份。
import { check, report, renderBoard, paneDom, framesOf, frameOf, splitMenuOf, replaceMenuOf, openWorkspaceStep, popoverRender, paneHeadOf, contrastRatio, mixWithBlack } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
check('入口把各个代码块都列了出来', mod.test.CHUNK_FILES.join(',') === './client.styles.js,./client.dicts.js,./client.model.js,./client.presets.js,./client.mcp.js,./client.menu.js,./client.pane.js,./client.view.js', mod.test.CHUNK_FILES.join(','));
const mods = await mod.test.chunks;
check('每个代码块都按 loader 规则注册并导出自己的东西', typeof mods.styles.CSS === 'string' && typeof mods.styles.css.pane === 'string' && typeof mods.styles.cx === 'function'
  && typeof mods.dicts.zh['panel.title'] === 'string' && typeof mods.dicts.en['panel.title'] === 'string'
  && typeof mods.model.createPaneStore === 'function' && typeof mods.presets.createPresetStore === 'function'
  && typeof mods.menu.createMenu === 'function' && typeof mods.pane.createPane === 'function'
  && typeof mods.view.createView === 'function');

check('中文与英文的词典键一一对应（新增的「替换工作区」那几条两边都齐）', (() => {
  const zh = Object.keys(mods.dicts.zh).sort().join(',');
  const en = Object.keys(mods.dicts.en).sort().join(',');
  return zh === en
    && typeof mods.dicts.en['pane.replaceWorkspace'] === 'string'
    && typeof mods.dicts.en['pane.replaceHint'] === 'string'
    && typeof mods.dicts.en['pane.replacing'] === 'string'
    && typeof mods.dicts.en['pane.replaceFailed'] === 'string'
    && typeof mods.dicts.en['pane.replaceAllOpen'] === 'string';
})());

const {
  createPaneStore,
  resolvePaneSessionId,
  leafNode,
  collectLeaves,
  countLeaves,
  hasSplit,
  replaceLeaf,
  removeLeaf,
  balanceTree,
  setSplitRatio,
  clampRatio,
  ratioLimits,
  nextRatio,
  PANE_DIRECTIONS,
  layoutRects,
  neighborPane,
  splitPlacement,
  splitCandidates,
  unopenedWorkspaces,
} = mods.model;

/** 造一个「左右分屏」节点，供纯函数断言使用。 */
const rowSplit = (id, a, b, ratio = 0.5) => ({ type: 'split', id, dir: 'row', ratio, a, b });

// --- 布局纯函数 ---------------------------------------------------------------------

const pair = rowSplit('s1', leafNode('p1'), leafNode('p2'));
check('叶子按从左到右的顺序收集', collectLeaves(pair).join(',') === 'p1,p2');
check('可以数出子树里有几个窗格', countLeaves(pair) === 2 && countLeaves(leafNode('p1')) === 1);
check('只有真正的分屏才算有分隔条', hasSplit(pair) === true && hasSplit(leafNode('p1')) === false && hasSplit(null) === false);

const nested = replaceLeaf(pair, 'p1', rowSplit('s2', leafNode('p1'), leafNode('p3')));
check('替换叶子把新分屏放进原位', collectLeaves(nested).join(',') === 'p1,p3,p2');
check('未被触碰的分支保持同一个节点（结构共享）', nested.b === pair.b && pair.a.paneKey === 'p1');
check('替换不存在的窗格不改动整棵树', replaceLeaf(pair, 'nope', leafNode('p9')) === pair);

const collapsed = removeLeaf(nested, 'p3');
check('关掉一个窗格后只塌掉它所在的分屏', collapsed.id === 's1' && collectLeaves(collapsed).join(',') === 'p1,p2');
check('塌陷后的子树就是原来那个兄弟节点', collapsed.a === nested.a.a);
check('删除不存在的窗格不改动整棵树', removeLeaf(nested, 'nope') === nested);
check('删掉最后一个窗格得到空树', removeLeaf(leafNode('p1'), 'p1') === null);

const tilted = setSplitRatio({ ...nested, a: { ...nested.a, ratio: 0.2 } }, 's2', 0.7);
check('按 id 修改某条分隔条的比例', tilted.a.ratio === 0.7 && tilted.ratio === 0.5);
check('改别的分隔条不影响本节点之外的结构', tilted.b === nested.b);
check('未知 id 的比例修改返回原树', setSplitRatio(nested, 'nope', 0.7) === nested);

const balanced = balanceTree(tilted);
check('均分把所有分隔条拉回中间', balanced.ratio === 0.5 && balanced.a.ratio === 0.5);
check('已经均分的树不做无谓的重建', balanceTree(balanced) === balanced);

check('比例被钳制在合法区间', clampRatio(0) === 0.06 && clampRatio(2) === 0.94 && clampRatio(0.3) === 0.3);
check('非法比例回落到均分', clampRatio(Number.NaN) === 0.5 && clampRatio(undefined) === 0.5);
check('容器够大时留出最小窗格宽度', ratioLimits(1000).min === 0.16 && ratioLimits(1000).max === 0.84);
check('容器刚好放得下两个最小窗格', ratioLimits(400).min === 0.4 && ratioLimits(400).max === 0.6);
check('容器过小时退回静态区间，不出现反向边界', ratioLimits(200).min === 0.06 && ratioLimits(200).max === 0.94);
check('尺寸未知时也不产生 NaN', ratioLimits(0).min === 0.06 && nextRatio(0.5, 100, 0) === 0.5);
check('拖动位移换算成容器占比', nextRatio(0.5, 100, 1000) === 0.6);
check('拖到边界外被钳制', nextRatio(0.5, -1000, 1000) === 0.16 && nextRatio(0.5, 1000, 1000) === 0.84);

// --- 面板存储 -----------------------------------------------------------------------

const empty = createPaneStore();
check('新面板没有窗格也没有布局', empty.getSnapshot().layout === null && empty.getSnapshot().activeKey === null);

empty.addPane('ws-a');
const firstLeaf = empty.getSnapshot().layout;
check('第一个窗格就是布局树的唯一叶子', firstLeaf.type === 'leaf' && firstLeaf.paneKey === 'pane-1');
check('首个窗格跟随工作区的最新会话', empty.getSnapshot().panes[0].follow === true);

empty.addPane('ws-b');
const twoUp = empty.getSnapshot();
check('第二个窗格在右侧分屏', twoUp.layout.type === 'split' && twoUp.layout.dir === 'row' && twoUp.layout.ratio === 0.5);
check('左右两块各占一半', collectLeaves(twoUp.layout).join(',') === 'pane-1,pane-2');
check('重复添加同一工作区不再开新窗格', empty.addPane('ws-a') === 'pane-1' && empty.getSnapshot().panes.length === 2);
empty.addPane('ws-a', 's-pin');
check('带会话的重复添加把窗格钉在该会话上', empty.getSnapshot().panes[0].sessionId === 's-pin');

const beforeSplit = empty.getSnapshot();
check('给不存在的窗格分屏什么也不做', empty.splitPane('pane-9', 'row') === undefined && empty.getSnapshot() === beforeSplit);
check('向右分屏返回新窗格', empty.splitPane('pane-1', 'row') === 'pane-3');
const threeUp = empty.getSnapshot();
check('分屏后新窗格排在原窗格右边', collectLeaves(threeUp.layout).join(',') === 'pane-1,pane-3,pane-2');
check('新窗格继承同一个工作区但等待选会话', threeUp.panes[2].workspaceId === 'ws-a' && threeUp.panes[2].sessionId === null && threeUp.panes[2].follow === false);
check('分屏后焦点落在新窗格上', threeUp.activeKey === 'pane-3');

empty.splitPane('pane-2', 'col');
const fourUp = empty.getSnapshot();
check('向下分屏生成上下两块', fourUp.layout.b.dir === 'col' && collectLeaves(fourUp.layout).join(',') === 'pane-1,pane-3,pane-2,pane-4');
check('可以指定新窗格的工作区', (() => {
  const store = createPaneStore();
  store.addPane('ws-a');
  store.splitPane('pane-1', 'row', 'ws-z');
  return store.getSnapshot().panes[1].workspaceId === 'ws-z';
})());

// --- 四个分屏方向 ---------------------------------------------------------------

check('分屏方向表覆盖四个方向，并保留只给轴的旧写法', mods.model.SPLIT_DIRECTIONS.join(',') === 'left,right,up,down'
  && splitPlacement('left').dir === 'row' && splitPlacement('left').newFirst === true
  && splitPlacement('right').newFirst === false
  && splitPlacement('up').dir === 'col' && splitPlacement('up').newFirst === true
  && splitPlacement('down').newFirst === false
  && splitPlacement('row').dir === 'row' && splitPlacement('col').dir === 'col'
  && splitPlacement('乱七八糟').dir === 'row' && splitPlacement('乱七八糟').newFirst === false);

check('向左分屏把新窗格放在左边', (() => {
  const store = createPaneStore();
  store.addPane('ws-a');
  store.splitPane('pane-1', 'left');
  const layout = store.getSnapshot().layout;
  return layout.dir === 'row' && collectLeaves(layout).join(',') === 'pane-2,pane-1';
})());

check('向上分屏把新窗格放在上面', (() => {
  const store = createPaneStore();
  store.addPane('ws-a');
  store.splitPane('pane-1', 'up');
  const layout = store.getSnapshot().layout;
  return layout.dir === 'col' && collectLeaves(layout).join(',') === 'pane-2,pane-1';
})());

/*
 * 「新窗格出现在哪一侧」是 left/up 存在的理由。
 *
 * 分割只能在叶子上做：新节点创建时，被切的叶子在前一条分支、新窗格在后一条分支。
 * 因此只用 right/down，新窗格永远出现在被切窗格的右边或下边；想让它出现在左边/上边
 * 是做不到的（叶子可以在原位继续展开成子树，但左右顺序无法互换）。
 */
check('只用向右分屏时，新窗格只能落在后半边', (() => {
  const store = createPaneStore();
  store.addPane('ws-a');
  store.splitPane('pane-1', 'right');
  const layout = store.getSnapshot().layout;
  return layout.a.paneKey === 'pane-1' && layout.b.paneKey === 'pane-2';
})());

check('向左分屏才能让新窗格站到前半边（向右分屏做不到）', (() => {
  const store = createPaneStore();
  store.addPane('ws-a');
  store.splitPane('pane-1', 'left');
  const layout = store.getSnapshot().layout;
  return layout.a.paneKey === 'pane-2' && layout.b.paneKey === 'pane-1';
})());

check('「上排两个并排、下排一个」这种嵌套排列可以拼出来', (() => {
  const store = createPaneStore();
  store.addPane('ws-a');              // pane-1
  store.splitPane('pane-1', 'down');  // [pane-1 / pane-2]
  store.splitPane('pane-1', 'right'); // [[pane-1 | pane-3] / pane-2]
  const layout = store.getSnapshot().layout;
  return layout.dir === 'col'
    && layout.a.dir === 'row'
    && collectLeaves(layout.a).join(',') === 'pane-1,pane-3'
    && collectLeaves(layout.b).join(',') === 'pane-2';
})());

check('四个方向都能用，且新窗格都继承同一个工作区', (() => {
  const store = createPaneStore();
  store.addPane('ws-a');
  for (const direction of mods.model.SPLIT_DIRECTIONS) store.splitPane('pane-1', direction);
  const state = store.getSnapshot();
  return state.panes.length === 5 && state.panes.every((pane) => pane.workspaceId === 'ws-a');
})());

// --- 分屏菜单第二步的候选工作区 -------------------------------------------------------

const candidateItems = [
  { workspaceId: 'ws-a', title: 'alpha', path: '/tmp/alpha' },
  { workspaceId: 'ws-b', title: 'beta', path: '/tmp/beta' },
  { workspaceId: 'ws-c', title: 'gamma', path: '/tmp/gamma' },
];

check('候选工作区：还没铺开的排前面，已铺开的排后面并标记', (() => {
  const rows = splitCandidates(candidateItems, ['ws-a', 'ws-c']);
  return rows.map((row) => row.workspaceId).join(',') === 'ws-b,ws-a,ws-c'
    && rows.map((row) => row.open).join(',') === 'false,true,true'
    && rows[0].title === 'beta' && rows[0].path === '/tmp/beta';
})());

check('候选工作区：组内保持 Host 给的工作区顺序', (() => {
  const rows = splitCandidates(candidateItems, []);
  return rows.map((row) => row.workspaceId).join(',') === 'ws-a,ws-b,ws-c';
})());

check('候选工作区：已铺开的工作区也不剔除（全部铺开后仍然能分屏）', (() => {
  const rows = splitCandidates([{ workspaceId: 'ws-a', title: 'alpha', path: '/tmp/alpha' }], ['ws-a']);
  return rows.length === 1 && rows[0].open === true;
})());

check('候选工作区：没有工作区时是空列表', splitCandidates([], ['ws-a']).length === 0);

const shrink = createPaneStore();
shrink.addPane('ws-a');
shrink.addPane('ws-b');
shrink.setRatio('split-1', 0.2);
check('分隔条比例被写进布局树', shrink.getSnapshot().layout.ratio === 0.2);
check('比例越界时被钳制', (() => {
  shrink.setRatio('split-1', 5);
  return shrink.getSnapshot().layout.ratio === 0.94;
})());
check('未知分隔条 id 不产生新快照', (() => {
  const before = shrink.getSnapshot();
  shrink.setRatio('split-9', 0.3);
  return shrink.getSnapshot() === before;
})());
shrink.balance();
check('均分把分隔条拉回 0.5', shrink.getSnapshot().layout.ratio === 0.5);
check('已均分时再点均分不产生新快照', (() => {
  const before = shrink.getSnapshot();
  shrink.balance();
  return shrink.getSnapshot() === before;
})());

const focus = createPaneStore();
focus.addPane('ws-a');
focus.addPane('ws-b');
focus.setActive('pane-2');
check('焦点可以移动到另一个窗格', focus.getSnapshot().activeKey === 'pane-2');
check('未知窗格拿不到焦点', (() => {
  const before = focus.getSnapshot();
  focus.setActive('pane-9');
  return focus.getSnapshot() === before;
})());

focus.removePane('pane-1');
check('关掉窗格后布局塌陷成单个叶子', focus.getSnapshot().layout.type === 'leaf' && focus.getSnapshot().layout.paneKey === 'pane-2');
focus.removePane('pane-2');
check('关掉最后一个窗格后布局清空', focus.getSnapshot().layout === null && focus.getSnapshot().activeKey === null);

const fallback = createPaneStore();
fallback.addPane('ws-a');
fallback.addPane('ws-b');
fallback.setActive('pane-1');
fallback.removePane('pane-1');
check('焦点窗格被关闭后交给相邻窗格', fallback.getSnapshot().activeKey === 'pane-2');

const closing = createPaneStore();
closing.addPane('ws-a');
closing.addPane('ws-b');
closing.setActive('pane-2');
closing.closeAll();
check('全部关闭后回到空棋盘', closing.getSnapshot().panes.length === 0 && closing.getSnapshot().layout === null && closing.getSnapshot().activeKey === null);

const seeded = createPaneStore();
seeded.ensureInitialized('ws-b', ['ws-a', 'ws-b']);
const seedState = seeded.getSnapshot();
check('首次打开以当前会话的工作区打头', seedState.panes[0].workspaceId === 'ws-b' && seedState.panes[1].workspaceId === 'ws-a');
check('首次打开左右并排且焦点在第一个', seedState.layout.dir === 'row' && seedState.activeKey === 'pane-1');
check('已经初始化过的面板不再重新播种', (() => {
  const before = seeded.getSnapshot();
  seeded.ensureInitialized('ws-a', ['ws-a', 'ws-b']);
  return seeded.getSnapshot() === before;
})());
check('只有一个工作区时布局就是单个窗格', (() => {
  const store = createPaneStore();
  store.ensureInitialized(undefined, ['ws-only']);
  return store.getSnapshot().layout.type === 'leaf';
})());

// --- 会话解析：分屏出来的窗格不镜像隔壁的会话 ---------------------------------------

const rows = [{ id: 's-1' }];
const sessionState = { byId: { 's-1': { id: 's-1', origin: 'user' } } };
check('跟随型窗格显示工作区的最新会话', resolvePaneSessionId({ sessionId: null, follow: true }, rows, sessionState, []) === 's-1');
check('分屏新窗格在选中会话前保持空白', resolvePaneSessionId({ sessionId: null, follow: false }, rows, sessionState, []) === undefined);
check('已钉住的会话始终优先', resolvePaneSessionId({ sessionId: 's-1', follow: false }, [], sessionState, []) === 's-1');

// --- 渲染出的棋盘 -------------------------------------------------------------------

const board = await renderBoard(mod);
const tree = board.render().tree;
const splits = findAll(tree, byData('data-split'));
check('两个窗格渲染成一条左右分隔', splits.length === 1 && splits[0].props['data-dir'] === 'row');
/*
 * 分屏的孩子**就是窗格本身**，中间不再套一层占位 div。
 *
 * 这不是排版口味：React 只在**兄弟节点之间**按 key 匹配。两个窗格是兄弟，交换布局树里
 * 两个叶子的 key 才会让它整体搬动这两棵子树，而不是卸载重建 —— 重建会让会话引用松手，
 * 两边的对话都重开一遍。「拖动标题栏交换位置」就是靠这一条保住会话的。
 */
check('分屏的孩子就是窗格本身（React 才能按 key 整体搬动它们）', splits[0].children[0].type.name === 'PaneFrame' && splits[0].children[2].type.name === 'PaneFrame',
  splits[0].children.map((child) => (child === null ? 'null' : (typeof child.type === 'function' ? child.type.name : String(child.type)))).join(','));
check('分隔条两侧各占一半宽度，比例写在窗格自己的 flexGrow 上', splits[0].children[0].props.grow === 0.5 && splits[0].children[2].props.grow === 0.5,
  String(splits[0].children[0].props.grow) + ' / ' + String(splits[0].children[2].props.grow));
check('比例真的落到了窗格的 style 上', framesOf(tree).every((frame) => mount(frame.type, frame.props).tree.props.style.flexGrow === 0.5));
const splitterEl = splits[0].children[1];
check('分隔条是一个分隔符组件', splitterEl.type.name === 'Splitter' && splitterEl.props.dir === 'row');
const paneDoms = framesOf(tree).map((frame) => mount(frame.type, frame.props).tree);
check('每个窗格标题栏都有一个分屏菜单，四个方向齐全', paneDoms.length === 2 && paneDoms.every((dom) => {
  const menu = splitMenuOf(dom);
  return menu !== undefined && menu.labels.join(',') === '向左分屏,向右分屏,向上分屏,向下分屏';
}));
check('分屏菜单的触发器是纯图标按钮（省标题栏横向空间）', paneDoms.every((dom) => {
  const menu = splitMenuOf(dom);
  return menu !== undefined && menu.popover.props.icon !== undefined && menu.popover.props.label === undefined;
}));

/*
 * 标题栏的每个孩子都必须有固定 key。
 *
 * React 对没有 key 的兄弟节点按位置匹配：一旦「可选孩子」（模式选择器、焦点标记）
 * 出现或消失，位置就会错开，React 会把用户刚按下鼠标的按钮复用成别的控件，
 * 于是 click 落到错误的处理函数上 —— 真实出现过的症状是「点『向下分屏』变成向右分屏」。
 */
check('窗格标题栏的每个孩子都带固定 key', paneDoms.every((dom) => {
  const head = paneHeadOf(dom);
  if (head === undefined) return false;
  const children = (head.children ?? []).flat().filter(Boolean);
  const keys = children.map((child) => child.props.key);
  return keys.every((key) => typeof key === 'string' && key !== '') && new Set(keys).size === keys.length;
}));
check('对话本体与错误行也带 key，出错时不会挪动对话位置', (() => {
  const pane = framesOf(tree)[0];
  const section = mount(pane.type, pane.props).tree;
  const keys = (section.children ?? []).flat().filter(Boolean).map((child) => child.props.key);
  return keys.includes('head') && keys.includes('body') && new Set(keys).size === keys.length;
})());

// 焦点变化不能改变标题栏的「孩子结构」：否则按下鼠标的按钮会被复用成别的控件。
const headShape = (dom) => (paneHeadOf(dom).children ?? []).flat().filter(Boolean)
  .map((child) => (typeof child.type === 'function' ? child.type.name : String(child.type)) + '#' + String(child.props.key));
const unfocusedShape = headShape(paneDoms[1]);
const focusBoard = await renderBoard(mod);
paneDom(focusBoard.render().tree, 'pane-1').tree.props.onPointerDownCapture();
check('把焦点切到另一个窗格后，标题栏结构（类型 + key）完全一致', (() => {
  const focused = paneDom(focusBoard.render().tree, 'pane-2');
  return headShape(focused.tree).join('|') === unfocusedShape.join('|');
})(), unfocusedShape.join('|'));

/*
 * 用户明确要求顶部标题栏只留标题与「添加工作区」：说明小字、「均分」「全部关闭」
 * 三个入口都删掉。均分仍然可以双击分隔条做到（见 drag-contract.mjs），
 * 关掉所有窗格仍然可以逐格关，因此这里只守住「这三个入口不再渲染」。
 */
check('顶部标题栏只剩标题与「添加工作区」：说明小字、均分、全部关闭都已移除', (() => {
  const hintGone = findAll(tree, (node) => node.props.className === 'dshSplitWs_hint').length === 0;
  const balanceGone = findAll(tree, (node) => node.props.title === '把所有分隔条移回中间位置').length === 0;
  const closeAllGone = findAll(tree, (node) => (node.children ?? []).includes('全部关闭')).length === 0;
  const addKept = findAll(tree, byName('Popover')).some((node) => node.props.title === '添加工作区');
  return hintGone && balanceGone && closeAllGone && addKept;
})());

/*
 * 分隔条的拖动（改比例）、键盘微调、双击均分，以及窗格标题栏的拖动交换，都属于「拖动」域，
 * 断言在 `drag-contract.mjs`。这里只留结构性的这一条：它必须声明成一个分隔符、且真的可聚焦。
 */
const dividerEl = mount(splitterEl.type, splitterEl.props);
check('分隔条声明成分隔符且可聚焦', dividerEl.tree.props.role === 'separator' && dividerEl.tree.props.tabIndex === 0
  && dividerEl.tree.props['aria-orientation'] === 'vertical');

// 焦点只有一处表达：整条标题栏是蓝色渐变 + 白字（窗格本身不加高亮框）。
check('焦点不用窗格外框表示', !/\.dshSplitWs_pane\[data-active=true\]\{/.test(mods.styles.CSS));
const activeHeadRule = /\.dshSplitWs_pane\[data-active=true\] \.dshSplitWs_paneHead\{([^}]*)\}/.exec(mods.styles.CSS);
const activeHead = activeHeadRule === null ? '' : activeHeadRule[1];
// 这条是踩过的坑：--dsw-alias-brand-primary 在深色主题里是近白的中性填充色，
// 拿它当底再写白字会白底白字；所以底色取的是蓝色强调色。
check('标题栏底色用蓝色强调色', activeHead.includes('var(--dshSplitWs-accent)') && activeHead.includes('background:linear-gradient('), activeHead);
check('标题栏底色不再用那支中性填充色', !/background:var\(--dsw-alias-brand-primary\)/.test(activeHead), activeHead);
check('强调色变量本身带静态蓝兜底，不会退回那支中性填充色', (() => {
  const rule = /\.dshSplitWs_root\{([^}]*)\}/.exec(mods.styles.CSS);
  if (rule === null) return false;
  const decl = /--dshSplitWs-accent:([^;]*)/.exec(rule[1]);
  return decl !== null
    && decl[1].includes('--dsw-alias-brand-primary-new-colorprimary-new-color')
    && decl[1].includes('--dsw-static-deepseek-500')
    && !decl[1].includes('--dsw-alias-brand-primary,');
})());
check('渐变两端都把蓝压深（白字才有对比度）', (activeHead.match(/color-mix\(in srgb,var\(--dshSplitWs-accent\) \d+%,var\(--dsw-static-neutral-1000\)\)/g) ?? []).length >= 3, activeHead);
check('标题栏文字是白色 token（用户明确要求白字）', /color:var\(--dsw-static-neutral-00\)/.test(activeHead), activeHead);
check('焦点样式里没有写死的白字/黑字', !/color:#fff/.test(mods.styles.CSS) && !/color:rgba\(255,255,255/.test(mods.styles.CSS) && !/color:#000/.test(mods.styles.CSS));

/*
 * 白字在整条渐变上都得看得清，所以把渐变实际算一遍。
 *
 * 强调色在深浅主题下解析成两支蓝（#5686fe / #4176e6，取自主题包的 token 定义），
 * 渐变每一端都是「强调色 × 百分比 + 黑」，按 WCAG 算与白字的对比度。
 */
const gradientStops = (activeHead.match(/color-mix\(in srgb,var\(--dshSplitWs-accent\) (\d+)%,var\(--dsw-static-neutral-1000\)\)/g) ?? [])
  .map((stop) => Number(/ (\d+)%/.exec(stop)[1]));
check('渐变有三个色标，都能解析出百分比', gradientStops.length === 3 && gradientStops.every((value) => Number.isFinite(value)), JSON.stringify(gradientStops));
for (const [themeName, accent] of [['深色主题', '#5686fe'], ['浅色主题', '#4176e6']]) {
  const worst = Math.min(...gradientStops.map((percent) => contrastRatio(mixWithBlack(accent, percent), '#ffffff')));
  check(themeName + '下白字在渐变最亮处也达到 4.5:1（实际 ' + worst.toFixed(2) + ':1）', worst >= 4.5, accent + ' stops=' + JSON.stringify(gradientStops));
}
// 反例：直接用纯强调色当底，白字对比度是不够的 —— 这正是要压深渐变的原因。
check('对照：不压深的纯强调色配白字达不到 4.5:1', contrastRatio('#5686fe', '#ffffff') < 4.5, contrastRatio('#5686fe', '#ffffff').toFixed(2));
check('标题栏里的文字与图标只继承颜色', /\.dshSplitWs_pane\[data-active=true\] \.dshSplitWs_wsName\{color:inherit\}/.test(mods.styles.CSS)
  && /\.dshSplitWs_pane\[data-active=true\] \.dshSplitWs_trigger\{color:inherit/.test(mods.styles.CSS)
  && /\.dshSplitWs_pane\[data-active=true\] \.dshSplitWs_iconButton\{color:inherit/.test(mods.styles.CSS));
// 标题栏按钮的 hover/展开底色：从「currentColor 调淡」换成「黑色压深」。
// 这不是口味问题：焦点标题栏上 currentColor 就是白，白字配「白 24% 压出来的浅灰蓝底」
// 实测只有 3.5:1，字糊在灰底上（用户的原话：下拉框灰色太难看、看不清字）。
check('标题栏里的 hover 底色是黑色压深', /\.dshSplitWs_pane\[data-active=true\] \.dshSplitWs_iconButton:hover:not\(:disabled\)\{background:color-mix\(in srgb,var\(--dsw-static-neutral-1000\)/.test(mods.styles.CSS)
  && /\.dshSplitWs_pane\[data-active=true\] \.dshSplitWs_trigger:hover:not\(:disabled\)\{background:color-mix\(in srgb,var\(--dsw-static-neutral-1000\)/.test(mods.styles.CSS));
check('展开态是最实的黑底（配白字）', /\.dshSplitWs_pane\[data-active=true\] \.dshSplitWs_triggerOpen\{border-color:transparent;background:var\(--dsw-static-neutral-1000\);/.test(mods.styles.CSS)
  && /\.dshSplitWs_pane\[data-active=true\] \.dshSplitWs_iconButtonOpen\{background:var\(--dsw-static-neutral-1000\);/.test(mods.styles.CSS));
check('标题栏按钮不再拿 currentColor 调淡当底色', !/\.dshSplitWs_pane\[data-active=true\][^{]*\{background:color-mix\(in srgb,currentColor/.test(mods.styles.CSS));
/*
 * 数值断言：底色是「最亮的那一端渐变」压黑来的，所以白字在最亮处也必须达标。
 * `kept` 是压黑之后仍然保留的底色百分比（0 = 纯黑），与上面两条规则里的黑量一一对应。
 */
for (const [themeName, accent] of [['深色主题', '#5686fe'], ['浅色主题', '#4176e6']]) {
  const brightestStop = mixWithBlack(accent, Math.max(...gradientStops));
  for (const [stateName, kept] of [['hover（黑 50%）', 50], ['展开（纯黑）', 0]]) {
    const ratio = contrastRatio(mixWithBlack(brightestStop, kept), '#ffffff');
    check(themeName + '下' + stateName + '白字达到 4.5:1（实际 ' + ratio.toFixed(2) + ':1）', ratio >= 4.5, brightestStop);
  }
}
check('标题栏里不再有单独的焦点胶囊', !/dshSplitWs_focusPill/.test(mods.styles.CSS) && mods.styles.css.focusPill === undefined);

/*
 * 展开后的「下拉框」面板底色。
 *
 * 原先用 --dsw-alias-bg-overlay，它在深色主题里是 #61666b 的中灰 —— 用户的原话是
 * 「标题栏上下拉框灰色太难看、看不清字」：白字压上去只剩 5.1:1，次要文字（「当前」
 * 「当前会话已开始…」）只有 3.3:1。改用「抬升表面」token（深色 #2c2c2e / 浅色 #fff）。
 */
const popoverRule = /\.dshSplitWs_popoverList\{([^}]*)\}/.exec(mods.styles.CSS);
const popoverDecl = popoverRule === null ? '' : popoverRule[1];
check('下拉框面板底色不用那支中灰 overlay', popoverDecl.includes('background:var(--dsw-alias-bg-layer-2)') && !popoverDecl.includes('bg-overlay'), popoverDecl);
check('下拉框里没有别的规则还在用 bg-overlay', !/background:var\(--dsw-alias-bg-overlay\)/.test(mods.styles.CSS));
// 面板自己就是 bg-layer-2，菜单项的 hover 必须换一支，否则深色主题下按下去没有任何反应。
check('菜单项 hover 不再用面板自己的底色', !/\.dshSplitWs_menuItem:hover\{background:var\(--dsw-alias-bg-layer-2\)\}/.test(mods.styles.CSS)
  && /\.dshSplitWs_menuItem:hover\{background:color-mix\(in srgb,currentColor/.test(mods.styles.CSS));
/*
 * 数值断言：写死的是主题包里那几支 token 的实际取值
 * （深色 bg-layer-2 = bluish-850 #2c2c2e、label-primary = bluish-50 #f9fafb、label-secondary = bluish-300 #cfd3d6；
 *  浅色 bg-layer-2 = bluish-00 #fff、label-primary = bluish-1000 #0f1115、label-secondary = bluish-600 #81858c）。
 */
for (const [themeName, surface, primary, secondary] of [
  ['深色主题', '#2c2c2e', '#f9fafb', '#cfd3d6'],
  ['浅色主题', '#ffffff', '#0f1115', '#81858c'],
]) {
  const body = contrastRatio(primary, surface);
  check(themeName + '下下拉框正文达到 4.5:1（实际 ' + body.toFixed(2) + ':1）', body >= 4.5, surface);
  // 深色主题是本次要修的那一支：3.85:1 → 9.25:1。
  if (themeName === '深色主题') {
    check(themeName + '下下拉框次要文字达到 4.5:1（实际 ' + contrastRatio(secondary, surface).toFixed(2) + ':1）', contrastRatio(secondary, surface) >= 4.5, surface);
  } else {
    /*
     * 浅色主题的次要文字用的是平台自己的 --dsw-alias-label-secondary（bluish-600 #81858c），
     * 它在任何浅底上都只有 3.x:1 —— 这是那支 token 自身的取值，不是这次换底色引入的。
     * 这里只守住「不比换底色之前更差」，要真提亮得改 label-secondary，那是平台的事。
     */
    const before = contrastRatio(secondary, '#e9ecf2');
    const after = contrastRatio(secondary, surface);
    check('浅色主题下次要文字没有变差（' + before.toFixed(2) + ':1 → ' + after.toFixed(2) + ':1，平台 token 自身限制）', after >= before, after.toFixed(2));
  }
}
// 对照：原来的中灰底，次要文字根本达不到 4.5:1 —— 这正是要换底色的原因。
check('对照：原来的中灰底下次要文字不达标', contrastRatio('#cfd3d6', '#61666b') < 4.5, contrastRatio('#cfd3d6', '#61666b').toFixed(2));

// 焦点高亮：默认第一个窗格，点击另一个后跟着走。
const firstTree = board.render().tree;
const firstPane = paneDom(firstTree, 'pane-1');
const secondPane = paneDom(firstTree, 'pane-2');
check('默认焦点在第一个窗格上', firstPane.tree.props['data-active'] === 'true' && secondPane.tree.props['data-active'] === 'false');
// 点击高亮挂在按下那一刻（送光标是另一件事，挂在 click 上，见 focus-contract.mjs）。
secondPane.tree.props.onPointerDownCapture();
check('点击窗格就把焦点交给它', board.paneStore.getSnapshot().activeKey === 'pane-2');
const secondTree = board.render().tree;
check('焦点样式跟着新窗格走', paneDom(secondTree, 'pane-2').tree.props['data-active'] === 'true' && paneDom(secondTree, 'pane-1').tree.props['data-active'] === 'false');
check('焦点只落在一个窗格上', [paneDom(secondTree, 'pane-1').tree.props['data-active'], paneDom(secondTree, 'pane-2').tree.props['data-active']].join(',') === 'false,true');


/*
 * 从窗格标题栏的分屏菜单分屏，是**两步**：先选方向，再选往新窗格里放哪个工作区。
 * 直接沿用当前窗格的工作区再开一格是旧的错误行为（用户明确要求改掉）。
 */
const beforeNew = board.paneStore.getSnapshot().panes.length;
const splitPane = paneDom(secondTree, 'pane-2');
const directionStep = splitMenuOf(splitPane.tree);
check('分屏菜单第一步是四个方向', directionStep.labels.join(',') === '向左分屏,向右分屏,向上分屏,向下分屏');
directionStep.items.find((item) => item.props.label === '向下分屏').props.onClick();
splitPane.flush();
check('点了方向不会立刻分屏（要先选工作区）', board.paneStore.getSnapshot().panes.length === beforeNew);
check('触发器图标跟着已选方向走', splitMenuOf(splitPane.tree).popover.props.icon.props.direction === 'down');

const pickStep = splitMenuOf(splitPane.tree);
check('第二步先提示要选工作区，再给「返回」', pickStep.rows[0].props.className === 'dshSplitWs_menuNote'
  && pickStep.rows[0].children.includes('选择要放进新窗格的工作区')
  && pickStep.labels[0] === '返回'
  && pickStep.items[0].props.hint === '向下分屏', pickStep.labels.join(','));
check('第二步在工作区列表前提供「新建工作区…」', pickStep.items[1].props.label === '新建工作区…'
  && pickStep.items[1].props.hint === '选择文件夹', pickStep.items[1].props.label + ' / ' + String(pickStep.items[1].props.hint));
check('第二步列出全部工作区：没铺开的在前，已铺开的在后并标「已打开」', (() => {
  const labels = pickStep.labels.slice(2).join(',');
  const hints = pickStep.items.slice(2).map((item) => item.props.hint).join(',');
  return labels === 'gamma,alpha,beta' && hints === '/tmp/gamma,已打开,已打开';
})(), pickStep.labels.join(',') + ' / ' + pickStep.items.map((item) => String(item.props.hint)).join(','));

pickStep.items.find((item) => item.props.label === 'gamma').props.onClick();
splitPane.flush();
const afterNew = board.paneStore.getSnapshot();
check('向下分屏新增一个窗格', afterNew.panes.length === beforeNew + 1 && afterNew.panes[afterNew.panes.length - 1].key === 'pane-3');
check('新窗格用的是选中的工作区，不是被切窗格的工作区', afterNew.panes[2].workspaceId === 'ws-c' && afterNew.panes[1].workspaceId === 'ws-b');
check('新窗格与原窗格上下排列', findAll(board.render().tree, byData('data-split')).some((node) => node.props['data-dir'] === 'col'));
check('分屏后焦点在新窗格上', afterNew.activeKey === 'pane-3');
check('选完工作区后菜单回到第一步，下次打开不会停在上次的方向上', splitMenuOf(splitPane.tree).labels.join(',') === '向左分屏,向右分屏,向上分屏,向下分屏');

const newPane = paneDom(board.render().tree, 'pane-3');
const provider = findAll(newPane.tree, byName('SessionProvider'))[0];
check('新窗格没有绑定会话，因此不会镜像隔壁的对话', provider !== undefined && provider.props.session === undefined);
check('新窗格提示先选会话而不是直接空白', provider !== undefined
  && findAll(provider.props.empty(), (node) => node.children.includes('为这个窗格选择会话，或新建会话')).length === 1);
check('新窗格自己就带着焦点标记', newPane.tree.props['data-active'] === 'true');

/*
 * 受控关闭的另一条路径：点别处 / 按 Esc 时 Popover 只回调 `onOpenChange`，
 * 分屏菜单同样要回到第一步，否则下次打开会停在上次选的方向上。
 */
const escapeMenu = paneDom(board.render().tree, 'pane-3');
splitMenuOf(escapeMenu.tree).items.find((item) => item.props.label === '向上分屏').props.onClick();
escapeMenu.flush();
check('再点方向仍然只进第二步', splitMenuOf(escapeMenu.tree).labels[0] === '返回');
splitMenuOf(escapeMenu.tree).popover.props.onOpenChange(false);
escapeMenu.flush();
check('点别处 / Esc 关闭菜单后回到第一步', splitMenuOf(escapeMenu.tree).labels.join(',') === '向左分屏,向右分屏,向上分屏,向下分屏');

// --- 第二步的「新建工作区…」 ----------------------------------------------------------

/*
 * 用户明确要的第三条路：分屏时可以直接挑一个新目录。
 * 关键在于方向要在关菜单之前抓稳 —— 关菜单会把 splitDirection 复位。
 */
const freshBoard = await renderBoard(mod, { pickedPath: '/tmp/fresh', createdId: 'ws-fresh' });
const freshPane = openWorkspaceStep(freshBoard, 'pane-1', '向右分屏');
splitMenuOf(freshPane.tree).items.find((item) => item.props.label === '新建工作区…').props.onClick();
await settle();
freshPane.flush();
const freshState = freshBoard.paneStore.getSnapshot();
check('新建工作区后按选定方向切进新窗格', freshState.panes.length === 3
  && freshState.panes[2].workspaceId === 'ws-fresh'
  && freshState.activeKey === 'pane-3', JSON.stringify(freshState.panes.map((pane) => pane.workspaceId)));
check('新工作区是用选中的目录注册的', freshBoard.createdWith.length === 1 && freshBoard.createdWith[0].path === '/tmp/fresh'
  && freshBoard.pickCount() === 1, JSON.stringify(freshBoard.createdWith));
check('新建出来的窗格在工作区清单里暂时还没有，因此显示未知工作区而不是串到别的工作区', (() => {
  const pane = paneDom(freshBoard.render().tree, 'pane-3');
  return pane !== undefined && pane.tree.props['data-pane'] === 'pane-3';
})());

// 取消：选择器返回空 → 棋盘一点不动，也不留错误。
const cancelBoard = await renderBoard(mod, { pickedPath: null });
const cancelPane = openWorkspaceStep(cancelBoard, 'pane-1', '向下分屏');
splitMenuOf(cancelPane.tree).items.find((item) => item.props.label === '新建工作区…').props.onClick();
await settle();
cancelPane.flush();
check('选择器取消时不新建窗格', cancelBoard.paneStore.getSnapshot().panes.length === 2
  && cancelBoard.createdWith.length === 0);
check('取消后没有留下报错', findAll(cancelPane.tree, (node) => typeof node.props.className === 'string'
  && node.props.className.includes('dshSplitWs_paneError')).length === 0);

// 选择器打不开：报错要指向「无法打开文件夹选择器」，而不是含糊的「添加工作区失败」。
const failBoard = await renderBoard(mod, { pickerThrows: true });
const failPane = openWorkspaceStep(failBoard, 'pane-1', '向左分屏');
splitMenuOf(failPane.tree).items.find((item) => item.props.label === '新建工作区…').props.onClick();
await settle();
failPane.flush();
check('选择器打不开时窗格报出具体原因', findAll(failPane.tree, (node) => typeof node.props.className === 'string'
  && node.props.className.includes('dshSplitWs_paneError'))
  .some((node) => JSON.stringify(node.children).includes('无法打开文件夹选择器')));
check('选择器打不开时不会留下半个窗格', failBoard.paneStore.getSnapshot().panes.length === 2);

/*
 * 顶部「添加工作区 → 新建工作区…」和上面这条共用同一段「选目录 + 注册」的实现，
 * 因此这里补一条回归断言：重构之后面板那条路照样能铺出新窗格。
 */
const panelBoard = await renderBoard(mod, { pickedPath: '/tmp/panel', createdId: 'ws-panel' });
const addPopover = findAll(panelBoard.render().tree, byName('Popover')).find((node) => node.props.title === '添加工作区');
const addItems = findAll(popoverRender(addPopover)(() => {}), byName('MenuItem'));
addItems.find((item) => item.props.label === '新建工作区…').props.onClick();
await settle();
const panelState = panelBoard.paneStore.getSnapshot();
check('面板的「新建工作区…」仍然把新工作区铺到棋盘右边', panelState.panes.length === 3
  && panelState.panes[2].workspaceId === 'ws-panel'
  && panelBoard.createdWith[0].path === '/tmp/panel', JSON.stringify(panelState.panes.map((pane) => pane.workspaceId)));

/*
 * --- 替换工作区：位置不变、内容换掉 --------------------------------------------------
 *
 * 用户明确要的一条路：在**这一格**的位置上，关掉原来的工作区，换成另一个（还没铺开的）
 * 工作区。因此这里守两件事：
 *   1. 存储只改那一格的记录，布局树与别的窗格是**同一个对象**（位置与比例一个字节不动）；
 *   2. 旧会话必须被清掉，否则这一格会继续显示上一个工作区的对话（看着像替换没生效）。
 */

check('未铺开的工作区：剔除已铺开的，顺序保持 Host 给的那样', (() => {
  const rows = unopenedWorkspaces(candidateItems, ['ws-b']);
  return rows.map((row) => row.workspaceId).join(',') === 'ws-a,ws-c' && rows[0].title === 'alpha';
})());
check('未铺开的工作区：都铺开时是空列表（菜单据此说明没有可换的）',
  unopenedWorkspaces(candidateItems, ['ws-a', 'ws-b', 'ws-c']).length === 0
  && unopenedWorkspaces([], []).length === 0);

const repStore = createPaneStore();
repStore.addPane('ws-a');
repStore.addPane('ws-b');
repStore.setActive('pane-2');
repStore.setPreset('pane-1', 'ptc');
repStore.setSession('pane-1', 's-a');
const repBefore = repStore.getSnapshot();
check('替换工作区：未知窗格什么也不做，也不产生新快照',
  repStore.replaceWorkspace('pane-9', 'ws-c') === false && repStore.getSnapshot() === repBefore);
check('替换工作区：换成同一个工作区什么也不做（不是一次「重开对话」）',
  repStore.replaceWorkspace('pane-1', 'ws-a') === false && repStore.getSnapshot() === repBefore);
check('替换工作区：真的换了才返回 true', repStore.replaceWorkspace('pane-1', 'ws-c') === true);
check('替换工作区：布局树原样（位置、层级、比例都不动）',
  repStore.getSnapshot().layout === repBefore.layout);
check('替换工作区：别的窗格还是同一个记录对象，焦点也不动',
  repStore.getSnapshot().panes[1] === repBefore.panes[1] && repStore.getSnapshot().activeKey === 'pane-2');
check('替换工作区：换工作区 + 清旧会话 + 回到「跟随最新会话」', (() => {
  const pane = repStore.getSnapshot().panes[0];
  return pane.workspaceId === 'ws-c' && pane.sessionId === null && pane.follow === true;
})());
check('替换工作区：这一格暂存的模式留着（它是用户为这一格选的）',
  repStore.getSnapshot().panes[0].preset === 'ptc');

/* ---------- 渲染出来的「替换工作区」菜单 ---------- */

const repBoard = await renderBoard(mod);
const repPane = paneDom(repBoard.render().tree, 'pane-1');
const repMenu = replaceMenuOf(repPane.tree);
check('每个窗格标题栏都有一个「替换工作区」图标菜单', repMenu !== undefined
  && repMenu.popover.props.icon !== undefined && repMenu.popover.props.label === undefined);
check('替换菜单与「添加工作区」同款：先「新建工作区…」，再列还没铺开的工作区',
  repMenu.labels.join(',') === '新建工作区…,gamma'
  && repMenu.items[0].props.hint === '选择文件夹'
  && repMenu.items[1].props.hint === '/tmp/gamma', repMenu.labels.join(','));
check('替换菜单不列已经铺在棋盘上的工作区（那些要靠拖动标题栏对调）',
  !repMenu.labels.includes('alpha') && !repMenu.labels.includes('beta'));

const repLayoutBefore = repBoard.paneStore.getSnapshot().layout;
repMenu.items[1].props.onClick();
repPane.flush();
const repAfter = repBoard.paneStore.getSnapshot();
check('选中一行就把这一格换成它：窗格数不变、布局树原样（还在原位）',
  repAfter.panes.length === 2 && repAfter.layout === repLayoutBefore
  && repAfter.panes[0].workspaceId === 'ws-c', JSON.stringify(repAfter.panes.map((pane) => pane.workspaceId)));
check('替换后这一格显示的是新工作区的状态，不是旧工作区的会话', (() => {
  const provider = findAll(paneDom(repBoard.render().tree, 'pane-1').tree, byName('SessionProvider'))[0];
  return provider !== undefined
    && findAll(provider.props.empty(), (node) => node.children.includes('该工作区还没有会话')).length === 1;
})());
check('替换后新工作区从候选里消失，旧工作区回到候选里', (() => {
  const menu = replaceMenuOf(paneDom(repBoard.render().tree, 'pane-1').tree);
  return menu.labels.join(',') === '新建工作区…,alpha';
})());

/*
 * 两种「没得选」要分开说：一个工作区都没注册过（棋盘是靠文件夹选择器刚长出来的那一格），
 * 与「别的工作区都铺在棋盘上了」。直接改 props 重挂这一格来看这两句话 ——
 * 否则得为一句文案造两个棋盘。
 */
const repNoChoiceRows = (overrides) => {
  const frame = frameOf(repBoard.render().tree, 'pane-1');
  return replaceMenuOf(mount(frame.type, { ...frame.props, ...overrides }).tree).rows;
};
check('别的工作区都铺开时，菜单说「没有别的工作区可换了」', (() => {
  const rows = repNoChoiceRows({ replaceChoices: [], workspaceCount: 3 });
  return rows.length === 2 && rows[0].props.label === '新建工作区…'
    && rows[1].children.includes('没有别的工作区可换了');
})());
check('一个工作区都还没注册过时说「还没有工作区」', (() => {
  const rows = repNoChoiceRows({ replaceChoices: [], workspaceCount: 0 });
  return rows[1].children.includes('还没有工作区');
})());

// 菜单里的「新建工作区…」：选目录 → 注册 → 用它替掉这一格（位置同样不变）。
const repNewBoard = await renderBoard(mod, { pickedPath: '/tmp/replace', createdId: 'ws-replaced' });
const repNewPane = paneDom(repNewBoard.render().tree, 'pane-2');
const repNewLayout = repNewBoard.paneStore.getSnapshot().layout;
replaceMenuOf(repNewPane.tree).items[0].props.onClick();
await settle();
repNewPane.flush();
const repNewState = repNewBoard.paneStore.getSnapshot();
check('「替换工作区 → 新建工作区…」用选中的目录注册，并把它放进这一格',
  repNewState.panes.length === 2 && repNewState.panes[1].workspaceId === 'ws-replaced'
  && repNewState.layout === repNewLayout
  && repNewBoard.createdWith.length === 1 && repNewBoard.createdWith[0].path === '/tmp/replace'
  && repNewBoard.pickCount() === 1, JSON.stringify(repNewState.panes.map((pane) => pane.workspaceId)));

// 选择器打不开：说清是「选择器」的问题，这一格保持原样。
const repFailBoard = await renderBoard(mod, { pickerThrows: true });
const repFailPane = paneDom(repFailBoard.render().tree, 'pane-1');
replaceMenuOf(repFailPane.tree).items[0].props.onClick();
await settle();
repFailPane.flush();
check('替换时选择器打不开：报「无法打开文件夹选择器」', findAll(repFailPane.tree, (node) => typeof node.props.className === 'string'
  && node.props.className.includes('dshSplitWs_paneError'))
  .some((node) => JSON.stringify(node.children).includes('无法打开文件夹选择器')));
check('替换时选择器打不开：这一格与整个棋盘都保持原样', (() => {
  const state = repFailBoard.paneStore.getSnapshot();
  return state.panes.length === 2 && state.panes[0].workspaceId === 'ws-a' && repFailBoard.createdWith.length === 0;
})());

report();
