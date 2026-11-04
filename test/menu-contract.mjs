/**
 * 顶部弹出菜单的离线契约测试。
 *
 * 真机问题：窗格拖窄后，菜单被 `.dshSplitWs_pane { overflow:hidden }` 裁掉。
 * 修法是把菜单 portal 到 body、用 fixed 定位。离线测试没有真实 DOM，所以这里
 * 守住「结构」：确实走 createPortal、容器是 body、菜单是 fixed、宽度按视口兜底。
 * 左右夹取与上下翻转属于浏览器几何，不在这里模拟。
 *
 * 用法：`node test/menu-contract.mjs`
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, report } from './board.mjs';
import {
  ReactDomStub, ReactStub, findAll, loadBundle, mount,
} from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const styles = await loadBundle(join(here, '..', 'client.styles.js'), { react: ReactStub });
const menuModule = await loadBundle(join(here, '..', 'client.menu.js'), { react: ReactStub });
const { Popover } = menuModule.createMenu({ css: styles.css, cx: styles.cx });

/* 记下 portal 调用：这是「菜单不再留在窗格 DOM 里」的直接证据。 */
const portals = [];
const originalCreatePortal = ReactDomStub.createPortal;
ReactDomStub.createPortal = (children, container) => {
  portals.push({ children, container });
  return children;
};

/* portal 的第二个参数会读 `document.body`；离线环境给一个最小替身。 */
globalThis.document = { body: { id: 'test-body' } };

const popover = mount(Popover, {
  label: '测试菜单',
  align: 'end',
  children: () => [],
});
const trigger = findAll(popover.tree, (node) => node.type === 'button')[0];
trigger.props.onClick();
popover.flush();

check('菜单打开后走 portal，而不是留在窗格 DOM 里', portals.length === 1, String(portals.length));
check('portal 的容器是 document.body', portals[0]?.container === globalThis.document.body);
const menu = findAll(popover.tree, (node) => node.props?.role === 'menu')[0];
check(
  '菜单用 fixed 定位（不再被窗格 overflow 裁切）',
  menu?.props?.style?.position === 'fixed',
  JSON.stringify(menu?.props?.style),
);
check(
  '菜单宽度的兜底值按视口收窄',
  styles.CSS.includes('min(240px,calc(100vw - 16px))'),
  '',
);

/* 再点一次触发器关闭，确认 portal 菜单从树上消失。 */
const closeTrigger = findAll(popover.tree, (node) => node.type === 'button')[0];
closeTrigger.props.onClick();
popover.flush();
check(
  '关闭后菜单不再出现在渲染树里',
  findAll(popover.tree, (node) => node.props?.role === 'menu').length === 0,
);

ReactDomStub.createPortal = originalCreatePortal;
delete globalThis.document;
report();