/**
 * 「用文件管理器打开工作区目录」的离线契约测试。
 *
 * 这条功能的实现**全部在浏览器半边**：它调用 dsh 自带的 Session 命名空间
 * （`remote.session.canOpenWorkspacePath` / `openWorkspacePath`），Host 那一半是
 * 别人的、别人测过的，所以这里要守住的是本插件这一侧：
 *   - 窗格标题栏上确实有那个按钮，key 唯一、位置对、工作区未知时禁用；
 *   - 点它问的是「这个部署能打开路径吗」，然后把**这一格**的路径交给
 *     `openWorkspacePath`（字段名就叫 `path`，形状不对 Host 会拒）；
 *   - 可用性只问一次；
 *   - 五种失败各自说出一句本地化的话（没有会话服务、没有图形环境、路径验不过、
 *     打开命令失败、连接断了），而不是把异常抛到窗格外面或者含糊地失败。
 *
 * 用法：`node test/open-contract.mjs`
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, report, renderBoard, paneDom, paneHeadOf } from './board.mjs';
import { ReactStub, findAll, loadBundle, settle } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * 假的 Session 命名空间
 * ------------------------------------------------------------------ */

/**
 * 造一个记账的 `remote.session` 替身。
 *
 * @param options.canOpen - `canOpenWorkspacePath()` 的答案。
 * @param options.open - `openWorkspacePath()` 的远端结果（`{ ok, value }` / `{ ok: false, error }`）。
 * @param options.canThrows - 让可用性查询在传输层失败。
 * @param options.openThrows - 让打开调用在传输层失败。
 */
function stubSession({ canOpen = true, open = { ok: true, value: { opened: true } }, canThrows = false, openThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    service: {
      canOpenWorkspacePath: () => {
        calls.push({ method: 'canOpenWorkspacePath' });
        if (canThrows) return Promise.reject(new Error('connection lost'));
        return Promise.resolve({ ok: true, value: canOpen });
      },
      openWorkspacePath: (request) => {
        calls.push({ method: 'openWorkspacePath', request });
        if (openThrows) return Promise.reject(new Error('connection lost'));
        return Promise.resolve(open);
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 客户端契约
 * ------------------------------------------------------------------ */

const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
check('用的是已经装好的 Session 命名空间（`remote.session`）',
  mod.test.SESSION_REMOTE_KEY === 'remote.session');
check('三个远端失败码都有对应的本地化说法',
  mod.test.OPEN_ERROR_KEYS['gateway/bad-request'] === 'pane.openBadPath'
  && mod.test.OPEN_ERROR_KEYS['gateway/internal'] === 'pane.openLaunchFailed'
  && mod.test.OPEN_ERROR_KEYS['gateway/cancelled'] === 'pane.openCancelled');
check('失败句是「前缀 + 本地化原因 + Host 原文」的完整句子',
  mod.test.openFailureText({ code: 'gateway/bad-request', message: 'Path has no verified Host path' }, (key) => key)
    === 'pane.openFailed: pane.openBadPath (Path has no verified Host path)'
  && mod.test.openFailureText({ code: 'weird' }, (key) => key) === 'pane.openFailed'
  && mod.test.openFailureText(undefined, (key) => key) === 'pane.openFailed');

/** 找一个窗格标题栏上的「打开工作区目录」按钮。 */
const openButtonOf = (dom) => findAll(dom, (node) => node.type === 'button'
  && node.props.title !== undefined && String(node.props.title).includes('打开工作区目录'))[0];

/** 窗格上的错误行文本。 */
const paneErrors = (pane) => findAll(pane.tree, (node) => typeof node.props.className === 'string'
  && node.props.className.includes('dshSplitWs_paneError')).map((node) => JSON.stringify(node.children));

/**
 * 挂一块棋盘并给它装上假的 Session 命名空间。
 * @returns `{ board, session }`。
 */
async function boardWith(options) {
  const board = await renderBoard(mod);
  const session = stubSession(options);
  board.stub.services.set(mod.test.SESSION_REMOTE_KEY, session.service);
  return { board, session };
}

/** 点某个窗格标题栏上的文件夹按钮，等异步回来后再刷一遍渲染。 */
async function clickOpen(board, paneKey) {
  const pane = paneDom(board.render().tree, paneKey);
  openButtonOf(pane.tree).props.onClick();
  await settle();
  pane.flush();
  return pane;
}

/* ---------- 按钮本身 ---------- */

const plain = await renderBoard(mod);
const pane = paneDom(plain.render().tree, 'pane-1');
const button = openButtonOf(pane.tree);
check('窗格标题栏上有「打开工作区目录」按钮', button !== undefined);
check('它是个带固定 key 的图标按钮，复用标题栏的按钮样式',
  button !== undefined && button.props.key === 'open'
  && button.props.className.includes('dshSplitWs_iconButton') && button.props.type === 'button');
check('它有可读的名字（无障碍标签同标题）',
  button.props['aria-label'] === button.props.title && button.props.title !== '');
check('按钮挨着工作区名 / 路径，排在「替换工作区」与分屏按钮之前',
  (() => {
    // 「打开目录」与「替换工作区」都是**这一格的工作区**上的动作，因此排在
    // 分屏（会动布局）之前。
    const keys = (paneHeadOf(pane.tree).children ?? []).flat().filter(Boolean).map((child) => child.props.key);
    return keys.join(',') === 'heading,open,replace,split,session,close';
  })());

// 工作区还不知道是哪个：没有路径可开，按钮必须是灰的。
plain.paneStore.addPane('ws-gone');
const orphanButton = openButtonOf(paneDom(plain.render().tree, 'pane-3').tree);
check('工作区不认识时按钮禁用（没有路径可开）',
  orphanButton !== undefined && orphanButton.props.disabled === true);

/* ---------- 成功这条路 ---------- */

const opened = await boardWith({});
const openedPane = await clickOpen(opened.board, 'pane-1');
check('先问「这个部署能不能打开路径」，再把**这一格**的工作区路径交出去',
  opened.session.calls.length === 2
  && opened.session.calls[0].method === 'canOpenWorkspacePath'
  && opened.session.calls[1].method === 'openWorkspacePath'
  && JSON.stringify(opened.session.calls[1].request) === JSON.stringify({ path: '/tmp/alpha' }));
check('打开成功时不留报错', paneErrors(openedPane).length === 0);

// 可用性是部署级事实：再点一次（另一个窗格）不该重新问一遍。
const secondPane = await clickOpen(opened.board, 'pane-2');
check('可用性只问一次，第二次点击直接打开',
  opened.session.calls.length === 3
  && opened.session.calls[2].method === 'openWorkspacePath'
  && opened.session.calls[2].request.path === '/tmp/beta'
  && paneErrors(secondPane).length === 0);

/* ---------- 失败这条路 ---------- */

// 1) 这个部署没有图形环境（Host 说 canOpenWorkspacePath 为 false）：
//    说清是部署不行，并且不去发那个注定失败的命令。
const headless = await boardWith({ canOpen: false });
const headlessPane = await clickOpen(headless.board, 'pane-1');
check('没有图形环境时说明是部署的限制，且不去调 openWorkspacePath',
  paneErrors(headlessPane).some((text) => text.includes('这个部署不能把路径交给桌面'))
  && headless.session.calls.length === 1);

// 2) 路径验不过（Host 的 gateway/bad-request）：本地化原因 + Host 原文。
const badPath = await boardWith({
  open: { ok: false, error: { code: 'gateway/bad-request', message: 'Path has no verified Host path' } },
});
const badPathPane = await clickOpen(badPath.board, 'pane-1');
check('路径验不过时说「这个路径在 Host 上不是一个目录」，并带上原文',
  paneErrors(badPathPane).some((text) => text.includes('打开工作区目录失败')
    && text.includes('这个路径在 Host 上不是一个目录') && text.includes('Path has no verified Host path')));

// 3) 打开命令失败（gateway/internal）。
const launchFailed = await boardWith({
  open: { ok: false, error: { code: 'gateway/internal', message: 'path open failed' } },
});
const launchFailedPane = await clickOpen(launchFailed.board, 'pane-1');
check('底层打开命令失败时说「文件管理器没能起来」',
  paneErrors(launchFailedPane).some((text) => text.includes('文件管理器没能起来')));

// 4) 这个部署里没有会话服务（没挂 session-controller）。
const noService = await renderBoard(mod);
const noServicePane = await clickOpen(noService, 'pane-1');
check('没有会话服务时直接说明，而不是静默无事发生',
  paneErrors(noServicePane).some((text) => text.includes('这个部署里没有会话服务')));

// 5) 传输层失败：不能把异常抛到窗格外面。
const down = await boardWith({ openThrows: true });
const downPane = await clickOpen(down.board, 'pane-1');
check('连接断了时收口成一句可读的失败，不把异常抛出去',
  paneErrors(downPane).some((text) => text.includes('打开工作区目录失败') && text.includes('connection lost')));
check('失败之后按钮回到可用状态（不会永久禁用）',
  openButtonOf(downPane.tree).props.disabled !== true);

// 可用性查询本身失败也要收口。
const downCan = await boardWith({ canThrows: true });
const downCanPane = await clickOpen(downCan.board, 'pane-1');
check('可用性查询失败时同样只报一句失败',
  paneErrors(downCanPane).some((text) => text.includes('打开工作区目录失败') && text.includes('connection lost'))
  && downCan.session.calls.length === 1);

/* ---------- 文案 ---------- */

const dicts = await mod.test.chunks;
const zh = dicts.dicts.zh;
const en = dicts.dicts.en;
const openKeys = ['pane.openWorkspace', 'pane.openingWorkspace', 'pane.openFailed', 'pane.openNoService',
  'pane.openNoDesktop', 'pane.openBadPath', 'pane.openLaunchFailed', 'pane.openCancelled'];
check('中英文案都齐（按钮名、忙碌态、失败前缀与五条原因）',
  openKeys.every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));

report();
