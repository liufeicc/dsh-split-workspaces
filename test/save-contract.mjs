/**
 * 离线契约测试：平铺布局的保存/恢复。
 *
 * 覆盖三层：
 *   1. `client.layout.js` 的纯序列化/校验：坏 JSON、缺会话、缺工作区、缺模式、
 *      布局剪枝、focus 回退、比例保留；
 *   2. 任务分派图的清洗：缺节点、自连、重复边、成环、多上级都丢掉，合法边和说明保留；
 *   3. 入口 `paneActions` 的真实落盘/读回：保存到 Host 磁盘、恢复棋盘/图/模式、
 *      清除保存记录。
 *
 * 用 `node test/save-contract.mjs` 单独运行。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReactStub, createStubContext, findAll, loadBundle, settle } from './harness.mjs';
import { check, report, renderBoard } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;
const layout = mods.layout;
const graphModel = mods.graphModel;

/** 造一份可保存的 paneStore 快照。 */
const paneSnapshot = () => ({
  panes: [
    { key: 'pane-1', workspaceId: 'ws-a', sessionId: 's-a', preset: 'standard', follow: true },
    { key: 'pane-2', workspaceId: 'ws-b', sessionId: 's-missing', preset: 'gone', follow: false },
  ],
  layout: {
    type: 'split',
    id: 'split-1',
    dir: 'row',
    ratio: 0.3,
    a: { type: 'leaf', paneKey: 'pane-1' },
    b: { type: 'leaf', paneKey: 'pane-2' },
  },
  activeKey: 'pane-2',
});

const workspaceById = new Map([
  ['ws-a', { workspaceId: 'ws-a', path: '/tmp/a' }],
  ['ws-b', { workspaceId: 'ws-b', path: '/tmp/b' }],
]);

const saved = layout.serialize(
  paneSnapshot(),
  workspaceById,
  { edges: [{ from: 's-a', to: 's-b', note: '让 B 处理这个' }] },
  'graph',
);

// --- 1. 序列化 ---------------------------------------------------------------------

check('保存结构带版本号', saved.version === layout.LAYOUT_VERSION);
check('保存棋盘模式与焦点', saved.mode === 'graph' && saved.activeKey === 'pane-2');
check('保存窗格的工作区、会话、Agent 模式与跟随标记', saved.panes.length === 2
  && saved.panes[0].workspacePath === '/tmp/a'
  && saved.panes[0].sessionId === 's-a'
  && saved.panes[0].preset === 'standard'
  && saved.panes[0].follow === true);
check('保存分派图的边与说明', saved.graph.edges.length === 1
  && saved.graph.edges[0].from === 's-a'
  && saved.graph.edges[0].to === 's-b'
  && saved.graph.edges[0].note === '让 B 处理这个');
check('空窗格但仍有分派图时也允许保存', layout.serialize(
  { panes: [], layout: null, activeKey: null },
  workspaceById,
  { edges: [{ from: 's-a', to: 's-b' }] },
  'tiles',
) !== null);
check('图还没读回来时不把 graph 字段写进快照', (() => {
  const payload = layout.serialize(paneSnapshot(), workspaceById, null, 'graph');
  return payload !== null && payload.graph === undefined && payload.mode === 'graph';
})());
check('既没有窗格也没有分派图时不生成保存结构', layout.serialize(
  { panes: [], layout: null, activeKey: null },
  workspaceById,
  { edges: [] },
  'tiles',
) === null);

// --- 2. 恢复：缺会话 / 缺模式 / 缺工作区都静默降级 --------------------------------

const context = {
  workspaces: [
    { workspaceId: 'ws-a', path: '/tmp/a' },
    { workspaceId: 'ws-b', path: '/tmp/b' },
  ],
  isValidPaneSession: (id) => id === 's-a' || id === 's-b',
  isValidGraphSession: (id) => id === 's-a' || id === 's-b',
  presetIds: ['standard', 'ptc'],
};
const restored = layout.restore(saved, context);
check('恢复出棋盘', restored.paneState !== null && restored.paneState.panes.length === 2);
check('恢复保留布局与分隔条比例', restored.paneState.layout.type === 'split' && restored.paneState.layout.ratio === 0.3);
check('仍然存在的会话被保留', restored.paneState.panes[0].sessionId === 's-a');
check('已经不存在的会话被清空', restored.paneState.panes[1].sessionId === null);
check('仍然存在的 Agent 模式被保留', restored.paneState.panes[0].preset === 'standard');
check('已经不存在的 Agent 模式被清空', restored.paneState.panes[1].preset === null);
// 花名册还没回来（超时路径）时保留保存时的模式 id，界面可回退显示 id，不阻塞恢复。
const keepPresets = layout.restore(saved, { ...context, presetIds: null });
check('模式清单未就绪时保留保存时的模式 id', keepPresets.paneState.panes[0].preset === 'standard'
  && keepPresets.paneState.panes[1].preset === 'gone');
check('焦点保留在仍然存在的窗格上', restored.paneState.activeKey === 'pane-2');
check('下一个窗格/分隔条编号避开已保存的 key', restored.paneState.nextKey === 3 && restored.paneState.nextSplit === 2);
check('恢复出分派图与模式', restored.mode === 'graph'
  && restored.graph.edges.length === 1
  && restored.graph.edges[0].from === 's-a');

check('失效版本直接忽略', layout.restore({ ...saved, version: 999 }, context) === null);
check('损坏的窗格数组直接忽略', layout.restore({ ...saved, panes: 'nope' }, context) === null);

// 工作区按路径回退（id 变了，路径还在）。
const byPath = layout.restore(saved, {
  ...context,
  workspaces: [
    { workspaceId: 'ws-a-new', path: '/tmp/a' },
    { workspaceId: 'ws-b-new', path: '/tmp/b' },
  ],
});
check('工作区 id 变了但路径还在时仍能恢复', byPath.paneState !== null
  && byPath.paneState.panes[0].workspaceId === 'ws-a-new');

// 窗格丢失时布局树剪枝，另一半保留。
const onePane = layout.restore(saved, {
  ...context,
  workspaces: [{ workspaceId: 'ws-a', path: '/tmp/a' }],
});
check('工作区全丢了的窗格被移除', onePane.paneState !== null && onePane.paneState.panes.length === 1);
check('剪枝后布局塌陷成留下的那个叶子', onePane.paneState.layout.type === 'leaf' && onePane.paneState.layout.paneKey === 'pane-1');
check('剪枝后焦点回退到第一个有效窗格', onePane.paneState.activeKey === 'pane-1');

// 布局树引用了不存在的窗格：重建一行。
const brokenLayout = layout.restore({
  ...saved,
  layout: { type: 'split', id: 'split-1', dir: 'row', ratio: 0.4, a: { type: 'leaf', paneKey: 'missing' }, b: { type: 'leaf', paneKey: 'pane-2' } },
}, context);
check('布局引用不存在的窗格时丢掉那一支', brokenLayout.paneState !== null
  && brokenLayout.paneState.panes.length === 1
  && brokenLayout.paneState.panes[0].key === 'pane-2');

// 保存结构里没有图：不应当覆盖 Host 上的图。
const noGraph = { ...saved };
delete noGraph.graph;
const noGraphRestored = layout.restore(noGraph, context);
check('旧结构没有图时 graph 为 null（交给 Host 的绑定恢复）', noGraphRestored.paneState !== null && noGraphRestored.graph === null);
check('没有 graph 字段时面板模式仍按保存值恢复', noGraphRestored.mode === 'graph');

// 只有图、没有窗格：仍可恢复图，窗格交给调用方播种。
const graphOnly = layout.restore({
  ...saved,
  panes: [],
  layout: null,
  activeKey: null,
}, context);
check('只有分派图时也恢复图', graphOnly !== null && graphOnly.paneState === null && graphOnly.graph.edges.length === 1);

// --- 3. 任务分派图清洗 -------------------------------------------------------------

const cleaned = graphModel.sanitizeEdges([
  { from: 's-a', to: 's-b' },
  { from: 's-a', to: 's-b' }, // 重复
  { from: 's-a', to: 's-c' }, // 合法，A 有两个孩子
  { from: 's-b', to: 's-c' }, // C 已有上级
  { from: 's-c', to: 's-a' }, // 成环
  { from: 's-x', to: 's-a' }, // 节点不存在
  { from: 's-a', to: 's-a' }, // 自连
  { from: 's-d', to: 's-e', note: '说明' },
], (id) => ['s-a', 's-b', 's-c', 's-d', 's-e'].includes(id));
check('清洗后只留下合法树边', cleaned.map((edge) => edge.from + '>' + edge.to).join(',') === 's-a>s-b,s-a>s-c,s-d>s-e');
check('清洗保留合法边的说明', cleaned[2].note === '说明');

// --- 4. 入口动作：Host 落盘 / 读回 / 清除 ------------------------------------------

let hostLayout = null;
const hostLayoutHandlers = {
  readLayout: async () => ({ ok: true, value: hostLayout }),
  writeLayout: async (request) => {
    hostLayout = request.layout;
    return { ok: true, value: { ok: true } };
  },
  clearLayout: async () => {
    hostLayout = null;
    return { ok: true, value: { ok: true } };
  },
};
const stub = createStubContext({ presets: [] });
stub.remoteHandlers.paneDispatch = hostLayoutHandlers;
await mod.apply(stub.ctx);
const main = stub.registered.find((definition) => definition.name === 'main');
const injected = main.inject();
const actions = injected.paneActions;
injected.paneStore.addPane('ws-a');
injected.paneStore.addPane('ws-b');
injected.paneStore.setSession('pane-1', 's-a');
injected.paneStore.setPreset('pane-1', 'standard');
injected.graphStore.setEdges([{ from: 's-a', to: 's-b', note: '分工' }]);
injected.viewModeStore.setMode('graph');

const saveResult = await actions.saveLayout(injected.paneStore.getSnapshot(), workspaceById, injected.graphStore.getSnapshot(), 'graph');
check('入口保存成功', saveResult.ok === true);
check('保存后可读取到布局', actions.hasSavedLayout() === true);
check('Host 上确实写入了保存结构', hostLayout !== null && hostLayout.version === layout.LAYOUT_VERSION);

injected.paneStore.closeAll();
injected.graphStore.setEdges([]);
injected.viewModeStore.setMode('tiles');
const restoredResult = actions.restoreSavedLayout({
  workspaces: [
    { workspaceId: 'ws-a', path: '/tmp/a' },
    { workspaceId: 'ws-b', path: '/tmp/b' },
  ],
  isValidPaneSession: (id) => id === 's-a' || id === 's-b',
  isValidGraphSession: (id) => id === 's-a' || id === 's-b',
  presetIds: ['standard'],
});
check('入口恢复棋盘', restoredResult.panes === true && injected.paneStore.getSnapshot().panes.length === 2);
check('入口恢复会话与模式', injected.paneStore.getSnapshot().panes[0].sessionId === 's-a'
  && injected.paneStore.getSnapshot().panes[0].preset === 'standard');
check('入口恢复分派图', restoredResult.graph === true
  && injected.graphStore.getSnapshot().edges.length === 1
  && injected.graphStore.getSnapshot().edges[0].note === '分工');
check('入口恢复面板模式', injected.viewModeStore.getSnapshot().mode === 'graph');

const cleared = await actions.clearSavedLayout();
check('清除 Host 保存记录成功', cleared === true && actions.hasSavedLayout() === false && hostLayout === null);

// 非法版本：只信任客户端校验，Host 原样返回坏数据时当作没有保存过。
const badStub = createStubContext({ presets: [] });
badStub.remoteHandlers.paneDispatch = {
  readLayout: async () => ({ ok: true, value: { version: 999 } }),
  writeLayout: async () => ({ ok: true, value: { ok: true } }),
  clearLayout: async () => ({ ok: true, value: { ok: true } }),
};
await mod.apply(badStub.ctx);
const badInjected = badStub.registered.find((definition) => definition.name === 'main').inject();
check('非法版本不恢复', await badInjected.paneActions.loadSavedLayout() === false
  && badInjected.paneActions.hasSavedLayout() === false
  && badInjected.paneActions.restoreSavedLayout(context).panes === false);

// --- 5. 自动恢复：挂载平铺面板时从 Host 读取布局 ----------------------------------

const savedForRestore = layout.serialize(
  {
    panes: [
      { key: 'pane-1', workspaceId: 'ws-a', sessionId: 's-a', preset: 'standard', follow: true },
      { key: 'pane-2', workspaceId: 'ws-b', sessionId: 's-b', preset: null, follow: false },
    ],
    layout: {
      type: 'split',
      id: 'split-1',
      dir: 'col',
      ratio: 0.6,
      a: { type: 'leaf', paneKey: 'pane-1' },
      b: { type: 'leaf', paneKey: 'pane-2' },
    },
    activeKey: 'pane-1',
  },
  workspaceById,
  { edges: [{ from: 's-a', to: 's-b', note: '恢复后的分工' }] },
  'graph',
);
const restoreBoard = await renderBoard(mod, {
  preloadPanes: false,
  remoteHandlers: {
    paneDispatch: {
      readLayout: async () => ({ ok: true, value: savedForRestore }),
      writeLayout: async () => ({ ok: true, value: { ok: true } }),
      clearLayout: async () => ({ ok: true, value: { ok: true } }),
    },
  },
});
// 先把模式清单置成“已读取”（测试替身返回空清单，状态 unavailable），
// 这样挂载时恢复效果不会停在“等清单”的分支。
await restoreBoard.injected.presetStore.load();
await restoreBoard.injected.paneActions.loadSavedLayout();
ReactStub.effectsEnabled = true;
const restoreInstance = restoreBoard.render();
for (let index = 0; index < 8; index += 1) await settle();
restoreInstance.flush();
for (let index = 0; index < 8; index += 1) await settle();
restoreInstance.flush();
ReactStub.effectsEnabled = false;
const restoredPaneState = restoreBoard.paneStore.getSnapshot();
check('面板挂载时自动恢复 Host 里保存的棋盘', restoredPaneState.initialized === true && restoredPaneState.panes.length === 2);
check('自动恢复保留布局方向与比例', restoredPaneState.layout.dir === 'col' && restoredPaneState.layout.ratio === 0.6);
check('自动恢复保留窗格里的会话', restoredPaneState.panes[0].sessionId === 's-a' && restoredPaneState.panes[1].sessionId === 's-b');
check('自动恢复分派图与说明', restoreBoard.injected.graphStore.getSnapshot().edges.length === 1
  && restoreBoard.injected.graphStore.getSnapshot().edges[0].note === '恢复后的分工');
check('自动恢复保存时的面板模式', restoreBoard.injected.viewModeStore.getSnapshot().mode === 'graph');

// --- 6. 界面：保存按钮真的写入 Host ------------------------------------------------

let writtenLayout = null;
const board = await renderBoard(mod, {
  remoteHandlers: {
    paneDispatch: {
      readLayout: async () => ({ ok: true, value: null }),
      writeLayout: async (request) => {
        writtenLayout = request.layout;
        return { ok: true, value: { ok: true } };
      },
      clearLayout: async () => ({ ok: true, value: { ok: true } }),
    },
  },
});
const tree = board.render().tree;
await settle();
const saveButtons = findAll(tree, (node) => node.type === 'button' && node.props['data-action'] === 'save-layout');
check('右上角渲染出保存图标按钮', saveButtons.length === 1);
check('保存按钮是图标而不是文字',
  saveButtons[0].children.length === 1 && saveButtons[0].children[0]?.type === 'svg');
saveButtons[0].props.onClick();
for (let index = 0; index < 5; index += 1) await settle();
check('点保存按钮把两个窗格写入 Host', Array.isArray(writtenLayout?.panes) && writtenLayout.panes.length === 2);
check('跟随窗格保存成眼前这一段对话，而不是只存 null', writtenLayout.panes[0].sessionId === 's-a' && writtenLayout.panes[1].sessionId === 's-b');
check('图未就绪时按钮不写不可靠的空图', writtenLayout.graph === undefined);

report();
