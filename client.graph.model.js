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

    /**
     * 两棵独立的委派树之间的垂直间距。
     *
     * 必须比同一棵树内部的行距（`GAP_Y`）明显大：否则第二棵树的根看起来像第一棵树的
     * 下一行子节点，用户会把两棵树读成一棵。现在每棵树都作为一个**整体块**堆叠，
     * 这条间距就是块与块之间的分隔。
     */
    const TREE_GAP = 56;

    /**
     * 文本排序器。
     *
     * 「按字母排序」在中文环境里就是按拼音（浏览器/Node 的 ICU 会处理），数字按
     * `numeric` 排（`session 2` 在 `session 10` 前面）。环境没有完整 ICU 时退回
     * 逐字符比较 —— 排序结果可能不理想，但绝不能因此让整个画布挂掉。
     */
    const textCollator = (() => {
      try {
        return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
      } catch {
        return null;
      }
    })();

    /**
     * 比较两个显示名。
     *
     * 空值统一当成空串（否则 `undefined` 会把排序器弄乱）；完全相同时返回 0，调用方
     * 再按 key 兜底排序，保证同一份数据每次算出来的顺序一致。
     */
    function compareText(left, right) {
      const a = left === undefined || left === null ? '' : String(left);
      const b = right === undefined || right === null ? '' : String(right);
      if (a === b) return 0;
      if (textCollator !== null) return textCollator.compare(a, b);
      return a < b ? -1 : 1;
    }

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
     * ## 多棵树必须整块堆叠
     *
     * 画布上可以同时存在多棵互不相连的树。早期实现把所有节点按「深度」放进同一批
     * 列里，于是第二棵树的根会和第一棵树的子节点落在相邻行，两棵树的箭头与说明
     * 交缠在一起，根本看不清哪条线属于哪棵树。
     *
     * 现在先按连通分量把森林拆成若干棵树，**每棵树单独布局**，再按根的出现顺序把
     * 整块垂直堆叠，块与块之间留 `TREE_GAP`。这样第二棵树的所有节点都在第一棵树
     * 的最底边之下，不会再穿插。
     *
     * @param edges - 边数组。
     * @param keys - 参与布局的会话 key（顺序即根与同层内的初始次序）。
     * @param options - 可覆盖的尺寸常量（离线测试里用小一点的值方便断言），
     *   其中 `treeGap` 覆盖两棵树之间的间距。
     * @returns `{ items, width, height }`，`items` 每项 `{ key, x, y, w, h, depth }`。
     */
    function layoutGraph(edges, keys, options) {
      const cardW = options?.cardW ?? CARD_W;
      const cardH = options?.cardH ?? CARD_H;
      const gapX = options?.gapX ?? GAP_X;
      const gapY = options?.gapY ?? GAP_Y;
      const pad = options?.pad ?? PAD;
      const treeGap = options?.treeGap ?? TREE_GAP;
      // 去重：同一个 key 进来两次只画一张卡片，否则两张卡片会完全重叠。
      const present = [];
      const presentSet = new Set();
      for (const key of Array.isArray(keys) ? keys : []) {
        if (typeof key !== 'string' || presentSet.has(key)) continue;
        presentSet.add(key);
        present.push(key);
      }
      const keySet = new Set(present);
      const usable = (Array.isArray(edges) ? edges : [])
        .filter((edge) => keySet.has(edge.from) && keySet.has(edge.to) && edge.from !== edge.to);
      const orderIndex = new Map(present.map((key, index) => [key, index]));

      /*
       * 先按连通分量拆森林。
       *
       * 合法数据里每个节点最多一个上级，所以「没有入边的节点」就是每棵树的根；
       * 从根做一次 DFS 就收集到整棵树。环上的节点没有根可达（数据异常时才会出现），
       * 兜底再按 present 顺序收一遍，保证不会漏画卡片。
       */
      const parentOf = new Map();
      const childrenOf = new Map();
      for (const edge of usable) {
        if (!parentOf.has(edge.to)) parentOf.set(edge.to, edge.from);
        const children = childrenOf.get(edge.from);
        if (children === undefined) childrenOf.set(edge.from, [edge.to]);
        else children.push(edge.to);
      }
      const visited = new Set();
      const components = [];
      const collect = (root) => {
        const component = [];
        const stack = [root];
        visited.add(root);
        while (stack.length > 0) {
          const current = stack.pop();
          component.push(current);
          for (const child of childrenOf.get(current) ?? []) {
            if (visited.has(child)) continue;
            visited.add(child);
            stack.push(child);
          }
        }
        components.push(component);
      };
      for (const key of present) if (!parentOf.has(key) && !visited.has(key)) collect(key);
      for (const key of present) if (!visited.has(key)) collect(key);

      const items = [];
      let cursor = 0;
      let maxWidth = 0;
      for (const component of components) {
        const componentSet = new Set(component);
        const componentEdges = usable.filter((edge) => componentSet.has(edge.from) && componentSet.has(edge.to));
        const componentParent = new Map();
        for (const edge of componentEdges) if (!componentParent.has(edge.to)) componentParent.set(edge.to, edge.from);

        // 最长路径分层：只在这棵树内部松弛。
        const depth = new Map(component.map((key) => [key, 0]));
        for (let round = 0; round < component.length; round += 1) {
          let changed = false;
          for (const edge of componentEdges) {
            const candidate = (depth.get(edge.from) ?? 0) + 1;
            if (candidate > (depth.get(edge.to) ?? 0)) {
              depth.set(edge.to, candidate);
              changed = true;
            }
          }
          if (!changed) break;
        }

        const columns = new Map();
        for (const key of component) {
          const level = depth.get(key) ?? 0;
          const column = columns.get(level);
          if (column === undefined) columns.set(level, [key]);
          else column.push(key);
        }
        const columnOrder = [...columns.keys()].sort((a, b) => a - b);
        const placed = new Map();
        for (const level of columnOrder) {
          const column = columns.get(level);
          column.sort((a, b) => {
            const pa = componentParent.get(a);
            const pb = componentParent.get(b);
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
              // cursor 是这棵树在整块画布里的顶部偏移；块内仍然从 pad 开始。
              y: pad + cursor + index * (cardH + gapY),
              w: cardW,
              h: cardH,
              depth: level,
            });
          });
        }

        const maxColumn = columnOrder.length === 0 ? 0 : (columnOrder[columnOrder.length - 1] + 1);
        const tallest = Math.max(0, ...columnOrder.map((level) => (columns.get(level) ?? []).length));
        const width = maxColumn === 0 ? cardW : maxColumn * cardW + (maxColumn - 1) * gapX;
        const height = tallest === 0 ? cardH : tallest * cardH + (tallest - 1) * gapY;
        maxWidth = Math.max(maxWidth, width);
        cursor += height + treeGap;
      }

      // cursor 在最后一棵树后面多留了一个 treeGap，减掉；没有任何树时用单卡高度兜底。
      const stackedHeight = components.length === 0 ? 0 : cursor - treeGap;
      return {
        items,
        width: pad * 2 + (maxWidth === 0 ? cardW : maxWidth),
        height: pad * 2 + (stackedHeight === 0 ? cardH : stackedHeight),
      };
    }

    /**
     * 把**还没连线**的会话卡片按工作区分组，供左侧花名册展示。
     *
     * 分组的动机很具体：任务分派列出的是全部已存在的会话，工作区一多、会话一多，
     * 「哪张卡片属于哪个工作区」只能靠卡片左上角那行小字去认，找起来很费劲。
     * 分组之后，每个工作区有一行标题，组内按会话名排序，找目标变成两级定位。
     *
     * ## 排序规则（都是「按字母」）
     *
     *   - **组之间**：按工作区显示名排；名字相同时按工作区 key 兜底。
     *   - **组内**：按会话显示名排；名字相同时按会话 id 兜底。
     *   - **不属于任何工作区的会话**（工作区被删了、会话还留着）固定排在最后：
     *     它们不是用户可以「去那个工作区找」的东西，混在字母序中间只会碍事。
     *
     * 返回的 `items` 是会话 id 数组；视图层只负责把 id 映射回卡片。
     *
     * @param cards - 候选卡片数组，每项 `{ key, label, workspaceKey, workspaceTitle }`。
     * @param options.unknownLabel - 「未归属工作区」的本地化显示名。
     * @returns `[{ key, label, items: [sessionId] }]`。
     */
    function groupSessionsByWorkspace(cards, options) {
      const unknownLabel = options?.unknownLabel ?? '';
      const groups = new Map();
      for (const card of Array.isArray(cards) ? cards : []) {
        if (card === null || typeof card !== 'object') continue;
        if (typeof card.key !== 'string' || card.key === '') continue;
        const hasWorkspace = typeof card.workspaceKey === 'string' && card.workspaceKey !== '';
        const groupKey = hasWorkspace ? card.workspaceKey : '';
        const groupLabel = hasWorkspace
          ? (typeof card.workspaceTitle === 'string' && card.workspaceTitle !== '' ? card.workspaceTitle : card.workspaceKey)
          : unknownLabel;
        const entry = groups.get(groupKey);
        if (entry === undefined) {
          groups.set(groupKey, { key: groupKey, label: groupLabel, cards: [card] });
        } else {
          // 同一工作区的卡片可能来自不同的会话行，标题以第一个非空的为准。
          if (entry.label === '' && groupLabel !== '') entry.label = groupLabel;
          entry.cards.push(card);
        }
      }
      const ordered = [...groups.values()];
      ordered.sort((left, right) => {
        // 未归属组固定垫底，不参与字母序。
        const leftOrphan = left.key === '';
        const rightOrphan = right.key === '';
        if (leftOrphan !== rightOrphan) return leftOrphan ? 1 : -1;
        return compareText(left.label, right.label) || compareText(left.key, right.key);
      });
      return ordered.map((group) => {
        const rows = [...group.cards];
        rows.sort((left, right) => compareText(left.label, right.label) || compareText(left.key, right.key));
        return { key: group.key, label: group.label, items: rows.map((card) => card.key) };
      });
    }

    /**
     * 整块画布的布局：左边一列是**用户从选择器拖进来的待连线会话**，右边是已经连成树的会话。
     *
     * 为什么待连线会话单独占一列：画布不再平铺全部会话（那样会话一多就没法找），
     * 用户先在左侧选择器里选好，再把卡片拖进来。拖进来的卡片先停在左列等连线，
     * 连上箭头之后才进入右侧的树。这样一眼就能分清：
     * **左列 = 还没连线的卡片，右侧 = 已经连好的树**。
     *
     * 树的内部布局完全复用 `layoutGraph`：整体水平平移一列，根仍在左、子仍往右，
     * 卡片与箭头的样子都不变。没有待连线卡片时，平移量为 0，画布与以前一模一样。
     *
     * @param edges - 已连接的边数组。
     * @param treeKeys - 树上会话的 key（顺序决定同层内的初始次序）。
     * @param stagedKeys - 已拖入画布、但还没连线的会话 key（按拖入顺序）。
     * @param options - 可覆盖的尺寸常量（离线测试里用小的值方便断言）。
     * @returns `{ items, width, height }`，`items` 每项 `{ key, x, y, w, h, depth, staged? }`。
     */
    function layoutGraphWithStaged(edges, treeKeys, stagedKeys, options) {
      const cardW = options?.cardW ?? CARD_W;
      const cardH = options?.cardH ?? CARD_H;
      const gapX = options?.gapX ?? GAP_X;
      const gapY = options?.gapY ?? GAP_Y;
      const pad = options?.pad ?? PAD;

      const tree = layoutGraph(edges, treeKeys, options);
      /*
       * 待连线卡片去重，并且不能与树上的会话重复：
       * 已连接的卡片由树来画，若它同时还在待连线表里，同一张卡片会被画两遍，
       * 其中一份还会停在旧位置。
       */
      const seen = new Set(tree.items.map((item) => item.key));
      const staged = [];
      for (const key of Array.isArray(stagedKeys) ? stagedKeys : []) {
        if (typeof key !== 'string' || key === '' || seen.has(key)) continue;
        seen.add(key);
        staged.push(key);
      }
      // 没有待连线卡片：完全退回原来的树布局，绝不因为多了这一层而改动老画面。
      if (staged.length === 0) {
        return { items: tree.items, width: tree.width, height: tree.height };
      }

      const items = [];
      let y = pad;
      staged.forEach((key, index) => {
        items.push({ key, x: pad, y, w: cardW, h: cardH, depth: 0, staged: true });
        y += cardH;
        if (index < staged.length - 1) y += gapY;
      });
      const stagedHeight = y + pad;

      let width;
      let height;
      if (tree.items.length > 0) {
        // 树的左边缘让出一列（卡片宽 + 列间距），待连线列自己占最左边一列。
        const shift = cardW + gapX;
        for (const item of tree.items) {
          items.push({ ...item, x: item.x + shift });
        }
        width = tree.width + shift;
        height = Math.max(tree.height, stagedHeight);
      } else {
        // 画布上只有待连线卡片：只剩左列，不要再留一列空白。
        width = pad * 2 + cardW;
        height = stagedHeight;
      }
      return { items, width, height };
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

    /**
     * 把一批“可能是坏数据”的边清洗成当前可用的树。
     *
     * 恢复保存的布局时必须走这里：保存的图可能引用了已经删除的会话，也可能是旧版本/
     * 手改过的 JSON（成环、同一目标多个上级、自连）。逐条按 `validateEdge` 接纳，
     * 保留下来的就是一棵合法的有向树；坏边丢掉而不是让恢复整体失败。
     *
     * @param edges - 待清洗的边数组。
     * @param isNode - 可选：这个会话 id 当前是否仍然存在。
     * @returns 新的合法边数组（深拷贝，保留说明文字）。
     */
    function sanitizeEdges(edges, isNode) {
      const next = [];
      const validNode = typeof isNode === 'function' ? isNode : () => true;
      for (const edge of Array.isArray(edges) ? edges : []) {
        if (edge === null || typeof edge !== 'object') continue;
        if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
        if (edge.from === '' || edge.to === '') continue;
        if (!validNode(edge.from) || !validNode(edge.to)) continue;
        if (!validateEdge(next, edge.from, edge.to).ok) continue;
        const item = { from: edge.from, to: edge.to };
        if (typeof edge.note === 'string' && edge.note.trim() !== '') item.note = edge.note.trim().slice(0, EDGE_NOTE_MAX);
        next.push(item);
      }
      return next;
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
      sanitizeEdges,
      resolveDrop,
      edgesFromBindings,
      groupSessionsByWorkspace,
      layoutGraph,
      layoutGraphWithStaged,
      bindingsFromEdges,
    };
  },
});