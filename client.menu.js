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
    const { useEffect, useRef, useState } = React;
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
        useEffect(() => {
          if (!open) return undefined;
          const onPointerDown = (event) => {
            const root = rootRef.current;
            if (root !== null && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
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
        const iconOnly = icon !== undefined;
        return h('div', { className: cx(css.popover, align === 'end' && css.popoverEnd), ref: rootRef },
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
            ? h('div', { className: css.popoverList, role: 'menu' },
                typeof children === 'function' ? children(() => setOpen(false)) : children)
            : null);
      }

      /** 弹出菜单里的一行。 */
      function MenuItem({ label, hint, active, onClick }) {
        return h('button', {
          type: 'button',
          role: 'menuitem',
          className: cx(css.menuItem, active && css.menuItemActive),
          onClick,
        },
          h('span', { className: css.menuItemLabel, title: label }, label),
          hint === undefined ? null : h('span', { className: css.menuItemHint }, hint));
      }
      return { Chevron, PanelIcon, SplitGlyph, FolderGlyph, Popover, MenuItem };
    }

    return { createMenu };
  },
});
