/**
 * 平铺面板的模型块：布局树、面板存储、「窗格显示哪个会话」的判定，
 * 以及分屏菜单第二步用的候选工作区。
 *
 * 这一块是纯逻辑，不依赖 React，也不碰 DOM，因此可以在 Node 里直接测。
 *
 * ## 布局树
 * 整块棋盘用一棵二叉树描述：
 *   - `leaf`：放一个窗格（`paneKey`）；
 *   - `split`：由一条分隔条分成两块，`dir` 为 `row` 时两块左右并排、分隔条左右拖，
 *     为 `col` 时两块上下叠放、分隔条上下拖；`ratio` 是 A 块占的比例。
 * 每次修改都返回新树，且未改动的子树保持同一个对象（结构共享），这样 React
 * 重新渲染时不必要的分支不会变化。
 *
 * 加载方式：入口 `client.js` 通过 `require.async('./client.model.js')` 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.model.js',
  factory() {
    /** 会话引用的来源标记，用于 `sessions.retain` 记账。 */
    const SESSION_SOURCE = 'splitWorkspaces';
    /** 拖动时任一窗格至少要留住的最小宽度（像素）。 */
    const SPLIT_MIN_PX = 160;
    /** 无论指针怎么拖，比例都不会越过的静态边界。 */
    const SPLIT_MIN_RATIO = 0.06;
    const SPLIT_MAX_RATIO = 0.94;
    /** 新建或均分时分隔条回到的位置。 */
    const SPLIT_EVEN_RATIO = 0.5;

    /** 四个分屏方向，菜单按这个顺序排列。 */
    const SPLIT_DIRECTIONS = ['left', 'right', 'up', 'down'];

    /**
     * 方向 → 「分割轴 + 新窗格放哪一侧」。
     *
     * 布局树只能把一个**叶子**切成两半，新的一半永远是一个新叶子。因此只支持
     * 「向右 / 向下」时，像「上面两个并排、下面一个」这种「复合块在上、叶子在下」
     * 的结构是造不出来的（复合块只能出现在后一侧）。补上 left / up 之后，
     * 任意二分树排列都能拼出来，例如 [A|B] 在上、C 在下：
     * 先把 A 向下分成 [A/C]，再把 A 向右分成 [[A|B]/C]。
     *
     * `row` / `col` 是只给轴的旧写法，等价于 `right` / `down`，保留兼容。
     */
    const SPLIT_PLACEMENTS = {
      left: { dir: 'row', newFirst: true },
      right: { dir: 'row', newFirst: false },
      up: { dir: 'col', newFirst: true },
      down: { dir: 'col', newFirst: false },
      row: { dir: 'row', newFirst: false },
      col: { dir: 'col', newFirst: false },
    };

    /** 把任意方向收敛成一个合法布置；不认识的方向按「向右」处理。 */
    function splitPlacement(direction) {
      return SPLIT_PLACEMENTS[direction] ?? SPLIT_PLACEMENTS.right;
    }

    /**
     * 分屏菜单第二步的候选工作区 —— 「先选方向，再选往新窗格里放哪个工作区」。
     *
     * 返回**全部**工作区，但把「还没铺开」的排在前面（分屏的第一意图就是再摊开
     * 一个工作区），已经铺在别的窗格里的排在后面并把 `open` 标出来，菜单据此显示
     * 「已打开」。保留已铺开的工作区是有意的：同一个工作区开两格看两个会话是合理
     * 用法，而且所有工作区都铺开之后，分屏菜单仍然有别的工作区可选。
     *
     * `Array.prototype.sort` 是稳定的，因此两组内部都保持 Host 给的工作区顺序。
     *
     * @param items - 工作区列表（`workspaces.list` 快照的 `items`）。
     * @param openWorkspaceIds - 已经铺在棋盘上的工作区 id。
     */
    function splitCandidates(items, openWorkspaceIds) {
      const open = new Set(openWorkspaceIds ?? []);
      return items
        .map((item) => ({
          workspaceId: item.workspaceId,
          title: item.title,
          path: item.path,
          open: open.has(item.workspaceId),
        }))
        .sort((left, right) => Number(left.open) - Number(right.open));
    }

    /**
     * 「还没铺在棋盘上」的工作区 —— 面板顶部「添加工作区」与窗格标题栏「替换工作区」
     * 共用同一份候选。
     *
     * 两处刻意用同一份：这两个动作的意图都是「让一个**新**工作区出现在棋盘上」，
     * 只是一个接在右边、一个替掉现有的一格。已经铺开的工作区因此都不在候选里 ——
     * 想把已经铺开的两个工作区对调，用「拖动标题栏交换位置」那条路（它不重开对话）。
     *
     * 保持 Host 给的顺序（`filter` 是稳定的），于是菜单里的排列与侧边栏一致。
     *
     * @param items - 工作区列表（`workspaces.list` 快照的 `items`）。
     * @param openWorkspaceIds - 已经铺在棋盘上的工作区 id。
     */
    function unopenedWorkspaces(items, openWorkspaceIds) {
      const open = new Set(openWorkspaceIds ?? []);
      return items.filter((item) => !open.has(item.workspaceId));
    }

    /** 造一个叶子节点。 */
    function leafNode(paneKey) {
      return { type: 'leaf', paneKey };
    }

    /** 收集树里所有叶子的 key，顺序是「从左到右、从上到下」。 */
    function collectLeaves(node, found = []) {
      if (node === null || node === undefined) return found;
      if (node.type === 'leaf') {
        found.push(node.paneKey);
        return found;
      }
      collectLeaves(node.a, found);
      collectLeaves(node.b, found);
      return found;
    }

    /** 数一棵子树里有几个窗格。 */
    function countLeaves(node) {
      if (node === null || node === undefined) return 0;
      if (node.type === 'leaf') return 1;
      return countLeaves(node.a) + countLeaves(node.b);
    }

    /** 树里是否存在分隔条（单个窗格没有）。 */
    function hasSplit(node) {
      if (node === null || node === undefined || node.type === 'leaf') return false;
      return true;
    }

    /**
     * 把某个窗格的叶子换成另一棵子树（分屏时用）。
     * 找不到目标窗格时原样返回；只重建路径上的节点，其余分支复用。
     */
    function replaceLeaf(node, paneKey, replacement) {
      if (node === null || node === undefined) return node;
      if (node.type === 'leaf') return node.paneKey === paneKey ? replacement : node;
      const a = replaceLeaf(node.a, paneKey, replacement);
      const b = replaceLeaf(node.b, paneKey, replacement);
      if (a === node.a && b === node.b) return node;
      return { ...node, a, b };
    }

    /**
     * 摘掉一个叶子，并把它留下的分屏「折叠」掉：只剩一边的分屏直接由那一边顶替，
     * 因此不会留下一边空着的分隔条。
     * @returns 新的树；最后一个窗格被摘掉时返回 null。
     */
    function removeLeaf(node, paneKey) {
      if (node === null || node === undefined) return null;
      if (node.type === 'leaf') return node.paneKey === paneKey ? null : node;
      const a = removeLeaf(node.a, paneKey);
      const b = removeLeaf(node.b, paneKey);
      if (a === null) return b;
      if (b === null) return a;
      if (a === node.a && b === node.b) return node;
      return { ...node, a, b };
    }

    /**
     * 交换树里两个叶子的位置 —— 「拖动窗格标题栏交换位置」的落点实现。
     *
     * 只换 key，不动别的任何结构：分屏的层级与比例原样留在原地，两个窗格记录
     * （工作区、会话引用、暂存模式、跟随标记）也一动不动。于是「交换位置」在 React
     * 眼里就只是**同一层里的两个兄弟节点换了 key**，它会整体搬动那两棵子树而不是
     * 卸载重建 —— 会话引用因此一次都不会松手（松手的代价见 `createPaneStore` 里
     * `swapPanes` 的说明）。
     *
     * **先确认两个 key 都在树上**才动手：只按 keyA 找到叶子就换成 keyB，遇到
     * keyB 不在树上的输入会把那个叶子换成一个谁也不认识的幽灵节点。不在树上（以及
     * 两个 key 相同）时原样返回 —— 调用方凭「返回的是不是同一个对象」就能判断
     * 这次交换到底成没成，未触及的分支也天然保持同一个对象（结构共享）。
     */
    function swapLeaves(node, keyA, keyB) {
      if (node === null || node === undefined) return node;
      if (keyA === keyB) return node;
      const leaves = collectLeaves(node);
      if (!leaves.includes(keyA) || !leaves.includes(keyB)) return node;
      const walk = (current) => {
        if (current.type === 'leaf') {
          if (current.paneKey !== keyA && current.paneKey !== keyB) return current;
          return leafNode(current.paneKey === keyA ? keyB : keyA);
        }
        const a = walk(current.a);
        const b = walk(current.b);
        if (a === current.a && b === current.b) return current;
        return { ...current, a, b };
      };
      return walk(node);
    }

    /** 把所有分隔条拉回中间。 */
    function balanceTree(node) {
      if (node === null || node === undefined || node.type === 'leaf') return node;
      const a = balanceTree(node.a);
      const b = balanceTree(node.b);
      if (a === node.a && b === node.b && node.ratio === SPLIT_EVEN_RATIO) return node;
      return { ...node, ratio: SPLIT_EVEN_RATIO, a, b };
    }

    /** 按 id 改某一条分隔条的比例；没有这条分隔条时原样返回。 */
    function setSplitRatio(node, splitId, ratio) {
      if (node === null || node === undefined || node.type === 'leaf') return node;
      if (node.id === splitId) return { ...node, ratio };
      const a = setSplitRatio(node.a, splitId, ratio);
      const b = setSplitRatio(node.b, splitId, ratio);
      if (a === node.a && b === node.b) return node;
      return { ...node, a, b };
    }

    /** 把任意输入收敛成一个合法比例。 */
    function clampRatio(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return SPLIT_EVEN_RATIO;
      return Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, value));
    }

    /**
     * 一条分隔条在给定容器尺寸下允许的比例范围：两边都要留住最小窗格宽度。
     * 容器本来就小到放不下两个最小窗格时，退回静态边界，而不是让上下界交叉。
     */
    function ratioLimits(sizePx) {
      const size = typeof sizePx === 'number' && Number.isFinite(sizePx) && sizePx > 0 ? sizePx : 0;
      const share = size === 0 ? 0.5 : SPLIT_MIN_PX / size;
      if (share >= 0.5) return { min: SPLIT_MIN_RATIO, max: SPLIT_MAX_RATIO };
      return { min: Math.max(SPLIT_MIN_RATIO, share), max: Math.min(SPLIT_MAX_RATIO, 1 - share) };
    }

    /**
     * 指针沿分隔条自己的方向移动 `deltaPx` 之后，分隔条应该落在的比例：
     * 起始比例 + 位移占容器的比例，最后钳制到允许范围。
     * 尺寸未知时返回起始比例（宁可不动，也不要算出 NaN）。
     */
    function nextRatio(startRatio, deltaPx, sizePx) {
      const limits = ratioLimits(sizePx);
      const moved = typeof sizePx === 'number' && Number.isFinite(sizePx) && sizePx > 0
        ? startRatio + deltaPx / sizePx
        : startRatio;
      return Math.min(limits.max, Math.max(limits.min, moved));
    }

    /*
     * ## 拖动窗格：先分清「单击」与「拖动」
     *
     * 标题栏上按下鼠标有两重含义：按一下就松（点亮窗格、把键盘光标送进它的输入框），
     * 以及按住拖到别处（交换两个窗格的位置）。区分这两者的唯一依据是**位移**：
     * 手抖一两像素绝不该把布局换掉。阈值放在模型里（而不是组件里），是为了让
     * 「多少算拖动」这条规则能在 Node 里直接测。
     */

    /** 指针离开起点多少像素才算「在拖」，否则按单击处理。 */
    const PANE_DRAG_THRESHOLD_PX = 4;

    /**
     * 指针从起点移动的距离够不够判为「拖动」。
     *
     * 用曼哈顿距离：算式简单、也没有「斜着挪 3 像素算不算」的模糊地带。这个尺度下
     * 两种距离的差别无关紧要，重要的是**按下那一刻的抖动不会触发交换**。
     */
    function paneDragExceeded(startX, startY, x, y) {
      return Math.abs(x - startX) + Math.abs(y - startY) >= PANE_DRAG_THRESHOLD_PX;
    }

    /*
     * ## 窗格几何：把布局树换算成矩形，再按矩形找「相应位置」的邻居
     *
     * 焦点快捷键（Alt+方向键）要回答的问题是「我这个窗格的右边 / 下面是谁」。布局树本身
     * 只记了嵌套关系，直接按树找邻居得处理「另一侧的父节点」「兄弟的子树」这类绕来绕去的
     * 情况；换成矩形之后就只剩比较坐标，规则也能用一句话说清 —— 这正是它值得单独成段的
     * 原因，也是它保持纯粹（不读 DOM、不知道窗口多大）的原因。
     */

    /** 判定矩形相邻时允许的浮点误差（比例是除出来的，边缘常有 1e-17 级的偏差）。 */
    const RECT_EPSILON = 1e-9;

    /**
     * 方向 → 「沿哪个轴比较 + 往哪一侧找」。
     * `axis: 'x'` 是左右，`'y'` 是上下；`forward` 表示要找坐标更大的那一侧（右 / 下）。
     */
    const PANE_DIRECTIONS = {
      right: { axis: 'x', forward: true },
      left: { axis: 'x', forward: false },
      down: { axis: 'y', forward: true },
      up: { axis: 'y', forward: false },
    };

    /**
     * 把布局树换算成每个窗格的矩形，坐标归一化到 0~1（整块棋盘就是 1x1）。
     *
     * 分隔条本身那几像素忽略不计：它不影响「谁在谁右边」的判定，忽略之后这段逻辑就是
     * 纯算术 —— 既不用读 DOM，也不用知道窗口多大，于是能在 Node 里直接测。
     *
     * @param layout - 布局树（可以为 null，此时返回空表）。
     * @returns Map<paneKey, { x, y, w, h }>。
     */
    function layoutRects(layout) {
      const rects = new Map();
      const walk = (node, rect) => {
        if (node === null || node === undefined) return;
        if (node.type === 'leaf') {
          rects.set(node.paneKey, rect);
          return;
        }
        // 比例照旧钳制一次：外部来的快照里可能是不合法的值，
        // 算出负宽度的矩形会让后面的比较全部失去意义。
        const ratio = clampRatio(node.ratio);
        const rest = 1 - ratio;
        if (node.dir === 'col') {
          walk(node.a, { x: rect.x, y: rect.y, w: rect.w, h: rect.h * ratio });
          walk(node.b, { x: rect.x, y: rect.y + rect.h * ratio, w: rect.w, h: rect.h * rest });
          return;
        }
        walk(node.a, { x: rect.x, y: rect.y, w: rect.w * ratio, h: rect.h });
        walk(node.b, { x: rect.x + rect.w * ratio, y: rect.y, w: rect.w * rest, h: rect.h });
      };
      walk(layout, { x: 0, y: 0, w: 1, h: 1 });
      return rects;
    }

    /** 两个候选谁更该当选（true 表示 left 更好）：距离近 → 重叠多 → 中心更对齐。 */
    function closerPane(left, right) {
      if (left.gap !== right.gap) return left.gap < right.gap;
      if (left.overlap !== right.overlap) return left.overlap > right.overlap;
      return left.offset < right.offset;
    }

    /**
     * 找 `activeKey` 在 `direction` 方向上的邻居窗格；一个合适的都没有时返回 undefined。
     *
     * 三条判定，缺一不可：
     *   1. **必须整个在那个方向之外** —— 向右找就要求候选的左边缘不小于当前的右边缘。
     *      于是「右下角那一块」不会被当成左上角窗格的右邻居。
     *   2. **垂直于该方向的轴上必须有重叠** —— 重叠为 0 的窗格不算「相应位置」。
     *      于是左下角窗格按 Alt+↑ 只落到左上角，不会落到横跨右上角的那一块。
     *   3. 排序：**方向轴上离得近的优先** → 垂直重叠多的优先 → 中心更对齐的优先。
     *      距离优先让「A | X | B」这种三连排里，A 往右先到紧挨着的 X，而不是跳过它直奔 B。
     *
     * 一条都不满足时返回 undefined —— 走到最边上再按就**不动**，不绕回对面：
     * 循环会让人在满屏窗格之间迷失方向，而不动至少是可预期的。
     *
     * @param layout - 布局树。
     * @param activeKey - 当前焦点窗格的 key。
     * @param direction - `left` / `right` / `up` / `down`。
     */
    function neighborPane(layout, activeKey, direction) {
      const spec = PANE_DIRECTIONS[direction];
      if (spec === undefined) return undefined;
      const rects = layoutRects(layout);
      const from = rects.get(activeKey);
      if (from === undefined) return undefined;
      const axis = spec.axis;
      const cross = axis === 'x' ? 'y' : 'x';
      const size = axis === 'x' ? 'w' : 'h';
      const crossSize = cross === 'x' ? 'w' : 'h';
      const fromNear = from[axis];
      const fromFar = fromNear + from[size];
      const fromCrossCenter = from[cross] + from[crossSize] / 2;
      let best;
      // 按布局树的叶子顺序遍历，于是所有条件都并列时结果稳定（先出现的赢）。
      for (const key of collectLeaves(layout)) {
        if (key === activeKey) continue;
        const to = rects.get(key);
        if (to === undefined) continue;
        const gap = spec.forward ? to[axis] - fromFar : fromNear - (to[axis] + to[size]);
        if (gap < -RECT_EPSILON) continue;
        const overlap = Math.min(from[cross] + from[crossSize], to[cross] + to[crossSize]) - Math.max(from[cross], to[cross]);
        if (overlap <= 0) continue;
        const candidate = {
          key,
          gap: gap < 0 ? 0 : gap,
          overlap,
          offset: Math.abs(to[cross] + to[crossSize] / 2 - fromCrossCenter),
        };
        if (best === undefined || closerPane(candidate, best)) best = candidate;
      }
      return best === undefined ? undefined : best.key;
    }

    /**
     * 棋盘的状态：打开的窗格列表 + 布局树 + 当前焦点。
     *
     * 它由插件自己持有（而不是 React），所以切换主面板、组件重新挂载都不会丢；
     * 对外只暴露不可变快照 + 订阅，配合 `useSyncExternalStore` 使用。
     */
    function createPaneStore() {
      let snapshot = { panes: [], layout: null, activeKey: null, initialized: false, nextKey: 1, nextSplit: 1 };
      const listeners = new Set();

      /** 发布下一个不可变快照，并唤醒所有订阅者。 */
      const publish = (next) => {
        snapshot = next;
        for (const listener of [...listeners]) listener();
      };

      /**
       * 造一个窗格记录。
       * `follow` 决定「没有指定会话时显示什么」：跟随型窗格显示该工作区最新的会话
       * （添加工作区就是为了盯它），而分屏刚切出来的窗格先空着等用户选，
       * 免得两个窗格莫名其妙地显示同一段对话。
       */
      const createPane = (key, workspaceId, sessionId, follow) => ({
        key,
        workspaceId,
        sessionId: sessionId ?? null,
        preset: null,
        follow,
      });

      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },

        /**
         * 把一个工作区铺成窗格；该工作区已经在棋盘上时复用它。
         * 新窗格接在棋盘的右边。
         * @returns 窗格 key；什么都没变时返回已有窗格的 key。
         */
        addPane(workspaceId, sessionId) {
          const existing = snapshot.panes.find((pane) => pane.workspaceId === workspaceId);
          if (existing !== undefined) {
            if (sessionId === undefined || sessionId === null) return existing.key;
            publish({
              ...snapshot,
              panes: snapshot.panes.map((pane) => (pane.key === existing.key ? { ...pane, sessionId } : pane)),
            });
            return existing.key;
          }
          const key = 'pane-' + String(snapshot.nextKey);
          const pane = createPane(key, workspaceId, sessionId, true);
          const layout = snapshot.layout === null
            ? leafNode(key)
            : {
                type: 'split',
                id: 'split-' + String(snapshot.nextSplit),
                dir: 'row',
                ratio: SPLIT_EVEN_RATIO,
                a: snapshot.layout,
                b: leafNode(key),
              };
          publish({
            panes: [...snapshot.panes, pane],
            layout,
            activeKey: snapshot.activeKey,
            initialized: true,
            nextKey: snapshot.nextKey + 1,
            nextSplit: snapshot.layout === null ? snapshot.nextSplit : snapshot.nextSplit + 1,
          });
          return key;
        },

        /**
         * 把一个窗格切成两半，`dir` 是 `left` / `right` / `up` / `down`，
         * 新的一半接手焦点。
         * 新窗格的工作区由调用方给出（界面上是分屏菜单第二步选出来的）；不传时
         * 仍沿用原窗格的工作区，这是给旧调用点与离线测试保留的默认语义。
         * 新窗格一律等用户自己选会话，因此不会镜像隔壁窗格的对话。
         * @returns 新窗格的 key；原窗格不存在时返回 undefined。
         */
        splitPane(key, dir, workspaceId) {
          const source = snapshot.panes.find((pane) => pane.key === key);
          if (source === undefined) return undefined;
          const newKey = 'pane-' + String(snapshot.nextKey);
          const target = workspaceId === undefined || workspaceId === null ? source.workspaceId : workspaceId;
          const pane = createPane(newKey, target, null, false);
          const placement = splitPlacement(dir);
          const layout = replaceLeaf(snapshot.layout, key, {
            type: 'split',
            id: 'split-' + String(snapshot.nextSplit),
            dir: placement.dir,
            ratio: SPLIT_EVEN_RATIO,
            // 新窗格在左/上时当第一个孩子，在右/下时当第二个孩子。
            a: leafNode(placement.newFirst ? newKey : key),
            b: leafNode(placement.newFirst ? key : newKey),
          });
          publish({
            ...snapshot,
            panes: [...snapshot.panes, pane],
            layout,
            activeKey: newKey,
            initialized: true,
            nextKey: snapshot.nextKey + 1,
            nextSplit: snapshot.nextSplit + 1,
          });
          return newKey;
        },

        /**
         * 把某个窗格换成另一个工作区 —— 「替换工作区」。
         *
         * 语义是**位置不变、内容换掉**：只改这一格的记录，布局树一个节点都不动
         * （分隔条的层级与比例因此原样留着，窗格在屏幕上的位置也不变）。
         *
         * 三件事必须一起做，少一件都会留下半截状态：
         *   1. `workspaceId` 换成新的；
         *   2. `sessionId` 清成 null —— 不清的话 `resolvePaneSessionId` 会继续把这一格
         *      钉在**旧工作区的那个会话**上（它还在，能解析出来），于是「工作区换了、
         *      对话还是上一个工作区的」，看着就像替换没生效；
         *   3. `follow` 归位成 true —— 与原「添加工作区」同一个语义：跟随新工作区
         *      最近更新的会话（旧值可能是分屏新窗格的 false，那会让这一格空着等选）。
         *
         * 会话引用（`useSessionReference`）由 `sessionId` 的变化自然收尾：旧引用被释放，
         * 新会话被持有 —— 用户要的「关闭原来的工作区」就是这一步，本存储不自己动引用。
         *
         * 暂存的模式（`preset`）**保留**：它是「这个窗格下一个会话用什么模式」的用户选择，
         * 换工作区不该把它偷偷改回默认。
         *
         * @returns 真的换了返回 true；窗格不存在、或换的还是同一个工作区时返回 false
         *   （两者都不产生新快照，调用方据此决定要不要报错）。
         */
        replaceWorkspace(key, workspaceId) {
          const pane = snapshot.panes.find((candidate) => candidate.key === key);
          if (pane === undefined || pane.workspaceId === workspaceId) return false;
          publish({
            ...snapshot,
            panes: snapshot.panes.map((candidate) => (candidate.key === key
              ? { ...candidate, workspaceId, sessionId: null, follow: true }
              : candidate)),
          });
          return true;
        },

        /**
         * 交换两个窗格的**位置**：布局树里两个叶子的 key 互换，其余一切（工作区、
         * 会话、暂存模式、跟随标记）都跟着各自的窗格走。
         *
         * 为什么不去改窗格记录里的 `workspaceId` / `sessionId`（那样看着更直接）：
         * 改记录等于让每个槽位都换成另一段对话，`useSessionReference` 的 effect 会成对
         * 重跑 —— 而 DSH 的 `SessionReference.release` 契约是「最后一次释放会拆掉会话的
         * 本地作用域与历史」，两边会同时重开一遍（滚动位置与输入框草稿一起丢）。
         * 只换布局树就没有这个问题：窗格记录不动，React 按 pane key 就能把已挂载的
         * 子树整体搬过去。
         *
         * 焦点（`activeKey`）**不动**：它记的是窗格 key，于是高亮与键盘光标跟着被拖动的
         * 窗格落到新位置。
         *
         * @returns 真的换了返回 true；同一个窗格、或两方有一个不在树上时返回 false
         *   （调用方据此决定要不要把键盘光标搬过去）。
         */
        swapPanes(keyA, keyB) {
          const layout = swapLeaves(snapshot.layout, keyA, keyB);
          if (layout === snapshot.layout) return false;
          publish({ ...snapshot, layout });
          return true;
        },

        /**
         * 关掉一个窗格：它所在的分屏折叠，焦点若在它身上就交给顶替它位置的窗格。
         *
         * @returns 接手焦点的窗格 key。只有**被关掉的正是当前焦点窗格**、且棋盘还有别的
         *   窗格时才有值 —— 调用方据此决定要不要把键盘光标也搬过去（关掉一个不相干的
         *   窗格时，光标必须原地不动）。没有接手者（关的不是焦点窗格、或棋盘因此空了）
         *   返回 undefined。
         */
        removePane(key) {
          if (!snapshot.panes.some((pane) => pane.key === key)) return undefined;
          const before = collectLeaves(snapshot.layout);
          const index = before.indexOf(key);
          const layout = removeLeaf(snapshot.layout, key);
          const after = collectLeaves(layout);
          const fallback = after.length === 0
            ? null
            : after[Math.min(Math.max(index, 0), after.length - 1)];
          const tookOver = snapshot.activeKey === key ? fallback : null;
          publish({
            ...snapshot,
            initialized: true,
            panes: snapshot.panes.filter((pane) => pane.key !== key),
            layout,
            activeKey: snapshot.activeKey === key ? fallback : snapshot.activeKey,
          });
          return tookOver === null ? undefined : tookOver;
        },

        /** 关掉所有窗格。 */
        closeAll() {
          publish({
            panes: [],
            layout: null,
            activeKey: null,
            initialized: true,
            nextKey: snapshot.nextKey + 1,
            nextSplit: snapshot.nextSplit + 1,
          });
        },

        /** 把某个窗格钉在一个具体会话上。 */
        setSession(key, sessionId) {
          publish({
            ...snapshot,
            panes: snapshot.panes.map((pane) => (pane.key === key ? { ...pane, sessionId } : pane)),
          });
        },

        /**
         * 松开所有钉在某个会话上的窗格 —— 那个会话已经被永久删除了。
         *
         * 为什么不是「删它的那个窗格自己清一下」：同一个会话可以同时显示在好几格上
         * （跟随型窗格会自动选中本工作区最新的会话，于是很可能与旁边那一格是同一段
         * 对话），而 `resolvePaneSessionId` 对「钉住的会话已经不在会话表里」是**照样
         * 返回它**（那一条是给刚建、还没来得及进列表的会话留的）。所以只清自己那一格，
         * 别的格子会一直指着一个已经不存在的会话，面板就卡在「正在打开会话…」。
         * 在这里按会话 id 一次清干净，调用方是谁都不影响结果。
         *
         * `follow` 刻意不动：跟随型窗格随即回退到本工作区最新的会话（那是它的本分），
         * 而用户亲手选过会话的分屏窗格回到「选择会话 / 新建会话」的空态 —— 空态问的
         * 正是「接下来看哪个」，比替用户随手挑一段新对话诚实。
         *
         * @param sessionId - 已经被删除的会话 id。
         * @returns 真的改动了快照返回 true；没有任何窗格钉着它时返回 false。
         */
        forgetSession(sessionId) {
          if (sessionId === null || sessionId === undefined) return false;
          if (!snapshot.panes.some((pane) => pane.sessionId === sessionId)) return false;
          publish({
            ...snapshot,
            panes: snapshot.panes.map((pane) => (pane.sessionId === sessionId ? { ...pane, sessionId: null } : pane)),
          });
          return true;
        },

        /** 记下该窗格下次新建会话要用的模式；null 表示跟随 Host 默认值。 */
        setPreset(key, preset) {
          publish({
            ...snapshot,
            panes: snapshot.panes.map((pane) => (pane.key === key ? { ...pane, preset } : pane)),
          });
        },

        /** 把焦点给某个窗格；同样值或未知窗格都不产生新快照。 */
        setActive(key) {
          if (snapshot.activeKey === key) return;
          if (!snapshot.panes.some((pane) => pane.key === key)) return;
          publish({ ...snapshot, activeKey: key });
        },

        /** 设置某条分隔条的比例（自动钳制）。 */
        setRatio(splitId, ratio) {
          const layout = setSplitRatio(snapshot.layout, splitId, clampRatio(ratio));
          if (layout === snapshot.layout) return;
          publish({ ...snapshot, layout });
        },

        /** 所有分隔条回到中间。 */
        balance() {
          const layout = balanceTree(snapshot.layout);
          if (layout === snapshot.layout) return;
          publish({ ...snapshot, layout });
        },

        /**
         * 第一次打开棋盘时播种：当前会话所在的工作区排第一，再补一个别的，
         * 于是打开就是两个窗格并排，而不是一块空白。
         */
        ensureInitialized(currentWorkspaceId, workspaceIds) {
          if (snapshot.initialized || snapshot.panes.length > 0 || workspaceIds.length === 0) return;
          const first = currentWorkspaceId !== undefined && workspaceIds.includes(currentWorkspaceId) ? currentWorkspaceId : workspaceIds[0];
          const second = workspaceIds.find((id) => id !== first);
          const chosen = second === undefined ? [first] : [first, second];
          const panes = chosen.map((workspaceId, index) => createPane('pane-' + String(index + 1), workspaceId, null, true));
          const layout = panes.length === 1
            ? leafNode(panes[0].key)
            : {
                type: 'split',
                id: 'split-' + String(snapshot.nextSplit),
                dir: 'row',
                ratio: SPLIT_EVEN_RATIO,
                a: leafNode(panes[0].key),
                b: leafNode(panes[1].key),
              };
          publish({
            panes,
            layout,
            activeKey: panes[0].key,
            initialized: true,
            nextKey: chosen.length + 1,
            nextSplit: panes.length === 1 ? snapshot.nextSplit : snapshot.nextSplit + 1,
          });
        },
      };
    }

    /** 某个工作区里「可以选」的会话：非归档、非子代理，最近更新的排前面。 */
    function selectableSessions(workspace, sessionState, archivedSessionIds) {
      if (workspace === undefined) return [];
      const rows = [];
      for (const id of workspace.sessionIds) {
        const summary = sessionState.byId[id];
        if (summary === undefined || summary.origin === 'subagent') continue;
        if (archivedSessionIds.includes(id)) continue;
        rows.push(summary);
      }
      rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
      return rows;
    }

    /**
     * 一个窗格该显示哪个会话：
     *   1. 它自己钉住的会话（只要那个会话还在；刚建的会话可能还没进 Workspace 行）；
     *   2. 只有「跟随型」窗格才退回到该工作区最新的会话；
     *   3. 分屏新开的窗格什么都不显示，等用户自己选。
     */
    function resolvePaneSessionId(pane, rows, sessionState, archivedSessionIds) {
      const explicit = pane.sessionId;
      if (explicit !== null && explicit !== undefined && !archivedSessionIds.includes(explicit)) {
        const summary = sessionState.byId[explicit];
        if (summary === undefined || summary.origin !== 'subagent') return explicit;
      }
      if (pane.follow === false) return undefined;
      return rows.length === 0 ? undefined : rows[0].id;
    }

    return {
      SESSION_SOURCE,
      SPLIT_MIN_PX,
      SPLIT_MIN_RATIO,
      SPLIT_MAX_RATIO,
      SPLIT_EVEN_RATIO,
      SPLIT_DIRECTIONS,
      SPLIT_PLACEMENTS,
      splitPlacement,
      splitCandidates,
      unopenedWorkspaces,
      leafNode,
      collectLeaves,
      countLeaves,
      hasSplit,
      replaceLeaf,
      removeLeaf,
      swapLeaves,
      balanceTree,
      setSplitRatio,
      clampRatio,
      ratioLimits,
      nextRatio,
      PANE_DRAG_THRESHOLD_PX,
      paneDragExceeded,
      RECT_EPSILON,
      PANE_DIRECTIONS,
      layoutRects,
      neighborPane,
      createPaneStore,
      selectableSessions,
      resolvePaneSessionId,
    };
  },
});
