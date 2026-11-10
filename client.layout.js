/**
 * 平铺面板的「布局持久化」纯逻辑块。
 *
 * 这一块只处理普通 JavaScript 数据：把 paneStore / graphStore / viewModeStore 的
 * 快照整理成可 JSON 化的保存结构，再在恢复时做校验、剪枝与回退。它不碰 React、
 * DOM 和 localStorage，因此可以在 Node 里直接测。
 *
 * ## 保存什么
 *
 *   - 平铺棋盘：布局树（分屏方向、层级、分隔条比例）、窗格顺序、当前焦点；
 *   - 每个窗格：工作区 id + 路径、会话 id、是否跟随最新会话、Agent 模式；
 *   - 任务分派：当时的边（含说明）和面板模式（平铺 / 设计）。
 *
 * ## 恢复时的降级
 *
 * 保存的是「过去某一刻」的界面，恢复时 Host 上的工作区/会话/模式可能已经变了。
 * 这里的原则是**只留下仍然成立的部分，绝不报错**：
 *   - 工作区不存在：先按 id 找，找不到再按路径找，还找不到就丢掉这个窗格；
 *   - 会话不存在 / 已归档 / 是子代理：窗格里的会话置空（跟随型会回退到最新会话）；
 *   - Agent 模式不存在：清空成默认；
 *   - 布局树失效或引用了不存在的窗格：剪掉无效分支，全坏了就按窗格顺序重建成一行；
 *   - 分派边的两端有会话已不存在：丢掉这条边。
 *
 * 加载方式：入口 `client.js` 通过 `require.async('./client.layout.js')` 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.layout.js',
  factory() {
    /** 保存结构版本；不认识的版本直接当“没有保存过”。 */
    const LAYOUT_VERSION = 1;
    /** 分隔条比例的静态安全边界，与 paneStore 的拖动钳制一致。 */
    const MIN_RATIO = 0.06;
    const MAX_RATIO = 0.94;
    const DEFAULT_RATIO = 0.5;
    /** 分派说明的最大长度，与 graphStore 的写入限制一致。 */
    const EDGE_NOTE_MAX = 200;

    /** 把比例钳制在安全区间；非法值回落到均分。 */
    function clampRatio(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RATIO;
      return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
    }

    /** 从 `pane-12` / `split-3` 这样的 key 里取出数字后缀；不是这个形状返回 undefined。 */
    function numericSuffix(value, prefix) {
      if (typeof value !== 'string' || !value.startsWith(prefix)) return undefined;
      const text = value.slice(prefix.length);
      if (text === '' || !/^\d+$/.test(text)) return undefined;
      return Number(text);
    }

    /** 通用的「最大数字后缀 + 1」，至少为 1。 */
    function nextNumeric(keys, prefix) {
      let max = 0;
      for (const key of keys) {
        const value = numericSuffix(key, prefix);
        if (value !== undefined && value > max) max = value;
      }
      return max + 1;
    }

    /** 取布局树里的全部分隔条 id。 */
    function collectSplitIds(node, found = []) {
      if (node === null || node === undefined || typeof node !== 'object') return found;
      if (node.type === 'split') {
        if (typeof node.id === 'string' && node.id !== '') found.push(node.id);
        collectSplitIds(node.a, found);
        collectSplitIds(node.b, found);
      }
      return found;
    }

    /** 取布局树里的全部窗格 key（按从左到右的顺序）。 */
    function collectLeafKeys(node, found = []) {
      if (node === null || node === undefined || typeof node !== 'object') return found;
      if (node.type === 'leaf') {
        if (typeof node.paneKey === 'string' && node.paneKey !== '') found.push(node.paneKey);
        return found;
      }
      if (node.type === 'split') {
        collectLeafKeys(node.a, found);
        collectLeafKeys(node.b, found);
      }
      return found;
    }

    /**
     * 校验布局树，并把无效分支剪掉。
     *
     * @param node - 保存的布局树节点。
     * @param paneKeys - 当前仍然有效的窗格 key 集合。
     * @param state - 递归共享的 `{ usedLeaves, usedSplits }`，防止重复 key/id。
     * @returns 合法节点；这个分支整个无效时返回 null。
     */
    function sanitizeLayout(node, paneKeys, state) {
      if (node === null || node === undefined || typeof node !== 'object') return null;
      if (node.type === 'leaf') {
        const key = node.paneKey;
        if (typeof key !== 'string' || key === '' || !paneKeys.has(key) || state.usedLeaves.has(key)) return null;
        state.usedLeaves.add(key);
        return { type: 'leaf', paneKey: key };
      }
      if (node.type !== 'split') return null;
      const a = sanitizeLayout(node.a, paneKeys, state);
      const b = sanitizeLayout(node.b, paneKeys, state);
      // 一半坏掉时保留另一半，让整棵树塌陷成那个子树，而不是整块丢失。
      if (a === null) return b;
      if (b === null) return a;
      let id = typeof node.id === 'string' && node.id !== '' ? node.id : '';
      if (id === '' || state.usedSplits.has(id)) {
        // 缺失或重复的 id 会破坏「拖这根分隔条」的定位，因此现场换一个。
        let suffix = state.autoSplit;
        do {
          suffix += 1;
          id = 'split-restored-' + String(suffix);
        } while (state.usedSplits.has(id));
        state.autoSplit = suffix;
      }
      state.usedSplits.add(id);
      return {
        type: 'split',
        id,
        dir: node.dir === 'col' ? 'col' : 'row',
        ratio: clampRatio(node.ratio),
        a,
        b,
      };
    }

    /** 按窗格顺序造一棵左右均分的平衡树（保存的布局完全不可用时的兜底）。 */
    function buildRowTree(keys) {
      let counter = 0;
      const build = (list) => {
        if (list.length === 1) return { type: 'leaf', paneKey: list[0] };
        const middle = Math.floor(list.length / 2);
        counter += 1;
        return {
          type: 'split',
          id: 'split-' + String(counter),
          dir: 'row',
          ratio: DEFAULT_RATIO,
          a: build(list.slice(0, middle)),
          b: build(list.slice(middle)),
        };
      };
      return build(keys);
    }

    /** 保存结构的基本形状检查：版本、窗格数组、布局对象、可选的图。 */
    function isSavedPayload(value) {
      if (value === null || value === undefined || typeof value !== 'object') return false;
      if (value.version !== LAYOUT_VERSION) return false;
      if (!Array.isArray(value.panes)) return false;
      if (value.layout !== null && typeof value.layout !== 'object') return false;
      if (value.graph !== undefined && value.graph !== null) {
        if (typeof value.graph !== 'object' || !Array.isArray(value.graph.edges)) return false;
      }
      return true;
    }

    /**
     * 把当前界面整理成保存结构。
     *
     * @param snapshot - paneStore 快照。
     * @param workspaceById - `Map<workspaceId, workspace>`。
     * @param graph - `{ edges }` 快照；传 null 表示本次没有拿到可靠的分派图，不写入 graph 字段。
     * @param mode - `tiles` / `graph`。
     * @returns 可 JSON 化的对象；什么都没有时返回 null。
     */
    function serialize(snapshot, workspaceById, graph, mode) {
      if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.panes)) return null;
      /*
       * `graph === null` 表示“这次调用没有拿到可靠的分派图”（例如 Host 绑定表还没
       * 读回来）。这时**不写 graph 字段**：恢复时就不会用一份空图去覆盖 Host 上可能
       * 还存在的旧绑定。只有确实拿到了图对象（哪怕边为空）才把图纳入快照。
       */
      const hasGraph = graph !== null && graph !== undefined && Array.isArray(graph.edges);
      const edges = hasGraph ? graph.edges : [];
      if (snapshot.panes.length === 0 && (!hasGraph || edges.length === 0)) return null;
      const panes = [];
      for (const pane of snapshot.panes) {
        if (pane === null || typeof pane !== 'object') continue;
        if (typeof pane.key !== 'string' || pane.key === '') continue;
        if (typeof pane.workspaceId !== 'string' || pane.workspaceId === '') continue;
        const workspace = typeof workspaceById?.get === 'function'
          ? workspaceById.get(pane.workspaceId)
          : workspaceById?.[pane.workspaceId];
        panes.push({
          key: pane.key,
          workspaceId: pane.workspaceId,
          workspacePath: typeof workspace?.path === 'string' ? workspace.path : '',
          sessionId: typeof pane.sessionId === 'string' && pane.sessionId !== '' ? pane.sessionId : null,
          preset: typeof pane.preset === 'string' && pane.preset !== '' ? pane.preset : null,
          follow: pane.follow === true,
        });
      }
      const payload = {
        version: LAYOUT_VERSION,
        savedAt: new Date().toISOString(),
        mode: mode === 'graph' ? 'graph' : 'tiles',
        activeKey: typeof snapshot.activeKey === 'string' ? snapshot.activeKey : null,
        panes,
        layout: snapshot.layout ?? null,
      };
      if (hasGraph) {
        payload.graph = {
          edges: edges.map((edge) => {
            if (edge === null || typeof edge !== 'object') return null;
            if (typeof edge.from !== 'string' || typeof edge.to !== 'string') return null;
            const item = { from: edge.from, to: edge.to };
            if (typeof edge.note === 'string' && edge.note !== '') item.note = edge.note;
            return item;
          }).filter((edge) => edge !== null),
        };
      }
      return payload;
    }

    /**
     * 把保存结构恢复成当前可用的快照。
     *
     * @param saved - 已解析的保存结构。
     * @param context - 恢复上下文：
     *   - `workspaces`：当前工作区数组 `[{ workspaceId, path }]`；
     *   - `isValidPaneSession(id)`：这个会话能不能放进窗格；
     *   - `isValidGraphSession(id)`：这个会话能不能作为分派图节点；
     *   - `presetIds`：当前存在的 Agent 模式 id 数组。
     * @returns `{ paneState, graph, mode }`；窗格和图都不可用时返回 null。
     *   `paneState` 为 null 表示没有可用窗格（调用方应播种默认布局）；
     *   `graph` 为 null 表示这份保存结构没有任务分派图（旧格式或保存时图还没就绪）；
     *   `mode` 是保存时的面板模式，单独恢复，不依赖图是否存在。
     */
    function restore(saved, context) {
      if (!isSavedPayload(saved)) return null;
      const workspaces = Array.isArray(context?.workspaces) ? context.workspaces : [];
      const byId = new Map();
      const byPath = new Map();
      for (const workspace of workspaces) {
        if (workspace === null || typeof workspace !== 'object') continue;
        if (typeof workspace.workspaceId === 'string' && workspace.workspaceId !== '') byId.set(workspace.workspaceId, workspace);
        if (typeof workspace.path === 'string' && workspace.path !== '') byPath.set(workspace.path, workspace);
      }
      const validPaneSession = typeof context?.isValidPaneSession === 'function' ? context.isValidPaneSession : () => true;
      const validGraphSession = typeof context?.isValidGraphSession === 'function' ? context.isValidGraphSession : () => true;
      /*
       * `presetIds` 为数组：按当前花名册校验；
       * 为 null/undefined：花名册还没就绪（调用方等超时后走这条路），保留保存时的
       * 模式 id。界面仍能显示它，用户也可以重新选；不在恢复阶段把可能有效的模式清掉。
       */
      const presetIds = Array.isArray(context?.presetIds) ? new Set(context.presetIds) : null;

      // 1. 窗格：工作区/会话/模式逐项校验，不成立就清空或丢弃这一格。
      const panes = [];
      const seenPaneKeys = new Set();
      for (const savedPane of saved.panes) {
        if (savedPane === null || typeof savedPane !== 'object') continue;
        if (typeof savedPane.key !== 'string' || savedPane.key === '' || seenPaneKeys.has(savedPane.key)) continue;
        const workspace = byId.get(savedPane.workspaceId) ?? byPath.get(savedPane.workspacePath);
        if (workspace === undefined) continue;
        seenPaneKeys.add(savedPane.key);
        const sessionId = typeof savedPane.sessionId === 'string' && savedPane.sessionId !== '' && validPaneSession(savedPane.sessionId)
          ? savedPane.sessionId
          : null;
        const preset = typeof savedPane.preset === 'string' && savedPane.preset !== '' && (presetIds === null || presetIds.has(savedPane.preset))
          ? savedPane.preset
          : null;
        panes.push({
          key: savedPane.key,
          workspaceId: workspace.workspaceId,
          sessionId,
          preset,
          follow: savedPane.follow === true,
        });
      }

      // 2. 布局：先按保存的树剪枝；完全不可用时按现有窗格顺序重建成一行。
      let paneState = null;
      let layout = null;
      if (panes.length > 0) {
        const paneKeys = new Set(panes.map((pane) => pane.key));
        layout = saved.layout === null || saved.layout === undefined
          ? null
          : sanitizeLayout(saved.layout, paneKeys, { usedLeaves: new Set(), usedSplits: new Set(), autoSplit: 0 });
        if (layout === null) layout = buildRowTree(panes.map((pane) => pane.key));
        const leaves = collectLeafKeys(layout);
        const leafSet = new Set(leaves);
        // 布局树没有覆盖到的窗格不会渲染，直接丢掉，避免“记录里存在但看不见”。
        const visiblePanes = panes.filter((pane) => leafSet.has(pane.key));
        if (visiblePanes.length > 0) {
          const activeKey = leaves.includes(saved.activeKey) ? saved.activeKey : leaves[0];
          paneState = {
            panes: visiblePanes,
            layout,
            activeKey,
            initialized: true,
            nextKey: nextNumeric(visiblePanes.map((pane) => pane.key), 'pane-'),
            nextSplit: nextNumeric(collectSplitIds(layout), 'split-'),
          };
        }
      }

      // 3. 任务分派图：只保留两端都还存在的边；环形/多上级等非法结构交给
      //    graphModel.sanitizeEdges 再处理。`null` 表示这份结构没有图，不应覆盖
      //    Host 上已有的绑定表。
      let graph = null;
      if (saved.graph !== undefined && saved.graph !== null && Array.isArray(saved.graph.edges)) {
        const edges = [];
        for (const edge of saved.graph.edges) {
          if (edge === null || typeof edge !== 'object') continue;
          if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
          if (edge.from === edge.to) continue;
          if (!validGraphSession(edge.from) || !validGraphSession(edge.to)) continue;
          const item = { from: edge.from, to: edge.to };
          if (typeof edge.note === 'string' && edge.note.trim() !== '') item.note = edge.note.trim().slice(0, EDGE_NOTE_MAX);
          edges.push(item);
        }
        graph = { edges };
      }

      if (paneState === null && graph === null) return null;
      return {
        paneState,
        graph,
        mode: saved.mode === 'graph' ? 'graph' : 'tiles',
      };
    }

    return {
      LAYOUT_VERSION,
      isSavedPayload,
      serialize,
      restore,
    };
  },
});
