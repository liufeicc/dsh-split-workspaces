/**
 * 真浏览器探针：这个插件的「点亮窗格就送光标」有三条约束**只有真浏览器能回答**，
 * 离线契约测试（假 document）模拟不了浏览器的默认动作。改这块代码前先跑一遍它：
 *
 *   node tools/browser-probe.mjs
 *
 * 它自己起一个无头 Chrome、打开一个临时页面，用 CDP 的 `Input.dispatchMouseEvent`
 * 发**可信**鼠标输入（可信输入才会触发浏览器的默认动作），然后逐条判定：
 *
 *   1. 焦点在输入框里时，单击一个不可聚焦的元素（段落）会把焦点抹成 `body`
 *      —— 所以「送光标」不能挂在 `pointerdown` 上（那时 focus 出来的会被这一步擦掉）；
 *   2. 挂在 `click` 上就留得住（`click` 之后没有会改焦点的默认动作）；
 *   3. 但在 `click` 里无条件 `focus()` 一个 contenteditable，会把刚拖出来的选区整段抹掉
 *      —— 所以用户刚选完文字时必须一个字都不碰；
 *   4. 加上「选区折叠才送光标」这个守卫后，拖选照旧、单击照旧送光标。
 *
 * 需要本机有 `google-chrome` 或 `chromium`，因此**不进**离线契约测试（那三个仍然免依赖）。
 * 可以用环境变量指定浏览器：`DSH_PROBE_CHROME=/path/to/chrome node tools/browser-probe.mjs`。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSER = process.env.DSH_PROBE_CHROME ?? 'google-chrome';
const PORT = Number(process.env.DSH_PROBE_PORT ?? 9350);
const dir = mkdtempSync(join(tmpdir(), 'dsh-focus-probe-'));
const page = join(dir, 'probe.html');
const profile = join(dir, 'profile');

writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>focus probe</title>
<style>body{font:16px sans-serif} #para{padding:8px} #ce{border:1px solid #999;padding:4px;width:240px}</style>
<input id="box" value="composer">
<p id="para">selectable text here</p>
<div id="ce" contenteditable="true">editable</div>
<script>
  window.mode = 'none';
  // mode = pointerdown：像「挂在 pointerdown 上」那样送光标
  document.addEventListener('pointerdown', () => {
    if (window.mode === 'pointerdown') document.getElementById('ce').focus();
  }, true);
  // mode = always：挂在 click 上但无条件聚焦
  // mode = guard：挂在 click 上，仅当选区折叠（= 没在选文字）时聚焦
  document.addEventListener('click', () => {
    if (window.mode === 'always') document.getElementById('ce').focus();
    if (window.mode === 'guard' && document.getSelection().isCollapsed === true) document.getElementById('ce').focus();
  }, true);
</script>`);

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--disable-dev-shm-usage', '--window-size=1000,700',
  '--remote-debugging-port=' + String(PORT), '--user-data-dir=' + profile, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let browserLog = '';
child.stderr.on('data', (chunk) => { browserLog += String(chunk); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails !== undefined) throw new Error('页面里报错: ' + JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.ws.close(); }
}

async function waitForBrowser() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + String(PORT) + '/json/version');
      if (response.ok) return await response.json();
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('浏览器没起来（' + BROWSER + '）：\n' + browserLog.slice(-800));
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('ok   ' + label);
    return;
  }
  failures += 1;
  console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

let cdp;
try {
  const version = await waitForBrowser();
  console.log('# ' + version.Browser);
  const created = await (await fetch('http://127.0.0.1:' + String(PORT) + '/json/new?' + encodeURIComponent('file://' + page), { method: 'PUT' })).json();
  cdp = new Cdp(created.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await sleep(400);

  const rect = (id) => cdp.eval(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return { x: r.left + 6, y: r.top + r.height / 2 }; })()`);
  const mouse = (type, point, extra = {}) => cdp.send('Input.dispatchMouseEvent', {
    type, x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, ...extra,
  });
  const active = () => cdp.eval("document.activeElement.id || document.activeElement.tagName");
  const selection = () => cdp.eval('String(document.getSelection())');
  /** 在段落上拖一把（可信输入），末尾会自然产生一次 click。 */
  const dragSelect = async () => {
    await cdp.eval("document.getElementById('box').focus()");
    const from = await rect('para');
    await mouse('mousePressed', { x: from.x + 100, y: from.y });
    for (let step = 1; step <= 4; step += 1) {
      await mouse('mouseMoved', { x: from.x + 100 - step * 26, y: from.y }, { buttons: 1 });
      await sleep(20);
    }
    await mouse('mouseReleased', { x: from.x - 4, y: from.y });
    await sleep(80);
  };

  // 1. 单击不可聚焦元素：mousedown 的默认动作会把焦点抹成 body。
  await cdp.eval("window.mode = 'none'");
  await cdp.eval("document.getElementById('box').focus()");
  const para = await rect('para');
  await mouse('mousePressed', para);
  check('单击段落时浏览器把输入框的焦点抹成 body（所以 pointerdown 里聚焦没用）', await active() === 'BODY', await active());
  await mouse('mouseReleased', para);
  check('什么都不做时，松开鼠标也不会自己把焦点还回来', await active() === 'BODY', await active());

  // 2. 挂在 pointerdown 上：同样留不住。
  await cdp.eval("window.mode = 'pointerdown'");
  await cdp.eval("document.getElementById('box').focus()");
  await mouse('mousePressed', para);
  await mouse('mouseReleased', para);
  await sleep(50);
  check('把 focus 挂在 pointerdown 上，点完仍然是 body（结论：不能挂 pointerdown）', await active() === 'BODY', await active());

  // 3. 挂在 click 上：留得住。
  await cdp.eval("window.mode = 'always'");
  await cdp.eval("document.getElementById('box').focus()");
  await mouse('mousePressed', para);
  await mouse('mouseReleased', para);
  await sleep(50);
  check('把 focus 挂在 click 上，点完光标确实进了 contenteditable', await active() === 'ce', await active());

  // 4. 但无条件聚焦会把刚拖出来的选区抹掉。
  await cdp.eval("window.mode = 'always'");
  await dragSelect();
  check('无条件在 click 里聚焦会把选区整段抹掉（所以必须给选区让路）', await selection() === '', JSON.stringify(await selection()));

  // 5. 加上「选区折叠才送光标」的守卫：拖选照旧。
  await cdp.eval("window.mode = 'guard'");
  await dragSelect();
  const kept = await selection();
  check('带守卫时拖选出来的文字完好保留', kept.trim().length > 4, JSON.stringify(kept));
  check('带守卫时拖选不会被抢焦点', await active() === 'BODY', await active());

  // 6. 守卫不影响单击。
  await cdp.eval("window.mode = 'guard'");
  await cdp.eval("document.getElementById('box').focus()");
  const point = await rect('para');
  await mouse('mousePressed', point);
  await mouse('mouseReleased', point);
  await sleep(50);
  check('带守卫时单击照旧把光标送进 contenteditable', await active() === 'ce', await active());
} finally {
  if (cdp !== undefined) cdp.close();
  child.kill('SIGKILL');
}

if (failures > 0) {
  console.error('\n' + String(failures) + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
