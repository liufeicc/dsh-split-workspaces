/**
 * 离线契约测试：给每个窗格的「对话内容区」分配不同背景色。
 *
 * 要守住三件事，缺一件用户就会看到不对的画面：
 *
 *   1. **同一屏内不重复。** 四个格子必须能一眼分清；超过色板大小才允许复用。
 *   2. **颜色跟会话走。** 刷新、拖动交换窗格之后，同一段对话还是同一种底色 ——
 *      否则用户刚记住「紫色那格是 A 会话」，交换一下就变了。
 *   3. **文字仍然清楚。** 底色始终是深色，正文 / 次要文字 / 三级文字在每一种底色上
 *      都要过 WCAG AA；这里逐色算真实的 sRGB 混合结果，不靠「看起来挺深」。
 *
 * 另外把「只染内容区」钉住：标题栏规则里不许出现 tint 变量。
 *
 *   node test/tint-contract.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReactStub, loadBundle } from './harness.mjs';
import { check, report, renderBoard, framesOf, paneDom, contrastRatio } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;
const { PANE_TINTS, assignPaneTints } = mods.model;
const CSS = mods.styles.CSS;

/** 造一条窗格记录；只保留分色算法关心的三个字段。 */
const pane = (key, sessionId, workspaceId = 'ws-' + key) => ({ key, workspaceId, sessionId, follow: true });

/** 把 `values` 里的颜色 id 收成集合，便于断言「两两不同」。 */
const tintIds = (map) => new Set([...map.values()].map((tint) => tint.id));

/** 两份 Map 的 key → tint.id 是否完全一致（与插入顺序无关）。 */
function sameTintMap(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, tint] of left) {
    if (right.get(key)?.id !== tint.id) return false;
  }
  return true;
}

// --- 分配：同屏不重复 ---------------------------------------------------------------

check('色板至少能铺满四个窗格', PANE_TINTS.length >= 4, '只有 ' + String(PANE_TINTS.length) + ' 色');

const four = assignPaneTints([
  pane('pane-1', 's1'),
  pane('pane-2', 's2'),
  pane('pane-3', 's3'),
  pane('pane-4', 's4'),
]);
check('四个会话拿到四种不同颜色', tintIds(four).size === 4, [...four.values()].map((tint) => tint.id).join(','));
check('每个窗格的颜色都来自色板', [...four.values()].every((tint) => PANE_TINTS.includes(tint)));

const eight = assignPaneTints(Array.from({ length: PANE_TINTS.length }, (_, index) => pane('pane-' + String(index + 1), 'sess-' + String(index))));
check('色板装满时不重复', tintIds(eight).size === PANE_TINTS.length, [...eight.values()].map((tint) => tint.id).join(','));

const nine = assignPaneTints(Array.from({ length: PANE_TINTS.length + 1 }, (_, index) => pane('pane-' + String(index + 1), 'sess-' + String(index))));
check('超出色板大小时每个窗格仍有颜色，重复无法避免但不丢色', nine.size === PANE_TINTS.length + 1 && [...nine.values()].every((tint) => PANE_TINTS.includes(tint)));

// --- 分配：颜色跟会话走 -------------------------------------------------------------

const reversed = assignPaneTints([
  pane('pane-4', 's4'),
  pane('pane-2', 's2'),
  pane('pane-1', 's1'),
  pane('pane-3', 's3'),
]);
check('布局数组顺序变化（比如恢复保存的布局）不改变每个窗格的颜色', sameTintMap(four, reversed));

const swappedPanes = [
  pane('pane-9', 's1'),
  pane('pane-8', 's2'),
  pane('pane-7', 's3'),
  pane('pane-6', 's4'),
];
const swappedKeys = assignPaneTints(swappedPanes);
/** 把「窗格 → 颜色」还原成「会话 → 颜色」，比较时不受窗格 key 顺序影响。 */
const tintBySession = (panes, tints) => new Map(panes.map((item) => [item.sessionId, tints.get(item.key).id]));
const baseBySession = tintBySession([
  pane('pane-1', 's1'),
  pane('pane-2', 's2'),
  pane('pane-3', 's3'),
  pane('pane-4', 's4'),
], four);
check('同一组会话换到别的窗格 key 上，颜色仍按会话对应',
  [...tintBySession(swappedPanes, swappedKeys)].every(([sessionId, tintId]) => baseBySession.get(sessionId) === tintId));

const singleS1 = assignPaneTints([pane('pane-1', 's1')]).get('pane-1');
const singleS2 = assignPaneTints([pane('pane-1', 's2')]).get('pane-1');
check('窗格里换一个会话，底色跟着换', singleS1.id !== singleS2.id, singleS1.id + ' / ' + singleS2.id);

const emptyPanes = assignPaneTints([pane('pane-1', null, 'ws-a'), pane('pane-2', null, 'ws-b')]);
check('还没建会话的空窗格按工作区分色，也不会撞色', emptyPanes.get('pane-1').id !== emptyPanes.get('pane-2').id);

check('空棋盘返回空 Map', assignPaneTints([]).size === 0);

// --- 可读性：按真实 sRGB 混合结果算对比度 -------------------------------------------

/** 模拟 CSS `color-mix(in srgb, tint percent%, base)` 的 sRGB 通道插值。 */
function mix(tint, base, percent) {
  const from = tint.replace('#', '').match(/../g).map((pair) => parseInt(pair, 16));
  const to = base.replace('#', '').match(/../g).map((pair) => parseInt(pair, 16));
  const channels = from.map((channel, index) => Math.round(channel * (percent / 100) + to[index] * (1 - percent / 100)));
  return '#' + channels.map((channel) => channel.toString(16).padStart(2, '0')).join('');
}

/*
 * 样式块里实际用的混合比例（改动 client.styles.js 时必须同步改这三个数）。
 * PANE_BG_PERCENT 取左上角光晕的最高点：渐变只会往更暗的方向走，所以这里是
 * 正文对比度最差、也是最需要检查的位置。
 * 正文 #dceaf7、次要文字 #9fb6c9、三级文字 #839db2 都来自科幻主题的 token。
 */
const PANE_BG_PERCENT = 20;
const BUBBLE_PERCENT = 5;
const INPUT_PERCENT = 6;
const TEXT_PRIMARY = '#dceaf7';
const TEXT_SECONDARY = '#9fb6c9';
const TEXT_TERTIARY = '#839db2';

let worstPrimary = 21;
let worstSecondary = 21;
let worstTertiary = 21;
for (const tint of PANE_TINTS) {
  const bg = mix(tint.value, '#05080e', PANE_BG_PERCENT);
  const bubble = mix(tint.value, '#0e1929', BUBBLE_PERCENT);
  const input = mix(tint.value, '#0b1423', INPUT_PERCENT);
  worstPrimary = Math.min(worstPrimary, contrastRatio(TEXT_PRIMARY, bg), contrastRatio(TEXT_PRIMARY, bubble));
  worstSecondary = Math.min(worstSecondary, contrastRatio(TEXT_SECONDARY, bg), contrastRatio(TEXT_SECONDARY, bubble), contrastRatio(TEXT_SECONDARY, input));
  worstTertiary = Math.min(worstTertiary, contrastRatio(TEXT_TERTIARY, bg));
  check('「' + tint.id + '」的正文与次要文字在底色上仍清楚', contrastRatio(TEXT_PRIMARY, bg) >= 7 && contrastRatio(TEXT_SECONDARY, bg) >= 4.5,
    '正文 ' + contrastRatio(TEXT_PRIMARY, bg).toFixed(2) + ':1，次要 ' + contrastRatio(TEXT_SECONDARY, bg).toFixed(2) + ':1');
  check('「' + tint.id + '」的气泡与输入框里文字仍清楚', contrastRatio(TEXT_PRIMARY, bubble) >= 7 && contrastRatio(TEXT_SECONDARY, input) >= 4.5,
    '气泡正文 ' + contrastRatio(TEXT_PRIMARY, bubble).toFixed(2) + ':1，输入框次要 ' + contrastRatio(TEXT_SECONDARY, input).toFixed(2) + ':1');
}
check('所有色相的三级文字都过 WCAG AA（4.5:1）', worstTertiary >= 4.5, '最差 ' + worstTertiary.toFixed(2) + ':1');
check('所有色相的正文都远超 AAA（≥ 7:1）', worstPrimary >= 7, '最差 ' + worstPrimary.toFixed(2) + ':1');
check('所有色相的次要文字都过 AA（≥ 4.5:1）', worstSecondary >= 4.5, '最差 ' + worstSecondary.toFixed(2) + ':1');

// --- 样式表：只染内容区，标题栏不动 ------------------------------------------------

/* 基础样式与科幻覆盖里各有一条 `.dshSplitWs_paneBody`，取带 tint 的那一条。 */
const bodyRules = [...CSS.matchAll(/\.dshSplitWs_paneBody\{([^}]*)\}/g)].map((match) => match[1]);
const tintedBody = bodyRules.find((rule) => rule.includes('--dshSplitWs-pane-tint'));
check('内容区规则存在', bodyRules.length > 0);
check('内容区底色是径向 + 线性两层半透明渐变，不是实心色块',
  tintedBody !== undefined
  && tintedBody.includes('radial-gradient')
  && tintedBody.includes('linear-gradient')
  && tintedBody.includes('transparent 68%'));
check('会话根背景是半透明遮罩，渐变能透上来',
  tintedBody !== undefined && tintedBody.includes('rgba(5,8,14,.44)'));
check('内容区覆盖了正文所在的背景 token，而不是只画一层装饰',
  tintedBody !== undefined
  && tintedBody.includes('--dsw-specific-bubble:color-mix')
  && tintedBody.includes('--dsw-specific-input-major:color-mix'));
check('气泡与输入框保留原来的深色，只带一点色相（避免整段对话变成色块）',
  tintedBody !== undefined
  && tintedBody.includes('rgba(14,25,41,.9)')
  && tintedBody.includes('rgba(11,20,35,.9)'));
check('滚动条颜色跟着窗格色相走（不再固定为青色）', CSS.includes('--dshSplitWs-pane-tint,#5ee7ff) 24%,transparent'));
check('标题栏规则里没有 tint 变量（「只染内容区」）',
  [...CSS.matchAll(/\.dshSplitWs_paneHead\{([^}]*)\}/g)].every((match) => !match[1].includes('--dshSplitWs-pane-tint')));
check('三级文字在内容区里被提到可读的亮度',
  tintedBody !== undefined && tintedBody.includes('--dsw-alias-label-tertiary:#839db2'));

// --- 渲染：窗格根节点真的带上了这个变量 --------------------------------------------

const board = await renderBoard(mod);
const tree = board.render().tree;
const frames = framesOf(tree);
check('测试棋盘渲染出两个窗格', frames.length === 2);
check('两个窗格拿到不同颜色', new Set(frames.map((frame) => frame.props.tint?.id)).size === 2,
  frames.map((frame) => frame.props.tint?.id).join(','));

const first = paneDom(tree, 'pane-1');
check('窗格根节点的 style 里有 --dshSplitWs-pane-tint', first !== undefined
  && first.tree.props.style !== undefined
  && typeof first.tree.props.style['--dshSplitWs-pane-tint'] === 'string');
check('data-tint 与变量来自同一个色板项', first !== undefined
  && PANE_TINTS.some((tint) => tint.id === first.tree.props['data-tint'] && tint.value === first.tree.props.style['--dshSplitWs-pane-tint']));
check('两个窗格并排时，配色变量与分屏比例写在同一个 style 里', first !== undefined
  && typeof first.tree.props.style.flexGrow === 'number'
  && first.tree.props.style['--dshSplitWs-pane-tint'] !== undefined);

report();
