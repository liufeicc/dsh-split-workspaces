/**
 * 离线契约测试：任务分派画布上**没连线的卡片**（`staged`）必须能保存与恢复。
 *
 * 这条链路在 `client.layout.js` / `client.view.js` 里本来就有；这里专门盯住一个
 * 会让它悄悄失效的边界：
 *
 *   > 同一个工作区里有多张普通空白会话时，`graphCards` 只保留最新的一张。
 *
 * 如果用户先把旧的那张拖进画布，再新建一张空白会话，旧卡片就会被「空白名额」过滤掉：
 * 画布上少一张卡、保存时也会丢。修复后，**已经进入 `stagedSessions` 的会话不受名额
 * 限制**；保存也只按「会话是否真实存在」过滤，不看显示层。
 *
 * 覆盖：
 *   1. 组件层：同工作区两张空白会话，旧的那张加入画布后仍然出现在画布上；
 *   2. 保存层：点右上角「保存」后，`graph.staged` 里确实有它；
 *   3. 恢复层：刷新（从保存结构恢复）后它还在画布上；
 *   4. 纯逻辑：`serialize`/`restore` 对 `staged` 的原样保留（含坏值清洗）。
 *
 * 跑法：`node test/staged-save-contract.mjs`
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReactStub, byName, findAll, loadBundle, mount, settle } from './harness.mjs';
import { check, report, renderBoard } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;
const layout = mods.layout;

/** 同一工作区里比 `s-blank` 更旧的第二张普通空白会话。 */
const OLD_BLANK = {
  id: 's-blank-old',
  displayTitle: 'alpha',
  blank: true,
  origin: 'user',
  updatedAt: 1,
  retainedBy: {},
  projectionValues: {},
};

/**
 * 测试台里的组件树是「元素树」：`GraphBoard` 在父组件的树里只占一个元素，children
 * 要 mount 之后才会渲染。所以查卡片/选择器项之前先把它真正渲染出来。
 */
const graphDomOf = (tree) => {
  const node = findAll(tree, byName('GraphBoard'))[0];
  return node === undefined ? undefined : mount(node.type, node.props);
};

const cardsOf = (tree, sessionId) => findAll(tree, (node) => (
  typeof node.props?.className === 'string'
  && node.props.className.split(' ').includes('dshSplitWs_graphCard')
  && node.props['data-session'] === sessionId
));

// ───────────────────────── 一、纯逻辑：staged 原样保存/恢复 ─────────────────────────

{
  const payload = layout.serialize(null, new Map(), {
    edges: [],
    staged: ['s-a', 's-a', '', null, 's-b'],
  }, { scope: 'graph' });
  check('未连线节点写进 graph.staged（去重、丢掉坏值）',
    payload !== null
    && JSON.stringify(payload.graph.staged) === JSON.stringify(['s-a', 's-b']),
    JSON.stringify(payload?.graph));

  const restored = layout.restore(payload, {
    workspaces: [],
    isValidGraphSession: (id) => id === 's-a',
    presetIds: [],
  });
  check('恢复时只留下仍在册的未连线节点',
    restored !== null
    && Array.isArray(restored.graph.staged)
    && JSON.stringify(restored.graph.staged) === JSON.stringify(['s-a']),
    JSON.stringify(restored?.graph));
}

{
  // 平铺模式保存只写棋盘，但必须把上一次保存的 staged 一起带上，不能清空。
  const previous = layout.serialize(null, new Map(), { edges: [], staged: ['s-a'] }, { scope: 'graph' });
  const tiles = layout.serialize(
    {
      panes: [{ key: 'pane-1', workspaceId: 'ws-a', sessionId: null, preset: null, follow: true }],
      layout: { type: 'leaf', paneKey: 'pane-1' },
      activeKey: 'pane-1',
    },
    new Map([['ws-a', { workspaceId: 'ws-a', path: '/tmp/a' }]]),
    null,
    { scope: 'tiles', previous },
  );
  check('平铺模式保存会带上一次保存的未连线节点',
    tiles !== null && Array.isArray(tiles.graph?.staged) && tiles.graph.staged[0] === 's-a',
    JSON.stringify(tiles?.graph));
}

// ───────────────────────── 二、组件层：空白名额不该吃掉画布上的卡片 ─────────────────────────

ReactStub.effectsEnabled = true;
/*
 * 组件在任务分派模式下会挂 1.5s 的状态轮询与 window 级拖动监听。离线测试没有浏览器
 * 全局对象，这里补一个最小 `window`：定时器用 Node 的（unref 掉，别把进程挂住），
 * 事件监听是空实现。测试结束删掉。
 */
const fakeWindow = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer),
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.window = fakeWindow;
try {
  let written = null;
  const board = await renderBoard(mod, {
    extraSessions: [{ workspaceId: 'ws-a', session: OLD_BLANK }],
    remoteHandlers: {
      paneDispatch: {
        list: async () => ({ ok: true, value: { targets: [] } }),
        readLayout: async () => ({ ok: true, value: null }),
        writeLayout: async ({ layout: payload }) => {
          written = payload;
          return { ok: true, value: { ok: true } };
        },
        readStates: async () => ({ ok: true, value: { states: {} } }),
        listTargets: async () => ({ ok: true, value: { targets: [] } }),
      },
    },
  });

  const panel = board.render();
  await settle();
  panel.flush();

  // 切到任务分派模式（真实路径：点模式按钮 → store 变 → flush 重新读快照）。
  const modeButton = findAll(panel.tree, (node) => node.type === 'button' && node.children.includes('任务分派'))[0];
  check('面板上有「任务分派」模式按钮', modeButton !== undefined);
  modeButton.props.onClick();
  // 模式 store 不是 React state（替身不订阅），要显式重渲染才能读到新快照。
  panel.render();

  const graphBoard = findAll(panel.tree, byName('GraphBoard'))[0];
  check('切到任务分派后渲染出画布', graphBoard !== undefined);

  /*
   * 关键场景：旧空白会话在 `graphCards` 里本来会被「同工作区留最新一张」过滤掉。
   * 修复前 `stageSession` 用 `graphCardById` 判断，会直接拒绝；修复后按会话表判断，
   * 允许它进画布，并且 `graphCards` 会因为它已在 `stagedSessions` 而保留它。
   */
  graphBoard.props.actions.stageSession('s-blank-old');
  panel.flush();
  await settle();
  panel.flush();

  const freshBoard = findAll(panel.tree, byName('GraphBoard'))[0];
  const freshGraph = graphDomOf(panel.tree);
  check('同一工作区有更新的空白会话时，旧空白卡片加入画布后仍然显示',
    freshGraph !== undefined
    && cardsOf(freshGraph.tree, 's-blank-old').length === 1
    && cardsOf(freshGraph.tree, 's-blank-old')[0].props['data-staged'] === 'true',
    JSON.stringify(cardsOf(freshGraph.tree, 's-blank-old').map((card) => card.props['data-session'])));
  check('加入画布后它从左侧选择器消失',
    !freshBoard.props.pickerGroups.some((group) => group.items.some((item) => item.key === 's-blank-old')));

  // 等保存按钮可用（dispatch 绑定表读回 + 图快照就绪），再点真实按钮。
  let saveButton = findAll(panel.tree, (node) => node.props?.['data-action'] === 'save-layout')[0];
  for (let attempt = 0; attempt < 20 && (saveButton === undefined || saveButton.props.disabled === true); attempt += 1) {
    await settle();
    panel.flush();
    saveButton = findAll(panel.tree, (node) => node.props?.['data-action'] === 'save-layout')[0];
  }
  check('保存按钮可用', saveButton !== undefined && saveButton.props.disabled !== true);
  saveButton.props.onClick();
  for (let attempt = 0; attempt < 30 && written === null; attempt += 1) {
    await settle();
    panel.flush();
  }
  check('点保存后写出的结构里有这张未连线卡片',
    written !== null
    && written.graph !== undefined
    && Array.isArray(written.graph.staged)
    && written.graph.staged.includes('s-blank-old'),
    JSON.stringify(written?.graph));

  // 刷新（从保存结构恢复）后它还在。
  const restored = board.injected.paneActions.restoreSavedLayout({
    workspaces: [
      { workspaceId: 'ws-a', path: '/tmp/alpha' },
      { workspaceId: 'ws-b', path: '/tmp/beta' },
      { workspaceId: 'ws-c', path: '/tmp/gamma' },
    ],
    isValidPaneSession: () => true,
    isValidGraphSession: () => true,
    presetIds: [],
  });
  check('恢复结构里带回这张未连线卡片',
    restored.graph === true && Array.isArray(restored.staged) && restored.staged.includes('s-blank-old'),
    JSON.stringify(restored.staged));

  /*
   * 模拟一次真正的「刷新」：用一个**新的**插件实例（新的 paneStore/graphStore）
   * 启动，并让 Host 返回刚写出的布局。只重新 mount 组件不够 —— 恢复流程只在
   * 棋盘还没就位时跑，共享的旧 store 已经 initialized 了。
   */
  const board2 = await renderBoard(mod, {
    preloadPanes: false,
    extraSessions: [{ workspaceId: 'ws-a', session: OLD_BLANK }],
    remoteHandlers: {
      paneDispatch: {
        list: async () => ({ ok: true, value: { targets: [] } }),
        readLayout: async () => ({ ok: true, value: written }),
        writeLayout: async () => ({ ok: true, value: { ok: true } }),
        readStates: async () => ({ ok: true, value: { states: {} } }),
        listTargets: async () => ({ ok: true, value: { targets: [] } }),
      },
    },
  });
  const restoredPanel = board2.render();
  let restoredGraph;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await settle();
    restoredPanel.flush();
    const restoredMode = findAll(restoredPanel.tree, (node) => node.type === 'button' && node.children.includes('任务分派'))[0];
    if (restoredMode !== undefined && restoredMode.props['aria-pressed'] !== true) {
      restoredMode.props.onClick();
      restoredPanel.render();
    }
    restoredPanel.flush();
    restoredGraph = graphDomOf(restoredPanel.tree);
    if (restoredGraph !== undefined && cardsOf(restoredGraph.tree, 's-blank-old').length === 1) break;
  }
  check('刷新（新实例 + Host 返回保存结构）后旧的空白卡片重新出现在画布上',
    restoredGraph !== undefined && cardsOf(restoredGraph.tree, 's-blank-old').length === 1,
    JSON.stringify(cardsOf(restoredGraph?.tree, 's-blank-old').map((card) => card.props['data-session'])));
} finally {
  ReactStub.effectsEnabled = false;
}

report();
