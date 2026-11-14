/**
 * 多工作区平铺 —— 建目标与「清掉停止态旧目标」。
 *
 * 从 `host.batch.js` 拆出来：`goals.create` 的前置条件（已有 goal 时哪些能替换、
 * 哪些必须先 clear）是一套独立的规则，和批量等待/收尾不是同一件事。放在单独文件里，
 * 既让 batch 回到合理长度，也方便测试「停止态目标可以被新任务替换」。
 *
 * @module @local/dsh-split-workspaces/host-goal-create
 */

import { classifyGoal } from './host.goal-state.js';

/**
 * 把一个「受阻」视图里的人话取出来。
 *
 * 真实形状是 `{ code, message }`（code 是稳定分类码，message 是给人看的那句话）。
 * **不能用 `explanation`** —— 那个字段不存在，取出来永远是 undefined，于是只能退回去
 * 显示 `round-limit` 这类码，而不是真正的原因。
 *
 * @param view - 目标视图。
 * @returns 原因文本；没有就返回空串。
 */
function blockReasonText(view) {
  const reason = view === undefined || view === null ? undefined : view.blockedReason;
  if (reason === undefined || reason === null) return '';
  if (typeof reason.message === 'string' && reason.message !== '') return reason.message;
  return typeof reason.code === 'string' ? reason.code : '';
}

/**
 * 建一个新目标；如果对方有一个**已经停住但不可直接替换**的旧目标，先清掉它。
 *
 * `goals.create` 的契约是「已 complete 的目标可以被替换；其余阶段必须先 clear 或
 * resume」。所以对方一旦 `blocked` 或 `paused`，直接 create 必然失败 —— 这正是
 * 「B 受阻之后 A 再也派不进去」的根因。
 *
 * 只清**已经停了**的目标：
 *   - `blocked` / `paused`：durable 终态，清理后重建；
 *   - `active + disarmed + idle`：Host 重启后的停止态，界面也显示「已暂停」，
 *     同样可以清理重建；
 *   - `active + armed` 或 agent 真在跑：对方还在干活，不清，按「忙」拒绝；
 *   - `complete` 不用清：create 自己就能替换（审核闸会在更早一步拦住真正交付的单）。
 * 清除会留下 durable tombstone 与历史，不是把记录抹掉。
 *
 * @param support - `goalSupport()` 的返回值。
 * @param agent - 目标的活 agent。
 * @param objective - 写进新目标的目标描述。
 * @returns `{ view, replaced }`；`replaced` 非空表示清掉过一个旧目标。
 */
export function createGoalFor(support, agent, objective) {
  try {
    return { view: support.goals.create(agent, { objective }), replaced: null };
  } catch (reason) {
    let current;
    try {
      current = support.goals.get(agent);
    } catch {
      current = undefined;
    }
    if (current === undefined || current === null) throw reason;
    /*
     * 用 classification 而不是只看 phase：active+disarmed+idle 在界面和派单语义里
     * 都是「已暂停」，但它不是 durable `paused`，旧逻辑会把它误当成「还在跑」，
     * 于是 create 抛错、A 永远派不进去。
     */
    const state = classifyGoal(current, agent);
    if (state.status !== 'paused' && state.status !== 'blocked') throw reason;
    try {
      support.goals.clear(agent, { id: current.id, revision: current.revision });
    } catch {
      // 清不掉（比如 revision 又变了）：保留原始错误，让调用方看到真实原因。
      throw reason;
    }
    return {
      view: support.goals.create(agent, { objective }),
      replaced: {
        phase: state.status,
        reason: state.status === 'blocked' ? blockReasonText(current) : state.reason,
      },
    };
  }
}

/**
 * 结果里那句「派单前清掉过旧目标」的说明。
 *
 * @param replaced - `createGoalFor()` 返回的 `replaced`。
 * @returns 说明文本；没清过就返回空串。
 */
export function replacedNote(replaced) {
  if (replaced === undefined || replaced === null) return '';
  const what = replaced.phase === 'paused' ? '暂停' : '受阻';
  const why = replaced.reason === '' ? '' : '（原因：' + replaced.reason + '）';
  return '派单前已清除对方一个' + what + '的旧目标' + why + '，本次是新的目标。';
}
