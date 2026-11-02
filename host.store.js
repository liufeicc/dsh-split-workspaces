/**
 * 多工作区平铺 —— 委派绑定表的落盘与读回。
 *
 * 委派关系（「谁可以把任务派给谁」）是**部署级**的事实，不是某个浏览器的偏好，
 * 所以必须存在 Host 上。这里负责两件事：
 *
 *   1. 把内存里的绑定表写成磁盘上的 JSON；
 *   2. 启动时把它读回来，读不懂就当作空表。
 *
 * 两个边界值得记住：
 *   - `makeTarget` 是这个「{ id, label, note? }」形状的唯一构造点，四处构造只要有一处
 *     漏掉 note，就会在下一次落盘时把用户的说明永久抹掉；
 *   - 写盘走「临时文件 + rename」，原子替换，进程在写的中间被杀也只会留下上一份完整
 *     文件，而不是半截 JSON。
 *
 * @module @local/dsh-split-workspaces/host-store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { EDGE_NOTE_MAX, STORE_VERSION } from './host.constants.js';

/**
 * 绑定目标的标准形状 —— 全插件只在这一个地方构造它。
 *
 * 为什么值得单独抽出来：这个「{ id, label, note? }」在整条链路上要构造**四次**
 * —— 读盘、装进绑定表、远程 `set`、远程 `list`。2026-11-02 就因为漏了其中一处
 * （装表那步只取了 id 和 label），出现了「箭头回来了、线上的说明没了」；更糟的是
 * 下一次落盘会按内存里的样子重写文件，把说明**永久**抹掉。
 * 收成一个函数，就不会再漏第二次。
 *
 * @param id - 目标会话 id。
 * @param label - 显示名；空时退回 id。
 * @param note - 用户写的分工说明；空白表示没有。
 * @returns 冻结前的普通对象。
 */
export function makeTarget(id, label, note) {
  const target = { id, label: typeof label === 'string' && label !== '' ? label : id };
  if (typeof note === 'string' && note !== '') target.note = note.slice(0, EDGE_NOTE_MAX);
  return target;
}
/** DSH 主目录。 */
function dshHome() {
  const home = process.env.DSH_HOME;
  return home === undefined || home === '' ? join(homedir(), '.dsh') : home;
}

/** 绑定表的落盘位置。 */
function storePath() {
  return join(dshHome(), 'storages', 'pane_dispatch_bindings.json');
}

/**
 * 从磁盘读回绑定表。
 *
 * 为什么这件事必须落在 **Host** 而不是浏览器：委派关系是「这个部署里谁可以把任务派给
 * 谁」，跟哪台机器、哪个浏览器打开界面没有关系。存浏览器 localStorage 的话，换个浏览器
 * 或者换台机器就看不见自己画的树了。
 *
 * 读不懂（文件缺失、JSON 坏了、版本对不上、字段形状不对）一律当作空表：一份读不出来的
 * 配置不该让整个插件加载失败，用户的损失只是「箭头没了」，重新画就行。
 *
 * @returns `{ owners: Array<{ id, label, targets }> }`。
 */
export function loadStore() {
  const empty = { version: STORE_VERSION, owners: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(storePath(), 'utf8'));
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object') return empty;
  if (parsed.version !== STORE_VERSION) return empty;
  const owners = [];
  for (const row of Array.isArray(parsed.owners) ? parsed.owners : []) {
    if (row === null || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (id === '') continue;
    const targets = [];
    const seen = new Set();
    for (const item of Array.isArray(row.targets) ? row.targets : []) {
      if (item === null || typeof item !== 'object') continue;
      const targetId = typeof item.id === 'string' ? item.id.trim() : '';
      if (targetId === '' || targetId === id || seen.has(targetId)) continue;
      seen.add(targetId);
      targets.push(makeTarget(targetId, item.label, item.note));
    }
    if (targets.length === 0) continue;
    owners.push({ id, label: typeof row.label === 'string' && row.label !== '' ? row.label : id, targets });
  }
  return { version: STORE_VERSION, owners };
}

/**
 * 把绑定表写回磁盘。
 *
 * 走「临时文件 + rename」：rename 在同一个文件系统里是原子的，所以进程正好在写的中间被
 * 杀掉时，磁盘上留下的是**上一份完整文件**，而不是半截 JSON。这个插件每次改动都写一次，
 * 数据量只有几百字节，不值得为它引入防抖。
 *
 * @param owners - `[{ id, label, targets }]`。
 * @returns 是否写成功；失败**不抛**（调用方是用户点一下箭头，不该因此报错）。
 */
export function saveStore(owners) {
  const file = storePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid;
    writeFileSync(temp, JSON.stringify({ version: STORE_VERSION, owners }, null, 2), 'utf8');
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}
