/**
 * 离线契约测试：**按工作区共享**的 SKILL 开关（技能库）。
 *
 * 与 `mcp-contract.mjs` 同一套路，重点验证三件事：
 *
 *   1. 纯逻辑：`selectionOf`（未配置 = 全不选）、`readLibrary` / `writeSelection`
 *      的降级分支、`createSkillStore`（乐观更新 + 失败回滚）；
 *   2. 真正渲染出来的窗格标题栏上出现了 SKILL 按钮，且与 MCP 按钮并存；
 *   3. 弹层里每个技能排两行（名字 + 描述），勾选状态与宿主一致，点一下把**工作区路径**
 *      与合并后的列表写给宿主。
 *
 * 另外钉死两条产品决定：
 *   - 技能库服务没挂上（`unavailable`）时标题栏**不显示**这个按钮，不会多出一个点不动的图标；
 *   - 目录里没有技能时，弹层说的是「去设置里看看」而不是空白。
 *
 *   node test/skill-contract.mjs
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

/** 宿主技能库报告的两个技能。 */
const SKILLS = [
  { name: 'git-commit-zh', description: '按团队规范写中文提交信息', path: '/home/u/.dsh/skills/git-commit-zh/SKILL.md' },
  { name: 'review', description: '按规范做代码审查', path: '/home/u/.dsh/skills/review/SKILL.md' },
];

/**
 * 假的 `remote.skillWorkspace` 命名空间。
 * @param overrides - 覆盖默认实现（用来造失败分支）。
 * @returns 替身命名空间，`calls` 里是历次 `set` 的请求。
 */
function fakeNamespace(overrides = {}) {
  const calls = [];
  return {
    calls,
    list: () => Promise.resolve({
      ok: true,
      value: { dir: '/home/u/.dsh/skills', defaultDir: '/home/u/.dsh/skills', skills: SKILLS, errors: [], shadowed: [], byWorkspace: { '/tmp/alpha': ['review'] } },
    }),
    set: (request) => {
      calls.push(request);
      return Promise.resolve({ ok: true, value: { workspace: request.workspace, selected: request.selected } });
    },
    setDir: (request) => Promise.resolve({ ok: true, value: { applied: true, dir: request.dir } }),
    ...overrides,
  };
}

const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;

check('入口把 SKILL 块也列了出来', mod.test.CHUNK_FILES.includes('./client.skill.js'));
check('SKILL 块导出预期的函数', typeof mods.skill.createSkillStore === 'function' && typeof mods.skill.createSkillControl === 'function');
check('命名空间键与宿主服务一致', mods.skill.SKILL_REMOTE_KEY === 'remote.skillWorkspace');
check('不把自挂的命名空间写进 inject（那会在挂载完成前死锁）', !mod.inject.includes('remote.skillWorkspace'));

const { selectionOf, readLibrary, writeSelection, createSkillStore } = mods.skill;

// --- 选择语义：未配置 = 全不选 ------------------------------------------------------

check('未配置的工作区是空选择', selectionOf({ byWorkspace: {} }, '/tmp/alpha').length === 0);
check('已配置的工作区原样返回', selectionOf({ byWorkspace: { '/tmp/alpha': ['review'] } }, '/tmp/alpha').join(',') === 'review');
check('没有路径时是空选择', selectionOf({ byWorkspace: {} }, undefined).length === 0);
check('快照缺字段也不抛错', selectionOf({}, '/tmp/alpha').length === 0);

// --- 读清单的降级分支 ---------------------------------------------------------------

const noService = await readLibrary(undefined);
check('服务没挂上时是「没就绪」而不是故障', noService.ok === false && noService.reason === 'notMounted');
const unmounted = await readLibrary({ list: () => Promise.resolve({ ok: false, error: { code: 'gateway/invocation-unavailable', message: 'nope' } }) });
check('网关说没挂载也归入「没就绪」', unmounted.ok === false && unmounted.reason === 'notMounted');
const listFail = await readLibrary({ list: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }) });
check('其它失败保留宿主原因', listFail.ok === false && listFail.reason === 'boom');
const listThrew = await readLibrary({ list: () => Promise.reject(new Error('carrier down')) });
check('抛出也变成可读原因', listThrew.ok === false && listThrew.reason === 'carrier down');
const listOk = await readLibrary(fakeNamespace());
check('正常清单原样带回', listOk.ok === true && listOk.library.skills.length === SKILLS.length);

// --- 写选择的降级分支 ---------------------------------------------------------------

const writeNoService = await writeSelection(undefined, '/tmp/alpha', ['review']);
check('服务没挂上时不写', writeNoService.ok === false && writeNoService.reason === 'notMounted');
const writeOk = await writeSelection({ set: () => Promise.resolve({ ok: true, value: { selected: ['git-commit-zh', 'review'] } }) }, '/tmp/alpha', ['review', 'git-commit-zh']);
check('写成功以宿主返回的规范值为准', writeOk.ok === true && writeOk.selected.join(',') === 'git-commit-zh,review');
const writeFail = await writeSelection({ set: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'disk full' } }) }, '/tmp/alpha', ['review']);
check('写失败带上宿主原因', writeFail.ok === false && writeFail.reason === 'disk full');

// --- store ---------------------------------------------------------------------------

const store = createSkillStore(() => fakeNamespace());
check('store 初始是 idle 且没有技能', store.getSnapshot().status === 'idle' && store.getSnapshot().skills.length === 0);
await store.load();
const loaded = store.getSnapshot();
check('载入后是 ready 并带上技能清单', loaded.status === 'ready' && loaded.skills.map((skill) => skill.name).join(',') === 'git-commit-zh,review');
check('载入后带上目录与各工作区选择', loaded.dir === '/home/u/.dsh/skills' && loaded.byWorkspace['/tmp/alpha'].join(',') === 'review');

const emptyStore = createSkillStore(() => fakeNamespace({ list: () => Promise.resolve({ ok: true, value: { dir: '/d', skills: [], byWorkspace: {} } }) }));
await emptyStore.load();
check('目录里没有技能时是 empty', emptyStore.getSnapshot().status === 'empty');

const unmountedStore = createSkillStore(() => undefined);
await unmountedStore.load();
check('命名空间没挂上时是静默的 unavailable', unmountedStore.getSnapshot().status === 'unavailable' && unmountedStore.getSnapshot().error === null);

const errorStore = createSkillStore(() => fakeNamespace({ list: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }) }));
await errorStore.load();
check('其它读取失败记为 error 并保留原因', errorStore.getSnapshot().status === 'error' && errorStore.getSnapshot().error === 'boom');

const pending = [];
const raceStore = createSkillStore(() => fakeNamespace({ list: () => new Promise((resolve) => pending.push(resolve)) }));
const firstRead = raceStore.load();
const secondRead = raceStore.load();
pending[1]({ ok: true, value: { dir: '/d', skills: [], byWorkspace: {} } });
pending[0]({ ok: true, value: { dir: '/d', skills: SKILLS, byWorkspace: {} } });
await Promise.all([firstRead, secondRead]);
check('并发载入只有最新一次能写入', raceStore.getSnapshot().skills.length === 0);

const okNamespace = fakeNamespace();
const okStore = createSkillStore(() => okNamespace);
await okStore.load();
const writeResult = await okStore.setSelection('/tmp/alpha', ['git-commit-zh', 'review']);
check('写成功返回 ok', writeResult.ok === true);
check('写成功后快照里是该工作区的新选择', okStore.getSnapshot().byWorkspace['/tmp/alpha'].join(',') === 'git-commit-zh,review');
check('写给宿主的是工作区路径与完整列表', okNamespace.calls.length === 1 && okNamespace.calls[0].workspace === '/tmp/alpha' && okNamespace.calls[0].selected.join(',') === 'git-commit-zh,review');

const badNamespace = fakeNamespace({ set: () => Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: 'disk full' } }) });
const badStore = createSkillStore(() => badNamespace);
await badStore.load();
const badResult = await badStore.setSelection('/tmp/alpha', ['git-commit-zh']);
check('写失败返回原因', badResult.ok === false && badResult.reason === 'disk full');
check('写失败回滚到原选择', badStore.getSnapshot().byWorkspace['/tmp/alpha'].join(',') === 'review');
check('写失败把原因留在快照里供界面显示', badStore.getSnapshot().error === 'disk full');

// --- 渲染出来的窗格标题栏 -------------------------------------------------------------

/** 弹出菜单的 `children` 渲染函数，兼容替身存放它的两种方式。 */
function childrenRender(popover) {
  if (typeof popover.props.children === 'function') return popover.props.children;
  if (typeof popover.children?.[0] === 'function') return popover.children[0];
  throw new Error('the popover has no children render function');
}

/**
 * 造一块棋盘：两个不同工作区各一格。
 * @param options - `withSkill` 为 false 时不挂技能库命名空间（验证按钮整体消失）。
 * @returns 可重复渲染的棋盘句柄。
 */
async function renderBoard(options = {}) {
  const stub = createStubContext({ presets: [] });
  const namespace = fakeNamespace();
  stub.services.set('remote.mcpWorkspace', {
    list: () => Promise.resolve({ ok: true, value: { servers: [{ name: 'rea', tools: 170 }], byWorkspace: {} } }),
    set: () => Promise.resolve({ ok: true, value: { selected: [] } }),
  });
  if (options.withSkill !== false) stub.services.set('remote.skillWorkspace', namespace);
  await mod.apply(stub.ctx);
  const main = stub.registered.find((definition) => definition.name === 'main');
  const injected = main.inject();
  await injected.mcpStore.load();
  await injected.skillStore.load();

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
  return { stub, namespace, injected, render };
}

/** 取某个工作区那一格标题栏上的 SKILL 开关（按图标 + 悬停提示认）。 */
function skillControlOf(board, title) {
  const rendered = board.render();
  const frame = findAll(rendered.tree, byName('PaneFrame'))
    .find((node) => node.props.workspace !== undefined && node.props.workspace.title === title);
  if (frame === undefined) return undefined;
  const pane = mount(frame.type, frame.props);
  return findAll(pane.tree, byName('Popover'))
    .find((node) => node.props.icon !== undefined
      && typeof node.props.title === 'string'
      && node.props.title.startsWith('这个工作区启用哪些技能'));
}

const board = await renderBoard();
const alpha = skillControlOf(board, 'alpha');
const beta = skillControlOf(board, 'beta');
check('两个工作区的窗格标题栏都有 SKILL 开关', alpha !== undefined && beta !== undefined);
check('已配置工作区在悬停提示里显示已选数量', alpha.props.title.endsWith('（已选 1）'), alpha.props.title);
check('未配置工作区不带数量（默认全不选）', beta.props.title.endsWith('里改）'), beta.props.title);

/** 取出某个开关弹层里渲染出来的那棵 SkillControl 树。 */
function controlTreeOf(control) {
  const children = childrenRender(control)();
  const list = Array.isArray(children) ? children : [children];
  const skillNode = list.find((node) => node !== null && node !== undefined && node.props !== undefined && node.props.workspacePath !== undefined);
  if (skillNode === undefined) throw new Error('the popover has no SkillControl child');
  return mount(skillNode.type, skillNode.props).tree;
}

/** 取出某个开关弹层里渲染出来的勾选行。 */
function rowsOf(control) {
  return findAll(controlTreeOf(control), (node) => node.props !== undefined && node.props.role === 'menuitemcheckbox');
}

const alphaRows = rowsOf(alpha);
check('弹层列出目录里的全部技能', alphaRows.map((row) => row.props.key).join(',') === 'skill:git-commit-zh,skill:review', alphaRows.map((row) => row.props.key).join(','));
check('已勾选的技能勾上', alphaRows.find((row) => row.props.key === 'skill:review').props['aria-checked'] === true);
check('未勾选的技能不勾', alphaRows.find((row) => row.props.key === 'skill:git-commit-zh').props['aria-checked'] === false);

const alphaText = JSON.stringify(controlTreeOf(alpha));
check('每行都带得出描述（技能靠描述区分用途）', alphaText.includes('按团队规范写中文提交信息') && alphaText.includes('按规范做代码审查'));

// 勾上 git-commit-zh：应当按**工作区路径**写回，并保留原来的选择。
alphaRows.find((row) => row.props.key === 'skill:git-commit-zh').props.onClick();
await settle();
check(
  '勾选把工作区路径与合并后的列表写给宿主',
  board.namespace.calls.length === 1
    && board.namespace.calls[0].workspace === '/tmp/alpha'
    && board.namespace.calls[0].selected.join(',') === 'review,git-commit-zh',
  JSON.stringify(board.namespace.calls),
);
check('共享快照按工作区路径记录', board.injected.skillStore.getSnapshot().byWorkspace['/tmp/alpha'].join(',') === 'review,git-commit-zh');
check('别的工作区不受影响', board.injected.skillStore.getSnapshot().byWorkspace['/tmp/beta'] === undefined);

// 弹层里能说明目录，否则用户不知道去哪里放技能。
check('弹层里说得出技能目录在哪', alphaText.includes('/home/u/.dsh/skills'));

/*
 * **每次打开都重读**（2026-10-26 用户实测提出的问题：在「设置 → 技能」里换掉目录后，
 * 点开弹层仍是旧清单，必须刷新页面才对）。
 *
 * 这里断言的是「打开」这个动作一定触发一次重读 —— 包括状态明明是 ready 的时候。
 */
{
  const calls = [];
  const original = board.injected.paneActions.loadSkills;
  board.injected.paneActions.loadSkills = () => {
    calls.push(Date.now());
    return Promise.resolve();
  };
  const fresh = skillControlOf(board, 'alpha');
  const before = skillControlOf(board, 'alpha').props.title;
  fresh.props.onOpenChange(true);
  check('打开弹层就重读清单（哪怕状态是 ready）', calls.length === 1, 'calls=' + calls.length);
  fresh.props.onOpenChange(false);
  check('关闭弹层不触发重读', calls.length === 1, 'calls=' + calls.length);
  board.injected.paneActions.loadSkills = original;
  check('悬停提示仍然带得出已选数量', typeof before === 'string' && before.endsWith('（已选 2）'), before);
}

// 目录为空时给出去处，而不是一片空白。
const emptyModule = await renderBoard();
emptyModule.stub.services.set('remote.skillWorkspace', fakeNamespace({ list: () => Promise.resolve({ ok: true, value: { dir: '/d', skills: [], byWorkspace: {} } }) }));
await emptyModule.injected.skillStore.load();
const emptyControl = skillControlOf(emptyModule, 'alpha');
check('目录里没有技能时仍然渲染得出提示', emptyControl !== undefined && JSON.stringify(controlTreeOf(emptyControl)).includes('技能目录里还没有技能'));

// 技能库没挂上：按钮整体不出现，标题栏与从前一样。
const noSkillBoard = await renderBoard({ withSkill: false });
check('技能库服务没挂上时标题栏不显示 SKILL 按钮', skillControlOf(noSkillBoard, 'alpha') === undefined);

console.log('');
if (failures.length === 0) {
  console.log('all checks passed');
} else {
  console.log(failures.length + ' check(s) failed');
  process.exitCode = 1;
}
