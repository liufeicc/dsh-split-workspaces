/**
 * 多工作区平铺 —— 布局的 Host 落盘。
 *
 * ## 为什么不能只存 localStorage
 *
 * 桌面版每次启动都会给 Web UI 分配一个新端口（`--port 0`），而浏览器的
 * localStorage 按 origin（协议 + 主机 + 端口）隔离：Ctrl+R 端口不变，所以能恢复；
 * 关掉 DSH 再打开，端口变了，同一个键就落在另一个 origin 里，读不到。
 *
 * 布局是“这个 profile 的界面偏好”，和浏览器实例无关，所以正确的位置是 Host 的
 * `~/.dsh/storages`。客户端仍保留 localStorage 作为同源快速镜像。
 *
 * ## 文件格式
 *
 * 直接存客户端 `client.layout.js` 生成的保存结构，不在 Host 侧重新解释字段；
 * 这样版本升级、字段增删只由客户端一个地方负责。Host 只做形状/大小兜底，
 * 防止一个坏文件或超大 JSON 把磁盘写满。
 *
 * 写盘走临时文件 + rename，和 `host.store.js` 一样，进程中途被杀不会留下半截 JSON。
 *
 * @module @local/dsh-split-workspaces/host-layout
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 一份布局的 JSON 上限；正常布局只有几 KB，1 MB 已经非常宽松。 */
const MAX_LAYOUT_BYTES = 1024 * 1024;

/** DSH 主目录。 */
function dshHome() {
  const home = process.env.DSH_HOME;
  return home === undefined || home === '' ? join(homedir(), '.dsh') : home;
}

/** 布局文件位置。 */
function layoutPath() {
  return join(dshHome(), 'storages', 'pane_layout.json');
}

/**
 * 从磁盘读回布局。
 *
 * 文件不存在、JSON 坏掉、根不是对象，一律返回 null：一份读不出来的布局只应让
 * 界面回到默认播种，不该让插件加载失败。
 *
 * @returns {object|null} 客户端保存结构。
 */
export function loadLayoutFile() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(layoutPath(), 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * 把布局写回磁盘。
 *
 * @param {object} payload - 客户端保存结构；必须是普通对象。
 * @returns {boolean} 是否写成功；失败不抛，由调用方转成远程错误。
 */
export function saveLayoutFile(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  let text;
  try {
    text = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_LAYOUT_BYTES) return false;
  const file = layoutPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid;
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除磁盘上的布局。
 *
 * 文件本来就不存在也算成功：用户点“清除保存记录”的语义是“之后不要再恢复”，
 * 不是“必须删掉一个文件”。
 *
 * @returns {boolean}
 */
export function clearLayoutFile() {
  try {
    unlinkSync(layoutPath());
    return true;
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'ENOENT';
  }
}
