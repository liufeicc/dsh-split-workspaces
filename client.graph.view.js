/**
 * 平铺面板的「任务分派」视图块：把会话画成卡片，用箭头连成有向树。
 *
 * 箭头方向就是委派方向：**A → B 表示会话 A 可以把任务派给会话 B**。
 *
 * 卡片是**会话**不是窗格（这条改过一次，理由见 `client.graph.model.js` 文件头）：
 * 同一个会话即使同时开在两个窗格里也只有一张卡片，关掉窗格也不会拆掉关系。
 *
 * ## 交互：先选会话，再连线
 *
 * 画布不再把全部会话平铺出来 —— 会话一多就没法找。现在分成左右两块：
 *
 *   1. **左侧选择器**：先选工作区（默认折叠），再选会话；会话条目可以**拖到右侧画布**，
 *      也可以直接点一下加入。
 *   2. **右侧画布**：只显示已经拖进来的卡片和已经连好的树。连一条边仍然按住卡片右边缘
 *      那个圆点，拖到另一张卡片上松手；删一条边点箭头中点那个小叉。
 *
 * 拖进来的卡片先停在左列「待连线」，连上箭头后才进入右侧的树；两者因此一眼可分。
 *
 * 之所以从「右边缘圆点」起手、而不是「按住卡片本体拖」：卡片本体还要能点（点一下
 * 切回平铺并聚焦那一格），两种拖动挤在同一个手势上会互相打架 —— 这一点在平铺模式的
 * 标题栏拖动里已经吃过一次亏（见 README 的坑 6）。圆点是个明确的起手区。
 *
 * ## 命中测试为什么是算出来的、不是 `elementFromPoint`
 *
 * 卡片的位置是 `layoutGraph` 算好的绝对坐标，指针在画布里的坐标也是算出来的，所以
 * 「落在哪张卡片上」只需要比一比矩形。用 `elementFromPoint` 反而要多处理几层
 * 嵌套（SVG 层压在上面、文字节点、滚动偏移），而且离线测试没法模拟。
 *
 * ## 校验在这一层做，但规则在模型里
 *
 * 成环、第二个上级这两条不变量属于「图」的定义，归 `client.graph.model.js` 的
 * `validateEdge`。这里只负责把拒绝原因翻译成人话，摆在画布底部。
 *
 * 加载方式：入口 `client.js` 用 `require.async('./client.graph.view.js')` 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.graph.view.js',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    /**
     * 把左侧会话条目拖到画布时使用的私有 MIME。
     *
     * 自定义类型是为了让画布只接受「从本选择器拖来的会话」，而不是任何一段文本；
     * 同时再写一份 `text/plain` 作为兼容兜底（某些平台会过滤私有类型）。
     */
    const SESSION_DRAG_MIME = 'application/x-dsh-split-workspace-session';

    /**
     * 霓虹调色板：卡片与关系按来源稳定取色。
     *
     * 取色的目的不是装饰，而是**帮助区分不同的树和不同的源会话**：同一个工作区的卡片、
     * 同一条源会话发出的箭头用同一种颜色，不同的源/工作区换一种。颜色由 key 的哈希决定，
     * 所以刷新后不会变，同一个对象永远同一个颜色。
     */
    const EDGE_PALETTE = ['#5ee7ff', '#a78bfa', '#ff7ad9', '#ffd166', '#6ef0b8', '#ff9f6e'];

    /** 给一个稳定的 key 挑一种霓虹色（同一 key 永远同一色）。 */
    function accentFor(key) {
      const text = typeof key === 'string' ? key : '';
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return EDGE_PALETTE[(hash >>> 0) % EDGE_PALETTE.length];
    }

    /**
     * 左侧的二级会话选择器。
     *
     * 第一级是工作区（默认**全部折叠**，一行一个），点开后才列出该工作区的会话；
     * 会话以**卡片**形式展示，可以拖到右侧画布，也可以点一下加入。已经加入画布的
     * 会话不会留在这里（见 `client.view.js` 的 `pickerGroups`），所以列表永远只
     * 包含「还能加进去的」，不需要额外的状态标记。
     *
     * @param props.groups - `[{ key, label, items: [{ key, label, workspaceTitle, running }] }]`。
     * @param props.onStage - 把会话拖/点进画布。
     * @param props.t / props.css / props.cx - 文案、class 表、class 拼接。
     * @param props.dragMime - 拖拽时写入的私有 MIME。
     */
    function GraphPicker(props) {
      const { groups, onStage, t, css, cx, dragMime } = props;
      /** 展开的工作区 key 集合；默认全折叠，先让用户选工作区。 */
      const [open, setOpen] = useState(() => new Set());
      const toggle = (key) => {
        setOpen((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };

      const rows = [];
      for (const group of groups) {
        const expanded = open.has(group.key);
        const accent = accentFor(group.key);
        rows.push(h('div', { key: 'g-' + group.key, className: css.graphPickerGroup },
          h('button', {
            key: 'head',
            type: 'button',
            className: cx(css.graphPickerGroupHead, expanded ? css.graphPickerGroupOpen : null),
            style: { '--pick-accent': accent },
            'aria-expanded': expanded,
            title: t('graph.pickerGroupHint', { title: group.label }),
            onClick: () => toggle(group.key),
          },
            h('svg', {
              key: 'chevron',
              className: css.graphPickerChevron,
              width: 8,
              height: 8,
              viewBox: '0 0 8 8',
              'aria-hidden': true,
            }, h('path', {
              d: 'M2.5 1l3.5 3-3.5 3',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            })),
            h('span', { key: 'label', className: css.graphPickerGroupLabel }, group.label),
            h('span', {
              key: 'dot',
              className: css.graphPickerDot,
              style: { background: accent, boxShadow: '0 0 8px ' + accent },
              'aria-hidden': true,
            })),
          expanded ? h('div', { key: 'items', className: css.graphPickerItems },
            group.items.map((item) => h('div', {
              key: item.key,
              className: css.graphPickerItem,
              style: { '--pick-accent': accent },
              role: 'button',
              tabIndex: 0,
              draggable: true,
              'data-session': item.key,
              title: t('graph.pickerItemHint', { title: item.label }),
              onDragStart: (event) => {
                event.dataTransfer.setData(dragMime, item.key);
                event.dataTransfer.setData('text/plain', item.key);
                event.dataTransfer.effectAllowed = 'copy';
              },
              onClick: () => onStage(item.key),
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onStage(item.key);
              },
            },
              h('div', { key: 'top', className: css.graphPickerCardTop },
                h('span', { key: 'ws', className: css.graphPickerCardWorkspace }, item.workspaceTitle),
                item.running === true
                  ? h('span', { key: 'run', className: css.graphPickerCardRun, title: t('pane.running') })
                  : null),
              h('div', { key: 'label', className: css.graphPickerCardTitle }, item.label),
              h('div', { key: 'hint', className: css.graphPickerCardHint },
                h('span', { key: 'text', className: css.graphPickerCardHintText }, t('graph.pickerDrag')),
                h('svg', {
                  key: 'arrow',
                  className: css.graphPickerCardArrow,
                  width: 12,
                  height: 12,
                  viewBox: '0 0 12 12',
                  'aria-hidden': true,
                }, h('path', {
                  d: 'M3 9L9 3M4.2 3H9v4.8',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.2,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                })))))) : null));
      }

      return h('aside', { className: css.graphPicker },
        h('div', { key: 'head', className: css.graphPickerHead },
          h('div', { key: 'title', className: css.graphPickerTitle }, t('graph.pickerTitle')),
          h('div', { key: 'hint', className: css.graphPickerHint }, t('graph.pickerHint'))),
        h('div', { key: 'scroll', className: css.graphPickerScroll },
          groups.length === 0
            ? h('div', { key: 'empty', className: css.graphPickerEmpty }, t('graph.pickerEmpty'))
            : rows));
    }
    GraphPicker.displayName = 'GraphPicker';

    /**
     * 一条边的几何：起点在源卡片右边缘中点，终点在目标卡片左边缘偏里一点。
     *
     * 用三次贝塞尔而不是直线：树里同一层到下一层经常有纵向偏移，直线会从卡片
     * 中间穿过，看起来像两条线交叉；贝塞尔从两侧水平进出，一眼能看出谁连谁。
     *
     * @param from - 源卡片矩形 `{ x, y, w, h }`。
     * @param to - 目标卡片矩形。
     * @returns `{ d, mx, my, ax, ay }` —— 路径、中点（放删除按钮）、箭头尖。
     */
    function edgeGeometry(from, to) {
      const x1 = from.x + from.w;
      const y1 = from.y + from.h / 2;
      const ax = to.x - 7;
      const ay = to.y + to.h / 2;
      const dx = Math.max(38, Math.abs(ax - x1) * 0.45);
      const c1x = x1 + dx;
      const c1y = y1;
      const c2x = ax - dx;
      const c2y = ay;
      const d = 'M ' + x1 + ' ' + y1 + ' C ' + c1x + ' ' + c1y + ', ' + c2x + ' ' + c2y + ', ' + ax + ' ' + ay;
      // 三次贝塞尔在 t=0.5 处的点：(P0 + 3P1 + 3P2 + P3) / 8。
      const mx = (x1 + 3 * c1x + 3 * c2x + ax) / 8;
      const my = (y1 + 3 * c1y + 3 * c2y + ay) / 8;
      return { d, mx, my, ax, ay };
    }

    /**
     * 设计模式的整块画布。
     *
     * @param props.cards - 卡片数组 `[{ key, label, workspaceTitle, running, inPane }]`，
     *   `key` 就是会话 id（由调用方按「当前铺开的工作区里的真实会话」算好）。
     * @param props.edges - 边数组，两端都是会话 id。
     * @param props.layout - `{ items, width, height }`（由调用方用模型算好，避免这里再依赖模型块）。
     * @param props.graph - 模型块（只用 `validateEdge` 与 `sameBindings` 之外的纯函数）。
     * @param props.actions - `{ addEdge, removeEdge, setNote, openPane }`。
     * @param props.t - 翻译函数。
     * @param props.css - class 名表。
     * @param props.cx - class 拼接工具。
     * @param props.degraded - 绑定服务没就绪时为真，画布顶部给一行说明。
     */
    function GraphBoard(props) {
      const { cards: cardList, edges, layout, graph, actions, pickerGroups, t, css, cx, degraded, diagnostic } = props;
      const canvasRef = useRef(null);
      /** 正在拉的那条线：`{ from, x, y }`，`x` / `y` 是画布坐标。 */
      const [drag, setDrag] = useState(null);
      /** 上一次被拒绝的原因码；下一次成功连边或换手势时清掉。 */
      const [rejectCode, setRejectCode] = useState(null);
      /** 正在编辑说明的那条边 `{ from, to }`；null 表示没有在编辑。 */
      const [editing, setEditing] = useState(null);
      /** 编辑中的说明草稿。 */
      const [draft, setDraft] = useState('');
      /** 左侧会话正被拖到画布上方；用来给画布加一圈高亮。 */
      const [dropActive, setDropActive] = useState(false);
      const itemsByKey = useMemo(() => {
        const index = new Map();
        for (const item of layout.items) index.set(item.key, item);
        return index;
      }, [layout]);

      /** 画布坐标：把视口坐标减去画布在视口里的位置，再补上滚动偏移。 */
      const toCanvas = useCallback((event) => {
        const node = canvasRef.current;
        if (node === null) return { x: 0, y: 0 };
        const rect = node.getBoundingClientRect();
        return {
          x: event.clientX - rect.left + node.scrollLeft,
          y: event.clientY - rect.top + node.scrollTop,
        };
      }, []);

      const onPortDown = useCallback((event, paneKey) => {
        event.preventDefault();
        event.stopPropagation();
        setRejectCode(null);
        const point = toCanvas(event);
        setDrag({ from: paneKey, x: point.x, y: point.y });
      }, [toCanvas]);

      /*
       * 从左侧选择器拖会话到画布。
       *
       * 只接受本选择器写的私有 MIME（外加 text/plain 兜底），不接任何一段外部文本：
       * 画布上出现的每一张卡片都必须对应一个真实会话 id，否则布局里查不到它，
       * 用户会看到一张拖不动的空卡。
       */
      const onDragOver = useCallback((event) => {
        const types = event.dataTransfer === undefined || event.dataTransfer === null
          ? []
          : Array.from(event.dataTransfer.types ?? []);
        if (!types.includes(SESSION_DRAG_MIME) && !types.includes('text/plain')) return;
        event.preventDefault();
        if (event.dataTransfer !== undefined && event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
      }, []);
      const onDragLeave = useCallback((event) => {
        // 在画布内部的子元素之间移动也会触发 dragleave，不能因此把高亮撤掉。
        if (event.relatedTarget !== null && event.relatedTarget !== undefined && event.currentTarget.contains(event.relatedTarget)) return;
        setDropActive(false);
      }, []);
      const onDrop = useCallback((event) => {
        event.preventDefault();
        setDropActive(false);
        const transfer = event.dataTransfer;
        if (transfer === undefined || transfer === null) return;
        const id = transfer.getData(SESSION_DRAG_MIME) || transfer.getData('text/plain');
        if (typeof id !== 'string' || id === '') return;
        actions.stageSession(id);
      }, [actions]);

      /*
       * 拖动期间的监听挂在 window 上，而不是画布节点上：指针一旦移出画布（用户往往
       * 正是拖到边缘那张卡片上），画布自己就收不到 move / up 了，拖动会卡在半路。
       */
      useEffect(() => {
        if (drag === null) return undefined;
        const onMove = (event) => {
          const point = toCanvas(event);
          setDrag((current) => (current === null ? current : { ...current, x: point.x, y: point.y }));
        };
        const onUp = (event) => {
          const current = drag;
          setDrag(null);
          /*
           * 判定整个交给模型里的纯函数（`resolveDrop`）：命中哪张卡片、这条边能不能加，
           * 两个问题的答案都只取决于数据，因此可以在离线测试里逐条喂。视图这边只负责
           * 把指针换算成画布坐标。
           */
          const resolved = graph.resolveDrop(edges, layout, current.from, toCanvas(event));
          if (resolved.over === null) return;
          if (resolved.verdict.ok === true) {
            setRejectCode(null);
            actions.addEdge(current.from, resolved.over);
            return;
          }
          setRejectCode(resolved.verdict.code);
        };
        const onCancel = () => setDrag(null);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        return () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
        };
      }, [drag, toCanvas, layout, edges, graph, actions]);

      /** 打开某条边的说明编辑器，草稿从这条边现有的说明起头。 */
      const openEditor = (edge) => {
        setRejectCode(null);
        setEditing({ from: edge.from, to: edge.to });
        setDraft(typeof edge.note === 'string' ? edge.note : '');
      };
      const saveNote = () => {
        if (editing === null) return;
        actions.setNote(editing.from, editing.to, draft);
        setEditing(null);
      };
      const removeEditing = () => {
        if (editing === null) return;
        actions.removeEdge(editing.from, editing.to);
        setEditing(null);
      };

      const rejectText = rejectCode === null ? null : (
        rejectCode === 'cycle' ? t('graph.rejectCycle')
          : rejectCode === 'has-parent' ? t('graph.rejectHasParent')
            : rejectCode === 'duplicate' ? t('graph.rejectDuplicate')
              : t('graph.rejectGeneric')
      );

      const cards = cardList.map((card) => {
        const item = itemsByKey.get(card.key);
        if (item === undefined) return null;
        /*
         * 「待连线」以布局结果为准，而不是看 staged 集合：会话连上箭头之后仍会留在
         * 集合里（删掉箭头要能回到待连线），但布局已经把它当成树节点，卡片就不该
         * 再显示虚线边框和移除按钮。
         */
        const isStaged = item.staged === true;
        const label = card.label === undefined || card.label === '' ? t('pane.untitled') : card.label;
        return h('div', {
          key: card.key,
          className: css.graphCard,
          style: {
            left: item.x + 'px',
            top: item.y + 'px',
            width: item.w + 'px',
            height: item.h + 'px',
            // 同一个工作区同一色；顶层光条、悬停边框和出线端口都跟着它走。
            '--card-accent': accentFor(card.workspaceKey === undefined || card.workspaceKey === '' ? card.key : card.workspaceKey),
          },
          'data-session': card.key,
          'data-running': card.running === true ? 'true' : 'false',
          'data-staged': isStaged ? 'true' : 'false',
          /*
           * 点卡片 = 「去平铺里看这个会话」。这个会话没在任何窗格里打开时点了没意义，
           * 卡片的悬停提示会如实说明（而不是假装能跳过去）。
           */
          onClick: card.inPane === true ? () => actions.openPane(card.key) : undefined,
          title: isStaged
            ? t('graph.stagedHint')
            : (card.inPane === true ? t('graph.openHint') : t('graph.noSessionHint')),
        },
          h('div', { key: 'ws', className: css.graphCardWorkspace }, card.workspaceTitle),
          h('div', { key: 'title', className: css.graphCardTitle }, label),
          h('div', { key: 'meta', className: css.graphCardMeta },
            card.running === true
              ? h('span', { key: 'dot', className: css.graphCardRunning }, t('pane.running'))
              : null,
            isStaged
              ? h('span', { key: 'staged', className: css.graphCardStaged }, t('graph.stagedBadge'))
              : null),
          /*
           * 待连线卡片右上角的「移出画布」。连上箭头之后它就不再是待连线，
           * 这个按钮也跟着消失 —— 移除关系走箭头上的编辑面板，两个动作不混。
           */
          isStaged ? h('button', {
            key: 'remove',
            type: 'button',
            className: css.graphCardRemove,
            title: t('graph.removeStaged'),
            'aria-label': t('graph.removeStaged'),
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => {
              event.stopPropagation();
              actions.unstageSession(card.key);
            },
          }, '×') : null,
          /*
           * 出线端口：拖动起点。用 `pointerdown` 而不是 `click`，因为这是一次拖动；
           * `stopPropagation` 保证它不会顺带把卡片自己的点击也点出去。
           */
          h('button', {
            key: 'port',
            type: 'button',
            className: css.graphPort,
            title: t('graph.dragHint'),
            'aria-label': t('graph.dragHint'),
            onPointerDown: (event) => onPortDown(event, card.key),
            onClick: (event) => event.stopPropagation(),
          }));
      });

      const lines = edges.map((edge, index) => {
        const from = itemsByKey.get(edge.from);
        const to = itemsByKey.get(edge.to);
        if (from === undefined || to === undefined) return null;
        const geometry = edgeGeometry(from, to);
        /*
         * 同一条源会话发出的箭头同色，不同的源换一种色：整张图因此能一眼分出
         * “这几条线是同一个上级派出去的”，也顺带满足视觉上的色彩层次。
         * 基础线用 60% 透明度的同色，叠一条流动的高光，光点沿箭头方向滑动。
         */
        const color = accentFor(edge.from);
        return h('g', { key: edge.from + '>' + edge.to },
          h('path', {
            key: 'line',
            d: geometry.d,
            className: css.graphEdge,
            fill: 'none',
            stroke: color + '99',
          }),
          h('path', {
            key: 'flow',
            d: geometry.d,
            className: css.graphEdgeFlow,
            fill: 'none',
            stroke: color,
            /*
             * `pathLength="100"` 把每条边的长度归一化：CSS 里只要写 `2 98`，
             * 无论实际路径多长，同一时刻路径上都**只有一个光点**在跑。
             * 不归一化的话，短边上会挤好几个点，看起来像一串虚线。
             */
            pathLength: '100',
            style: { animationDelay: (-index * 0.55) + 's' },
          }),
          h('polygon', {
            points: geometry.ax + ',' + geometry.ay + ' ' + (geometry.ax - 7) + ',' + (geometry.ay - 4) + ' ' + (geometry.ax - 7) + ',' + (geometry.ay + 4),
            className: css.graphArrow,
            fill: color,
          }),
          /*
           * 中点按钮 = 「编辑这条关系」。删除挪进了编辑面板里 —— 一个位置只放一个动作，
           * 免得误点；而「给这条箭头写说明」才是这里最常做的事。
           */
          h('g', {
            className: css.graphEdgeEdit,
            role: 'button',
            'aria-label': t('graph.editEdge'),
            onClick: (event) => {
              event.stopPropagation();
              openEditor(edge);
            },
            transform: 'translate(' + geometry.mx + ',' + geometry.my + ')',
          },
            h('circle', { r: 9 }),
            h('circle', { cx: -3.2, cy: 0, r: 1.25 }),
            h('circle', { cx: 0, cy: 0, r: 1.25 }),
            h('circle', { cx: 3.2, cy: 0, r: 1.25 })));
      });

      /*
       * 边上的说明标签：**只显示一个「说明」小徽标**，不铺开正文。
       *
       * 正文往往很长（“你负责接收主会话的任务，根据主会话要求……”），而两列卡片之间
       * 只有 84px，铺开必然压住左右两侧的卡片标题。折叠成小徽标后，线的中点只占一个
       * 圆角小胶囊；完整说明放在悬停提示里，点击徽标直接打开编辑面板看全文。
       */
      const noteLabels = edges.map((edge) => {
        if (typeof edge.note !== 'string' || edge.note === '') return null;
        const from = itemsByKey.get(edge.from);
        const to = itemsByKey.get(edge.to);
        if (from === undefined || to === undefined) return null;
        const geometry = edgeGeometry(from, to);
        const color = accentFor(edge.from);
        const open = (event) => {
          event.stopPropagation();
          openEditor(edge);
        };
        return h('div', {
          key: 'note-' + edge.from + '>' + edge.to,
          className: css.graphEdgeNote,
          role: 'button',
          tabIndex: 0,
          title: edge.note,
          style: {
            left: geometry.mx + 'px',
            top: (geometry.my - 18) + 'px',
            // 说明标签左边用箭头同色，扫一眼就能把标签和线对上。
            borderLeftColor: color,
            borderLeftWidth: '2px',
          },
          onPointerDown: (event) => event.stopPropagation(),
          onClick: open,
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            open(event);
          },
        },
          h('span', { key: 'dot', className: css.graphEdgeNoteDot, 'aria-hidden': true }),
          h('span', { key: 'text', className: css.graphEdgeNoteText }, t('graph.noteBadge')));
      });

      /*
       * 说明编辑面板。挂在画布上（而不是弹到窗口里）：它的位置就是那条边中点的位置，
       * 用户不会搞不清自己在改哪一条。
       */
      const editor = editing === null ? null : (() => {
        const edge = edges.find((item) => item.from === editing.from && item.to === editing.to);
        if (edge === undefined) return null;
        const from = itemsByKey.get(edge.from);
        const to = itemsByKey.get(edge.to);
        if (from === undefined || to === undefined) return null;
        const geometry = edgeGeometry(from, to);
        return h('div', {
          key: 'editor',
          className: css.graphEdgeEditor,
          style: { left: geometry.mx + 'px', top: geometry.my + 'px' },
          onPointerDown: (event) => event.stopPropagation(),
          onClick: (event) => event.stopPropagation(),
        },
          h('div', { key: 'title', className: css.graphEdgeEditorTitle }, t('graph.noteTitle')),
          h('div', { key: 'hint', className: css.graphEdgeEditorHint }, t('graph.noteHint')),
          h('textarea', {
            key: 'input',
            className: css.graphEdgeEditorInput,
            value: draft,
            maxLength: graph.EDGE_NOTE_MAX,
            placeholder: t('graph.notePlaceholder'),
            onChange: (event) => setDraft(event.target.value),
          }),
          h('div', { key: 'actions', className: css.graphEdgeEditorActions },
            h('button', {
              key: 'save',
              type: 'button',
              className: cx(css.button, css.primary),
              onClick: saveNote,
            }, t('graph.noteSave')),
            h('button', {
              key: 'delete',
              type: 'button',
              className: css.button,
              onClick: removeEditing,
            }, t('graph.removeEdge')),
            h('button', {
              key: 'cancel',
              type: 'button',
              className: css.button,
              onClick: () => setEditing(null),
            }, t('graph.noteCancel'))));
      })();

      return h('div', { className: css.graphWrap },
        h('div', { className: css.graphBar },
          h('span', { className: css.graphHint }, t('graph.hint')),
          rejectText === null ? null : h('span', { className: css.graphReject, role: 'alert' }, rejectText),
          degraded === true ? h('span', { className: css.graphDegraded }, t('pane.dispatchUnavailable')) : null),
        h('div', { className: css.graphBody },
          h(GraphPicker, {
            groups: pickerGroups,
            onStage: actions.stageSession,
            t,
            css,
            cx,
            dragMime: SESSION_DRAG_MIME,
          }),
          h('div', {
            className: css.graphScroll,
            'data-drop': dropActive ? 'true' : 'false',
            onDragOver,
            onDragLeave,
            onDrop,
          },
            h('div', {
              className: css.graphCanvas,
              ref: canvasRef,
              style: { width: layout.width + 'px', height: layout.height + 'px' },
              onPointerDown: () => setRejectCode(null),
            },
              h('svg', { className: css.graphSvg, width: layout.width, height: layout.height },
                lines,
                drag === null ? null : (() => {
                  const from = itemsByKey.get(drag.from);
                  if (from === undefined) return null;
                  const x1 = from.x + from.w;
                  const y1 = from.y + from.h / 2;
                  const dx = Math.max(38, Math.abs(drag.x - x1) * 0.45);
                  return h('path', {
                    key: 'pending',
                    d: 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (drag.x - dx) + ' ' + drag.y + ', ' + drag.x + ' ' + drag.y,
                    className: cx(css.graphEdge, css.graphEdgePending),
                    fill: 'none',
                  });
                })()),
              cards,
              noteLabels,
              editor,
              layout.items.length === 0
                ? h('div', { key: 'empty', className: css.graphEmpty }, t('graph.emptyCanvas'))
                : null),
            diagnostic === undefined ? null : h('div', { key: 'diag', className: css.graphDiagnostic }, diagnostic))));
    }
    GraphBoard.displayName = 'GraphBoard';

    return { GraphBoard, GraphPicker, edgeGeometry, SESSION_DRAG_MIME };
  },
});