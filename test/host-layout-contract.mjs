/**
 * Host 布局落盘的离线契约测试。
 *
 * 这里不启动 DSH，只验证 `host.layout.js` 的文件行为：
 *   - 没有文件时读出 null；
 *   - 写入后能原样读回（版本、窗格等字段不被 Host 改写）；
 *   - 文件落在 `$DSH_HOME/storages/pane_layout.json`；
 *   - 非法根值不写；
 *   - 清除后读回 null，重复清除也成功。
 *
 * 用 `node test/host-layout-contract.mjs` 单独运行。
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, report } from './board.mjs';

const home = mkdtempSync(join(tmpdir(), 'dsh-layout-store-'));
process.env.DSH_HOME = home;

const { clearLayoutFile, loadLayoutFile, saveLayoutFile } = await import('../host.layout.js');
const { PaneDispatchService } = await import('../host.service.js');

const payload = {
  version: 1,
  panes: [{ key: 'pane-1', workspaceId: 'ws-a', sessionId: 's-a' }],
  layout: { type: 'leaf', paneKey: 'pane-1' },
  activeKey: 'pane-1',
};

check('没有布局文件时读出 null', loadLayoutFile() === null);
check('布局保存成功', saveLayoutFile(payload) === true);
check('布局落在 $DSH_HOME/storages/pane_layout.json',
  existsSync(join(home, 'storages', 'pane_layout.json')));
check('读回的布局与写入一致', JSON.stringify(loadLayoutFile()) === JSON.stringify(payload));
check('数组/空值不是合法布局，不覆盖已有文件',
  saveLayoutFile([]) === false && saveLayoutFile(null) === false);
check('非法写入后旧布局仍然完整', JSON.stringify(loadLayoutFile()) === JSON.stringify(payload));
check('清除布局成功', clearLayoutFile() === true && loadLayoutFile() === null);
check('重复清除也成功', clearLayoutFile() === true);

const service = new PaneDispatchService({});
service.writeLayout({ layout: payload });
check('服务 writeLayout/readLayout 走同一份文件',
  JSON.stringify(service.readLayout({})) === JSON.stringify(payload));
service.clearLayout({});
check('服务 clearLayout 也清掉文件', service.readLayout({}) === null && loadLayoutFile() === null);

report();
