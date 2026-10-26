/**
 * 离线契约测试的共用测试台：断言记录、棋盘挂载、颜色对比度、以及从渲染结果里找元素的
 * 小工具。
 *
 * 三个契约测试（`layout-contract.mjs` 管平铺与菜单、`drag-contract.mjs` 管两种拖动、
 * `focus-contract.mjs` 管窗格几何与 `Alt+方向键`）都要「装一个带两个窗格的棋盘，再从渲染出的
 * 元素树里找窗格 / 菜单」，也要算「这处颜色在背景上够不够清楚」，因此放在这里共用，
 * 而不是复制三份。每个测试文件是独立进程，各装一次插件。
 *
 * 用法：
 *   const { check, report, renderBoard, paneDom } = await import('./board.mjs');
 *   check('说明', 条件);   // 立刻打印 ok / FAIL
 *   report();              // 最后打印汇总，并在有失败时把退出码置 1
 */
import { byName, createStubContext, findAll, mount, source } from './harness.mjs';

/** 失败的断言说明；`report()` 用它决定退出码。 */
const failures = [];

/**
 * 把 `#rgb` / `#rrggbb` 拆成三个通道值，并做 sRGB 反伽马。
 *
 * @param hex - 形如 `#4176e6` 或 `#fff` 的颜色。
 */
export function linearChannels(hex) {
  let value = hex.replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  return value.match(/../g).slice(0, 3).map((pair) => parseInt(pair, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
}

/** WCAG 相对亮度。 */
export function luminance(hex) {
  const [r, g, b] = linearChannels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 两个颜色的 WCAG 对比度（1~21）：正文文字要 ≥ 4.5，图标与边框这类非文字要 ≥ 3。 */
export function contrastRatio(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

/** 把强调色按 `percent` 与黑（`#000`）混合，模拟 CSS 里那条 color-mix。 */
export function mixWithBlack(hex, percent) {
  const channels = hex.replace('#', '').match(/../g).map((pair) => parseInt(pair, 16));
  const mixed = channels.map((channel) => Math.round(channel * (percent / 100)));
  return '#' + mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('');
}

/**
 * 把强调色按 `percent` 与白混合 —— 模拟「掺了透明度之后压在白底上」。
 * 浅色主题的棋盘底色就是白，所以这一支就是那条路子的显色。
 */
export function mixWithWhite(hex, percent) {
  const channels = hex.replace('#', '').match(/../g).map((pair) => parseInt(pair, 16));
  const mixed = channels.map((channel) => Math.round(channel * (percent / 100) + 255 * (1 - percent / 100)));
  return '#' + mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('');
}


/**
 * 记录一条断言结果。
 *
 * @param label - 人话说明（中文），失败时它就是定位问题的线索。
 * @param condition - 判定结果。
 * @param detail - 可选的实际值，方便看「差在哪」。
 */
export function check(label, condition, detail) {
  if (condition) {
    console.log('ok   ' + label);
    return;
  }
  failures.push(label);
  console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

/** 打印汇总并按需设置退出码；每个测试文件在最后调用一次。 */
export function report() {
  if (failures.length > 0) {
    console.error('\n' + String(failures.length) + ' check(s) failed');
    process.exitCode = 1;
    return;
  }
  console.log('\nall checks passed');
}

/**
 * 挂载棋盘：两个窗格、各自一个可选的会话。
 *
 * @param mod - 已装载的插件入口（`loadBundle` 的返回值）；`apply` 与插槽注册都从它来。
 * @param options.pickedPath - 文件夹选择器返回的路径；`null` 表示用户取消。
 * @param options.pickerThrows - 让文件夹选择器直接失败，用来检查报错文案。
 * @param options.createdId - `workspaces.create` 建出来的工作区 id。
 */
export async function renderBoard(mod, { pickedPath = '/tmp/new', pickerThrows = false, createdId = 'ws-new' } = {}) {
  const stub = createStubContext({ presets: [] });
  await mod.apply(stub.ctx);
  const main = stub.registered.find((definition) => definition.name === 'main');
  const injected = main.inject();
  injected.paneStore.addPane('ws-a');
  injected.paneStore.addPane('ws-b');

  const workspaces = source({
    items: [
      { workspaceId: 'ws-a', title: 'alpha', path: '/tmp/alpha', sessionIds: ['s-a', 's-blank'] },
      { workspaceId: 'ws-b', title: 'beta', path: '/tmp/beta', sessionIds: ['s-b'] },
      // 第三个工作区故意不铺开：分屏菜单第二步应当把它排在已铺开的前面。
      { workspaceId: 'ws-c', title: 'gamma', path: '/tmp/gamma', sessionIds: [] },
    ],
    archivedSessionIds: [],
  });
  const sessions = source({
    ids: ['s-a', 's-b', 's-blank'],
    byId: {
      's-a': { id: 's-a', displayTitle: 'a', blank: false, origin: 'user', updatedAt: 2, retainedBy: {}, projectionValues: {} },
      's-b': { id: 's-b', displayTitle: 'b', blank: false, origin: 'user', updatedAt: 1, retainedBy: {}, projectionValues: {} },
      // 没发过消息的空白会话：会话菜单不该列它，但「新建会话」应当优先复用它。
      's-blank': { id: 's-blank', displayTitle: '', blank: true, origin: 'user', updatedAt: 3, retainedBy: {}, projectionValues: {} },
    },
  });
  /** 记录 `workspaces.create` 收到的参数、`connectWorkspace` 的调用次数与 `pickDirectory` 的次数。 */
  const createdWith = [];
  let pickCount = 0;
  let connectCount = 0;
  const render = () => mount(main.component, {
    ...injected,
    t: stub.ctx.locale.bind('split-workspaces'),
    sessions: { retain: () => ({ release: () => {} }) },
    sessionList: sessions,
    workspaces: {
      ...injected.workspaces,
      list: workspaces,
      create: (input) => {
        createdWith.push(input);
        return Promise.resolve({ workspaceId: createdId });
      },
    },
    uiWorkspace: {
      connectWorkspace: () => {
        connectCount += 1;
        return Promise.resolve('s-new');
      },
      pickDirectory: () => {
        pickCount += 1;
        return pickerThrows ? Promise.reject(new Error('no picker')) : Promise.resolve(pickedPath);
      },
    },
    renderSlot: () => null,
    // 真实的 SessionProvider 在没有会话时会渲染 empty 兜底，这里保持同样语义，
    // 这样「窗格空白时提示先选会话」这类断言检查的就是真实渲染结果。
    SessionProvider: function SessionProvider(props) { return props.session === undefined ? props.empty() : null; },
  });
  return { stub, paneStore: injected.paneStore, render, createdWith, pickCount: () => pickCount, connectCount: () => connectCount };
}

/** 打开某个窗格的分屏菜单并点掉第一步的方向，返回停在第二步的窗格挂载。 */
export function openWorkspaceStep(board, paneKey, directionLabel) {
  const pane = paneDom(board.render().tree, paneKey);
  splitMenuOf(pane.tree).items.find((item) => item.props.label === directionLabel).props.onClick();
  pane.flush();
  return pane;
}

/** 棋盘上的窗格元素，按渲染顺序。 */
export const framesOf = (tree) => findAll(tree, byName('PaneFrame'));

/** 找某个窗格元素（按 pane key）。 */
export const frameOf = (tree, key) => framesOf(tree).find((node) => node.props.pane.key === key);

/** 挂载某个窗格，得到它真正渲染出的 DOM 元素（焦点、按钮都在里面）。 */
export const paneDom = (tree, key) => {
  const frame = frameOf(tree, key);
  if (frame === undefined) return undefined;
  return mount(frame.type, frame.props);
};

/** 一个窗格的标题栏元素。 */
export const paneHeadOf = (dom) => findAll(dom, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('dshSplitWs_paneHead'))[0];

/** 弹出菜单的 `children` 渲染函数，兼容替身存放它的两种方式。 */
export function popoverRender(popover) {
  if (typeof popover.props.children === 'function') return popover.props.children;
  if (typeof popover.children?.[0] === 'function') return popover.children[0];
  throw new Error('弹出菜单没有 children 渲染函数');
}

/** 一个窗格标题栏里的分屏菜单：触发器 + 菜单内容（`rows` 是渲染函数给出的原始元素）。 */
export function splitMenuOf(dom) {
  const popover = findAll(dom, byName('Popover')).find((node) => node.props.title === '分屏');
  if (popover === undefined) return undefined;
  const rows = popoverRender(popover)(() => {});
  const items = findAll(rows, byName('MenuItem'));
  return { popover, rows, items, labels: items.map((item) => item.props.label) };
}

/**
 * 一个窗格标题栏里的「替换工作区」菜单。
 *
 * 按元素的 `key === 'replace'` 找，不按 title 找：这个菜单的 title 是一句说明
 * （「把这一格换成另一个工作区（位置不变）」），改文案不该让测试失效。
 */
export function replaceMenuOf(dom) {
  const popover = findAll(dom, byName('Popover')).find((node) => node.props.key === 'replace');
  if (popover === undefined) return undefined;
  const rows = popoverRender(popover)(() => {});
  const items = findAll(rows, byName('MenuItem'));
  return { popover, rows, items, labels: items.map((item) => item.props.label) };
}

/**
 * 一个窗格标题栏里的「切换会话」菜单：会话行（行内左半是会话项、右半是删除按钮）、
 * 每个会话行末尾那个删除按钮，以及「新建会话」那一项。
 *
 * 按元素的 `key === 'session'` 找，理由与 replace 那个一样：title 是说明文字
 * （「切换会话」），不是识别标识。
 *
 * @param dom - 窗格的渲染树。
 * @param close - 传给菜单 children 渲染函数的关闭函数；测试用它断言「点一下先关菜单」。
 */
export function sessionMenuOf(dom, close = () => {}) {
  const popover = findAll(dom, byName('Popover')).find((node) => node.props.key === 'session');
  if (popover === undefined) return undefined;
  const rows = popoverRender(popover)(close);
  const items = findAll(rows, byName('MenuItem'));
  const rowNodes = findAll(rows, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('dshSplitWs_menuRow'));
  const deletes = findAll(rows, byName('MenuDeleteButton'));
  return { popover, rows, items, rowNodes, deletes };
}
