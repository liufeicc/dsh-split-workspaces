/**
 * 真浏览器实测：**拖动窗格标题栏交换两个窗格的位置**。
 *
 *   node tools/swap-probe.mjs
 *
 * 离线契约测试用假 document 走完了整条链路（按下 → 阈值 → 命中测试 → 交换），
 * 但有三件事只有真浏览器答得出来，这个探针就是去量它们的：
 *
 *   1. 指针捕获与命中测试配合得上 —— 拖动途中指针跑到别的窗格上方时，
 *      `elementFromPoint` 仍然回答「它下面是哪个窗格」（捕获只改事件派发）；
 *   2. **两棵子树是被搬动的，不是卸载重建的**（同层交换）。这一条是「交换位置不会
 *      重开两个对话」的全部依据：DSH 的 `SessionReference.release` 契约是「最后一次
 *      释放拆掉会话的本地作用域与历史」，一旦重建，两边都会重新打开一遍。
 *      探针在拖动前给每个窗格和它的输入框打上标记：交换后标记还在，就是搬动；
 *      标记没了，就是重建。跨层交换（两方不在同一层分屏里）React 搬不动，只能重建，
 *      探针把这件事**如实报告**出来，而不是判失败 —— 它是已知边界。
 *   3. 松开鼠标之后拍过来的那次 `click` 不会把光标抢回旧位置。
 *
 * 需要本机有 `google-chrome`（或 `chromium`）与可用的 `dsh`（用来起一个**独立的**
 * web 服务），因此**不进**离线契约测试。可以用环境变量覆盖：
 *
 *   DSH_PROBE_CHROME=/path/to/chrome      浏览器
 *   DSH_SWAP_PROBE_URL=http://…/?token=…  直接复用已经开着的服务，不再自己起
 *
 * 探针连的是一个自己新起的服务与一个无头浏览器，**不碰你正开着的窗口**。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSER = process.env.DSH_PROBE_CHROME ?? 'google-chrome';
const DSH_BIN = process.env.DSH_PROBE_DSH ?? 'dsh';
const CDP_PORT = Number(process.env.DSH_SWAP_PROBE_PORT ?? 9352);
const GIVEN_URL = process.env.DSH_SWAP_PROBE_URL;
/** 面板在侧边栏那一行的可访问名（词典里的 `panel.title`）。 */
const PANEL_LABEL = process.env.DSH_SWAP_PROBE_PANEL ?? '多工作区平铺';

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

/** 报告一条「量出来的事实」，不判失败 —— 用于已知边界。 */
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
 * 棋盘上每个窗格的状态：key、矩形、标题栏矩形，以及拖动前打上的那两个标记
 * （用来分辨「搬动」与「重建」）。
 */
const READ = `[...document.querySelectorAll('[data-pane]')].map((el) => {
  const rect = el.getBoundingClientRect();
  const head = el.querySelector('div');
  const headRect = head === null ? null : head.getBoundingClientRect();
  const box = el.querySelector('[contenteditable]');
  return {
    key: el.getAttribute('data-pane'),
    rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
    head: headRect === null ? null : [Math.round(headRect.x), Math.round(headRect.y), Math.round(headRect.width), Math.round(headRect.height)],
    headText: head === null ? '' : head.innerText.split('\\n')[0],
    paneMoved: el.dataset.probePane === undefined ? null : el.dataset.probePane,
    boxMoved: box === null ? null : (box.dataset.probeBox === undefined ? null : box.dataset.probeBox),
    hasComposer: box !== null,
    loading: el.innerText.includes('正在打开会话'),
  };
})`;

/** 给每个窗格与它的输入框打上标记，用来分辨「搬动」与「重建」。 */
const TAG = `(() => {
  for (const el of document.querySelectorAll('[data-pane]')) {
    const key = el.getAttribute('data-pane');
    el.dataset.probePane = key;
    const box = el.querySelector('[contenteditable]');
    if (box !== null) box.dataset.probeBox = key;
  }
  return document.querySelectorAll('[data-pane]').length;
})()`;

/**
 * 盯住「正在打开会话…」这句话有没有出现过，以及出现了多久。
 *
 * 它是会话引用真的松了手的可见信号（引用一归零，DSH 就拆掉会话的本地作用域与历史，
 * 重新持有会从零把历史再读一遍）。窗口可能只有几百毫秒，靠拖动前后各看一眼抓不住，
 * 因此这里挂一个 MutationObserver 全程盯着，并把每次出现/消失的时刻都记下来。
 *
 * **起始状态先量一次、但不记成事件**：探针要量的是「交换导致的重新打开」，而不是
 * 「拖动之前就还在读会话」—— 后者是探针自己起步太早，不该算到交换头上。
 */
const WATCH_LOADING = `(() => {
  window.__probeLoading = [];
  const readState = () => {
    const map = new Map();
    for (const el of document.querySelectorAll('[data-pane]')) {
      map.set(el.getAttribute('data-pane'), el.innerText.includes('正在打开会话'));
    }
    return map;
  };
  const state = readState();
  const scan = () => {
    for (const [key, loading] of readState()) {
      if (loading !== (state.get(key) === true)) {
        window.__probeLoading.push({ key, on: loading, t: Date.now() });
      }
      state.set(key, loading);
    }
  };
  window.__probeObserver = new MutationObserver(scan);
  window.__probeObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  return 'watching';
})()`;

const STOP_WATCHING = `(() => { window.__probeObserver.disconnect(); return window.__probeLoading; })()`;

/** 把「出现/消失」的事件流算成「哪个窗格闪了多久」。 */
function summarizeLoading(events) {
  if (events.length === 0) return '一次都没出现';
  const parts = [];
  for (const event of events) {
    if (event.on !== true) continue;
    const off = events.find((other) => other.key === event.key && other.on === false && other.t >= event.t);
    parts.push(event.key + ' 闪了 ' + String(off === undefined ? '（到探针结束都还在）' : String(off.t - event.t) + 'ms'));
  }
  return parts.join('，');
}

/** 某个 key 的窗格矩形。 */
const rectOf = (rows, key) => (rows.find((row) => row.key === key) ?? {}).rect;

/** 两组矩形是不是同一个位置（允许 1 像素的取整误差）。 */
function sameRect(left, right) {
  if (left === undefined || right === undefined || left === null || right === null) return false;
  return left.every((value, index) => Math.abs(value - right[index]) <= 1);
}

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
  const profile = mkdtempSync(join(tmpdir(), 'dsh-swap-probe-'));
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

  /** 可信鼠标输入：只有可信输入才会真正走指针捕获与默认动作。 */
  const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });

  /**
   * 从 `from` 拖到 `to`：中间插几步，让插件按真实节奏收到一串 pointermove
   * （阈值是在这些移动里被越过的，落点也是最后那一步定下来的）。
   *
   * `hook` 在**松手之前**被调用 —— 拖动反馈（被拖的那格淡出、落点那格亮起强调色圈）
   * 只存在于「按住还没松」这段窗口里，要看它就得趁那时候。
   */
  async function drag(from, to, hook) {
    await mouse('mouseMoved', from[0], from[1]);
    await mouse('mousePressed', from[0], from[1]);
    const steps = 6;
    for (let step = 1; step <= steps; step += 1) {
      const x = Math.round(from[0] + ((to[0] - from[0]) * step) / steps);
      const y = Math.round(from[1] + ((to[1] - from[1]) * step) / steps);
      await mouse('mouseMoved', x, y);
      await sleep(30);
    }
    if (hook !== undefined) await hook();
    await mouse('mouseReleased', to[0], to[1]);
    await sleep(400);
  }

  /** 把当前画面存成 PNG，并把路径打出来供看一眼。 */
  const shotDir = mkdtempSync(join(tmpdir(), 'dsh-swap-shots-'));
  async function screenshot(name) {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, name + '.png');
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    note('拖动反馈截图', file);
  }

  /*
   * 只截当前主题这一张。想顺手再截一张浅色主题是行不通的：主题是应用自己每次渲染都重新
   * 写上去的页面属性，探针手动摘掉之后下一次渲染就被补回来了（改设置又会写进用户的
   * profile）。浅色主题那一侧的落点圈可读性由离线契约测试按 WCAG 的 3:1 算过。
   */

  const panes = () => cdp.eval(READ);
  const order = (rows) => rows.map((row) => row.key).join(',');

  /**
   * 等到 `ready(rows)` 成立。
   *
   * 第一段要等到每个窗格都「不再显示『正在打开会话…』且输入框已经在 DOM 里」：不等就拖会
   * 量出假象 —— 窗格元素一出现（会话还在读）探针就动手，随后那次「正在打开会话…」消失
   * 会被误记成「交换把会话搞丢了又重开」。
   *
   * 后面再加一格时条件要放宽：「添加工作区」铺开的窗格可能落在一个**还没有会话**的工作区上，
   * 它显示的是「为这个窗格选择会话」而不是输入框，永远等不到 `hasComposer`。
   */
  async function waitForReady(ready) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const rows = await panes();
      if (rows.length > 0 && ready(rows)) return rows;
      await sleep(500);
    }
    throw new Error('等了一直没有等到窗格就绪');
  }

  // --- 同层交换：两个并排的窗格 -------------------------------------------------------
  const start = await waitForReady((rows) => rows.length >= 2 && rows.every((row) => row.loading === false && row.hasComposer === true));
  check('棋盘上至少有两个窗格', start.length >= 2, JSON.stringify(start));
  check('两个窗格的对话一开始都已就绪（不是还在读会话）', start.every((row) => row.loading === false && row.hasComposer === true),
    JSON.stringify(start.map((row) => [row.key, row.loading, row.hasComposer])));
  const left = start[0];
  const right = start[1];
  await cdp.eval(TAG);
  await cdp.eval(WATCH_LOADING);
  // 落点选目标窗格的正文区（不是标题栏）：拖动途中指针必然扫过正文，那是合法的落点。
  await drag(
    [left.head[0] + 60, left.head[1] + Math.round(left.head[3] / 2)],
    [right.rect[0] + Math.round(right.rect[2] / 2), right.rect[1] + Math.round(right.rect[3] * 0.7)],
    () => screenshot('drag-' + String(process.env.DSH_SWAP_PROBE_SHOT ?? 'current')),
  );
  const loading = await cdp.eval(STOP_WATCHING);
  const swapped = await cdp.eval(READ);
  check('拖动标题栏后两个窗格交换了位置', order(swapped) === [right.key, left.key, ...start.slice(2).map((row) => row.key)].join(','),
    order(swapped));
  check('两格换的是「位置」：各自占的矩形正好是对方原来的那个',
    sameRect(rectOf(swapped, left.key), right.rect) && sameRect(rectOf(swapped, right.key), left.rect),
    JSON.stringify(swapped.map((row) => row.rect)));
  check('交换靠搬动整棵子树完成：窗格与它的输入框都还是原来那两个 DOM 节点',
    swapped[0].paneMoved === right.key && swapped[0].boxMoved === right.key
    && swapped[1].paneMoved === left.key && swapped[1].boxMoved === left.key,
    JSON.stringify(swapped));
  check('交换之后没有出现「正在打开会话」（会话引用没有松手）', loading.length === 0 && swapped.every((row) => row.loading === false),
    summarizeLoading(loading));

  // 再拖回去，确认交换是双向的、也不是一次性的运气。
  await cdp.eval(TAG);
  const back = await panes();
  await drag(
    [back[1].head[0] + 60, back[1].head[1] + Math.round(back[1].head[3] / 2)],
    [back[0].rect[0] + Math.round(back[0].rect[2] / 2), back[0].rect[1] + Math.round(back[0].rect[3] * 0.7)],
  );
  const restored = await cdp.eval(READ);
  check('反向拖回去又换回原来的顺序', order(restored) === order(start), order(restored));

  /*
   * 拖动不是「点哪儿都会换」：按在标题栏的**按钮**上再移动，一个字都不该动。
   * 这里挑标题栏里那个关闭按钮左边的分屏按钮（有 title 可查）来按。
   */
  const hold = await panes();
  await drag(
    [hold[0].rect[0] + hold[0].rect[2] - 24, hold[0].head[1] + Math.round(hold[0].head[3] / 2)],
    [hold[1].rect[0] + Math.round(hold[1].rect[2] / 2), hold[1].rect[1] + Math.round(hold[1].rect[3] * 0.7)],
  );
  const untouched = await panes();
  check('从标题栏按钮上起手时按钮照旧工作、窗格不换位置', order(untouched) === order(start), order(untouched));

  /*
   * 从**非当前焦点**的窗格上起手：按下会先把焦点点亮到它身上（`onPointerDownCapture`），
   * 于是整个棋盘在拖动途中重渲染一次。指针捕获必须活过这次重渲染 —— 否则拖动会断在
   * 半路，表现出来就是「只有第一次移动算数」。这一条只有真浏览器答得上：离线测试的
   * React 替身不会替换 DOM 节点，也模拟不了「捕获被重渲染弄丢」。
   */
  const activeNow = await cdp.eval("document.querySelector('[data-pane][data-active=true]')?.getAttribute('data-pane') ?? null");
  const inactive = untouched.find((row) => row.key !== activeNow);
  const focused = untouched.find((row) => row.key === activeNow);
  if (inactive === undefined || focused === undefined) {
    note('「从非焦点窗格起手」这一节跳过（看不准哪一格是焦点）', String(activeNow));
  } else {
    await drag(
      [inactive.head[0] + 60, inactive.head[1] + Math.round(inactive.head[3] / 2)],
      [focused.rect[0] + Math.round(focused.rect[2] / 2), focused.rect[1] + Math.round(focused.rect[3] * 0.7)],
    );
    const woke = await panes();
    check('从非焦点窗格起手也拖得动（按下点亮它时的那次重渲染没有弄丢指针捕获）',
      order(woke) === [inactive.key, ...untouched.filter((row) => row.key !== inactive.key).map((row) => row.key)].join(','), order(woke));
    const activeAfter = await cdp.eval("document.querySelector('[data-pane][data-active=true]')?.getAttribute('data-pane') ?? null");
    check('交换之后高亮跟着被拖的那一格走', activeAfter === inactive.key, String(activeAfter));
    // 拖回原样，免得后面的小节依赖这里的顺序。
    await drag(
      [woke[0].head[0] + 60, woke[0].head[1] + Math.round(woke[0].head[3] / 2)],
      [woke[1].rect[0] + Math.round(woke[1].rect[2] / 2), woke[1].rect[1] + Math.round(woke[1].rect[3] * 0.7)],
    );
    check('拖回去恢复原顺序', order(await panes()) === order(start));
  }

  // --- 跨层交换：再加一格，让两方不在同一层分屏里 ---------------------------------------
  const added = await cdp.eval(`(() => {
    const trigger = document.querySelector('button[title="添加工作区"]');
    if (trigger === null) return 'no-trigger';
    trigger.click();
    return 'opened';
  })()`);
  if (added !== 'opened') {
    note('跨层交换这一节跳过（找不到「添加工作区」按钮）', added);
  } else {
    await sleep(300);
    const picked = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('[role="menuitem"]')];
      const row = rows[rows.length - 1];
      if (row === undefined) return 'no-item';
      row.click();
      return 'clicked';
    })()`);
    const three = await waitForReady((rows) => rows.length >= 3 && rows.every((row) => row.loading === false));
    if (picked !== 'clicked' || three.length < 3) {
      note('跨层交换这一节跳过（没能再铺开一格）', picked + ' / ' + String(three.length));
    } else {
      const first = three[0];
      const last = three[three.length - 1];
      /*
       * 新铺的这一格可能落在一个还没有会话的工作区上（显示「为这个窗格选择会话」）。
       * 那不影响这一节要量的事：重建与不重建看的是窗格子树本身，会话重新打开的时长
       * 只在真的有会话的格子上量得到 —— 下面如实报告哪几格有对话。
       */
      if (last.hasComposer !== true) note('新铺的第三格还没有会话（这一格量不到「正在打开会话」）', last.headText);
      await cdp.eval(TAG);
      await cdp.eval(WATCH_LOADING);
      await drag(
        [last.head[0] + 60, last.head[1] + Math.round(last.head[3] / 2)],
        [first.rect[0] + Math.round(first.rect[2] / 2), first.rect[1] + Math.round(first.rect[3] * 0.7)],
      );
      const deepLoading = await cdp.eval(STOP_WATCHING);
      const deep = await cdp.eval(READ);
      check('跨层拖动也把两格换了过来', order(deep) === [last.key, ...three.slice(1, -1).map((row) => row.key), first.key].join(','), order(deep));
      check('跨层交换换的也是「位置」：各自占的矩形正好是对方原来的那个',
        sameRect(rectOf(deep, first.key), last.rect) && sameRect(rectOf(deep, last.key), first.rect),
        JSON.stringify(deep.map((row) => row.rect)));
      check('跨层交换没有把别的窗格也牵连进来', deep.filter((row) => row.paneMoved === row.key).length === deep.length - 2,
        JSON.stringify(deep.map((row) => row.paneMoved)));
      const rebuilt = deep.filter((row) => row.paneMoved !== row.key).map((row) => row.key);
      note('跨层交换时这两格是卸载重建的（React 只在兄弟节点之间按 key 搬动）', rebuilt.length === 0 ? '这次没有重建' : rebuilt.join(','));
      note('整个跨层交换过程里「正在打开会话…」出现过几次', summarizeLoading(deepLoading));
    }
  }

  // --- click 的落点 ---------------------------------------------------------------------
  const after = await panes();
  const activeKey = await cdp.eval("document.querySelector('[data-pane][data-active=true]')?.getAttribute('data-pane') ?? null");
  note('交换之后仍然高亮的窗格', String(activeKey));
  note('棋盘上现在的窗格顺序', order(after));
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
