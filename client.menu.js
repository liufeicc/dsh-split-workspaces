/**
 * 平铺面板的菜单块：弹出菜单与它用到的那些小图标 —— 棋盘上「人点得到」的零件。
 *
 * 这一层谁也不依赖：不知道窗格、不知道棋盘，只认 class 名与一个开关回调。
 * 从 client.view.js 拆出来，是因为视图块一度超过 800 行，而菜单零件本来就是独立的一层。
 *
 * 依赖由入口块注入（DSH 的包内代码块之间不能互相 require）：
 * createMenu({ css, cx }) 拿到 class 名对照表与拼接工具。
 *
 * 加载方式：入口 client.js 用 require.async('./client.menu.js') 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.menu.js',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const { useEffect, useLayoutEffect, useRef, useState } = React;
    const h = React.createElement;

    /** 组装菜单零件。 */
    function createMenu({ css, cx }) {
      /** 菜单触发器共用的小箭头。 */
      function Chevron() {
        return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: css.glyph },
          h('path', { d: 'M4 6.5 8 10.5 12 6.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
      }

      /** 侧边栏图标：2×2 的平铺格子，其中一格填实表示「有焦点」。 */
      function PanelIcon({ size = 18 }) {
        const edge = typeof size === 'number' ? size : 18;
        return h('svg', { width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, className: css.glyph },
          h('rect', { x: 3, y: 4, width: 8, height: 7, rx: 1.8, fill: 'currentColor' }),
          h('rect', { x: 13, y: 4, width: 8, height: 7, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.5 }),
          h('rect', { x: 3, y: 13, width: 8, height: 7, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.5 }),
          h('rect', { x: 13, y: 13, width: 8, height: 7, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.5 }));
      }

      /**
       * 分屏图标：一个框，加上「新窗格会出现的那条边」的分隔线。
       * 四个方向用同一套画法，只有那条线的位置不同。
       */
      function SplitGlyph({ direction }) {
        const vertical = direction === 'left' || direction === 'right';
        const line = vertical
          ? (direction === 'left' ? 'M6.5 3.2v9.6' : 'M9.5 3.2v9.6')
          : (direction === 'up' ? 'M3.2 6.5h9.6' : 'M3.2 9.5h9.6');
        return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: css.glyph },
          h('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
          h('path', { d: line, stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }));
      }

      /**
       * 文件夹图标：窗格标题栏上「用系统文件管理器打开这个工作区目录」的按钮。
       *
       * 画法与另外两个图标一致：14×14 视框、`stroke: currentColor`，因此焦点窗格
       * 标题栏上的白字配色会自动继承，不需要为它单写一条样式。
       */
      function FolderGlyph() {
        return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: css.glyph },
          h('path', {
            d: 'M2.2 4.4A1.2 1.2 0 0 1 3.4 3.2h2.3l1.3 1.6h5.6a1.2 1.2 0 0 1 1.2 1.2v6a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2z',
            stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
          }));
      }

      /**
       * 替换图标：两支方向相反的箭头（上下两条），说的是「把这一格的内容换掉」。
       *
       * 为什么不用文件夹 + 箭头：标题栏上已经有「打开目录」那个文件夹图标，再来一个
       * 带文件夹的图标会被当成同一个动作。两支反向箭头是「替换 / 对调」最省解释的画法，
       * 而且与另外三个图标同一套画法（14×14 视框、`stroke: currentColor`），
       * 焦点窗格标题栏上的白字配色自动继承。
       */
      function ReplaceGlyph() {
        return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: css.glyph },
          // 上面那条向右：「往这一格里放」。
          h('path', {
            d: 'M3 5.5h7.5M8 3l2.5 2.5L8 8',
            stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
          // 下面那条向左：「原来那个出去」。
          h('path', {
            d: 'M13 10.5H5.5M8 8l-2.5 2.5L8 13',
            stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
          }));
      }

      /**
       * 无遮罩的弹出菜单：点击别处或按 Esc 关闭。
       *
       * 传了 `icon` 就用一个纯图标按钮当触发器（窗格标题栏里的分屏菜单用它省地方），
       * 否则用「文字 + 小箭头」的按钮。
       *
       * 传了 `open` 就切成**受控**：内部不再自己记账，任何开关意图都回调
       * `onOpenChange`。分屏菜单用它——它有两段内容（先方向、再工作区），关闭时
       * 必须由外部把内容复位回第一段，否则下次打开会停在上次选的方向上。
       */
      function Popover({ label, title, disabled, align, icon, open: controlledOpen, onOpenChange, children }) {
        const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
        const controlled = controlledOpen !== undefined;
        const open = controlled ? controlledOpen : uncontrolledOpen;
        /** 统一的开关入口：受控时只上报，非受控时自己改，两者都通知回调。 */
        const setOpen = (next) => {
          const value = typeof next === 'function' ? next(open) : next;
          if (!controlled) setUncontrolledOpen(value);
          if (onOpenChange !== undefined) onOpenChange(value);
        };
        const rootRef = useRef(null);
        const menuRef = useRef(null);
        /** 菜单的 fixed 定位：`null` 表示还没量出来，先隐藏避免闪一下。 */
        const [anchor, setAnchor] = useState(null);
        const updateRef = useRef(null);
        useEffect(() => {
          if (!open) return undefined;
          const onPointerDown = (event) => {
            if (!(event.target instanceof Node)) return;
            const root = rootRef.current;
            const menu = menuRef.current;
            /*
             * 菜单已经 portal 到 body，不再位于 root 里。两处都要查，否则点菜单项
             * 会被当成「点了外面」而先关掉菜单，点击落不到目标上。
             */
            if (root !== null && root.contains(event.target)) return;
            if (menu !== null && menu.contains(event.target)) return;
            setOpen(false);
          };
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            setOpen(false);
          };
          document.addEventListener('mousedown', onPointerDown, true);
          document.addEventListener('keydown', onKeyDown, true);
          return () => {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
          };
        }, [open]);
        /*
         * 菜单的定位。
         *
         * 为什么不能再用 CSS 的 `position:absolute`：菜单原来挂在窗格标题栏里，
         * 而 `.dshSplitWs_pane` 是 `overflow:hidden`。窗格一窄，240px 宽的菜单
         * 必然超出窗格边界被裁掉（左右都一样）。portal 到 body 之后菜单不再受
         * 窗格裁切，再用 fixed 把它锚在触发器旁边：
         *   - 水平：align=end 时右边缘对齐触发器，向左展开；最后夹取到视口内；
         *   - 垂直：默认在下方，下面放不下且上面更宽裕时向上翻转；
         *   - 高度：按可用空间限制，超出时菜单内部滚动。
         */
        useLayoutEffect(() => {
          if (!open) {
            setAnchor(null);
            updateRef.current = null;
            return undefined;
          }
          const update = (event) => {
            const trigger = rootRef.current;
            const menu = menuRef.current;
            if (trigger === null) return;
            /*
             * 菜单自己滚动时不重算位置：否则每滚一格都把内容滚动误当成页面在动，
             * 菜单位置会跟着抖。只有窗口/窗格/棋盘的滚动才需要跟随触发器。
             */
            if (event !== undefined && menu !== null
              && event.target instanceof Node && menu.contains(event.target)) return;
            const margin = 8;
            const gap = 4;
            const rect = trigger.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const maxWidth = Math.max(80, Math.min(420, viewportWidth - margin * 2));
            const minWidth = Math.min(240, maxWidth);
            const menuWidth = menu === null
              ? minWidth
              : Math.max(minWidth, Math.min(menu.offsetWidth, maxWidth));
            let left = align === 'end' ? rect.right - menuWidth : rect.left;
            left = Math.max(margin, Math.min(left, viewportWidth - margin - menuWidth));
            const menuHeight = menu === null ? 0 : menu.offsetHeight;
            const below = viewportHeight - margin - (rect.bottom + gap);
            const above = rect.top - gap - margin;
            let top = rect.bottom + gap;
            let maxHeight = Math.min(340, Math.max(120, below));
            if ((menuHeight > below || below < 120) && above > below) {
              maxHeight = Math.min(340, Math.max(120, above));
              const used = menuHeight === 0 ? maxHeight : Math.min(menuHeight, maxHeight);
              top = Math.max(margin, rect.top - gap - used);
            }
            setAnchor({ top, left, minWidth, maxWidth, maxHeight });
          };
          updateRef.current = update;
          update();
          window.addEventListener('resize', update);
          /*
           * 用 rAF 合并滚动事件：棋盘滚动会连续触发几十次，没必要每次都 setState。
           * capture 才能听到窗格内部的滚动（scroll 不冒泡）。
           */
          let frame = 0;
          const onScroll = (event) => {
            if (frame !== 0) return;
            frame = requestAnimationFrame(() => {
              frame = 0;
              update(event);
            });
          };
          window.addEventListener('scroll', onScroll, true);
          return () => {
            updateRef.current = null;
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', onScroll, true);
            if (frame !== 0) cancelAnimationFrame(frame);
          };
        }, [open, align]);
        /*
         * 菜单内容会变：分屏菜单从「方向」切到「工作区」、MCP 勾选后多一行。
         * 高度一变就要重算上下翻转，所以用 ResizeObserver 盯着尺寸，而不是
         * 每次 render 都重算（那样很容易写出 setState 循环）。
         */
        useEffect(() => {
          if (!open) return undefined;
          const menu = menuRef.current;
          if (menu === null || typeof ResizeObserver === 'undefined') return undefined;
          const observer = new ResizeObserver(() => {
            if (updateRef.current !== null) updateRef.current();
          });
          observer.observe(menu);
          return () => observer.disconnect();
        }, [open]);
        const iconOnly = icon !== undefined;
        const menuStyle = anchor === null
          ? { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }
          : {
              position: 'fixed',
              top: anchor.top,
              left: anchor.left,
              minWidth: anchor.minWidth,
              maxWidth: anchor.maxWidth,
              maxHeight: anchor.maxHeight,
              zIndex: 1000,
            };
        return h('div', { className: css.popover, ref: rootRef },
          h('button', {
            type: 'button',
            className: iconOnly
              ? cx(css.iconButton, open && css.iconButtonOpen)
              : cx(css.trigger, open && css.triggerOpen),
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            title: title ?? label,
            'aria-label': iconOnly ? (title ?? label) : undefined,
            disabled: disabled === true,
            onClick: () => setOpen((value) => !value),
          }, iconOnly ? icon : h('span', { className: css.triggerLabel }, label), iconOnly ? null : h(Chevron, null)),
          open
            ? ReactDOM.createPortal(
                h('div', {
                  ref: menuRef,
                  className: css.popoverList,
                  role: 'menu',
                  style: menuStyle,
                }, typeof children === 'function' ? children(() => setOpen(false)) : children),
                document.body,
              )
            : null);
      }

      /**
       * 勾选标记：多选菜单用（本面板的 MCP 开关）。画法与其它图标同一套
       * （视框小、`stroke: currentColor`），焦点窗格标题栏上的白字配色自动继承。
       */
      function CheckGlyph() {
        return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: css.glyph },
          h('path', { d: 'M3.5 8.5 6.5 11.5 12.5 4.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));
      }

      /**
       * MCP 图标：一个插头 —— 「外部服务器接到本工作区」最直白的样子。
       *
       * 标题栏改成纯图标之后，这个图形是用户区分「MCP」与「技能」的唯一线索，所以两者
       * 的轮廓要有明显差别：插头是**带两根针的圆角块**，技能是**一颗四角星**。
       */
      function McpGlyph() {
        return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: css.glyph },
          h('path', {
            d: 'M5.2 2.2v2.4M10.8 2.2v2.4',
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
          }),
          h('path', {
            d: 'M3.6 4.6h8.8v2.1a4.4 4.4 0 0 1-4.4 4.4 4.4 4.4 0 0 1-4.4-4.4z',
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round',
          }),
          h('path', {
            d: 'M8 11.1v2.7',
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
          }));
      }

      /**
       * 技能图标：一颗四角星。
       *
       * 与「设置 → 技能」页里的技能库图标同源（那边是一叠卡片加一颗星），标题栏太小
       * 画不下卡片，就只留星 —— 用户在两处看到的是同一个符号。
       */
      function SkillGlyph() {
        return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: css.glyph },
          h('path', {
            d: 'M8 1.9 9.9 6.1 14.1 8 9.9 9.9 8 14.1 6.1 9.9 1.9 8 6.1 6.1Z',
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round',
          }));
      }

      /**
       * 垃圾桶图标：会话菜单里每行末尾那个「删除这个会话」按钮。
       *
       * 画法与另外几个图标同一套（16×16 视框、`stroke: currentColor`），因此按钮自己
       * 的配色（平时次要文字色、悬停危险色）直接生效，不必为图标单写一条样式。
       * 画成开盖 + 三条竖线，与侧边栏「…」菜单里那个删除是同一种东西，用户认得。
       */
      function TrashGlyph() {
        return h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: css.glyph },
          h('path', {
            d: 'M3 5h10M6.5 5V3.5h3V5M5 5l.6 8h4.8L11 5M6.8 7.4v4M9.2 7.4v4',
            stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
          }));
      }

      /**
       * 菜单行末尾的图标按钮：删除这一行代表的那个东西。
       *
       * 为什么单独一个组件、而不是复用 `MenuItem`：`MenuItem` 是 `<button>`，而它要放在
       * 一行可点击的会话项**旁边**。一个按钮里套一个按钮是无效 HTML，浏览器会把里面那个
       * 拆到外面，点击落在谁身上就说不准了。所以两者平级，由调用方放进一个行容器
       * （`css.menuRow`）里；这里只管「长什么样、点了回调谁」。
       *
       * `label` 同时用作 `title` 与 `aria-label`：按钮里只有图标，读屏与悬停提示都得靠它，
       * 而调用方给的是一整句带会话名的说明（「删除会话“xxx”」），因此不同行不会混淆。
       */
      function MenuDeleteButton({ label, onClick }) {
        return h('button', {
          type: 'button',
          role: 'menuitem',
          className: cx(css.menuDelete),
          title: label,
          'aria-label': label,
          onClick,
        }, TrashGlyph());
      }

      /**
       * 弹出菜单里的一行。
       *
       * `checked` 给多选菜单用：传了（true/false 都算）就渲染一个勾选位，
       * 未勾选时**占位保留**，否则勾来勾去整行文字会左右跳。不传则是原来的单选语义。
       */
      function MenuItem({ label, hint, active, checked, onClick }) {
        return h('button', {
          type: 'button',
          role: checked === undefined ? 'menuitem' : 'menuitemcheckbox',
          'aria-checked': checked === undefined ? undefined : checked === true,
          className: cx(css.menuItem, active && css.menuItemActive),
          onClick,
        },
          checked === undefined
            ? null
            : h('span', { className: css.menuItemCheck, 'aria-hidden': true }, checked === true ? CheckGlyph() : null),
          h('span', { className: css.menuItemLabel, title: label }, label),
          hint === undefined ? null : h('span', { className: css.menuItemHint }, hint));
      }
      return { Chevron, PanelIcon, SplitGlyph, FolderGlyph, ReplaceGlyph, CheckGlyph, McpGlyph, SkillGlyph, TrashGlyph, Popover, MenuItem, MenuDeleteButton };
    }

    return { createMenu };
  },
});
