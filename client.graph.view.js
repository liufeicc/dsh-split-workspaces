/**
 * 平铺面板的「任务分派」视图块：把每个**会话**画成一张卡片，用箭头连成有向树。
 *
 * 箭头方向就是委派方向：**A → B 表示会话 A 可以把任务派给会话 B**。
 *
 * 卡片是**会话**不是窗格（这条改过一次，理由见 `client.graph.model.js` 文件头）：
 * 同一个会话即使同时开在两个窗格里也只有一张卡片，关掉窗格也不会拆掉关系。
 *
 * ## 交互只有两条
 *
 *   1. **连一条边**：按住卡片右边缘那个圆点，拖到另一张卡片上松手。
 *   2. **删一条边**：点箭头中点那个小叉。
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
      const { cards: cardList, edges, layout, graph, actions, t, css, cx, degraded, diagnostic } = props;
      const canvasRef = useRef(null);
      /** 正在拉的那条线：`{ from, x, y }`，`x` / `y` 是画布坐标。 */
      const [drag, setDrag] = useState(null);
      /** 上一次被拒绝的原因码；下一次成功连边或换手势时清掉。 */
      const [rejectCode, setRejectCode] = useState(null);
      /** 正在编辑说明的那条边 `{ from, to }`；null 表示没有在编辑。 */
      const [editing, setEditing] = useState(null);
      /** 编辑中的说明草稿。 */
      const [draft, setDraft] = useState('');

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
        const label = card.label === undefined || card.label === '' ? t('pane.untitled') : card.label;
        return h('div', {
          key: card.key,
          className: css.graphCard,
          style: { left: item.x + 'px', top: item.y + 'px', width: item.w + 'px', height: item.h + 'px' },
          'data-session': card.key,
          'data-running': card.running === true ? 'true' : 'false',
          /*
           * 点卡片 = 「去平铺里看这个会话」。这个会话没在任何窗格里打开时点了没意义，
           * 卡片的悬停提示会如实说明（而不是假装能跳过去）。
           */
          onClick: card.inPane === true ? () => actions.openPane(card.key) : undefined,
          title: card.inPane === true ? t('graph.openHint') : t('graph.noSessionHint'),
        },
          h('div', { key: 'ws', className: css.graphCardWorkspace }, card.workspaceTitle),
          h('div', { key: 'title', className: css.graphCardTitle }, label),
          h('div', { key: 'meta', className: css.graphCardMeta },
            card.running === true
              ? h('span', { key: 'dot', className: css.graphCardRunning }, t('pane.running'))
              : null),
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

      const lines = edges.map((edge) => {
        const from = itemsByKey.get(edge.from);
        const to = itemsByKey.get(edge.to);
        if (from === undefined || to === undefined) return null;
        const geometry = edgeGeometry(from, to);
        return h('g', { key: edge.from + '>' + edge.to },
          h('path', {
            d: geometry.d,
            className: css.graphEdge,
            fill: 'none',
          }),
          h('polygon', {
            points: geometry.ax + ',' + geometry.ay + ' ' + (geometry.ax - 7) + ',' + (geometry.ay - 4) + ' ' + (geometry.ax - 7) + ',' + (geometry.ay + 4),
            className: css.graphArrow,
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
       * 边上的说明标签：直接画在箭头中点上方，一眼看得出「这条线为什么存在」。
       * `pointer-events:none` —— 它只是说明，点击应当落到箭头/卡片上。
       */
      const noteLabels = edges.map((edge) => {
        if (typeof edge.note !== 'string' || edge.note === '') return null;
        const from = itemsByKey.get(edge.from);
        const to = itemsByKey.get(edge.to);
        if (from === undefined || to === undefined) return null;
        const geometry = edgeGeometry(from, to);
        const short = edge.note.length > 24 ? edge.note.slice(0, 24) + '…' : edge.note;
        return h('div', {
          key: 'note-' + edge.from + '>' + edge.to,
          className: css.graphEdgeNote,
          style: { left: geometry.mx + 'px', top: (geometry.my - 18) + 'px' },
          title: edge.note,
        }, short);
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
        h('div', { className: css.graphScroll },
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
            editor),
          cardList.length > 0 ? null : h('div', { className: css.graphEmpty }, t('board.emptyTitle')),
          diagnostic === undefined ? null : h('div', { key: 'diag', className: css.graphDiagnostic }, diagnostic)));
    }
    GraphBoard.displayName = 'GraphBoard';

    return { GraphBoard, edgeGeometry };
  },
});