/**
 * 离线契约测试：窗格「切换会话」下拉里的**删除会话**。
 *
 * 要盯住的是四件事，它们各自都能单独坏掉：
 *   1. **每行一个删除按钮**，按钮是会话项**旁边**平级的 `<button>`，而不是塞在
 *      `MenuItem`（它自己就是按钮）里面 —— 按钮套按钮是无效 HTML，浏览器会把内层拆
 *      到外面，点击落到谁身上就说不准了；
 *   2. 点哪一行就删哪一行：请求里的 `sessionId` / `displayTitle` 必须来自**那一行**，
 *      而不是「窗格当前显示的那个会话」（两者经常不是同一个，这正是逐行删除的意义）；
 *   3. 删除本身不在这里实现：请求交给 `@local/dsh-session-delete` 的确认弹窗
 *      （`ctx.get('sessionDeleteUi')` 惰性解析），删成功的收尾走 `onDeleted`；
 *   4. 服务不在（没装那个插件）时**不假装删掉了**：在窗格错误行里说清楚。
 *
 * 还有一条与删除本身无关、但删除必须做对的不变量：一个会话可能同时显示在好几格上
 * （跟随型窗格会自动选中本工作区最新的会话），删掉之后**每一格**都得松手 ——
 * 只清发起删除的那一格，别的格子会一直指着一个已经不存在的会话。
 *
 *   node test/delete-contract.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReactStub, byClass, byName, findAll, loadBundle } from './harness.mjs';
import { check, report, renderBoard, paneDom, sessionMenuOf } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;

check('入口声明了删除服务的键（与 session-delete 半边同名）', mod.test.SESSION_DELETE_UI_KEY === 'sessionDeleteUi');

/*
 * 样式与词典：样式表里必须有这两个 class 的实际规则，中英文案三个键都得有。
 * 少哪一样，界面上都会退化成「一个没有样式的裸图标」或「一整句英文键名」。
 */
const { CSS, css } = mods.styles;
check('样式表里有菜单行与删除按钮的规则', CSS.includes('.' + css.menuRow + '{') && CSS.includes('.' + css.menuDelete + '{'));
check('class 名对照表与样式表一致', css.menuRow === 'dshSplitWs_menuRow' && css.menuDelete === 'dshSplitWs_menuDelete');
for (const key of ['pane.deleteSession', 'pane.deleteSessionNamed', 'pane.deleteUnavailable']) {
  check('词典里有 ' + key + '（中英各一份）', typeof mods.dicts.zh[key] === 'string' && typeof mods.dicts.en[key] === 'string');
}

/*
 * 第一块棋盘：装上假的删除服务，检查「谁被请求删除」。
 * 服务放在 `ctx.get` 的替身表里而不是 inject 列表里：真实的插件就是这么拿它的，
 * 于是这里走的也是同一条惰性解析路径。
 */
const board = await renderBoard(mod);
const requests = [];
board.stub.services.set('sessionDeleteUi', {
  request: (call) => {
    requests.push(call);
    return true;
  },
});

const pane1 = paneDom(board.render().tree, 'pane-1');
let closed = 0;
const menu = sessionMenuOf(pane1.tree, () => {
  closed += 1;
});

check('「新建会话」仍在菜单里', menu.items.some((item) => item.props.label === '新建会话'));
check('每个会话一行（本工作区只有一个会话，故一行）', menu.rowNodes.length === 1 && menu.deletes.length === 1);
check('「新建会话」那一项没有删除按钮', menu.rowNodes.every((row) => findAll(row, byName('MenuItem')).length === 1) && menu.items.filter((item) => findAll(item, byName('MenuDeleteButton')).length > 0).length === 0);

const row = menu.rowNodes[0];
const sessionItem = findAll(row, byName('MenuItem'))[0];
const deleteButton = findAll(row, byName('MenuDeleteButton'))[0];
/** 那个组件真正渲染出来的元素（替身树里组件元素与 DOM 元素是两层，断言要看后者）。 */
const deleteDom = deleteButton.type(deleteButton.props);
check('会话项与删除按钮是同一行的两个平级按钮', row.children.includes(sessionItem) && row.children.includes(deleteButton));
check('删除按钮是 <button>，且有角色与无障碍名字', deleteDom.type === 'button' && deleteDom.props.role === 'menuitem' && typeof deleteDom.props['aria-label'] === 'string');
check('删除按钮的提示语带着这一行会话的名字', deleteDom.props['aria-label'] === '删除会话“a”' && deleteDom.props.title === deleteDom.props['aria-label'], deleteDom.props['aria-label']);
check('删除按钮里画的是图标而不是文字', findAll(deleteDom, (node) => node.type === 'svg').length === 1);

// 点删除：先关菜单，再把这一行交给确认弹窗，且**不**直接改窗格状态。
deleteButton.props.onClick();
check('点删除会先把菜单关掉', closed === 1, String(closed));
check('删除请求带着这一行的会话 id 与名字', requests.length === 1 && requests[0].sessionId === 's-a' && requests[0].displayTitle === 'a', JSON.stringify(requests[0] ?? null));
check('删除请求带着「删成功之后」的收尾回调', typeof requests[0].onDeleted === 'function');
check('光点一下不直接改窗格状态（删除还没确认）', board.paneStore.getSnapshot().panes.every((pane) => pane.sessionId === null));

// 另一个工作区的窗格：它的删除按钮带的是**它自己那行**的会话，与 pane-1 无关。
const pane2 = paneDom(board.render().tree, 'pane-2');
const menu2 = sessionMenuOf(pane2.tree);
menu2.deletes[0].props.onClick();
check('另一个窗格的删除按钮带的是它自己那一行的会话', requests.length === 2 && requests[1].sessionId === 's-b' && requests[1].displayTitle === 'b', JSON.stringify(requests[1] ?? null));

/*
 * 删成功的收尾：一个会话可能同时显示在好几格上（跟随型窗格会自动选中本工作区最新的
 * 会话，用户也可以在两格里选同一个），因此这里把两格都钉到 s-a 上，再走一次回调。
 */
board.paneStore.setSession('pane-1', 's-a');
board.paneStore.setSession('pane-2', 's-a');
requests[0].onDeleted('s-a');
const afterDelete = board.paneStore.getSnapshot().panes;
check('删成功后所有钉着它的窗格都松手了', afterDelete.every((pane) => pane.sessionId === null), JSON.stringify(afterDelete));
check('forgetSession 对没人钉着的会话返回 false', board.paneStore.forgetSession('s-zzz') === false);
check('forgetSession 对空 id 什么也不做', board.paneStore.forgetSession(null) === false && board.paneStore.forgetSession(undefined) === false);
check('松手后跟随型窗格回退到本工作区最新的会话', (() => {
  const pane = paneDom(board.render().tree, 'pane-1');
  return pane.props.sessionId === 's-a' && pane.props.pane.follow === true;
})());

/*
 * 第二块棋盘：`ctx.get` 里**没有**删除服务（没装 dsh-session-delete）。
 * 这时不能假装删掉了：错误行里要说清是哪一件事没准备好。
 */
const lonely = await renderBoard(mod);
const lonelyPane = paneDom(lonely.render().tree, 'pane-1');
const lonelyMenu = sessionMenuOf(lonelyPane.tree);
lonelyMenu.deletes[0].props.onClick();
lonelyPane.flush();
const errorLine = findAll(lonelyPane.tree, byClass('dshSplitWs_paneError'))[0];
check('没有删除服务时窗格明说「删除功能没准备好」', errorLine !== undefined && errorLine.children[0] === mods.dicts.zh['pane.deleteUnavailable'], errorLine === undefined ? '没有错误行' : String(errorLine.children[0]));

/*
 * 服务是**惰性**解析的：注入面里拿到的那个函数每次点击都重新 `ctx.get` 一次，
 * 因此「面板先渲染、删除服务后挂上」这条真实时序也能自愈 —— 用 updateProps 模拟
 * 父组件重新传下一份注入面（真实的挂载早于/晚于渲染都可能发生）。
 */
const late = await renderBoard(mod);
const lateInjected = late.stub.registered.find((definition) => definition.name === 'main').inject();
const latePane = paneDom(late.render().tree, 'pane-1');
const lateRequests = [];
late.stub.services.set('sessionDeleteUi', { request: (call) => { lateRequests.push(call); return true; } });
latePane.updateProps({ ...latePane.props, requestSessionDelete: lateInjected.requestSessionDelete });
sessionMenuOf(latePane.tree).deletes[0].props.onClick();
check('删除服务晚于渲染挂上时，点一下照样能删（惰性解析）', lateRequests.length === 1 && lateRequests[0].sessionId === 's-a');

report();
