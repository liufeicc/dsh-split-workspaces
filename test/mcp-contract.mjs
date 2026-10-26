/**
 * 离线契约测试：**按工作区共享**的 MCP 工具开关。
 *
 * 与 `preset-contract.mjs` 同一套路：用浏览器加载器的方式装载入口，让 `apply` 跑在
 * 替身 Context 上，在没有浏览器、没有 Host 的情况下驱动这件事的两半：
 *
 *   1. 纯逻辑：`selectionOf`（未配置 = 全不选）、`readRoster` / `writeSelection`
 *      （含"服务没挂上"与"网关说没挂载"两条降级分支）、`createMcpStore`
 *      （含乐观更新与失败回滚）；
 *   2. 真正渲染出来的棋盘：断言窗格标题栏上确实出现了 MCP 开关、菜单里勾选状态
 *      与宿主报告一致、点一下会把**工作区路径**与合并后的列表写给宿主，并且
 *      同一工作区的**另一个窗格**跟着变（"改一个全变"）。
 *
 *   node test/mcp-contract.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReactStub, byName, createStubContext, findAll, loadBundle, mount, settle, source } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];

/** 记录一条断言结果。 */
function check(label, condition, detail) {
  if (condition) {
    console.log('ok   ' + label);
    return;
  }
  failures.push(label);
  console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

/** 宿主报告的服务器清单。 */
const SERVERS = [
  { name: 'rea', tools: 170 },
  { name: 'blender', tools: 9 },
];

/**
 * 假的 `remote.mcpWorkspace` 命名空间：记录每次 `set` 的入参，便于断言"到底写了什么"。
 * @param overrides - 覆盖默认实现（用来造失败分支）。
 * @returns 替身命名空间，`calls` 里是历次 `set` 的请求。
 */
function fakeNamespace(overrides = {}) {
  const calls = [];
  return {
    calls,
    list: () => Promise.resolve({ ok: true, value: { servers: SERVERS, byWorkspace: { '/tmp/alpha': ['rea'] } } }),
    set: (request) => {
      calls.push(request);
      return Promise.resolve({ ok: true, value: { workspace: request.workspace, selected: request.selected } });
    },
    ...overrides,
  };
}

const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;

check('入口把 MCP 块也列了出来', mod.test.CHUNK_FILES.includes('./client.mcp.js'));
check('MCP 块导出预期的函数', typeof mods.mcp.createMcpStore === 'function' && mods.mcp.MCP_REMOTE_KEY === 'remote.mcpWorkspace');
check('不把自挂的命名空间写进 inject（那会在挂载完成前死锁）', !mod.inject.includes('remote.mcpWorkspace'));

const { selectionOf, readRoster, writeSelection, createMcpStore } = mods.mcp;

// --- 选择语义：未配置 = 全不选 ------------------------------------------------------

check('未配置的工作区是空选择', selectionOf({ byWorkspace: {} }, '/tmp/alpha').length === 0);
check('已配置的工作区原样返回', selectionOf({ byWorkspace: { '/tmp/alpha': ['rea'] } }, '/tmp/alpha').join(',') === 'rea');
check('没有路径时是空选择', selectionOf({ byWorkspace: {} }, undefined).length === 0);
check('快照缺字段也不抛错', selectionOf({}, '/tmp/alpha').length === 0);

// --- 读清单的降级分支 ---------------------------------------------------------------

const noService = await readRoster(undefined);
check('服务没挂上时是「没就绪」而不是故障', noService.ok === false && noService.reason === 'notMounted');
const unmounted = await readRoster({ list: () => Promise.resolve({ ok: false, error: { code: 'gateway/invocation-unavailable', message: 'nope' } }) });
check('网关说没挂载也归入「没就绪」', unmounted.ok === false && unmounted.reason === 'notMounted');
const rosterFail = await readRoster({ list: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }) });
check('其它失败保留宿主原因', rosterFail.ok === false && rosterFail.reason === 'boom');
const rosterThrew = await readRoster({ list: () => Promise.reject(new Error('carrier down')) });
check('抛出也变成可读原因', rosterThrew.ok === false && rosterThrew.reason === 'carrier down');
const rosterOk = await readRoster(fakeNamespace());
check('正常清单原样带回', rosterOk.ok === true && rosterOk.roster.servers.length === SERVERS.length);

// --- 写选择的降级分支 ---------------------------------------------------------------

const writeNoService = await writeSelection(undefined, '/tmp/alpha', ['rea']);
check('服务没挂上时不写', writeNoService.ok === false && writeNoService.reason === 'notMounted');
const writeOk = await writeSelection({ set: () => Promise.resolve({ ok: true, value: { selected: ['rea', 'blender'] } }) }, '/tmp/alpha', ['blender', 'rea']);
check('写成功以宿主返回的规范值为准', writeOk.ok === true && writeOk.selected.join(',') === 'rea,blender');
const writeFail = await writeSelection({ set: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'disk full' } }) }, '/tmp/alpha', ['rea']);
check('写失败带上宿主原因', writeFail.ok === false && writeFail.reason === 'disk full');

// --- store ---------------------------------------------------------------------------

const store = createMcpStore(() => fakeNamespace());
check('store 初始是 idle 且没有服务器', store.getSnapshot().status === 'idle' && store.getSnapshot().servers.length === 0);
await store.load();
const loaded = store.getSnapshot();
check('载入后是 ready 并带上服务器清单', loaded.status === 'ready' && loaded.servers.map((server) => server.name).join(',') === 'rea,blender');
check('载入后带上各工作区的选择', loaded.byWorkspace['/tmp/alpha'].join(',') === 'rea');

const emptyStore = createMcpStore(() => fakeNamespace({ list: () => Promise.resolve({ ok: true, value: { servers: [], byWorkspace: {} } }) }));
await emptyStore.load();
check('宿主没报告服务器时是 empty', emptyStore.getSnapshot().status === 'empty');

const unmountedStore = createMcpStore(() => undefined);
await unmountedStore.load();
check('命名空间没挂上时是静默的 unavailable', unmountedStore.getSnapshot().status === 'unavailable' && unmountedStore.getSnapshot().error === null);

const errorStore = createMcpStore(() => fakeNamespace({ list: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }) }));
await errorStore.load();
check('其它读取失败记为 error 并保留原因', errorStore.getSnapshot().status === 'error' && errorStore.getSnapshot().error === 'boom');

const pending = [];
const raceStore = createMcpStore(() => fakeNamespace({ list: () => new Promise((resolve) => pending.push(resolve)) }));
const firstRead = raceStore.load();
const secondRead = raceStore.load();
pending[1]({ ok: true, value: { servers: [], byWorkspace: {} } });
pending[0]({ ok: true, value: { servers: SERVERS, byWorkspace: {} } });
await Promise.all([firstRead, secondRead]);
check('并发载入只有最新一次能写入', raceStore.getSnapshot().servers.length === 0);

// 乐观更新 + 失败回滚
const okNamespace = fakeNamespace();
const okStore = createMcpStore(() => okNamespace);
await okStore.load();
const writeResult = await okStore.setSelection('/tmp/alpha', ['rea', 'blender']);
check('写成功返回 ok', writeResult.ok === true);
check('写成功后快照里是该工作区的新选择', okStore.getSnapshot().byWorkspace['/tmp/alpha'].join(',') === 'rea,blender');
check('写给宿主的是工作区路径与完整列表', okNamespace.calls.length === 1 && okNamespace.calls[0].workspace === '/tmp/alpha' && okNamespace.calls[0].selected.join(',') === 'rea,blender');

const badNamespace = fakeNamespace({ set: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'disk full' } }) });
const badStore = createMcpStore(() => badNamespace);
await badStore.load();
const badResult = await badStore.setSelection('/tmp/alpha', ['blender']);
check('写失败返回原因', badResult.ok === false && badResult.reason === 'disk full');
check('写失败回滚到原选择', badStore.getSnapshot().byWorkspace['/tmp/alpha'].join(',') === 'rea');
check('写失败把原因留在快照里供界面显示', badStore.getSnapshot().error === 'disk full');

// --- 渲染出来的窗格标题栏 -------------------------------------------------------------

/** 弹出菜单的 `children` 渲染函数，兼容替身存放它的两种方式。 */
function childrenRender(popover) {
  if (typeof popover.props.children === 'function') return popover.props.children;
  if (typeof popover.children?.[0] === 'function') return popover.children[0];
  throw new Error('the popover has no children render function');
}

/**
 * 造一块棋盘：两个**不同**工作区各一格。
 *
 * 注意本插件的一条不变量：`addPane` 按 workspaceId 去重，「一个工作区最多一格」。
 * 所以「同一工作区多个窗格共享选择」这个场景在界面上根本不会出现；"按工作区共享"
 * 的真正含义是 —— 选择存在**工作区路径**上（不是窗格、不是会话），于是该工作区的
 * 每个会话、以及关掉再开的窗格读到的都是同一份，且不同工作区互不影响。
 */
async function renderBoard() {
  const stub = createStubContext({ presets: [] });
  const namespace = fakeNamespace();
  stub.services.set('remote.mcpWorkspace', namespace);
  await mod.apply(stub.ctx);
  const main = stub.registered.find((definition) => definition.name === 'main');
  const injected = main.inject();
  await injected.mcpStore.load();

  injected.paneStore.addPane('ws-a');
  injected.paneStore.addPane('ws-b');

  const workspaces = source({
    items: [
      { workspaceId: 'ws-a', title: 'alpha', path: '/tmp/alpha', sessionIds: ['s-a'] },
      { workspaceId: 'ws-b', title: 'beta', path: '/tmp/beta', sessionIds: ['s-b'] },
    ],
    archivedSessionIds: [],
  });
  const sessions = source({
    ids: ['s-a', 's-b'],
    byId: {
      's-a': { id: 's-a', displayTitle: 'blank a', blank: true, origin: 'user', updatedAt: 1, retainedBy: {}, projectionValues: {} },
      's-b': { id: 's-b', displayTitle: 'blank b', blank: true, origin: 'user', updatedAt: 1, retainedBy: {}, projectionValues: {} },
    },
  });
  const render = () => mount(main.component, {
    ...injected,
    t: stub.ctx.locale.bind('split-workspaces'),
    sessions: { retain: () => ({ sessionId: 's', release: () => {} }) },
    sessionList: sessions,
    workspaces: { ...injected.workspaces, list: workspaces, create: () => Promise.resolve({ workspaceId: 'ws-new' }) },
    uiWorkspace: { connectWorkspace: () => Promise.resolve('s-new'), pickDirectory: () => Promise.resolve(null) },
    renderSlot: () => null,
    SessionProvider: function SessionProvider() { return null; },
  });
  return { stub, namespace, injected, t: stub.ctx.locale.bind('split-workspaces'), render };
}

/** 取某个工作区那一格标题栏上的 MCP 开关。 */
function mcpControlOf(board, title) {
  const rendered = board.render();
  const frame = findAll(rendered.tree, byName('PaneFrame'))
    .find((node) => node.props.workspace !== undefined && node.props.workspace.title === title);
  if (frame === undefined) return undefined;
  const pane = mount(frame.type, frame.props);
  // 2026-10-26：MCP 开关改成**纯图标**（标题栏空间不够），所以按 icon 而不是 label 认。
  return findAll(pane.tree, byName('Popover'))
    .find((node) => node.props.icon !== undefined
      && typeof node.props.title === 'string'
      && node.props.title.startsWith('这个工作区里哪些 MCP'));
}

const board = await renderBoard();
const alpha = mcpControlOf(board, 'alpha');
const beta = mcpControlOf(board, 'beta');
check('两个工作区的窗格标题栏都有 MCP 开关', alpha !== undefined && beta !== undefined);
check('已配置工作区在悬停提示里显示已选数量', alpha.props.title.endsWith('（已选 1）'), alpha.props.title);
check('未配置工作区不带数量（默认全不选）', beta.props.title.endsWith('跟着变）'), beta.props.title);

const menuItems = findAll(childrenRender(alpha)(() => {}), byName('MenuItem'));
check('菜单列出宿主报告的全部服务器', menuItems.map((item) => item.props.label).join(',') === 'rea,blender');
check('已选中的服务器被勾上', menuItems.find((item) => item.props.label === 'rea').props.checked === true);
check('未选中的服务器不勾', menuItems.find((item) => item.props.label === 'blender').props.checked === false);
check('每行带上工具数', menuItems.find((item) => item.props.label === 'rea').props.hint === '170');

// 勾上 blender：应当按**工作区路径**写回。
menuItems.find((item) => item.props.label === 'blender').props.onClick();
await settle();
check(
  '勾选把工作区路径与合并后的列表写给宿主',
  board.namespace.calls.length === 1
    && board.namespace.calls[0].workspace === '/tmp/alpha'
    && board.namespace.calls[0].selected.join(',') === 'rea,blender',
  JSON.stringify(board.namespace.calls),
);
check('共享快照按工作区路径记录', board.injected.mcpStore.getSnapshot().byWorkspace['/tmp/alpha'].join(',') === 'rea,blender');
check('重开这一格读到的还是同一份选择（选择属于工作区，不属于窗格）', mcpControlOf(board, 'alpha').props.title.endsWith('（已选 2）'));
check('别的工作区不受影响', mcpControlOf(board, 'beta').props.title.endsWith('跟着变）'));

console.log('');
if (failures.length === 0) {
  console.log('all checks passed');
} else {
  console.log(failures.length + ' check(s) failed');
  process.exitCode = 1;
}
