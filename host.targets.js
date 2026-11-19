/**
 * 多工作区平铺 —— 「派单目标」记录的落盘与读回。
 *
 * 目标是什么：用户在「新建会话」里选「新建目标」时创建的真实会话。它和普通会话
 * 一样存在于 Host，只是额外带一条**目标记录**。这条记录只解决一个显示问题：
 * 空白会话默认在所有会话列表里隐藏；带目标记录的空白会话要显示为「未命名目标」，
 * 让用户可以先建目标、再连线派单，而不必先输入一句话。
 *
 * 为什么不跟画布布局一起保存：目标在创建那一刻就必须存在，不能等用户点
 * 「保存画布」。所以它单独落一个文件，创建/删除时立刻写盘；画布保存只负责
 * 节点、边和位置。
 *
 * 写盘同样走「临时文件 + rename」：进程在写的中间被杀，磁盘上留下的只会是
 * 上一份完整文件，而不是半截 JSON。
 *
 * @module @local/dsh-split-workspaces/host-targets
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 目标记录的文件版本；形状变了就升它，旧文件按空表处理。 */
const TARGETS_VERSION = 1;

/** DSH 主目录。 */
function dshHome() {
  const home = process.env.DSH_HOME;
  return home === undefined || home === '' ? join(homedir(), '.dsh') : home;
}

/** 目标记录文件的位置。 */
function targetsPath() {
  return join(dshHome(), 'storages', 'pane_dispatch_targets.json');
}

/**
 * 读回全部目标记录。
 *
 * 读不懂（文件缺失、JSON 坏了、版本对不上、字段形状不对）一律当作空列表：
 * 目标记录只是一个显示辅助，不该让它把整个插件卡住。
 *
 * @returns `Array<{ id: string, workspaceId: string, createdAt: number }>`。
 */
export function loadTargets() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(targetsPath(), 'utf8'));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  if (parsed.version !== TARGETS_VERSION) return [];
  const targets = [];
  const seen = new Set();
  for (const row of Array.isArray(parsed.targets) ? parsed.targets : []) {
    if (row === null || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const workspaceId = typeof row.workspaceId === 'string' ? row.workspaceId.trim() : '';
    if (id === '' || workspaceId === '' || seen.has(id)) continue;
    seen.add(id);
    targets.push({
      id,
      workspaceId,
      createdAt: Number.isFinite(row.createdAt) ? row.createdAt : Date.now(),
    });
  }
  return targets;
}

/**
 * 覆盖写入目标记录。
 *
 * @param targets - `Array<{ id, workspaceId, createdAt }>`。
 * @returns 是否写成功；失败不抛，调用方负责提示。
 */
export function saveTargets(targets) {
  const file = targetsPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid;
    const payload = {
      version: TARGETS_VERSION,
      targets: (Array.isArray(targets) ? targets : []).map((target) => ({
        id: target.id,
        workspaceId: target.workspaceId,
        createdAt: target.createdAt,
      })),
    };
    writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}
