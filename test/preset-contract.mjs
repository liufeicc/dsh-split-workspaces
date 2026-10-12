/**
 * 离线契约测试：每个窗格独立的 Agent 模式（预设）选择器。
 *
 * 与 `layout-contract.mjs` 一样，用浏览器加载器的方式装载入口，再让 `apply`
 * 跑在一个替身 Context 上，然后在没有浏览器、没有 Host 的情况下驱动这件事的两半：
 *
 *   1. 花名册工具（`presetName`、`readPresetRoster`、`selectPreset`、
 *      `createPresetStore`）对着假的 `remote.agentPresets` 命名空间跑，
 *      覆盖「被拒绝」与「注册表未挂载」两条分支；
 *   2. 真正渲染出来的棋盘：用截获的插槽注册与 React 替身调用 `SplitPanel` 与
 *      `PaneFrame`，因此断言的是人真正看到的窗格标题栏 —— 每个窗格显示哪个模式、
 *      选一个模式会不会被暂存、空白会话是否立刻生效、以及已经开始的会话
 *      （Host 拒绝改标签）是否被放着不动。
 *
 *   node test/preset-contract.mjs
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

/** 出货的模式花名册：四个内置（不带名字）、一个自定义、一个坏掉的。 */
const ROSTER = [
  { id: 'standard', isDefault: true },
  { id: 'ptc', isDefault: false },
  { id: 'minimal', isDefault: false },
  { id: 'cordis', isDefault: false },
  { id: 'mine', isDefault: false, name: '我的模式', description: '自定义' },
  { id: 'broken', isDefault: false, broken: 'declaration is invalid' },
];

const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;

check('client.js returns apply and the internals the test drives', typeof mod.apply === 'function' && typeof mod.test === 'object');
check('the Client half declares the preset namespace', mod.inject.includes('remote') && mod.inject.includes('remote.agentPresets'));
check('the Client half keeps its existing services', ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace'].every((name) => mod.inject.includes(name)));

const { BUILT_IN_PRESET_KEYS, presetName, presetOfSession, readPresetRoster, selectPreset, createPresetStore } = mods.presets;
const { createPaneStore } = mods.model;

// --- display copy -------------------------------------------------------------------

const t = (key) => ({ 'preset.standard': '标准模式', 'preset.cordis': '创造模式' }[key] ?? key);
check('a shipped preset publishes no name and gets dictionary copy', presetName({ id: 'standard' }, t) === '标准模式');
check('a custom preset keeps its declared name', presetName({ id: 'mine', name: '我的模式' }, t) === '我的模式');
check('an unknown nameless preset falls back to its id', presetName({ id: 'unknown' }, t) === 'unknown');
check('the shipped ids with copy are exactly the four built-ins', Object.keys(BUILT_IN_PRESET_KEYS).sort().join(',') === 'cordis,minimal,ptc,standard');
check('a session without a recorded preset reports none', presetOfSession({ projectionValues: {} }) === undefined);
check('a session preset is read from its projection', presetOfSession({ projectionValues: { agentPreset: 'cordis' } }) === 'cordis');

// --- roster read --------------------------------------------------------------------

const okRoster = await readPresetRoster({ list: () => Promise.resolve({ ok: true, value: { presets: ROSTER } }) });
check('a healthy list arrives as presets', okRoster.ok === true && okRoster.presets.length === ROSTER.length);
const missing = await readPresetRoster({ list: () => Promise.resolve({ ok: false, error: { code: 'gateway/invocation-unavailable', message: 'not mounted' } }) });
check('an unmounted registry is an empty roster, not a failure', missing.ok === true && missing.presets.length === 0);
const failed = await readPresetRoster({ list: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }) });
check('any other failure keeps its message', failed.ok === false && failed.reason === 'boom');
const threw = await readPresetRoster({ list: () => Promise.reject(new Error('carrier down')) });
check('a thrown carrier fault becomes a readable reason', threw.ok === false && threw.reason === 'carrier down');

// --- preset application -------------------------------------------------------------

const accepted = await selectPreset({ select: () => Promise.resolve({ ok: true, value: 'cordis' }) }, 's-1', 'cordis');
check('an accepted pick reports success', accepted.ok === true);
const refused = await selectPreset({ select: () => Promise.resolve({ ok: false, error: { code: 'agent-preset/locked', message: 'locked', details: { reason: 'This session has already started' } } }) }, 's-1', 'cordis');
check('a refusal carries the host reason', refused.ok === false && refused.reason === 'This session has already started');
const refusedBare = await selectPreset({ select: () => Promise.resolve({ ok: false, error: { code: 'agent-preset/not-found', message: 'unknown preset' } }) }, 's-1', 'nope');
check('a refusal without a reason falls back to its message', refusedBare.ok === false && refusedBare.reason === 'unknown preset');
const selectThrew = await selectPreset({ select: () => Promise.reject(new Error('offline')) }, 's-1', 'cordis');
check('a thrown select is reported, never thrown at the pane', selectThrew.ok === false && selectThrew.reason === 'offline');

// --- roster store -------------------------------------------------------------------

const store = createPresetStore({ list: () => Promise.resolve({ ok: true, value: { presets: ROSTER } }) });
check('the roster store starts idle and empty', store.getSnapshot().status === 'idle' && store.getSnapshot().options.length === 0);
await store.load();
const loaded = store.getSnapshot();
check('a loaded roster drops broken presets', loaded.options.map((option) => option.id).join(',') === 'standard,ptc,minimal,cordis,mine');
check('the host default is marked', loaded.defaultId === 'standard');
check('a loaded roster is ready', loaded.status === 'ready' && loaded.error === null);

const customOnly = createPresetStore({ list: () => Promise.resolve({ ok: true, value: { presets: [{ id: 'mine', isDefault: false, name: '我的模式' }] } }) });
await customOnly.load();
check('without an explicit default the first healthy preset stands in', customOnly.getSnapshot().defaultId === 'mine');

const emptyStore = createPresetStore({ list: () => Promise.resolve({ ok: true, value: { presets: [{ id: 'broken', isDefault: true, broken: 'nope' }] } }) });
await emptyStore.load();
check('a roster of only broken presets renders nothing', emptyStore.getSnapshot().status === 'unavailable' && emptyStore.getSnapshot().options.length === 0);

const errorStore = createPresetStore({ list: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }) });
await errorStore.load();
check('a failed load keeps its error', errorStore.getSnapshot().status === 'error' && errorStore.getSnapshot().error === 'boom');

const pendingRosterReads = [];
const raceStore = createPresetStore({ list: () => new Promise((resolve) => pendingRosterReads.push(resolve)) });
const firstRead = raceStore.load();
const secondRead = raceStore.load();
pendingRosterReads[1]({ ok: true, value: { presets: [] } });
pendingRosterReads[0]({ ok: true, value: { presets: ROSTER } });
await Promise.all([firstRead, secondRead]);
check('only the newest roster read may publish', raceStore.getSnapshot().status === 'unavailable' && raceStore.getSnapshot().options.length === 0);

// --- the rendered board -------------------------------------------------------------

/** 造一块棋盘：两个窗格，其中一个是空白会话，另一个已经跑过回合。 */
async function renderBoard({ respond } = {}) {
  const stub = createStubContext({ presets: ROSTER, respond });
  await mod.apply(stub.ctx);
  const tBound = stub.ctx.locale.bind('split-workspaces');
  const main = stub.registered.find((definition) => definition.name === 'main');
  const injected = main.inject();
  await injected.presetStore.load();

  const paneStore = injected.paneStore;
  paneStore.addPane('ws-a');
  paneStore.addPane('ws-b');

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
      's-a': { id: 's-a', displayTitle: 'blank', blank: true, origin: 'user', updatedAt: 2, retainedBy: {}, projectionValues: {} },
      's-b': { id: 's-b', displayTitle: 'cordis run', blank: false, running: false, origin: 'user', updatedAt: 1, retainedBy: {}, projectionValues: { agentPreset: 'cordis' } },
    },
  });

  const render = () => mount(main.component, {
    ...injected,
    t: tBound,
    sessions: { retain: () => ({ sessionId: 's', release: () => {} }) },
    sessionList: sessions,
    workspaces: { ...injected.workspaces, list: workspaces, create: () => Promise.resolve({ workspaceId: 'ws-new' }) },
    uiWorkspace: {
      connectWorkspace: (workspaceId) => Promise.resolve('s-new-' + workspaceId),
      pickDirectory: () => Promise.resolve(null),
    },
    renderSlot: () => null,
    SessionProvider: function SessionProvider() { return null; },
  });

  return { stub, t: tBound, paneStore, render };
}

/** 弹出菜单的 `children` 渲染函数，兼容替身存放它的两种方式。 */
function childrenRender(popover) {
  if (typeof popover.props.children === 'function') return popover.props.children;
  if (typeof popover.children?.[0] === 'function') return popover.children[0];
  throw new Error('the popover has no children render function');
}

/** 挂载棋盘里的一个窗格，保留它的 Hook 状态，方便把已落地的选择 flush 出来。 */
function mountPane(board, workspaceTitle) {
  const rendered = board.render();
  const frames = findAll(rendered.tree, byName('PaneFrame'));
  const frame = frames.find((node) => node.props.workspace !== undefined && node.props.workspace.title === workspaceTitle);
  if (frame === undefined) return undefined;
  return mount(frame.type, frame.props);
}

/** 打开一个窗格里的模式选择器，返回它的菜单项。 */
function paneParts(pane) {
  const popover = findAll(pane.tree, byName('Popover')).find((node) => node.props.title === '该窗格新建会话时使用的 Agent 模式');
  if (popover === undefined) return { pane, label: undefined, items: [], notes: [] };
  let closed = false;
  const children = childrenRender(popover)(() => { closed = true; });
  return {
    pane,
    label: popover.props.label,
    done: () => closed,
    items: findAll(children, byName('MenuItem')),
    notes: findAll(children, (node) => typeof node.type === 'string' && typeof node.props.className === 'string' && node.props.className.includes('menuNote')).map((node) => node.children.join('')),
  };
}

/** 一个窗格的会话选择器，用来点它的「新建会话」。 */
function sessionMenu(pane) {
  const popover = findAll(pane.tree, byName('Popover')).find((node) => node.props.title === '切换会话');
  return findAll(childrenRender(popover)(() => {}), byName('MenuItem'));
}

/** 一个窗格上显示的错误行。 */
function paneErrors(pane) {
  return findAll(pane.tree, (node) => typeof node.type === 'string' && typeof node.props.className === 'string' && node.props.className.includes('paneError'))
    .map((node) => node.children.join(''));
}

const board = await renderBoard();
const first = paneParts(mountPane(board, 'alpha'));
const second = paneParts(mountPane(board, 'beta'));

check('every pane gets a mode picker', first.label !== undefined && second.label !== undefined);
check('a pane without a choice shows the host default mode', first.label === '标准模式', first.label);
check('a pane whose Session recorded a preset shows that preset', second.label === '创造模式', second.label);
check('the menu lists every healthy preset', first.items.map((item) => item.props.label).join(',') === '标准模式,PTC 模式,极简模式,创造模式,我的模式');
check('the current mode is marked in the menu', first.items.find((item) => item.props.active === true).props.label === '标准模式');
check('a started Session explains that the pick lands on the next session', second.notes.includes('当前会话已开始；所选模式会用于该窗格的下一个会话。'));
check('a blank Session shows no such note', first.notes.length === 0);

// 给「会话还是空白」的窗格选一个模式：立刻生效。
const blankPick = first.items.find((item) => item.props.label === '创造模式');
blankPick.props.onClick();
check('a pick closes the menu', first.done() === true);
await settle();
check('a pick is staged on the pane', board.paneStore.getSnapshot().panes.find((pane) => pane.workspaceId === 'ws-a').preset === 'cordis');
const blankSelect = board.stub.calls.filter((call) => call.method === 'select');
check('a blank Session takes the pick right away', blankSelect.length === 1 && blankSelect[0].sessionId === 's-a' && blankSelect[0].presetId === 'cordis');

// 给「已经跑过回合」的窗格选模式：只暂存，不动眼前这个会话。
const startedPick = second.items.find((item) => item.props.label === '标准模式');
startedPick.props.onClick();
await settle();
check('a started Session is never relabelled', board.stub.calls.filter((call) => call.method === 'select').length === 1);
check('the pick is still staged for the pane', board.paneStore.getSnapshot().panes.find((pane) => pane.workspaceId === 'ws-b').preset === 'standard');
check('the staged mode is labelled as pending for that pane', paneParts(mountPane(board, 'beta')).items.find((item) => item.props.hint === '下一个会话').props.label === '标准模式');

// 暂存的模式会用在窗格的下一个会话上。
const fresh = mountPane(board, 'beta');
const newSession = sessionMenu(fresh).find((item) => item.props.label === '新建会话');
newSession.props.onClick();
await settle();
const created = board.stub.calls.filter((call) => call.method === 'select' && call.sessionId.startsWith('s-new-'));
check('a new pane Session is created with the staged mode', created.length === 1 && created[0].presetId === 'standard', JSON.stringify(created));
check('the pane then pins the created Session', board.paneStore.getSnapshot().panes.find((pane) => pane.workspaceId === 'ws-b').sessionId === 's-new-ws-b');
check('the re-rendered pane shows the staged mode', paneParts(mountPane(board, 'beta')).label === '标准模式');

// 被拒绝的切换要显示在窗格上，而不是悄悄什么都不做。
const refusing = await renderBoard({
  respond: (method) => (method === 'select'
    ? { ok: false, error: { code: 'agent-preset/locked', message: 'locked', details: { reason: 'This session has already started' } } }
    : { ok: true, value: { presets: ROSTER } }),
});
const refusedPane = mountPane(refusing, 'alpha');
paneParts(refusedPane).items.find((item) => item.props.label === '创造模式').props.onClick();
await settle();
refusedPane.flush();
check('a refused switch is shown in the pane', paneErrors(refusedPane).length === 1 && paneErrors(refusedPane)[0].includes('This session has already started'), JSON.stringify(paneErrors(refusedPane)));

// 模式没能应用上，也不该拦住窗格新建会话。
const failingNew = await renderBoard({
  respond: (method) => (method === 'select'
    ? { ok: false, error: { code: 'agent-preset/invalid', message: 'broken preset', details: { reason: 'declaration is invalid' } } }
    : { ok: true, value: { presets: ROSTER } }),
});
const failingPane = mountPane(failingNew, 'beta');
paneParts(failingPane).items.find((item) => item.props.label === '创造模式').props.onClick();
await settle();
const failingFresh = mountPane(failingNew, 'beta');
sessionMenu(failingFresh).find((item) => item.props.label === '新建会话').props.onClick();
await settle();
failingFresh.flush();
check('a refused new-session mode still opens the Session', failingNew.paneStore.getSnapshot().panes.find((pane) => pane.workspaceId === 'ws-b').sessionId === 's-new-ws-b');
check('and the refusal is reported on the pane', paneErrors(failingFresh).some((line) => line.includes('declaration is invalid')), JSON.stringify(paneErrors(failingFresh)));

// 没有预设注册表的部署：棋盘照常，只是没有模式选择器。
const bare = createStubContext({ respond: () => ({ ok: false, error: { code: 'gateway/invocation-unavailable', message: 'not mounted' } }) });
await mod.apply(bare.ctx);
const bareMain = bare.registered.find((definition) => definition.name === 'main');
const bareInjected = bareMain.inject();
await bareInjected.presetStore.load();
bareInjected.paneStore.addPane('ws-a');
check('an unmounted registry leaves the picker out', bareInjected.presetStore.getSnapshot().status === 'unavailable');
check('the pane list still works without a registry', typeof bareInjected.paneActions.loadPresets === 'function');

// 连接重建后的刷新是接上的。
check('the board reloads the roster after a connection reset', typeof board.stub.connection.handler === 'function');
const before = board.stub.calls.filter((call) => call.method === 'list').length;
board.stub.connection.handler();
await new Promise((resolve) => setImmediate(resolve));
check('a connection reset re-reads the roster', board.stub.calls.filter((call) => call.method === 'list').length === before + 1);

// 没有模式字段的旧窗格记录也不能把选择器弄坏。
const legacy = createPaneStore();
legacy.addPane('ws-legacy');
check('a fresh pane records the host default rather than a mod', legacy.getSnapshot().panes[0].preset === null);

if (failures.length > 0) {
  console.error('\n' + String(failures.length) + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
