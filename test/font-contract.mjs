/**
 * 离线契约测试：平铺面板的字体与消息浮现效果。
 *
 * 两件事分开验：
 *   1. Host 半边的字体路由 —— 字体文件真的由插件自己提供，文件名白名单、方法、
 *      Content-Type、HEAD 语义与未知路径都要对；
 *   2. 客户端样式 —— 两个 @font-face 指向那条路由、字体只作用于本面板（菜单 portal
 *      单独声明）、代码块仍走等宽字体，以及消息浮现动画只在聊天流的直接子项上。
 *
 *   node test/font-contract.mjs
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, check, report } from './dispatch-harness.mjs';
import { ReactStub, loadBundle } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// --- Host：字体路由 ---------------------------------------------------------------

/** 记录 `webServer.register` 收到的路由。 */
const routes = [];
const webServer = {
  register(route) {
    routes.push(route);
    return () => {
      const index = routes.indexOf(route);
      if (index >= 0) routes.splice(index, 1);
    };
  },
};
boot({ webServer });

const route = routes.find((candidate) => candidate.path === '/split-workspaces-fonts');
check('字体路由注册为 /split-workspaces-fonts 前缀路由', route !== undefined && route.kind === 'prefix');

/** 跑一次路由，收集 status / headers / body。 */
function callRoute(method, url) {
  const state = { status: 0, headers: {}, body: undefined, ended: false };
  route.handler({ method, url }, {
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers ?? {};
    },
    end(body) {
      state.body = body;
      state.ended = true;
    },
  });
  return state;
}

const chinesePath = join(here, '..', 'fonts', 'zcool-kuaile-chinese-simplified.woff2');
const latinPath = join(here, '..', 'fonts', 'zcool-kuaile-latin.woff2');
check('两个字体文件都存在', existsSync(chinesePath) && existsSync(latinPath));
check('中文字体是可用的 woff2 且体积合理', existsSync(chinesePath) && statSync(chinesePath).size > 200_000);

const chinese = callRoute('GET', '/split-workspaces-fonts/zcool-kuaile-chinese-simplified.woff2?v=1');
check('GET 中文字体返回 200 与 font/woff2', chinese.status === 200 && chinese.headers['content-type'] === 'font/woff2');
check('GET 返回的确实是 woff2（wOF2 文件头）', Buffer.isBuffer(chinese.body) && chinese.body.subarray(0, 4).toString() === 'wOF2');
check('Content-Length 与文件大小一致', chinese.status === 200 && Number(chinese.headers['content-length']) === statSync(chinesePath).size);
check('缓存头允许字体被浏览器缓存', chinese.status === 200 && /max-age=\d+/.test(chinese.headers['cache-control'] ?? ''));

const latin = callRoute('GET', '/split-workspaces-fonts/zcool-kuaile-latin.woff2?v=1');
check('GET 拉丁子集返回 200', latin.status === 200 && Buffer.isBuffer(latin.body) && latin.body.length < 20_000);

check('未知文件名返回 404', callRoute('GET', '/split-workspaces-fonts/nope.woff2').status === 404);
check('路径穿越不在白名单里，返回 404', callRoute('GET', '/split-workspaces-fonts/..%2Findex.js').status === 404);
check('POST 返回 405', callRoute('POST', '/split-workspaces-fonts/zcool-kuaile-latin.woff2').status === 405);
const head = callRoute('HEAD', '/split-workspaces-fonts/zcool-kuaile-latin.woff2');
check('HEAD 返回 200、有长度但不发 body', head.status === 200 && head.body === undefined && Number(head.headers['content-length']) > 0);

// --- 客户端：字体与动画 -----------------------------------------------------------

const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;
const CSS = mods.styles.CSS;

check('声明了两个 @font-face（中文 + 拉丁）', (CSS.match(/@font-face/g) ?? []).length === 2);
check('字体 URL 指向 Host 的字体路由',
  CSS.includes("src:url('/split-workspaces-fonts/zcool-kuaile-chinese-simplified.woff2?v=1')")
  && CSS.includes("src:url('/split-workspaces-fonts/zcool-kuaile-latin.woff2?v=1')"));
check('两个字体用 unicode-range 分工，不互相抢字符',
  CSS.includes('unicode-range:U+2E80-2EFF') && CSS.includes('unicode-range:U+0000-00FF'));
check('会话正文保持系统原字体（不在会话容器上覆盖字体）',
  !CSS.includes('[data-conversation-content]{--dsw-font-family'));
check('平铺面板的标题/按钮使用站酷快乐体',
  /\.dshSplitWs_root\{[^}]*--dsw-font-family:"SplitWorkspaceKuaile"/.test(CSS));
check('系统没有站酷快乐体时回退到系统中文字体',
  CSS.includes('"Noto Sans CJK SC","Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif'));
check('portal 菜单单独声明字体（不在 root 的继承链里）',
  /\.dshSplitWs_popoverList\{[^}]*--dsw-font-family/.test(CSS));
check('代码块没有被字体覆盖（仍用独立的 code token）',
  !CSS.includes('--ds-font-family-code:') && !CSS.includes('--dsw-font-markdown-code-font-family:'));
check('消息浮现 keyframes 存在', CSS.includes('@keyframes dshSplitWsTextRise'));
check('浮现只作用于助手正文（assistant-step 且非 reasoning）',
  CSS.includes('[data-conversation-content] [data-chat-flow-key][data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])')
  && CSS.includes('.dshSplitWs_paneBody [data-chat-flow-key][data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])'));
check('浮现按段落/列表项逐块播放，每块 2 秒',
  CSS.includes(':is(p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,table)')
  && CSS.includes('animation:dshSplitWsTextRise 2s'));
check('整条消息不再整体淡入（动画没有落在 flow item 本身）',
  !CSS.includes('animation:dshSplitWsTextRise .38s')
  && !/\[data-chat-flow-key\]\[data-chat-flow-kind="assistant-step"\]:not\(\[data-chat-group-part="reasoning"\]\)\{/.test(CSS));
check('用户消息、工具行、思考过程没有浮现',
  !CSS.includes('[data-chat-flow] > [data-chat-flow-key]')
  && !CSS.includes('[data-chat-flow-kind="user"]')
  && !CSS.includes('[data-chat-flow-kind="tool-call"]'));
check('浮现不碰正文里的行内节点', !CSS.includes('[data-chat-flow] [data-chat-flow-key] :is('));
check('减少动态偏好下关掉浮现', CSS.includes('prefers-reduced-motion:reduce') && CSS.includes('animation:none !important'));

report();
