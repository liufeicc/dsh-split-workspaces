/**
 * 平铺面板的「委派图」纯模型块：有向树的增删、校验、分层布局，以及「图 → 绑定」的换算。
 *
 * 这一层**不认识 React、不碰 DOM**，因此可以在 Node 里直接测（`test/graph-contract.mjs`）。
 * 视图块只负责把这里算出来的矩形画成卡片、把边画成箭头。
 *
 * ## 卡片就是会话，不是窗格
 *
 * 这一条是**改过一次**的设计决定。第一版把卡片绑在窗格 key 上，理由是「你说这一格
 * 派给那一格，指的就是屏幕上那一格」。真用起来立刻露馅：
 *
 *   - 同一个会话开在两格 → 两张卡片，连哪张都说不清；
 *   - 关掉窗格 → 关系跟着消失，可「谁能派给谁」跟窗口开没开没有关系；
 *   - 换掉某格的会话 → 关系悄悄跟到了新会话身上；
 *   - 没在棋盘上打开的会话 → 永远连不出箭头（真机上就撞了这个）。
 *
 * 所以现在**节点 = 会话 id**：箭头记的是「会话 A 可以把任务派给会话 B」，与它在哪个
 * 窗格、有没有窗格，全都无关。窗格只是这些会话的一种看法。
 *
 * 换算发生在 `bindingsFromEdges`：两端都在会话册里才成为一条绑定；两端是同一个会话、
 * 或某一端已经不在册（被删了）时，那条边不产生绑定。
 *
 * ## 为什么是「树」而不是一般的有向图
 *
 * 允许多个上级会立刻带来两个说不清的问题：C 同时归 A 和 B 管时，谁该等谁？画出来的
 * 图还叫不叫树？所以这里守两条不变量：
 *   1. **不成环**（A→B→A 没有任何意义）；
 *   2. **每个节点最多一个上级**（in-degree ≤ 1）。
 * 两条都由 `validateEdge` 在执行前拒绝，并给出可以原样展示的原因码。
 *
 * 加载方式：入口 `client.js` 用 `require.async('./client.graph.model.js')` 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.graph.model.js',
  factory() {
    /** 卡片尺寸与间距（像素）。布局与绘制共用同一份常量，避免两边算出来对不上。 */
    const CARD_W = 232;
    const CARD_H = 96;
    const GAP_X = 84;
    const GAP_Y = 22;
    const PAD = 28;

    /** 一条委派说明的最大长度（字符）。它会进工具描述，太长会把上下文吃掉。 */
    const EDGE_NOTE_MAX = 200;

    /** 两种面板模式。 */
    const MODE_TILES = 'tiles';
    const MODE_GRAPH = 'graph';

    /**
     * 面板模式的存储。
     *
     * 单独一个 store 而不是塞进 `paneStore`：模式是**看的方式**，与窗格、布局毫无关系；
     * 混在一起会让「切模式」看起来像一次布局改动，离线测试也得多铺一层。
     * 它同样放在 store 里（而不是组件 state），因为主面板切走再切回来会重新挂载 ——
     * 用 state 的话每次回来看见的都是平铺模式。
     */
    function createViewModeStore() {
      let snapshot = { mode: MODE_TILES };
      const listeners = new Set();
      const publish = (next) => {
        snapshot = next;
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        /**
         * 切换模式。
         * @param mode - `tiles` 或 `graph`；其它值忽略（不让一个手滑把面板弄成空白）。
         */
        setMode(mode) {
          if (mode !== MODE_TILES && mode !== MODE_GRAPH) return;
          if (snapshot.mode === mode) return;
          publish({ mode });
        },
      };
    }

    /**
     * 委派边的存储。
     *
     * 只存 `{ from, to }` 两个窗格 key。快照是不可变的，每次改动换一个新数组 ——
     * 与 `paneStore` 同款，React 才能靠引用变化判断要不要重画。
     */
    function createGraphStore() {
      let snapshot = { edges: [] };
      const listeners = new Set();
      const publish = (edges) => {
        snapshot = { edges };
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },

        /**
         * 加一条边。**不做校验** —— 校验在 `validateEdge`，由调用方先做。
         * 这里只保护最底线的一条：不重复、不自连。
         * @returns 是否真的加了。
         */
        addEdge(from, to) {
          if (typeof from !== 'string' || typeof to !== 'string') return false;
          if (from === to) return false;
          if (snapshot.edges.some((edge) => edge.from === from && edge.to === to)) return false;
          publish([...snapshot.edges, { from, to }]);
          return true;
        },

        /**
         * 写/清一条边的说明。
         *
         * 这段文字是**写给发起方的模型看的**：说明这个目标会话是做什么的、什么情况下
         * 该把活派给它。它会随绑定一起送到 Host，最终出现在那个会话的工具描述里
         * （见 Host 的 `dispatchDescription`）。
         *
         * @param from - 派出方会话 id。
         * @param to - 目标会话 id。
         * @param note - 说明文字；空白表示清掉。
         * @returns 是否找到并更新了那条边。
         */
        setNote(from, to, note) {
          const text = typeof note === 'string' ? note.trim().slice(0, EDGE_NOTE_MAX) : '';
          let touched = false;
          const next = snapshot.edges.map((edge) => {
            if (edge.from !== from || edge.to !== to) return edge;
            touched = true;
            if (text === '') {
              const stripped = { from: edge.from, to: edge.to };
              return stripped;
            }
            return { from: edge.from, to: edge.to, note: text };
          });
          if (!touched) return false;
          publish(next);
          return true;
        },

        /** 删一条边（按两端精确匹配）；返回是否删掉了。 */
        removeEdge(from, to) {
          const next = snapshot.edges.filter((edge) => !(edge.from === from && edge.to === to));
          if (next.length === snapshot.edges.length) return false;
          publish(next);
          return true;
        },

        /**
         * 整个替换边集合（用于从 Host 重建，或者窗格被关掉之后的清理）。
         * @param edges - 完整的新边集合；非法项被丢掉而不是让整批失败。
         */
        setEdges(edges) {
          const next = [];
          const seen = new Set();
          for (const edge of Array.isArray(edges) ? edges : []) {
            if (edge === null || typeof edge !== 'object') continue;
            if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
            if (edge.from === edge.to) continue;
            const id = edge.from + '\u0000' + edge.to;
            if (seen.has(id)) continue;
            seen.add(id);
            const item = { from: edge.from, to: edge.to };
            if (typeof edge.note === 'string' && edge.note.trim() !== '') item.note = edge.note.trim().slice(0, EDGE_NOTE_MAX);
            next.push(item);
          }
          publish(next);
        },

        /**
         * 某个会话被**删除**时，把它牵涉的边一起清掉。
         *
         * 注意与「关窗格」的区别：关窗格**不清边** —— 节点是会话，窗口关掉不影响
         * 「谁能派给谁」。只有会话本身没了，那条边才真的失去意义（留着也只是悬空）。
         * @param sessionId - 被删掉的会话 id。
         */
        removeSession(sessionId) {
          const next = snapshot.edges.filter((edge) => edge.from !== sessionId && edge.to !== sessionId);
          if (next.length === snapshot.edges.length) return;
          publish(next);
        },

        /** 某个会话作为派出方的全部目标。 */
        edgesFrom(sessionId) {
          return snapshot.edges.filter((edge) => edge.from === sessionId);
        },
      };
    }

    /**
     * 从 `start` 沿边能不能走到 `goal`（用来判环）。
     *
     * 迭代式 DFS + 已访问集合：图很小，但**绝不能递归** —— 一旦哪天真有环漏进来，
     * 递归会把面板栈打穿，而迭代式只会安安稳稳地返回 true。
     *
     * @param edges - 边数组。
     * @param start - 起点窗格 key。
     * @param goal - 要找的终点窗格 key。
     * @returns 可达为 true。
     */
    function hasPath(edges, start, goal) {
      if (start === goal) return true;
      const childrenOf = new Map();
      for (const edge of edges) {
        const list = childrenOf.get(edge.from);
        if (list === undefined) childrenOf.set(edge.from, [edge.to]);
        else list.push(edge.to);
      }
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length > 0) {
        const current = stack.pop();
        for (const next of childrenOf.get(current) ?? []) {
          if (next === goal) return true;
          if (seen.has(next)) continue;
          seen.add(next);
          stack.push(next);
        }
      }
      return false;
    }

    /**
     * 这条边能不能加。
     *
     * 四个原因码，每一个都对应一句用户能看懂的话（文案在 `client.dicts.js`）：
     *   - `self`       —— 自己派给自己；
     *   - `duplicate`  —— 这条边已经有了；
     *   - `cycle`      —— 加了会成环（对方已经能走回你自己）；
     *   - `has-parent` —— 对方已经有上级了（这是一棵树）。
     *
     * @param edges - 现有边数组。
     * @param from - 派出方窗格 key。
     * @param to - 接收方窗格 key。
     * @returns `{ ok: true }` 或 `{ ok: false, code }`。
     */
    function validateEdge(edges, from, to) {
      if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') {
        return { ok: false, code: 'invalid' };
      }
      if (from === to) return { ok: false, code: 'self' };
      if (edges.some((edge) => edge.from === from && edge.to === to)) return { ok: false, code: 'duplicate' };
      // 环：从 to 出发已经能走回 from，再连 from→to 就闭环了。
      if (hasPath(edges, to, from)) return { ok: false, code: 'cycle' };
      // 树：每个节点最多一个上级。
      if (edges.some((edge) => edge.to === to)) return { ok: false, code: 'has-parent' };
      return { ok: true };
    }

    /**
     * 一次「松手」的判定：指针落在哪张卡片上，以及这条边能不能加。
     *
     * 抽成纯函数是为了可测 —— 拖动本身是浏览器行为（`pointermove` / `pointerup`），
     * 离线测试模拟不了；但**决定的全部依据**（矩形、边集合、起点）都是数据，可以在
     * Node 里直接喂进去。视图层只负责把指针坐标算出来再调它。
     *
     * @param edges - 现有边数组。
     * @param layout - `layoutGraph` 的返回值。
     * @param fromKey - 起手那张卡片。
     * @param point - 画布坐标 `{ x, y }`。
     * @returns `{ over: null }` 表示没落在任何卡片上（什么都不做），
     *   否则 `{ over, verdict }`，`verdict` 是 `validateEdge` 的结果。
     */
    function resolveDrop(edges, layout, fromKey, point) {
      const items = layout === undefined || layout === null || !Array.isArray(layout.items) ? [] : layout.items;
      let over = null;
      for (const item of items) {
        if (point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h) {
          over = item.key;
          break;
        }
      }
      if (over === null || over === fromKey) return { over: null };
      return { over, verdict: validateEdge(edges, fromKey, over) };
    }

    /**
     * 从 Host 的绑定表反推出边（用于「刷新页面后把上次画的树恢复出来」）。
     *
     * 绑定表是 `Map<ownerId, { label, targets }>`，一条绑定就是一个 owner 指向若干目标；
     * 反过来就是若干条 `owner → target` 的边。**不需要另外存一份图** —— 绑定表本身就是
     * 那棵树，这也是当初把「边」直接定义成「授权」的好处之一。
     *
     * @param bindings - `Map<ownerId, { targets: [{ id }] }>`，可能为空。
     * @returns 边数组 `[{ from, to }]`。
     */
    function edgesFromBindings(bindings) {
      const edges = [];
      const seen = new Set();
      if (bindings === undefined || bindings === null || typeof bindings.forEach !== 'function') return edges;
      bindings.forEach((entry, ownerId) => {
        const targets = Array.isArray(entry) ? entry : (entry === undefined || entry === null ? [] : entry.targets ?? []);
        for (const item of targets) {
          if (item === undefined || item === null || typeof item.id !== 'string') continue;
          if (item.id === ownerId) continue;
          const id = ownerId + '\u0000' + item.id;
          if (seen.has(id)) continue;
          seen.add(id);
          const edge = { from: ownerId, to: item.id };
          if (typeof item.note === 'string' && item.note !== '') edge.note = item.note;
          edges.push(edge);
        }
      });
      return edges;
    }

    /**
     * 分层布局：根在左，子节点往右，同一层里按顺序往下排。
     *
     * 为什么用「最长路径分层」而不是简单 BFS 深度：树里两种分层只在链路等长时一致；
     * 一旦某个子树更深，BFS 会把浅的那个节点放得比它的下级还靠左，箭头就会往回画。
     * 取「到根的最长路径」保证每条边一定是从左指向右。
     *
     * @param edges - 边数组。
     * @param keys - 参与布局的窗格 key（顺序即同层内的初始次序）。
     * @param options - 可覆盖的尺寸常量（离线测试里用小一点的值方便断言）。
     * @returns `{ items, width, height }`，`items` 每项 `{ key, x, y, w, h, depth }`。
     */
    function layoutGraph(edges, keys, options) {
      const cardW = options?.cardW ?? CARD_W;
      const cardH = options?.cardH ?? CARD_H;
      const gapX = options?.gapX ?? GAP_X;
      const gapY = options?.gapY ?? GAP_Y;
      const pad = options?.pad ?? PAD;
      const present = Array.isArray(keys) ? keys.filter((key) => typeof key === 'string') : [];
      const keySet = new Set(present);
      const usable = (Array.isArray(edges) ? edges : [])
        .filter((edge) => keySet.has(edge.from) && keySet.has(edge.to) && edge.from !== edge.to);
      // 最长路径分层：反复松弛，轮数上限 = 节点数（有环也一定会停）。
      const depth = new Map(present.map((key) => [key, 0]));
      for (let round = 0; round < present.length; round += 1) {
        let changed = false;
        for (const edge of usable) {
          const candidate = (depth.get(edge.from) ?? 0) + 1;
          if (candidate > (depth.get(edge.to) ?? 0)) {
            depth.set(edge.to, candidate);
            changed = true;
          }
        }
        if (!changed) break;
      }
      // 同层排序：先按「上级在本层里的次序」，再按传入顺序 —— 一棵子树因此聚在一起。
      const parentOf = new Map();
      for (const edge of usable) if (!parentOf.has(edge.to)) parentOf.set(edge.to, edge.from);
      const orderIndex = new Map(present.map((key, index) => [key, index]));
      const columns = new Map();
      for (const key of present) {
        const level = depth.get(key) ?? 0;
        const column = columns.get(level);
        if (column === undefined) columns.set(level, [key]);
        else column.push(key);
      }
      const columnOrder = [...columns.keys()].sort((a, b) => a - b);
      const placed = new Map();
      const items = [];
      for (const level of columnOrder) {
        const column = columns.get(level);
        column.sort((a, b) => {
          const pa = parentOf.get(a);
          const pb = parentOf.get(b);
          const ra = pa === undefined ? Number.MAX_SAFE_INTEGER : (placed.get(pa) ?? orderIndex.get(pa) ?? 0);
          const rb = pb === undefined ? Number.MAX_SAFE_INTEGER : (placed.get(pb) ?? orderIndex.get(pb) ?? 0);
          if (ra !== rb) return ra - rb;
          return (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0);
        });
        column.forEach((key, index) => {
          placed.set(key, index);
          items.push({
            key,
            x: pad + level * (cardW + gapX),
            y: pad + index * (cardH + gapY),
            w: cardW,
            h: cardH,
            depth: level,
          });
        });
      }
      const maxColumn = columnOrder.length === 0 ? 0 : (columnOrder[columnOrder.length - 1] + 1);
      const tallest = Math.max(0, ...columnOrder.map((level) => (columns.get(level) ?? []).length));
      return {
        items,
        width: pad * 2 + (maxColumn === 0 ? cardW : maxColumn * cardW + (maxColumn - 1) * gapX),
        height: pad * 2 + (tallest === 0 ? cardH : tallest * cardH + (tallest - 1) * gapY),
      };
    }

    /**
     * 把图换算成 Host 需要的那张绑定表：`ownerSessionId → [{ id, label }]`。
     *
     * 三道过滤，任何一道不过就跳过这条边（**不报错**）：
     *   1. 两端都得解析出会话（还没选会话的窗格解析不出来）；
     *   2. 两端不能是同一个会话（两个窗格显示同一段对话时，自己派给自己没有意义）；
     *   3. 同一个 owner 下不重复。
     *
     * @param edges - 边数组。
     * @param describe - `(paneKey) => { sessionId, label } | null`，由视图层按当前
     *   会话表算好传进来（它最清楚每一格此刻挂着哪个会话）。
     * @returns `Map<ownerSessionId, Array<{ id, label }>>`。
     */
    function bindingsFromEdges(edges, describe) {
      const byOwner = new Map();
      for (const edge of Array.isArray(edges) ? edges : []) {
        const source = describe(edge.from);
        const target = describe(edge.to);
        // 两端都得在会话册里；某一端已被删除时这条边不产生绑定（界面上会由调用方清掉）。
        if (source === null || source === undefined || target === null || target === undefined) continue;
        if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
        if (edge.from === edge.to) continue;
        const entry = byOwner.get(edge.from) ?? {
          // 派出方自己的名字也要带上：Host 只在错误信息里点名它，自己查不到会话标题。
          label: source.label === undefined ? edge.from : source.label,
          targets: [],
        };
        if (entry.targets.some((item) => item.id === edge.to)) continue;
        const target_ = { id: edge.to, label: target.label === undefined ? edge.to : target.label };
        // 说明随绑定一起上送：Host 用它生成那个会话的工具描述。
        if (typeof edge.note === 'string' && edge.note !== '') target_.note = edge.note;
        entry.targets.push(target_);
        byOwner.set(edge.from, entry);
      }
      return byOwner;
    }

    return {
      CARD_W,
      CARD_H,
      GAP_X,
      GAP_Y,
      PAD,
      EDGE_NOTE_MAX,
      MODE_TILES,
      MODE_GRAPH,
      createViewModeStore,
      createGraphStore,
      hasPath,
      validateEdge,
      resolveDrop,
      edgesFromBindings,
      layoutGraph,
      bindingsFromEdges,
    };
  },
});