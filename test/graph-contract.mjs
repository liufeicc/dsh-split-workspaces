/**
 * 「设计模式：委派图」的离线契约测试。
 *
 * 覆盖三层：
 *   1. **纯模型** —— 树的四条校验、分层布局、图 → 绑定的换算（全部可以在 Node 里直接喂）；
 *   2. **远端命名空间** —— `paneDispatch` 真的挂上去了、方法就那两个、codec 是 strict；
 *   3. **渲染** —— 顶部模式切换、卡片、箭头、删除回调，以及绑定同步真的发出了请求。
 *
 * 拖动本身（`pointermove` / `pointerup`）是浏览器行为，离线测试模拟不了；所以它依赖的
 * **判定**被抽成了 `resolveDrop` 这个纯函数，这里逐条喂 —— 视图那边只负责换算坐标。
 *
 * 跑法：`node test/graph-contract.mjs`
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReactStub, loadBundle, createStubContext, mount, settle, findAll, byName } from './harness.mjs';
import { check, report, renderBoard } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;
const graph = mods.graphModel;

// ────────────────────────────── 一、纯模型 ──────────────────────────────

/** 造一条边，省得每次写全。 */
const edge = (from, to) => ({ from, to });

check('空图接受任何一条边', graph.validateEdge([], 'a', 'b').ok === true);
check('不许自己派给自己', (() => {
  const verdict = graph.validateEdge([], 'a', 'a');
  return verdict.ok === false && verdict.code === 'self';
})());
check('同一条边不许加两遍', (() => {
  const verdict = graph.validateEdge([edge('a', 'b')], 'a', 'b');
  return verdict.ok === false && verdict.code === 'duplicate';
})());
check('一个会话只能有一个上级（树，不是 DAG）', (() => {
  const verdict = graph.validateEdge([edge('a', 'c')], 'b', 'c');
  return verdict.ok === false && verdict.code === 'has-parent';
})());
check('同一个上级可以有两个孩子（A→B、A→C 都成立）',
  graph.validateEdge([edge('a', 'b')], 'a', 'c').ok === true);
/*
 * 反过来连 A→B 之后再加 B→A：既是环、也会让 A 多一个上级。**报环**而不是报
 * 「已有上级」—— 两条都成立时，环是更具体、更能解释「为什么不能这么连」的那条。
 */
check('直接反向成环被拒绝，且报的是环', (() => {
  const verdict = graph.validateEdge([edge('a', 'b')], 'b', 'a');
  return verdict.ok === false && verdict.code === 'cycle';
})());
check('绕一圈的环也被拒绝（A→B→C，再来 C→A）', (() => {
  const verdict = graph.validateEdge([edge('a', 'b'), edge('b', 'c')], 'c', 'a');
  return verdict.ok === false && verdict.code === 'cycle';
})());
check('多下级的链上成环同样被拒绝（A→B、A→C，再来 B→C 是「第二个上级」）', (() => {
  const verdict = graph.validateEdge([edge('a', 'b'), edge('a', 'c')], 'b', 'c');
  return verdict.ok === false && verdict.code === 'has-parent';
})());
check('hasPath 能沿多跳找到目标', graph.hasPath([edge('a', 'b'), edge('b', 'c')], 'a', 'c') === true);
check('hasPath 走不通时返回 false', graph.hasPath([edge('a', 'b')], 'b', 'a') === false);
check('hasPath 对空图不会误判', graph.hasPath([], 'a', 'b') === false);

// ── 分层布局 ──
const layout = graph.layoutGraph([edge('a', 'b'), edge('a', 'c')], ['a', 'b', 'c'], { cardW: 100, cardH: 50, gapX: 40, gapY: 10, pad: 5 });
const at = (key) => layout.items.find((item) => item.key === key);
check('三层各自落在一列上：根在左、孩子整体往右', at('b').depth === 1 && at('c').depth === 1 && at('a').depth === 0);
check('同层的孩子不会重叠', at('b').y !== at('c').y);
check('每条边都从左指向右（不会有箭头往回画）', at('b').x > at('a').x && at('c').x > at('a').x);
check('布局宽度按层数算，不是按节点数', layout.width === 5 * 2 + 100 * 2 + 40);
check('没有任何节点时布局不会产生负尺寸', (() => {
  const empty = graph.layoutGraph([], [], {});
  return empty.items.length === 0 && empty.width >= 0 && empty.height >= 0;
})());
check('链式结构按最长路径分层（浅节点不会跑到它下级右边）', (() => {
  const chain = graph.layoutGraph([edge('a', 'b'), edge('b', 'c')], ['a', 'b', 'c'], {});
  const depth = (key) => chain.items.find((item) => item.key === key).depth;
  return depth('a') < depth('b') && depth('b') < depth('c');
})());

// ── 落点判定 ──
check('松手落在卡片上就算命中', (() => {
  const resolved = graph.resolveDrop([], layout, 'a', { x: at('b').x + 2, y: at('b').y + 2 });
  return resolved.over === 'b' && resolved.verdict.ok === true;
})());
check('松手落在空白处什么都不做', graph.resolveDrop([], layout, 'a', { x: -100, y: -100 }).over === null);
check('松手落回自己身上不算一条边', graph.resolveDrop([], layout, 'a', { x: at('a').x + 1, y: at('a').y + 1 }).over === null);

// ── 图 → 绑定 ──
const describe = (map) => (key) => map[key] ?? null;
const bindings = graph.bindingsFromEdges(
  [edge('s-a', 's-b'), edge('s-a', 's-c'), edge('s-b', 's-c')],
  describe({ 's-a': { label: 'A 会话' }, 's-b': { label: 'B 会话' }, 's-c': { label: 'C 会话' } }),
);
check('一个上级的两个目标合并到同一条绑定里', bindings.get('s-a').targets.length === 2);
check('绑定里的目标就是会话 id（边两端本来就是会话）', bindings.get('s-a').targets.every((item) => item.id.startsWith('s-')));
check('下级也能自己派出去（B→C 成立）', bindings.get('s-b').targets.some((item) => item.id === 's-c'));
check('某一端已不在会话册里时那条边不产生绑定', graph.bindingsFromEdges(
  [edge('s-a', 's-gone')],
  describe({ 's-a': { label: 'A' } }),
).size === 0);
check('指向自己的边不产生绑定', graph.bindingsFromEdges(
  [edge('s-a', 's-a')],
  describe({ 's-a': { label: 'A' } }),
).size === 0);
check('同一个目标只记一次', (() => {
  const map = graph.bindingsFromEdges(
    [edge('s-a', 's-b'), edge('s-a', 's-b')],
    describe({ 's-a': { label: 'A' }, 's-b': { label: 'B' } }),
  );
  return map.get('s-a').targets.length === 1;
})());
check('绑定表带上派出方自己的显示名（Host 报错要点名它）',
  bindings.get('s-a').label === 'A 会话', bindings.get('s-a').label);
check('能从绑定表反推出边（刷新后恢复箭头靠它）', (() => {
  const map = new Map([
    ['s-a', { label: 'A', targets: [{ id: 's-b', label: 'B' }, { id: 's-c', label: 'C' }] }],
    ['s-b', { label: 'B', targets: [{ id: 's-c', label: 'C' }] }],
  ]);
  const edges = graph.edgesFromBindings(map);
  return edges.length === 3
    && edges.some((edge) => edge.from === 's-a' && edge.to === 's-b')
    && edges.some((edge) => edge.from === 's-b' && edge.to === 's-c');
})());
check('空绑定表反推出空图', graph.edgesFromBindings(new Map()).length === 0);

check('边的说明会随绑定一起送给 Host', (() => {
  const map = graph.bindingsFromEdges(
    [{ from: 's-a', to: 's-b', note: '专做逆向' }],
    describe({ 's-a': { label: 'A' }, 's-b': { label: 'B' } }),
  );
  return map.get('s-a').targets[0].note === '专做逆向';
})());
check('反向还原时说明也一起回来', (() => {
  const edges = graph.edgesFromBindings(new Map([['s-a', { label: 'A', targets: [{ id: 's-b', label: 'B', note: '专做逆向' }] }]]));
  return edges.length === 1 && edges[0].note === '专做逆向';
})());

// ── 两个 store ──
const graphStore = graph.createGraphStore();
graphStore.addEdge('a', 'b');
graphStore.addEdge('a', 'b');
check('重复加边不会产生第二条', graphStore.getSnapshot().edges.length === 1);
graphStore.addEdge('a', 'c');
check('edgesFrom 只返回这个窗格自己派出去的', graphStore.edgesFrom('a').length === 2 && graphStore.edgesFrom('b').length === 0);
graphStore.setNote('a', 'c', '只做测试');
check('setNote 能写进说明', graphStore.getSnapshot().edges.find((edge) => edge.to === 'c').note === '只做测试');
graphStore.setNote('a', 'c', '   ');
check('setNote 传空白等于清掉说明', graphStore.getSnapshot().edges.find((edge) => edge.to === 'c').note === undefined);
graphStore.setNote('a', 'c', '专做逆向分析');
graphStore.removeSession('b');
check('会话被删除时清掉它牵涉的边（不留悬空边）',
  graphStore.getSnapshot().edges.length === 1 && graphStore.getSnapshot().edges[0].to === 'c');
graphStore.setEdges([edge('x', 'y'), edge('x', 'x'), { from: 1, to: 2 }, edge('x', 'y')]);
check('整批替换会丢掉非法项与重复项', (() => {
  const edges = graphStore.getSnapshot().edges;
  return edges.length === 1 && edges[0].from === 'x' && edges[0].to === 'y';
})());

const modeStore = graph.createViewModeStore();
check('面板默认是平铺模式', modeStore.getSnapshot().mode === graph.MODE_TILES);
modeStore.setMode('nonsense');
check('非法的模式值被忽略，不会把面板弄成空白', modeStore.getSnapshot().mode === graph.MODE_TILES);
modeStore.setMode(graph.MODE_GRAPH);
check('可以切到设计模式', modeStore.getSnapshot().mode === graph.MODE_GRAPH);

// ─────────────────── 二、远端命名空间与绑定同步 ───────────────────

const stubForRemote = createStubContext({ presets: [] });
await mod.apply(stubForRemote.ctx);
await settle();
const mounted = stubForRemote.mounted ?? [];
check('插件把 paneDispatch 命名空间挂到了远端网关上', mounted.length === 1 && mounted[0].package === '@local/dsh-split-workspaces', JSON.stringify(mounted.map((item) => item.package)));
const descriptors = mounted.length === 0 ? [] : mounted[0].descriptors;
check('命名空间只暴露 list 与 set 两个方法',
  descriptors.map((item) => item.method).sort().join(',') === 'list,set', descriptors.map((item) => item.method).join(','));
check('每个输入 codec 都是 strict（网关的硬要求）', descriptors.every((item) => item.parameters.every((param) => param.codec.mode === 'strict')));
check('每个 strict codec 都带 create() schema 工厂（注册表的硬要求）',
  descriptors.every((item) => item.parameters.every((param) => typeof param.codec.create === 'function')));

/** 假的远端命名空间：记下每次 set 的载荷，也可以让它失败。 */
function fakeService({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async list() { return { ok: true, value: { targets: [] } }; },
    async set(request) {
      calls.push(request);
      if (fail) return { ok: false, error: { code: 'gateway/internal', message: 'boom' } };
      return { ok: true, value: { ok: true, count: request.targets.length } };
    },
  };
}

const syncService = fakeService();
const sync = mods.dispatch.createDispatchSync(() => syncService);
await sync.load();
await sync.sync(new Map([['s-a', [{ id: 's-b', label: 'B' }]]]));
check('绑定表被推给宿主', syncService.calls.length === 1 && syncService.calls[0].owner === 's-a');
check('推的是完整目标集合（不做增量语义）', syncService.calls[0].targets.length === 1);

const before = syncService.calls.length;
await sync.sync(new Map([['s-a', [{ id: 's-b', label: 'B' }]]]));
check('没有变化就一个请求都不发', syncService.calls.length === before);

// 只改说明、不改目标，也必须推上去
await sync.sync(new Map([['s-a', { label: 'A', targets: [{ id: 's-b', label: 'B', note: '专做逆向' }] }]]));
check('只改说明也会推送（否则分工说明永远到不了 Host）',
  syncService.calls.length === before + 1
  && syncService.calls[syncService.calls.length - 1].targets[0].note === '专做逆向',
  JSON.stringify(syncService.calls[syncService.calls.length - 1]));

await sync.sync(new Map());
check('删光目标后会发一次空集合（否则宿主那边删不掉）', (() => {
  const last = syncService.calls[syncService.calls.length - 1];
  return last.owner === 's-a' && last.targets.length === 0;
})());

{
  /*
   * 队列抗异常：`queue = queue.then(fn)` 只要抛过一次，整条链就永久 rejected，
   * 之后画箭头全都不生效且没有任何报错。
   *
   * 注意「取服务抛异常」必须发生在**首次读取之后** —— 读取之前抛会让同步器一直停在
   * 未就绪状态（这是有意的，见上面那条用例），根本走不到队列。
   */
  let broken = false;
  const healthy = fakeService();
  const flaky = mods.dispatch.createDispatchSync(() => {
    if (broken) throw new Error('boom');
    return healthy;
  });
  await flaky.load();
  broken = true;
  const failedOnce = await flaky.sync(new Map([['s-a', { label: 'A', targets: [{ id: 's-b', label: 'B' }] }]]));
  check('取服务抛异常时如实报告失败', failedOnce.ok === false && typeof failedOnce.error === 'string');
  broken = false;
  const recovered = await flaky.sync(new Map([['s-a', { label: 'A', targets: [{ id: 's-b', label: 'B' }] }]]));
  check('一次异常不会毒化队列，后续同步照常进行', recovered.ok === true && healthy.calls.length === 1);
}

const failService = fakeService({ fail: true });
const failing = mods.dispatch.createDispatchSync(() => failService);
await failing.load();
const failed = await failing.sync(new Map([['s-a', [{ id: 's-b', label: 'B' }]]]));
check('写入失败会如实报告，而不是假装成功', failed.ok === false && typeof failed.error === 'string');
check('写入失败时界面状态变成 error', failing.getSnapshot().status === 'error');

{
  /*
   * 真机踩过：远端命名空间是异步挂载的，主面板挂载时读得太早会拿到「没挂上」，
   * 于是刷新页面后箭头全没了（Host 磁盘上明明存着）。`load()` 现在会等一会儿。
   */
  let mounted = false;
  setTimeout(() => { mounted = true; }, 120);
  const late = fakeService();
  const waiting = mods.dispatch.createDispatchSync(() => (mounted ? late : undefined));
  const loaded = await waiting.load();
  check('命名空间晚一点挂上也能读到（刷新后恢复箭头的前提）', loaded instanceof Map);
  check('等到了就正常置为 ready', waiting.getSnapshot().status === 'ready');
}

{
  // 等不到时不许假装就绪 —— 假装就绪会让「推空表把存好的树清掉」变成可能。
  const never = mods.dispatch.createDispatchSync(() => undefined);
  const loaded = await never.load();
  check('始终等不到时返回 undefined，不谎报成功', loaded === undefined);
  check('始终等不到时状态是 unavailable，且没有置成 ready',
    never.getSnapshot().status === 'unavailable');
  const deferred = await never.sync(new Map([['s-a', { label: 'A', targets: [{ id: 's-b', label: 'B' }] }]]));
  check('未就绪时同步只记期望、不发送', deferred.deferred === true);
}

const noService = mods.dispatch.createDispatchSync(() => undefined);
await noService.load();
check('Host 半边没加载时记为 unavailable，而不是 error（静默降级）', noService.getSnapshot().status === 'unavailable');

// ────────────────────────────── 三、渲染 ──────────────────────────────

const board = await renderBoard(mod, {});
const injected = board.stub.registered.find((definition) => definition.name === 'main').inject();

/** 从当前棋盘渲染树里找设计画布元素。 */
function graphBoardOf(tree) {
  const node = findAll(tree, byName('GraphBoard'))[0];
  return node === undefined ? undefined : mount(node.type, node.props);
}

const tree = board.render().tree;
const modeButtons = findAll(tree, (node) => node.props?.['aria-pressed'] !== undefined && typeof node.props.className === 'string' && node.props.className.includes('dshSplitWs_mode'));
check('顶部有两个模式按钮', modeButtons.length === 2, String(modeButtons.length));
check('默认高亮的是平铺', modeButtons[0].props['aria-pressed'] === true && modeButtons[1].props['aria-pressed'] === false);

/*
 * 「刷新 / 重启之后箭头还在」—— 这条路径以前完全没被测试覆盖过：
 * 它发生在**挂载时的 useEffect** 里，而测试替身的 useEffect 是空实现。
 *
 * 现在替身会真的执行副作用，并且 `$mount` 会把远端命名空间登记进服务表，
 * 于是这条链可以端到端跑：挂载 → load() → 读 Host 绑定表 → 反推成边。
 */
{
  const stored = {
    ok: true,
    value: {
      targets: [
        { owner: 's-a', ownerLabel: 'a', items: [{ id: 's-b', label: 'b', note: '专做逆向' }] },
      ],
    },
  };
  const host = await renderBoard(mod, {});
  host.stub.remoteHandlers.paneDispatch = {
    list: async () => stored,
    set: async () => ({ ok: true }),
  };
  ReactStub.effectsEnabled = true;
  try {
    const mounted = host.render();
    // 挂载时的 load() 是异步的：让出几轮微任务与定时器。
    await new Promise((resolve) => setTimeout(resolve, 120));
    mounted.flush();
    const restored = host.stub.registered.find((definition) => definition.name === 'main').inject().graphStore;
    check('挂载时会把 Host 上存着的箭头恢复出来',
      restored.getSnapshot().edges.length === 1
      && restored.getSnapshot().edges[0].from === 's-a'
      && restored.getSnapshot().edges[0].to === 's-b',
      JSON.stringify(restored.getSnapshot().edges));
    check('恢复出来的箭头也带着说明',
      restored.getSnapshot().edges[0].note === '专做逆向',
      JSON.stringify(restored.getSnapshot().edges[0]));
  } finally {
    ReactStub.effectsEnabled = false;
  }
}

// 切到设计模式（真实路径：点按钮 → store 变 → 重渲染）
modeButtons[1].props.onClick();
const graphTree = board.render().tree;
const graphDom = graphBoardOf(graphTree);
check('切到设计模式后渲染出画布', graphDom !== undefined);
const cards = findAll(graphDom.tree, (node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('dshSplitWs_graphCard'));
check('每个真实会话一张卡片（空白会话不算）', cards.length === 3, String(cards.length));
check('没在棋盘上打开的会话也出现（候选是全部已存在会话）',
  cards.some((card) => card.props['data-session'] === 's-c'));
check('卡片按会话 key，不是窗格 key', cards.every((card) => typeof card.props['data-session'] === 'string' && card.props['data-session'].startsWith('s-')));
check('卡片上写着工作区名与会话标题', (() => {
  const text = JSON.stringify(graphDom.tree);
  return text.includes('alpha') && text.includes('beta');
})());
check('每张卡片都有右边缘的出线端口（拖动起点）', findAll(graphDom.tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshSplitWs_graphPort')).length === 3);

// 真正加一条边（两端都是会话 id）
const graphActions = injected.graphActions;
graphActions.addEdge('s-a', 's-b');
const withEdge = graphBoardOf(board.render().tree);
const paths = findAll(withEdge.tree, (node) => node.type === 'path' && typeof node.props?.d === 'string' && node.props.d.startsWith('M '));
check('画出了一条箭头路径', paths.length === 1, String(paths.length));
check('箭头带指向目标的多边形', findAll(withEdge.tree, (node) => node.type === 'polygon').length === 1);

const editButton = findAll(withEdge.tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshSplitWs_graphEdgeEdit'))[0];
check('每条边中点有一个编辑按钮', editButton !== undefined);

/*
 * 点开编辑面板 → 写说明 → 保存。
 *
 * 这里必须**复用同一个挂载实例**：编辑器开没开是组件自己的 state，重新 mount 一次
 * 就是一份全新的 state，面板会「自己关上」—— 第一版测试这么写，于是怎么点都找不到面板。
 */
const canvas = graphBoardOf(board.render().tree);
const editButton2 = findAll(canvas.tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshSplitWs_graphEdgeEdit'))[0];
editButton2.props.onClick({ stopPropagation: () => {} });
canvas.flush();
const textarea = findAll(canvas.tree, (node) => node.type === 'textarea')[0];
check('点中点会打开说明编辑面板', textarea !== undefined);
textarea.props.onChange({ target: { value: '专做逆向分析，需要拆 EXE 时派给它' } });
canvas.flush();
const saveButton = findAll(canvas.tree, (node) => node.type === 'button' && node.children.includes('保存'))[0];
check('面板里有保存按钮', saveButton !== undefined);
saveButton.props.onClick();
check('保存后说明写进了这条边', injected.graphStore.getSnapshot().edges[0].note === '专做逆向分析，需要拆 EXE 时派给它',
  JSON.stringify(injected.graphStore.getSnapshot().edges[0]));
const withNote = graphBoardOf(board.render().tree);
check('画布上能看到这段说明', JSON.stringify(withNote.tree).includes('专做逆向分析'));

// 删除走编辑面板里的按钮
const canvas2 = graphBoardOf(board.render().tree);
const editButton3 = findAll(canvas2.tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshSplitWs_graphEdgeEdit'))[0];
editButton3.props.onClick({ stopPropagation: () => {} });
canvas2.flush();
const removeButton = findAll(canvas2.tree, (node) => node.type === 'button' && node.children.includes('删除这条关系'))[0];
check('编辑面板里能删除这条关系', removeButton !== undefined);
removeButton.props.onClick();
check('删除后边从存储里消失', injected.graphStore.getSnapshot().edges.length === 0);
const afterDelete = graphBoardOf(board.render().tree);
check('删掉之后画布上不再有箭头', afterDelete !== undefined && findAll(afterDelete.tree, (node) => node.type === 'polygon').length === 0);

// 切回平铺：布局必须一个字节都没动
const backButtons = findAll(board.render().tree, (node) => node.props?.['aria-pressed'] !== undefined && typeof node.props.className === 'string' && node.props.className.includes('dshSplitWs_mode'));
backButtons[0].props.onClick();
const tileTree = board.render().tree;
check('切回平铺后画布消失、窗格回来', graphBoardOf(tileTree) === undefined
  && findAll(tileTree, byName('PaneFrame')).length === 2);

/*
 * 关窗格**不该**动箭头 —— 节点是会话，窗口开不开与「谁能派给谁」无关。
 * 只有会话本身被删掉时，那条边才失去意义。
 */
modeButtons[1].props.onClick();
graphActions.addEdge('s-a', 's-b');
injected.paneActions.removePane('pane-2');
check('关掉窗格不会清掉委派箭头', injected.graphStore.getSnapshot().edges.length === 1);
injected.paneActions.forgetSession('s-b');
check('会话被删除时才清掉它牵涉的箭头', injected.graphStore.getSnapshot().edges.length === 0);

report();