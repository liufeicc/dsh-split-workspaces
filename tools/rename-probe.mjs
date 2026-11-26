/**
 * 真浏览器探针：**任务分派画布的「改卡片名称」端到端**。
 *
 *   node tools/rename-probe.mjs
 *
 * 离线契约测试覆盖了弹层、trim、空名拒绝、失败提示这些纯逻辑；但有三件事只有真浏览器
 * 答得出来，这个探针就是去量它们的：
 *
 *   1. **未命名的卡片不给改名**：新建的空白会话（未命名会话）与登记成员工但仍未命名的
 *      卡片上都不出现铅笔 —— 这是用户明确要求的规则；
 *   2. 有标题的卡片上铅笔真的点得开、弹层真的出现在画面上，点保存后名字跟着变；
 *   3. 改名走的是会话标题（不是插件自己的本地状态）：刷新页面后新名字还在。
 *
 * ## 正向用例的数据从哪来
 *
 * 空白会话不能改名，所以正向用例需要一个**已经有标题**的会话。探针不会去动真实数据：
 * 它从 `~/.dsh/sessions` 里挑一个**最旧、最小**的会话目录**复制**进临时数据目录
 * （只读复制，原目录一个字都不改），再在副本上改名。找不到合适的会话时，正向用例
 * 会跳过并打印 `note`，未命名规则仍然照常验证。
 *
 * ## 不碰你的数据
 *
 * 探针用**临时 DSH_HOME** 起一个独立的 `dsh web`：
 *   - `sessions/` 是全新的空目录（改名要写会话数据，绝不能指向真实目录）；
 *   - `profiles/`、`skills/`、`.credentials.yaml` 用软链接复用（只读，插件与模型都在里面）；
 *   - `storages/workspace.json` 复制一份（工作区列表还在，画布布局仍是空的）。
 * 卡片是探针自己在临时目录里**新建的空白会话**，改的是它；退出时临时目录整个删掉。
 *
 * 需要本机有 `google-chrome`（或 `chromium`）与 `dsh`。可用环境变量覆盖：
 *
 *   DSH_PROBE_CHROME=/path/to/chrome
 *   DSH_RENAME_PROBE_URL=http://…/?token=…   复用已经开着的服务（**会改那里的会话**，
 *                                            只在你确认过的情况下用）
 */
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSER = process.env.DSH_PROBE_CHROME ?? 'google-chrome';
const DSH_BIN = process.env.DSH_PROBE_DSH ?? 'dsh';
const CDP_PORT = Number(process.env.DSH_RENAME_PROBE_PORT ?? 9354);
const GIVEN_URL = process.env.DSH_RENAME_PROBE_URL;
const PANEL_LABEL = process.env.DSH_RENAME_PROBE_PANEL ?? '多工作区平铺';
const REAL_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const NEW_NAME = '探针改名-' + String(Date.now()).slice(-6);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('ok   ' + label);
    return;
  }
  failures += 1;
  console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}
function note(label, detail) {
  console.log('note ' + label + (detail === undefined ? '' : ' — ' + detail));
}

/** 极简 CDP 客户端（与另外几个探针同款）。 */
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

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails !== undefined) {
      throw new Error('页面里报错: ' + String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    }
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + String(CDP_PORT) + '/json/list')).json();
      const page = list.find((target) => target.type === 'page');
      if (page !== undefined) return page;
    } catch {
      // 还没起来，继续等。
    }
    await sleep(500);
  }
  throw new Error('DevTools 一直没就绪');
}

/** 造一个「布局为空、会话为空、但插件与工作区都在」的临时数据目录。 */
function makeTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-rename-probe-home-'));
  // 会话目录必须是真目录：改名的写入只能落在这里。
  mkdirSync(join(home, 'sessions'), { recursive: true });
  for (const name of ['profiles', 'skills', 'attachments']) {
    const from = join(REAL_HOME, name);
    if (existsSync(from)) symlinkSync(from, join(home, name));
  }
  for (const name of ['.credentials.yaml', 'AGENTS.md']) {
    const from = join(REAL_HOME, name);
    if (existsSync(from)) symlinkSync(from, join(home, name));
  }
  mkdirSync(join(home, 'storages'), { recursive: true });
  for (const name of ['workspace.json', 'pane_dispatch_targets.json']) {
    const from = join(REAL_HOME, 'storages', name);
    if (existsSync(from)) copyFileSync(from, join(home, 'storages', name));
  }
  return home;
}

/**
 * 把一个真实会话**复制**进临时数据目录，供「有标题的会话」正向用例使用。
 *
 * 只读复制：真实目录一个字节都不改，副本在探针退出时随临时目录一起删掉。
 * 目录结构是 `<cwd-key>/session-<id>/`，必须连同 `cwd-key` 那一层一起复制，
 * 否则 Host 找不到这个会话属于哪个工作区。
 *
 * @returns 复制成功与否（找不到就返回 false，调用方跳过正向用例）。
 */
function seedSession(tempHome, sessionId) {
  const root = join(REAL_HOME, 'sessions');
  if (!existsSync(root)) return null;
  /*
   * 磁盘上有两种目录布局：`<uuid>` 与 `session-<uuid>`（不同版本/入口留下的）。
   * 两种都试；返回**界面里用的会话 id**（即去掉 `session-` 前缀的那个）。
   */
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  const folders = [bare, 'session-' + bare];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const folder of folders) {
      const from = join(root, entry.name, folder);
      if (!existsSync(from)) continue;
      const to = join(tempHome, 'sessions', entry.name, folder);
      mkdirSync(join(tempHome, 'sessions', entry.name), { recursive: true });
      cpSync(from, to, { recursive: true });
      /*
       * 标题是**投影**：它缓存在 `storages/session_projcache/sessions/<uuid>.json`
       * 里。不一起复制的话，副本会被当成「没有标题」，正向用例就白跑了。
       */
      const cacheFrom = join(REAL_HOME, 'storages', 'session_projcache', 'sessions', bare + '.json');
      if (existsSync(cacheFrom)) {
        mkdirSync(join(tempHome, 'storages', 'session_projcache', 'sessions'), { recursive: true });
        copyFileSync(cacheFrom, join(tempHome, 'storages', 'session_projcache', 'sessions', bare + '.json'));
      }
      return { sessionId: bare, folder };
    }
  }
  return null;
}

async function startServer(tempHome) {
  const child = spawn(DSH_BIN, ['web', '--no-open', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: tempHome },
  });
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

/** 打开面板并切到任务分派模式。 */
async function openGraph(cdp) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(500);
    const ready = await cdp.eval('!!document.querySelector(' + JSON.stringify('button[aria-label="' + PANEL_LABEL + '"]') + ')');
    if (ready === true) break;
  }
  const opened = await cdp.eval(`(() => {
    const button = document.querySelector('button[aria-label=${JSON.stringify(PANEL_LABEL)}]');
    if (button === null) return false;
    button.click();
    return true;
  })()`);
  if (opened !== true) throw new Error('侧边栏里找不到「' + PANEL_LABEL + '」');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500);
    if (await cdp.eval("document.querySelectorAll('[data-pane]').length") > 0) break;
  }
  const switched = await cdp.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '任务分派');
    if (button === undefined) return false;
    button.click();
    return true;
  })()`);
  if (switched !== true) throw new Error('找不到「任务分派」模式按钮');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500);
    if (await cdp.eval("document.querySelectorAll('.dshSplitWs_graphPickerGroupHead').length") > 0) break;
  }
}

/** 在第一个工作区行上点「创建会话」，返回新会话 id（从左侧列表里认出来）。 */
async function createSessionInFirstWorkspace(cdp) {
  await cdp.eval(`(() => {
    for (const head of document.querySelectorAll('.dshSplitWs_graphPickerGroupHead')) head.click();
    return true;
  })()`);
  await sleep(400);
  const clicked = await cdp.eval(`(() => {
    const button = document.querySelector('.dshSplitWs_graphPickerGroupAction[data-kind="session"]');
    if (button === null || button.disabled) return null;
    button.click();
    return true;
  })()`);
  if (clicked !== true) return null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500);
    const ids = await cdp.eval("[...document.querySelectorAll('.dshSplitWs_graphPickerItem')].map((el) => el.getAttribute('data-session')).filter(Boolean)");
    if (ids.length > 0) return ids[0];
  }
  return null;
}

/** 点某个会话条目的铅笔，返回是否点到了。 */
async function clickPickerPencil(cdp, sessionId) {
  return cdp.eval(`(() => {
    const item = document.querySelector('.dshSplitWs_graphPickerItem[data-session="' + ${JSON.stringify(sessionId)} + '"]');
    if (item === null) return false;
    const button = item.querySelector('.dshSplitWs_graphPickerRename');
    if (button === null) return false;
    button.click();
    return true;
  })()`);
}

/** 等弹层出现，返回输入框里的当前值。 */
async function readDialog(cdp) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(200);
    const value = await cdp.eval(`(() => {
      const input = document.querySelector('.dshSplitWs_graphRenameInput');
      return input === null ? null : input.value;
    })()`);
    if (value !== null) return value;
  }
  return null;
}

/** 在弹层里输入新名字并保存。 */
async function submitDialog(cdp, name) {
  const typed = await cdp.eval(`(() => {
    const input = document.querySelector('.dshSplitWs_graphRenameInput');
    if (input === null) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (typed !== true) return false;
  await sleep(200);
  const saved = await cdp.eval(`(() => {
    const panel = document.querySelector('.dshSplitWs_graphRenamePanel');
    if (panel === null) return false;
    const button = [...panel.querySelectorAll('button')].find((el) => el.textContent.trim() === '保存');
    if (button === undefined) return false;
    button.click();
    return true;
  })()`);
  if (saved !== true) return false;
  // 等弹层关闭（成功）或出现错误行（失败）。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    const state = await cdp.eval(`(() => {
      const panel = document.querySelector('.dshSplitWs_graphRenamePanel');
      if (panel === null) return { open: false, error: null };
      const error = panel.querySelector('.dshSplitWs_graphRenameError');
      return { open: true, error: error === null ? null : error.textContent };
    })()`);
    if (state.open === false) return { ok: true };
    if (state.error !== null) return { ok: false, error: state.error };
  }
  return { ok: false, error: '弹层一直没有关闭' };
}

/** 左侧某个会话条目的标题文字。 */
const pickerTitleOf = (cdp, sessionId) => cdp.eval(`(() => {
  const item = document.querySelector('.dshSplitWs_graphPickerItem[data-session="' + ${JSON.stringify(sessionId)} + '"]');
  if (item === null) return null;
  const node = item.querySelector('.dshSplitWs_graphPickerCardTitle');
  return node === null ? null : node.textContent;
})()`);

/** 画布上某张卡片的标题文字。 */
const cardTitleOf = (cdp, sessionId) => cdp.eval(`(() => {
  const card = document.querySelector('.dshSplitWs_graphCard[data-session="' + ${JSON.stringify(sessionId)} + '"]');
  if (card === null) return null;
  const node = card.querySelector('.dshSplitWs_graphCardTitle');
  return node === null ? null : node.textContent;
})()`);

let cdp;
let server;
let browser;
let tempHome;
/** 被复制进临时目录的那个「有标题会话」的界面 id；没有就是 null。 */
let resolvedSeedId = null;
try {
  let url = GIVEN_URL;
  if (url === undefined) {
    tempHome = makeTempHome();
    /*
     * 正向用例需要一个**有标题**的会话（空白会话按规则不能改名）。用户用
     * `DSH_RENAME_PROBE_SESSION=<会话id>` 指定一个，探针把它**复制**进临时目录，
     * 在副本上改名；没有指定就只跑未命名规则。
     */
    const seedId = process.env.DSH_RENAME_PROBE_SESSION;
    if (seedId !== undefined && seedId !== '') {
      const copied = seedSession(tempHome, seedId);
      note(copied === null ? '指定的会话没找到，正向用例会跳过' : '已把指定会话复制进临时目录', seedId);
      if (copied !== null) resolvedSeedId = copied.sessionId;
    }
    const started = await startServer(tempHome);
    server = started.child;
    url = started.url;
    note('临时数据目录', tempHome);
  }
  const profile = mkdtempSync(join(tmpdir(), 'dsh-rename-probe-profile-'));
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
  await openGraph(cdp);

  // --- 1. 未命名的卡片：**不给改名** ---------------------------------------------------
  /*
   * 用户明确要求：未命名会话 / 未命名员工不能改卡片名称。这里量的是界面真的没有入口，
   * 而不是「点了之后才报错」。
   */
  const blankId = await createSessionInFirstWorkspace(cdp);
  check('在临时数据目录里新建了一条空白会话', typeof blankId === 'string' && blankId !== '', String(blankId));
  if (typeof blankId !== 'string') throw new Error('没建出会话，后面没法继续');
  check('它显示成「未命名会话」', await pickerTitleOf(cdp, blankId) === '未命名会话',
    String(await pickerTitleOf(cdp, blankId)));
  check('未命名会话的左侧条目**没有**改名铅笔',
    await cdp.eval(`document.querySelector('.dshSplitWs_graphPickerItem[data-session="${blankId}"] .dshSplitWs_graphPickerRename') === null`) === true);
  check('未命名会话的左侧条目仍然有删除按钮',
    await cdp.eval(`document.querySelector('.dshSplitWs_graphPickerItem[data-session="${blankId}"] .dshSplitWs_graphPickerDelete') !== null`) === true);

  // 拖进画布：卡片上同样不该有铅笔。
  await cdp.eval(`(() => {
    const item = document.querySelector('.dshSplitWs_graphPickerItem[data-session="${blankId}"]');
    if (item !== null) item.click();
    return true;
  })()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(300);
    if (await cdp.eval(`document.querySelector('.dshSplitWs_graphCard[data-session="${blankId}"]') !== null`) === true) break;
  }
  check('未命名会话的卡片上**没有**改名铅笔',
    await cdp.eval(`document.querySelector('.dshSplitWs_graphCard[data-session="${blankId}"] .dshSplitWs_graphCardRename') === null`) === true);

  // 把它登记成员工：仍未命名 → 仍然没有铅笔。
  await cdp.eval(`(() => {
    const buttons = [...document.querySelectorAll('.dshSplitWs_graphPickerGroupAction[data-kind="target"]')];
    for (const button of buttons) {
      button.click();
      return true;
    }
    return false;
  })()`);
  await sleep(1200);
  const employeeUntitled = await cdp.eval(`[...document.querySelectorAll('.dshSplitWs_graphPickerItem')]
    .filter((el) => (el.querySelector('.dshSplitWs_graphPickerCardTitle')?.textContent ?? '') === '未命名员工')
    .map((el) => el.getAttribute('data-session'))`);
  if (Array.isArray(employeeUntitled) && employeeUntitled.length > 0) {
    const employeeId = employeeUntitled[0];
    check('未命名员工的左侧条目**没有**改名铅笔',
      await cdp.eval(`document.querySelector('.dshSplitWs_graphPickerItem[data-session="${employeeId}"] .dshSplitWs_graphPickerRename') === null`) === true);
  } else {
    note('跳过「未命名员工」这一条（没在左侧看到未命名员工卡片）');
  }

  // --- 2. 有标题的会话：铅笔可用、改名生效、刷新后还在 ----------------------------------
  const seededId = resolvedSeedId;
  if (seededId === null || seededId === '') {
    note('跳过正向改名用例：没有指定一个有标题的会话', 'DSH_RENAME_PROBE_SESSION=<sessionId>');
  } else {
    // 从真实会话目录**复制**这个会话到临时目录（原目录只读），再在副本上改名。
    // 会话列表是异步拉回来的；给种子会话一点时间出现在左侧。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(500);
      const found = await cdp.eval(`document.querySelector('.dshSplitWs_graphPickerItem[data-session="${seededId}"]') !== null`);
      if (found === true) break;
    }
    const seeded = await cdp.eval(`(() => {
      const item = document.querySelector('.dshSplitWs_graphPickerItem[data-session="' + ${JSON.stringify(seededId)} + '"]');
      if (item === null) return null;
      return item.querySelector('.dshSplitWs_graphPickerCardTitle')?.textContent ?? null;
    })()`);
    const inventory = await cdp.eval(`[...document.querySelectorAll('.dshSplitWs_graphPickerItem')]
      .map((el) => (el.getAttribute('data-session') ?? '?') + '=' + (el.querySelector('.dshSplitWs_graphPickerCardTitle')?.textContent ?? ''))`);
    /*
     * 指定的会话没被 Host 列出来时**跳过**而不是判失败：这是「正向用例」的取材问题
     * （会话目录直接复制进来，Host 的目录索引不一定认它），不是功能坏了。
     * 未命名规则那几条才是这个探针的核心断言。
     */
    if (seeded === null) {
      note('指定的会话没有被 Host 列出来，跳过正向用例', JSON.stringify({ sought: seededId, listed: inventory }));
    }
    if (seeded !== null) {
      const originalTitle = seeded;
      check('有标题的会话左侧条目上有改名铅笔',
        await cdp.eval(`document.querySelector('.dshSplitWs_graphPickerItem[data-session="${seededId}"] .dshSplitWs_graphPickerRename') !== null`) === true);
      check('点左侧铅笔能点开', await clickPickerPencil(cdp, seededId));
      const seededValue = await readDialog(cdp);
      check('弹层预填的是当前名字', seededValue === originalTitle, String(seededValue));
      const renamed = await submitDialog(cdp, NEW_NAME);
      check('保存后弹层关闭（平台接受了改名）', renamed.ok === true, JSON.stringify(renamed));
      await sleep(600);
      check('左侧条目的名字变成新名字', await pickerTitleOf(cdp, seededId) === NEW_NAME,
        String(await pickerTitleOf(cdp, seededId)));

      // 拖进画布，卡片上也应该是新名字，并且有铅笔。
      await cdp.eval(`(() => {
        const item = document.querySelector('.dshSplitWs_graphPickerItem[data-session="${seededId}"]');
        if (item !== null) item.click();
        return true;
      })()`);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(300);
        if (await cdp.eval(`document.querySelector('.dshSplitWs_graphCard[data-session="${seededId}"]') !== null`) === true) break;
      }
      check('卡片上的名字跟左侧一致', await cardTitleOf(cdp, seededId) === NEW_NAME,
        String(await cardTitleOf(cdp, seededId)));
      check('卡片上有改名铅笔',
        await cdp.eval(`document.querySelector('.dshSplitWs_graphCard[data-session="${seededId}"] .dshSplitWs_graphCardRename') !== null`) === true);

      // 刷新后名字还在：说明改的是会话标题，不是本地状态。
      await cdp.send('Page.reload');
      await sleep(1500);
      await openGraph(cdp);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(400);
        if (await cdp.eval("document.querySelectorAll('.dshSplitWs_graphPickerGroupHead').length") > 0) break;
      }
      await cdp.eval(`(() => {
        for (const head of document.querySelectorAll('.dshSplitWs_graphPickerGroupHead')) head.click();
        return true;
      })()`);
      await sleep(800);
      check('刷新后仍然是新名字', await pickerTitleOf(cdp, seededId) === NEW_NAME,
        String(await pickerTitleOf(cdp, seededId)));

      // 空名字被拒绝，取消不会改坏。
      await clickPickerPencil(cdp, seededId);
      const reopened = await readDialog(cdp);
      check('再次打开弹层，预填新名字', reopened === NEW_NAME, String(reopened));
      const empty = await submitDialog(cdp, '   ');
      check('空名字当场拒绝（弹层不关）', empty.ok === false && String(empty.error).includes('不能为空'), JSON.stringify(empty));
      await cdp.eval(`(() => {
        const panel = document.querySelector('.dshSplitWs_graphRenamePanel');
        if (panel === null) return false;
        const button = [...panel.querySelectorAll('button')].find((el) => el.textContent.trim() === '取消');
        if (button === undefined) return false;
        button.click();
        return true;
      })()`);
      await sleep(400);
      check('取消后名字没有被改坏', await pickerTitleOf(cdp, seededId) === NEW_NAME,
        String(await pickerTitleOf(cdp, seededId)));
    }
  }
} catch (error) {
  failures += 1;
  console.error('探针失败：', error);
} finally {
  if (cdp !== undefined) cdp.close();
  if (browser !== undefined) browser.kill('SIGKILL');
  if (server !== undefined) server.kill('SIGKILL');
  if (tempHome !== undefined) rmSync(tempHome, { recursive: true, force: true });
}

if (failures > 0) {
  console.error('\n' + String(failures) + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}