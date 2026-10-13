/**
 * 真浏览器实测：**窗格标题栏的「替换工作区」**。
 *
 *   node tools/replace-probe.mjs
 *
 * 离线契约测试（`test/layout-contract.mjs`）验的是存储与菜单的语义：布局树不动、
 * 别的窗格是同一个对象、会话被清掉。但有几件事只有真浏览器答得出来，这个探针专门量它们：
 *
 *   1. 那个图标按钮**真的点得开**（弹出菜单是插件自己的受控浮层，React 替身里没有真实
 *      事件派发与浮层挂载）；
 *   2. 菜单里列出的候选**真的没有已经铺开的工作区** —— 这是「位置不变、换一个进来」这条
 *      语义的界面部分；
 *   3. 选中一行之后，那一格**还在原地**（矩形与 DOM 节点都没换），只是标题与对话变了：
 *      矩形不变是「替换而不是关掉再开一格」的唯一可见证据，DOM 节点不变则说明这一格
 *      没有被卸载重建（重建会丢掉输入框草稿与滚动位置）。
 *
 * 需要本机有 `google-chrome`（或 `chromium`）与可用的 `dsh`（用来起一个**独立的**
 * web 服务），因此**不进**离线契约测试。可以用环境变量覆盖：
 *
 *   DSH_PROBE_CHROME=/path/to/chrome          浏览器
 *   DSH_REPLACE_PROBE_URL=http://…/?token=…   直接复用已经开着的服务，不再自己起
 *
 * 探针连的是一个自己新起的服务与一个无头浏览器，**不碰你正开着的窗口**。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSER = process.env.DSH_PROBE_CHROME ?? 'google-chrome';
const DSH_BIN = process.env.DSH_PROBE_DSH ?? 'dsh';
const CDP_PORT = Number(process.env.DSH_REPLACE_PROBE_PORT ?? 9353);
const GIVEN_URL = process.env.DSH_REPLACE_PROBE_URL;
/** 面板在侧边栏那一行的可访问名（词典里的 `panel.title`）。 */
const PANEL_LABEL = process.env.DSH_REPLACE_PROBE_PANEL ?? '多工作区平铺';
/**
 * 替换按钮的可访问名 —— 就是词典里 `pane.replaceHint` 那句话。
 * 图标按钮没有可见文字，只能靠它认（离线测试走的是元素的 key，不看文案）。
 */
const REPLACE_LABEL = process.env.DSH_REPLACE_PROBE_LABEL ?? '把这一格换成另一个工作区（位置不变）';
/** 弹出菜单里「新建工作区…」那一行（词典 `panel.newWorkspace`）。 */
const NEW_WORKSPACE = '新建工作区…';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
/** 记录一条断言，失败时把实际值一并打出来。 */
function check(label, condition, detail) {
  if (condition) {
    console.log('ok   ' + label);
    return;
  }
  failures += 1;
  console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

/** 报告一条「量出来的事实」，不判失败 —— 用于已知边界与截图路径。 */
function note(label, detail) {
  console.log('note ' + label + (detail === undefined ? '' : ' — ' + detail));
}

/** 极简 CDP 客户端：够用就好，不为一个探针引依赖。 */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('连不上 DevTools')));
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const slot = this.pending.get(message.id);
      if (slot === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) slot.reject(new Error(JSON.stringify(message.error)));
      else slot.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** 求值并取回值；页面里抛错就直接失败，别把错当成 undefined。 */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails !== undefined) {
      throw new Error('页面里报错: ' + String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    }
    return result.result.value;
  }

  close() { this.ws.close(); }
}

/** 等 DevTools 起来，返回页面 target。 */
async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + String(CDP_PORT) + '/json/list')).json();
      const page = list.find((target) => target.type === 'page');
      if (page !== undefined) return page;
    } catch (error) {
      // 还没起来，继续等。
    }
    await sleep(500);
  }
  throw new Error('DevTools 一直没就绪');
}

/**
 * 自己起一个独立的 `dsh web`：探针要能看到真实的平铺面板，又不能干扰用户正开着的窗口，
 * 因此宁可多花一次冷启动的时间。
 */
async function startServer() {
  const child = spawn(DSH_BIN, ['web', '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const matched = /\bdsh web:\s+(https?:\/\/\S+)/.exec(output);
    if (matched !== null) return { child, url: matched[1] };
    if (child.exitCode !== null) throw new Error('dsh web 起不来：' + output.slice(-500));
    await sleep(500);
  }
  child.kill('SIGKILL');
  throw new Error('等了两分钟也没等到 dsh web 的访问地址');
}

/** 打开平铺面板，等到棋盘上有窗格。 */
async function openBoard(cdp) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(1000);
    const ready = await cdp.eval('!!document.querySelector(\'button[aria-label=' + JSON.stringify(PANEL_LABEL) + ']\')');
    if (ready === true) break;
  }
  const clicked = await cdp.eval(`(() => {
    const button = document.querySelector('button[aria-label=${JSON.stringify(PANEL_LABEL)}]');
    if (button === null) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) throw new Error('侧边栏里找不到「' + PANEL_LABEL + '」那一行');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(1000);
    if (await cdp.eval("document.querySelectorAll('[data-pane]').length") > 0) return;
  }
  throw new Error('棋盘一直没渲染出窗格');
}

/**
 * 棋盘上每个窗格的现场：key、矩形、标题栏文字、是否还在读会话，以及探针打过的 DOM 标记。
 *
 * `probePane` 是探针在替换**之前**写在这一格上的 `dataset` 值。替换之后它还在，就说明
 * 这一格是**同一个 DOM 节点**（没有被卸载重建）—— 那正是「位置不变、只换内容」想要的。
 */
const READ = `[...document.querySelectorAll('[data-pane]')].map((el) => {
  const rect = el.getBoundingClientRect();
  const head = el.querySelector('div');
  const lines = head === null ? [] : head.innerText.split('\\n');
  const box = el.querySelector('[contenteditable]');
  return {
    key: el.getAttribute('data-pane'),
    rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
    name: lines[0] ?? '',
    path: lines[1] ?? '',
    body: el.innerText.replace(/\\s+/g, ' ').slice(0, 400),
    loading: el.innerText.includes('正在打开会话'),
    hasComposer: box !== null,
    tagged: el.dataset.probePane ?? null,
  };
})`;

/** 给每格打上「我就是这个 key」的标记，用来分辨「同一个节点」与「重建」。 */
const TAG = `(() => {
  for (const el of document.querySelectorAll('[data-pane]')) el.dataset.probePane = el.getAttribute('data-pane');
  return document.querySelectorAll('[data-pane]').length;
})()`;

/** 某一格标题栏里的「替换工作区」按钮（图标按钮，靠可访问名认）。 */
const replaceTrigger = (key) => `(() => {
  const pane = document.querySelector('[data-pane=${JSON.stringify(key)}]');
  if (pane === null) return 'no-pane';
  const head = pane.querySelector('div');
  const button = head === null ? null : [...head.querySelectorAll('button[aria-haspopup="menu"]')]
    .find((candidate) => (candidate.getAttribute('aria-label') ?? '').includes(${JSON.stringify(REPLACE_LABEL)}));
  if (button === undefined || button === null) return 'no-button';
  button.click();
  return 'clicked';
})()`;

/** 打开的菜单里的行：`{ label, hint }`（label 是工作区名，hint 是路径或「已打开」）。 */
const READ_MENU = `[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((row) => ({
  label: row.children[0]?.textContent ?? '',
  hint: row.children[1]?.textContent ?? '',
}))`;

/** 点菜单里标签为 `label` 的那一行。 */
const clickMenuRow = (label) => `(() => {
  const rows = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
  const row = rows.find((candidate) => (candidate.children[0]?.textContent ?? '') === ${JSON.stringify(label)});
  if (row === undefined) return 'no-row';
  row.click();
  return 'clicked';
})()`;

/** 两组矩形是不是同一个位置（允许 1 像素的取整误差）。 */
function sameRect(left, right) {
  if (left === undefined || right === undefined || left === null || right === null) return false;
  return left.every((value, index) => Math.abs(value - right[index]) <= 1);
}

/** 某个 key 的窗格现场。 */
const rowOf = (rows, key) => rows.find((row) => row.key === key);

let cdp;
let server;
let browser;
try {
  let url = GIVEN_URL;
  if (url === undefined) {
    const started = await startServer();
    server = started.child;
    url = started.url;
  }
  const profile = mkdtempSync(join(tmpdir(), 'dsh-replace-probe-'));
  browser = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=1600,1000',
    '--remote-debugging-port=' + String(CDP_PORT), '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const target = await waitForTarget();
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  await openBoard(cdp);

  const shotDir = mkdtempSync(join(tmpdir(), 'dsh-replace-shots-'));
  /** 把当前画面存成 PNG，并把路径打出来供看一眼。 */
  async function screenshot(name) {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, name + '.png');
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    note('截图', file);
  }

  const panes = () => cdp.eval(READ);

  /**
   * 等到 `ready(rows)` 成立。
   *
   * 起步条件与 swap-probe 一样：每个窗格都不再显示「正在打开会话…」且有输入框。
   * 不等就开始点会量出假象 —— 那一格本来还在读会话，替换后「读完了」会被误记成
   * 「替换导致的重新打开」。
   */
  async function waitForReady(ready) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const rows = await panes();
      if (rows.length > 0 && ready(rows)) return rows;
      await sleep(500);
    }
    throw new Error('等了一直没有等到窗格就绪');
  }

  const start = await waitForReady((rows) => rows.length >= 2
    && rows.every((row) => row.loading === false && row.hasComposer === true));
  check('棋盘上至少有两个窗格，且对话都已就绪', start.length >= 2
    && start.every((row) => row.hasComposer === true), JSON.stringify(start.map((row) => [row.key, row.name])));

  const victim = start[0];
  const others = start.slice(1);
  note('将被替换的窗格', victim.key + ' / ' + victim.name + ' / ' + victim.path);

  // 每一格标题栏上都得有这个按钮。
  const buttonStates = await cdp.eval(`[...document.querySelectorAll('[data-pane]')].map((pane) => {
    const head = pane.querySelector('div');
    const found = head === null ? [] : [...head.querySelectorAll('button[aria-haspopup="menu"]')]
      .filter((candidate) => (candidate.getAttribute('aria-label') ?? '').includes(${JSON.stringify(REPLACE_LABEL)}));
    return { key: pane.getAttribute('data-pane'), count: found.length, title: found[0]?.getAttribute('title') ?? '' };
  })`);
  check('每个窗格标题栏上都有一个「替换工作区」图标按钮',
    buttonStates.length === start.length && buttonStates.every((state) => state.count === 1),
    JSON.stringify(buttonStates));
  check('它带可读的名字（标题同一句话，鼠标停上去能看见）',
    buttonStates.every((state) => state.title === REPLACE_LABEL), JSON.stringify(buttonStates.map((state) => state.title)));

  await cdp.eval(TAG);
  const tagged = await panes();
  check('替换前每格都打上了 DOM 标记（下面用它分辨「同一个节点」与「重建」）',
    tagged.every((row) => row.tagged === row.key), JSON.stringify(tagged.map((row) => row.tagged)));

  // --- 打开菜单 -----------------------------------------------------------------------
  const opened = await cdp.eval(replaceTrigger(victim.key));
  check('点这一格的「替换工作区」按钮能打开菜单', opened === 'clicked', opened);
  await sleep(300);
  await screenshot('replace-menu');
  const menu = await cdp.eval(READ_MENU);
  check('菜单第一行是「新建工作区…」，右边提示「选择文件夹」',
    menu.length > 0 && menu[0].label === NEW_WORKSPACE && menu[0].hint === '选择文件夹',
    JSON.stringify(menu));
  check('菜单里不再列出已经铺开的工作区（候选的提示是路径，不是「已打开」）',
    menu.slice(1).every((row) => row.hint !== '已打开'),
    JSON.stringify(menu));

  const candidates = menu.slice(1);
  if (candidates.length === 0) {
    note('这一节跳过：棋盘外的空闲工作区一个都没有（菜单只显示「没有别的工作区可换了」）', JSON.stringify(menu));
  } else {
    const chosen = candidates[0];
    note('选中的候选', chosen.label + ' / ' + chosen.hint);

    const clicked = await cdp.eval(clickMenuRow(chosen.label));
    check('能点中候选那一行', clicked === 'clicked', clicked);

    // 等这一格换过来（标题变成新工作区名），最多 15 秒。
    let after;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(500);
      after = await panes();
      if (rowOf(after, victim.key)?.name === chosen.label) break;
    }
    const replaced = rowOf(after, victim.key);
    check('这一格的标题变成了选中的工作区', replaced !== undefined && replaced.name === chosen.label,
      replaced === undefined ? '窗格不见了' : replaced.name);
    check('也不是原来那个工作区了', replaced !== undefined && replaced.name !== victim.name,
      String(replaced?.name));
    check('窗格数量不变（替换的是位置，不是关掉再加一格）', after.length === start.length,
      String(after.length) + ' vs ' + String(start.length));
    check('**位置不变**：这一格的矩形与替换前逐像素一致',
      sameRect(replaced?.rect, victim.rect), JSON.stringify([victim.rect, replaced?.rect]));
    check('别的窗格的矩形也一个像素都没动',
      others.every((row) => sameRect(rowOf(after, row.key)?.rect, row.rect)),
      JSON.stringify(after.map((row) => [row.key, row.rect])));
    check('这一格是**同一个 DOM 节点**（没有被卸载重建，输入框草稿与滚动位置都还在）',
      replaced !== undefined && replaced.tagged === victim.key, String(replaced?.tagged));
    check('菜单已经关掉了', await cdp.eval("document.querySelectorAll('[role=\"menu\"]').length") === 0);
    check('这一格不再显示原来那段对话', replaced !== undefined && replaced.body !== victim.body,
      String(replaced?.body).slice(0, 80));
    /*
     * 新工作区的会话可能正被读一遍（第一格换到别的工作区时，它的最新会话要重新持有）。
     * 这不是错误，给它 15 秒读完，再断言没有**永远**卡在「正在打开会话…」上。
     */
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (after.every((row) => row.loading === false)) break;
      await sleep(500);
      after = await panes();
    }
    check('替换之后没有卡在「正在打开会话…」上', after.every((row) => row.loading === false),
      JSON.stringify(after.map((row) => [row.key, row.loading, row.hasComposer])));
    await screenshot('replace-after');
  }

  // --- 换回来：菜单里应当又能看见原来那个工作区 -----------------------------------------
  const back = await panes();
  const backTarget = rowOf(back, victim.key);
  if (backTarget === undefined) {
    note('回程这一节跳过：找不到原来那一格了', String(victim.key));
  } else {
    const reopened = await cdp.eval(replaceTrigger(backTarget.key));
    if (reopened !== 'clicked') {
      note('回程这一节跳过：按钮点不开', reopened);
    } else {
      await sleep(300);
      const backMenu = await cdp.eval(READ_MENU);
      check('替换掉的那个工作区回到了候选里（同一格再换回去可行）',
        backMenu.slice(1).some((row) => row.label === victim.name), JSON.stringify(backMenu));
      const restored = await cdp.eval(clickMenuRow(victim.name));
      let final;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(500);
        final = await panes();
        if (rowOf(final, victim.key)?.name === victim.name) break;
      }
      check('换回去之后标题回到原来的工作区', rowOf(final, victim.key)?.name === victim.name, restored);
      check('换回去也没动布局', sameRect(rowOf(final, victim.key)?.rect, victim.rect)
        && others.every((row) => sameRect(rowOf(final, row.key)?.rect, row.rect)),
        JSON.stringify(final.map((row) => [row.key, row.rect])));
    }
  }
} finally {
  if (cdp !== undefined) cdp.close();
  if (browser !== undefined) browser.kill('SIGKILL');
  if (server !== undefined) server.kill('SIGTERM');
}

if (failures > 0) {
  console.error('\n' + String(failures) + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
