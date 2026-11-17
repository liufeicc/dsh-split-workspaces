/**
 * 离线契约测试：派单光效。
 *
 * 分两层：
 *   1. Host 的视觉事件队列 —— `noteDispatch` / `pullVisual` 的增量、水位、容量；
 *      派单工具在投递前记录事件；
 *   2. 客户端 fx 块的纯几何与接线 —— 贝塞尔路径、窗格边缘取点、棋盘边缘取点，
 *      以及 `client.js` 的代码块清单、`client.view.js` 的轮询入口。
 *
 * 真正的飞行/发光只有浏览器能验，这里只把「坐标算对、事件能到、轮询接上」钉住。
 *
 *   node test/fx-contract.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, check, report } from './dispatch-harness.mjs';
import { ReactStub, loadBundle } from './harness.mjs';
import { REMOTE_MARKERS } from '../host.constants.js';

const here = dirname(fileURLToPath(import.meta.url));

// --- Host：视觉事件队列 -----------------------------------------------------------

const harness = boot({});
const service = harness.services.get('paneDispatch');
check('服务暴露 noteDispatch / pullVisual', typeof service.noteDispatch === 'function' && typeof service.pullVisual === 'function');
check('远端方法清单包含 pullVisual',
  Array.isArray(REMOTE_MARKERS.methods) && REMOTE_MARKERS.methods.some((item) => item.method === 'pullVisual'));

service.noteDispatch('session-a', ['session-b', 'session-c']);
const first = service.pullVisual({ since: 0 });
check('记录一条派单事件', first.events.length === 1
  && first.events[0].type === 'dispatch'
  && first.events[0].source === 'session-a'
  && first.events[0].targets.join(',') === 'session-b,session-c');
check('latest 随事件前进', first.latest === 1);
check('since 之后不再重复返回', service.pullVisual({ since: first.latest }).events.length === 0);

service.noteDispatch('session-a', []);
check('空目标不产生光效事件', service.pullVisual({ since: 1 }).events.length === 0);

for (let index = 0; index < 70; index += 1) service.noteDispatch('s-' + String(index), ['t-' + String(index)]);
check('事件队列只保留最近 64 条', service.visualEvents.length === 64);
check('队列首条是第 8 条事件（8..71）', service.visualEvents[0].seq === 8 && service.visualEvents[63].seq === 71);

const toolSource = readFileSync(join(here, '..', 'host.tool.js'), 'utf8');
check('dispatch_task 在真正投递前记录视觉事件', toolSource.includes('service.noteDispatch(ownerId, requested.map'));

// --- 客户端：几何与接线 -----------------------------------------------------------

const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;
const { dispatchPath, randomPointIn, boardEdge } = mods.fx;

check('客户端代码块清单包含 fx', mod.test.CHUNK_FILES.includes('./client.fx.js'));

const path = dispatchPath({ x: 0, y: 0 }, { x: 100, y: 0 });
check('路径是直线（不再绕圈）', path.d === 'M 0 0 L 100 0' && path.points.length === 2);
const targetRect = { left: 100, top: 100, width: 200, height: 100 };
const low = randomPointIn(targetRect, () => 0);
const high = randomPointIn(targetRect, () => 1);
check('目标落点在窗格内随机（四周留 20% 边距）',
  low.x === 140 && low.y === 120 && high.x === 260 && high.y === 180);

const board = { left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200 };
check('棋盘边缘取最近的右边', Math.abs(boardEdge(board, { x: 500, y: 100 }).x - 400) < 0.01);
check('棋盘边缘取最近的下边', Math.abs(boardEdge(board, { x: 200, y: 500 }).y - 200) < 0.01);

const viewSource = readFileSync(join(here, '..', 'client.view.js'), 'utf8');
check('棋盘挂载时轮询派单事件', viewSource.includes('pullDispatchVisual(since)'));
check('Host 重载后水位能回退（否则新事件会被旧 since 过滤）', viewSource.includes('serverLatest < since'));
check('轮询失败只降频，不永久停止', viewSource.includes('failures >= 5 ? 1000 : 300'));
check('窗格缺失时把会话映射成 null（飞向/飞入棋盘边缘）', viewSource.includes('elementForSession'));
check('fx 样式包含 120px 光晕、头部、双层尾迹与边框高亮框',
  mods.styles.CSS.includes('.dshSplitWs_fxGlow')
  && mods.styles.CSS.includes('width:120px;height:120px')
  && mods.styles.CSS.includes('.dshSplitWs_fxHead')
  && mods.styles.CSS.includes('.dshSplitWs_fxTail')
  && mods.styles.CSS.includes('.dshSplitWs_fxTailCore')
  && mods.styles.CSS.includes('.dshSplitWs_fxFlash')
  && mods.styles.CSS.includes('.dshSplitWs_fxHit')
  && !mods.styles.CSS.includes('.dshSplitWs_fxTrail')
  && !mods.styles.CSS.includes('.dshSplitWs_fxLayer'));
check('边框脉冲颜色是合法 rgba（不再拼接出 rgba(...)00）',
  readFileSync(join(here, '..', 'client.fx.js'), 'utf8').includes("rgba(' + rgb")
  && !readFileSync(join(here, '..', 'client.fx.js'), 'utf8').includes("color + '00'"));
check('飞行时长放慢到 2.4 秒', readFileSync(join(here, '..', 'client.fx.js'), 'utf8').includes('FLIGHT_MS = 2400'));
check('命中时窗格抖动并有白光覆盖层', (() => {
  const source = readFileSync(join(here, '..', 'client.fx.js'), 'utf8');
  return source.includes("translate: '-7px 4px'")
    && source.includes("dshSplitWs_fxHit")
    && source.includes("offset: 0.28") && source.includes("impact(targetElement");
})());
check('多目标串行发射（上一颗落地后再发下一颗）',
  readFileSync(join(here, '..', 'client.fx.js'), 'utf8').includes('chain = chain.then'));
check('不再画轨迹线（没有 SVG path / strokeDashoffset）',
  !readFileSync(join(here, '..', 'client.fx.js'), 'utf8').includes('strokeDashoffset'));

report();
