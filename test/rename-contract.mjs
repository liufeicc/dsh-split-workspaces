/**
 * 离线契约测试：任务分派画布的「改卡片名称」。
 *
 * 这条功能有两个入口（左侧选择器、画布卡片），但**只有一个弹层**：两处的铅笔都
 * 打开由 `GraphBoard` 托管的同一个弹层。测试因此分三层：
 *
 *   1. 文案：中英两份词典都有改名相关的每一条键（少一条就会在界面上直接露出键名）；
 *   2. 入口与弹层：两个位置的铅笔都渲染得出来、点了弹层、输入框里是当前名字；
 *   3. 提交：走的是平台官方路径（`sessions.using` → `session.rename`），
 *      标题会 `trim`、空名字当场拒绝不发请求、失败时把原因显示在弹层里且不关闭。
 *
 * 跑法：`node test/rename-contract.mjs`
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReactStub, byName, findAll, loadBundle, mount, settle } from './harness.mjs';
import { check, report, renderBoard } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;

const RENAME_KEYS = [
  'graph.renameCard',
  'graph.renameNamed',
  'graph.renameTitle',
  'graph.renameHint',
  'graph.renamePlaceholder',
  'graph.renameSave',
  'graph.renameSaving',
  'graph.renameCancel',
  'graph.renameEmpty',
  'graph.renameInvalid',
  'graph.renameUnavailable',
  'graph.renameFailed',
];

// ───────────────────────── 一、词典：中英都要齐 ─────────────────────────

for (const key of RENAME_KEYS) {
  check('中文词典有 ' + key, typeof mods.dicts.zh[key] === 'string' && mods.dicts.zh[key] !== '');
  check('英文词典有 ' + key, typeof mods.dicts.en[key] === 'string' && mods.dicts.en[key] !== '');
}
check('带名称的提示会把名字填进去',
  mods.dicts.zh['graph.renameNamed'].replace('{title}', '甲') === '修改「甲」的名称'
  && mods.dicts.en['graph.renameNamed'].replace('{title}', 'A') === 'Rename “A”');

// ───────────────────────── 二、入口与弹层 ─────────────────────────

const cssOf = mods.styles.css;
const hasClass = (node, token) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(token);
const graphBoardOf = (tree) => {
  const node = findAll(tree, byName('GraphBoard'))[0];
  return node === undefined ? undefined : mount(node.type, node.props);
};

/**
 * 改名弹层在父树里只是一个 `<GraphRenameDialog>` 元素 —— 它的输入框要 mount 之后
 * 才存在。测试替身的组件树就是这样：元素是数据，组件要显式渲染。
 */
const dialogOf = (board) => {
  const node = findAll(board.tree, byName('GraphRenameDialog'))[0];
  return node === undefined ? undefined : mount(node.type, node.props);
};

/** 进入任务分派模式并返回挂载好的 GraphBoard。 */
async function openGraph(board) {
  const panel = board.render();
  await settle();
  panel.flush();
  const modeButton = findAll(panel.tree, (node) => node.type === 'button' && node.children.includes('任务分派'))[0];
  modeButton.props.onClick();
  // 模式 store 不是 React state（替身不订阅），要显式重渲染才能读到新快照。
  panel.render();
  await settle();
  panel.flush();
  return { panel, graph: graphBoardOf(panel.tree) };
}

ReactStub.effectsEnabled = true;
/*
 * 任务分派模式下组件会挂 1.5s 的状态轮询（`window.setTimeout`）。离线测试没有浏览器
 * 全局对象，这里补一个最小 `window`：定时器用 Node 的并 unref（别把进程挂住），
 * 事件监听是空实现。
 */
globalThis.window = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer),
  addEventListener: () => {},
  removeEventListener: () => {},
};
try {
  const board = await renderBoard(mod);
  // 动作层会读会话列表判断「有没有名字」；s-a 是本用例要改的那个（有标题）。
  board.stub.setSessionList({
    's-a': { id: 's-a', title: 'a', blank: false },
    's-b': { id: 's-b', title: 'b', blank: false },
    's-c': { id: 's-c', title: 'c', blank: false },
    // 空白会话没有 title：未命名，不能改名。
    's-blank': { id: 's-blank', blank: true },
  });
  const { panel, graph } = await openGraph(board);
  check('任务分派画布渲染出来了', graph !== undefined);

  // 把一张卡片拖进画布：只有画布上真的有卡片，才有「卡片上的铅笔」。
  graph.props.actions.stageSession('s-a');
  panel.flush();
  await settle();
  panel.flush();
  const boardNow = graphBoardOf(panel.tree);
  boardNow.flush();

  const cardPencil = findAll(boardNow.tree, (node) => hasClass(node, cssOf.graphCardRename))[0];
  check('画布卡片上有「改卡片名称」图标', cardPencil !== undefined);
  if (cardPencil === undefined) throw new Error('找不到卡片上的铅笔');
  check('铅笔的可访问名里带卡片当前名称',
    typeof cardPencil.props['aria-label'] === 'string' && cardPencil.props['aria-label'].includes('a'),
    String(cardPencil.props['aria-label']));

  cardPencil.props.onClick({ stopPropagation: () => {} });
  boardNow.flush();
  const dialog = dialogOf(boardNow);
  check('点铅笔弹出改名框', dialog !== undefined);
  const input = findAll(dialog.tree, (node) => hasClass(node, cssOf.graphRenameInput))[0];
  check('输入框里是卡片当前名称', input !== undefined && input.props.value === 'a', JSON.stringify(input?.props.value));
  const panelNode = findAll(dialog.tree, (node) => hasClass(node, cssOf.graphRenamePanel))[0];
  check('弹层是模态对话框（role/aria）',
    panelNode !== undefined && panelNode.props.role === 'dialog' && panelNode.props['aria-modal'] === 'true');
  check('点铅笔不会顺带打开浮窗',
    findAll(boardNow.tree, (node) => hasClass(node, 'dshSplitWs_floatingPane')).length === 0);

  // 空名字：当场拒绝，不发请求，弹层保持打开。
  input.props.onChange({ target: { value: '   ' } });
  dialog.flush();
  const saveButton = findAll(dialog.tree, (node) => node.type === 'button' && node.children.includes('保存'))[0];
  check('弹层里有保存按钮', saveButton !== undefined);
  const callsBefore = board.stub.calls.filter((call) => call.method === 'rename').length;
  saveButton.props.onClick();
  await settle();
  dialog.flush();
  check('空名称不发请求', board.stub.calls.filter((call) => call.method === 'rename').length === callsBefore);
  check('空名称给出提示',
    findAll(dialog.tree, (node) => hasClass(node, cssOf.graphRenameError)).some((node) => String(node.children).includes('不能为空')));

  // 正常保存：标题两端空白被去掉，弹层关闭（关闭的是 GraphBoard 的 state）。
  const input2 = findAll(dialog.tree, (node) => hasClass(node, cssOf.graphRenameInput))[0];
  input2.props.onChange({ target: { value: '  新名字  ' } });
  dialog.flush();
  const save2 = findAll(dialog.tree, (node) => node.type === 'button' && node.children.includes('保存'))[0];
  save2.props.onClick();
  await settle();
  boardNow.flush();
  const renameCalls = board.stub.calls.filter((call) => call.method === 'rename');
  check('保存时走的是平台会话重命名（sessions.using → session.rename）',
    renameCalls.length === 1
    && renameCalls[0].sessionId === 's-a'
    && renameCalls[0].title === '新名字',
    JSON.stringify(renameCalls));
  check('保存成功后弹层关闭', dialogOf(boardNow) === undefined);

  // ───────────────────────── 三、失败与取消 ─────────────────────────

  const failingBoard = await renderBoard(mod, {
    rename: () => ({ ok: false, error: { code: 'session/rename-failed', message: '磁盘写入失败' } }),
  });
  failingBoard.stub.setSessionList({ 's-a': { id: 's-a', title: 'a', blank: false } });
  const failingOpen = await openGraph(failingBoard);
  failingOpen.graph.props.actions.stageSession('s-a');
  failingOpen.panel.flush();
  await settle();
  failingOpen.panel.flush();
  const failingNow = graphBoardOf(failingOpen.panel.tree);
  failingNow.flush();
  findAll(failingNow.tree, (node) => hasClass(node, cssOf.graphCardRename))[0].props.onClick({ stopPropagation: () => {} });
  failingNow.flush();
  const failingDialog = dialogOf(failingNow);
  check('失败用例也弹出了改名框', failingDialog !== undefined);
  findAll(failingDialog.tree, (node) => hasClass(node, cssOf.graphRenameInput))[0].props.onChange({ target: { value: '改名' } });
  failingDialog.flush();
  findAll(failingDialog.tree, (node) => node.type === 'button' && node.children.includes('保存'))[0].props.onClick();
  await settle();
  failingDialog.flush();
  check('改名失败时弹层保持打开',
    findAll(failingDialog.tree, (node) => hasClass(node, cssOf.graphRenamePanel)).length === 1);
  check('改名失败时把平台给的原因显示出来',
    findAll(failingDialog.tree, (node) => hasClass(node, cssOf.graphRenameError))
      .some((node) => String(node.children).includes('磁盘写入失败')));

  // 取消：Escape 关闭（关闭的是 GraphBoard 的 state），不发请求。
  const cancelPanel = findAll(failingDialog.tree, (node) => hasClass(node, cssOf.graphRenamePanel))[0];
  const callsBeforeCancel = failingBoard.stub.calls.filter((call) => call.method === 'rename').length;
  cancelPanel.props.onKeyDown({ key: 'Escape', preventDefault: () => {} });
  failingNow.flush();
  check('按 Escape 关闭弹层', dialogOf(failingNow) === undefined);
  check('取消不会发重命名请求',
    failingBoard.stub.calls.filter((call) => call.method === 'rename').length === callsBeforeCancel);

  // ───────────────────────── 四、左侧选择器的铅笔 ─────────────────────────

  const pickerBoard = await renderBoard(mod);
  pickerBoard.stub.setSessionList({
    's-a': { id: 's-a', title: 'a', blank: false },
    's-b': { id: 's-b', title: 'b', blank: false },
    's-blank': { id: 's-blank', blank: true },
  });
  const pickerOpen = await openGraph(pickerBoard);
  const boardInstance = graphBoardOf(pickerOpen.panel.tree);
  boardInstance.flush();
  // 先展开一个工作区，才看得到它的会话条目。
  const pickerNode = findAll(boardInstance.tree, byName('GraphPicker'))[0];
  check('左侧选择器渲染出来了', pickerNode !== undefined);
  const pickerDom = mount(pickerNode.type, pickerNode.props);
  const groupHead = findAll(pickerDom.tree, (node) => hasClass(node, cssOf.graphPickerGroupHead))[0];
  groupHead.props.onClick();
  pickerDom.flush();
  const pickerItems = findAll(pickerDom.tree, (node) => hasClass(node, cssOf.graphPickerItem));
  const itemOf = (id) => pickerItems.find((node) => node.props['data-session'] === id);
  const itemA = itemOf('s-a');
  check('左侧列出了 s-a 这个会话', itemA !== undefined,
    JSON.stringify(pickerItems.map((node) => node.props['data-session'])));
  const pickerPencil = findAll(itemA, (node) => hasClass(node, cssOf.graphPickerRename))[0];
  check('左侧会话条目上有「改卡片名称」图标', pickerPencil !== undefined);
  check('左侧铅笔的可访问名里带会话名称',
    typeof pickerPencil.props['aria-label'] === 'string' && pickerPencil.props['aria-label'].includes('a'),
    String(pickerPencil.props['aria-label']));

  /*
   * 点左侧铅笔 → 弹层由 GraphBoard 托管，所以要在 GraphBoard 那个挂载实例上看。
   * `onRenameSession` 是 GraphBoard 传下来的回调，点它会 mark 那个实例 dirty。
   */
  pickerPencil.props.onClick({ stopPropagation: () => {} });
  boardInstance.flush();
  const pickerDialog = dialogOf(boardInstance);
  check('点左侧铅笔也弹出同一个改名框', pickerDialog !== undefined);
  check('左侧改名框预填的是该会话的名称',
    String(findAll(pickerDialog.tree, (node) => hasClass(node, cssOf.graphRenameInput))[0]?.props.value) === 'a',
    JSON.stringify(findAll(pickerDialog.tree, (node) => hasClass(node, cssOf.graphRenameInput))[0]?.props.value));

  // ───────────────────────── 四之二、空白会话改完名要看得见 ─────────────────────────

  /*
   * 真实平台的规则：空白会话的 `displayTitle` 会回退成项目目录名，所以视图按
   * `blank` 显示「未命名会话」。改名后快照里多了一条 `title`，卡片必须优先显示它，
   * 否则用户改完名看到的还是「未命名会话」——这条是探针跑出来的。
   */
  const titledBlank = {
    id: 's-blank-titled',
    displayTitle: 'alpha',
    title: '用户起的名字',
    blank: true,
    origin: 'user',
    // 更新一点，保证它拿下该工作区「只显示一条空白会话」的那个名额。
    updatedAt: 9,
    retainedBy: {},
    projectionValues: {},
  };
  const titledBoard = await renderBoard(mod, {
    extraSessions: [{ workspaceId: 'ws-a', session: titledBlank }],
  });
  const titledOpen = await openGraph(titledBoard);
  const titledGraph = graphBoardOf(titledOpen.panel.tree);
  titledGraph.flush();
  const titledCard = titledGraph.props.cards.find((card) => card.key === 's-blank-titled');
  check('空白会话有显式标题时，卡片显示用户起的名字',
    titledCard !== undefined && titledCard.label === '用户起的名字',
    JSON.stringify(titledCard));

  // ───────────────────────── 四之三、未命名会话不能改，未命名员工可以 ─────────────────────────

  /*
   * 用户要求：**未命名会话不能改，未命名员工可以改**。
   *
   * 普通空白会话的标题会被平台回退成目录名或占位名，即便写进标题也显示不出来，
   * 所以不给入口、动作层也拒绝；目标员工是用户显式创建的对象，允许先起名。
   * 三层都要对得上：
   *   1. 未命名会话：画布/选择器都不渲染铅笔，动作层直接拒绝；
   *   2. 未命名员工：卡片有铅笔，弹层初始值为空，动作层放行。
   */
  const untitledBoard = await renderBoard(mod);
  untitledBoard.stub.setSessionList({
    's-blank': { id: 's-blank', blank: true },
    's-a': { id: 's-a', title: 'a', blank: false },
  });
  const untitledOpen = await openGraph(untitledBoard);
  untitledOpen.graph.props.actions.stageSession('s-blank');
  untitledOpen.panel.flush();
  await settle();
  untitledOpen.panel.flush();
  const untitledNow = graphBoardOf(untitledOpen.panel.tree);
  untitledNow.flush();
  const blankCard = findAll(untitledNow.tree, (node) => hasClass(node, cssOf.graphCard) && node.props['data-session'] === 's-blank')[0];
  check('未命名会话的卡片上没有改名铅笔',
    blankCard !== undefined && findAll(blankCard, (node) => hasClass(node, cssOf.graphCardRename)).length === 0);
  check('未命名会话的卡片仍然有「移出画布」按钮',
    blankCard !== undefined && findAll(blankCard, (node) => hasClass(node, cssOf.graphCardRemove)).length === 1);

  const refused = await untitledOpen.graph.props.actions.renameSession('s-blank', '新名字');
  check('动作层直接拒绝未命名会话', refused !== undefined && refused.ok === false && String(refused.reason).includes('未命名'),
    JSON.stringify(refused));

  // 左侧选择器里的未命名条目同样没有铅笔。
  const untitledPickerNode = findAll(untitledNow.tree, byName('GraphPicker'))[0];
  const untitledPicker = mount(untitledPickerNode.type, untitledPickerNode.props);
  findAll(untitledPicker.tree, (node) => hasClass(node, cssOf.graphPickerGroupHead))[0].props.onClick();
  untitledPicker.flush();
  const untitledItem = findAll(untitledPicker.tree, (node) => hasClass(node, cssOf.graphPickerItem) && node.props['data-session'] === 's-a')[0];
  check('有标题的会话在左侧仍有铅笔',
    untitledItem !== undefined && findAll(untitledItem, (node) => hasClass(node, cssOf.graphPickerRename)).length === 1);

  // 把这张空白会话登记成「员工」：仍未命名，但用户要求允许先起名。
  await untitledBoard.injected.targetStore.addTarget('s-blank', 'ws-a');
  untitledOpen.panel.render();
  await settle();
  untitledOpen.panel.flush();
  const employeeNow = graphBoardOf(untitledOpen.panel.tree);
  employeeNow.flush();
  const employeeCard = findAll(employeeNow.tree, (node) => hasClass(node, cssOf.graphCard) && node.props['data-session'] === 's-blank')[0];
  const employeeLabel = employeeCard === undefined
    ? undefined
    : findAll(employeeCard, (node) => hasClass(node, cssOf.graphCardTitle))[0]?.children;
  const employeeRenameButtons = employeeCard === undefined
    ? []
    : findAll(employeeCard, (node) => hasClass(node, cssOf.graphCardRename));
  check('未命名员工的卡片上有改名铅笔', employeeCard !== undefined
    && String(employeeLabel) === '未命名员工'
    && employeeRenameButtons.length === 1,
  JSON.stringify(employeeLabel));

  // 点铅笔：改名框的初始草稿应为空，而不是预填「未命名员工」。
  if (employeeRenameButtons.length === 1) {
    employeeRenameButtons[0].props.onClick({ stopPropagation() {} });
    employeeNow.flush();
  }
  const employeeDialog = findAll(employeeNow.tree, byName('GraphRenameDialog'))[0];
  check('未命名员工点铅笔会打开改名框', employeeDialog !== undefined);
  check('改名框初始值是空的（不预填占位名）',
    employeeDialog !== undefined && employeeDialog.props.request.title === '',
    JSON.stringify(employeeDialog === undefined ? undefined : employeeDialog.props.request));
  const renamedEmployee = await employeeNow.props.actions.renameSession('s-blank', '新员工');
  check('动作层允许未命名员工改名',
    renamedEmployee !== undefined && renamedEmployee.ok === true,
    JSON.stringify(renamedEmployee));

  // ───────────────────────── 五、旧部署降级 ─────────────────────────

  const legacyBoard = await renderBoard(mod);
  const legacyOpen = await openGraph(legacyBoard);
  const legacyGraph = graphBoardOf(legacyOpen.panel.tree);
  legacyGraph.props.actions.stageSession('s-a');
  legacyOpen.panel.flush();
  await settle();
  legacyOpen.panel.flush();
  const legacyNow = graphBoardOf(legacyOpen.panel.tree);
  // 模拟旧宿主：动作面里根本没有 renameSession。
  const withoutRename = { ...legacyNow.props, actions: { ...legacyNow.props.actions, renameSession: undefined } };
  const legacyMount = mount(legacyNow.component, withoutRename);
  legacyMount.flush();
  check('没有改名能力时不渲染铅笔（而不是留一个点了没反应的按钮）',
    findAll(legacyMount.tree, (node) => hasClass(node, cssOf.graphCardRename)).length === 0);
} finally {
  ReactStub.effectsEnabled = false;
}

report();