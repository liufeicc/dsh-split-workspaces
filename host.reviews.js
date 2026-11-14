/**
 * 多工作区平铺 —— 交付之后的「审核」。
 *
 * 从 `host.batch.js` 拆出来：审核是交付之后的**下一道闸**，与「这一批怎么等、
 * 怎么收尾」是两件事。放在单独文件里，既让 batch 回到合理长度，也让审核的两条入口
 * （人工点「审核完成」后的释放、模型 `reviews` 的落账）集中在一处。
 *
 * 审核的最终真相是目标上的 complete goal，而不是单独一张账：审核账丢失时，
 * `ensureReviewFromGoal()` 会从 complete goal 补账；新派单在 `goals.create` 之前
 * 也会看 goal，不覆盖待审核的 complete goal（见 `host.batch.js` 的创建闸）。
 *
 * @module @local/dsh-split-workspaces/host-reviews
 */

import { liveAgent } from './host.goal-state.js';
import { describeCandidates, matchBinding } from './host.message.js';
import { goalSupport, resolveTargetAgent } from './host.wait.js';
import { ensureReviewFromGoal } from './host.watch.js';

/**
 * 建新目标之前的审核闸：上一单 complete、但没有审核记录时，给模型一句可执行的话。
 *
 * 它与 `explainConflicts` 里的 `review` 文案保持一致，但用在「已经 resolve 出 agent、
 * 正要 createGoal」的最后一步 —— 即使 `adoptOrphanGoals` 没跑或没认出 complete goal，
 * 这里也能拦住，绝不让 `goals.create` 直接把待审核的 goal 覆盖掉。
 *
 * @param binding - 被拦住的目标。
 * @returns 一句人话。
 */
export function reviewBlockedText(binding) {
  return '「' + binding.label + '」上一单已经完成，但还没审核（目标栏显示「待审核」）。'
    + '结论留在目标会话的历史里；先用 dispatch_task 带 reviews 记录审核结论，再派新任务。';
}

/**
 * 人已经点过目标条上的「审核完成」：goal 被清掉了，但插件的待审核记录还在。
 *
 * 以 goal 为真相 —— 目标上已经没有 complete 的 goal（或换成了新 goal），就说明审核
 * 这一步已经被人做过，把记录清掉、放行新派单。读不到目标状态时保留审核闸：宁严勿松。
 *
 * @param ctx - 宿主上下文。
 * @param service - 绑定表。
 * @param ownerId - 发起方会话 id。
 * @param bindings - 这一次要派的目标。
 */
export async function releaseHumanReviewed(ctx, service, ownerId, bindings) {
  const support = goalSupport(ctx);
  if (support === null) return;
  for (const binding of bindings) {
    if (service.reviewOf(ownerId, binding.id) === undefined) continue;
    let agent;
    try {
      agent = await resolveTargetAgent(support, binding);
    } catch {
      continue;
    }
    let view;
    try {
      view = support.goals.get(liveAgent(ctx, agent));
    } catch {
      continue;
    }
    if (view === undefined || view === null || view.phase !== 'complete') {
      service.takeReview(ownerId, binding.id);
    }
  }
}

/**
 * 记录一次审核（`dispatch_task` 的 `reviews` 参数）。
 *
 * 审核按目标进行：
 *   - 只有**真的交付过**（deliverable: true）且还没审核的目标才能审；
 *   - 通过或驳回都会清掉待审核状态 —— 驳回之后就能带着缺口重派；
 *   - 驳回必须写清缺什么，否则重派时还是同一句「再做一遍」。
 *
 * 先整批校验、再整批落账：任何一项不合法都不改动已审状态，避免「批里错一个、
 * 前面几个已经被清掉」的半截状态。唯一的例外是 `ensureReviewFromGoal()` 在校验阶段
 * 补记缺失的审核账 —— 那只是把「complete goal 应该待审核」这个事实补回来，不是
 * 审核动作；调用失败也不会丢数据，下次还能再补。
 *
 * @param options.ctx - 宿主上下文。
 * @param options.service - 绑定表（读写待审核记录）。
 * @param options.ownerId - 发起方会话 id。
 * @param options.bindings - 这个会话可派的目标。
 * @param options.reviews - 模型给的数组 `[{ target, verdict, note? }]`。
 * @returns `{ status: 'reviewed', results, stillRunning: 0, note }`。
 */
export async function runReviews(options) {
  const { ctx, service, ownerId, bindings, reviews } = options;
  const plan = [];
  const seen = new Set();
  for (const raw of reviews) {
    const targetText = typeof raw?.target === 'string' ? raw.target.trim() : '';
    if (targetText === '') throw new Error('reviews 里每一项都要给 target（序号、标题或会话 id）。');
    const binding = matchBinding(bindings, targetText);
    if (binding === null) {
      throw new Error(
        '没认出要审核哪个目标：' + targetText + '。当前可派的是：\n' + describeCandidates(bindings),
      );
    }
    if (seen.has(binding.id)) throw new Error('同一个目标一次只能审一次：「' + binding.label + '」。');
    seen.add(binding.id);
    const verdict = raw?.verdict;
    if (verdict !== 'accepted' && verdict !== 'rejected') {
      throw new Error('reviews 里的 verdict 只能是 accepted 或 rejected。');
    }
    const note = typeof raw?.note === 'string' ? raw.note.trim() : '';
    if (verdict === 'rejected' && note === '') {
      throw new Error('驳回必须写清缺什么（note），否则重派时对方还是不知道要补哪一条。');
    }
    /*
     * 审核账可能因为「交付后还没落盘就被重启」而丢失，但目标上的 complete goal 仍在。
     * 以 goal 为最终真相补记一条审核记录，否则界面显示「待审核」、reviews 却报
     * 「没有待审核的交付」—— 真机上就是这样把 A 引向了错误的结论。
     */
    let review = service.reviewOf(ownerId, binding.id);
    if (review === undefined) {
      review = await ensureReviewFromGoal(ctx, service, ownerId, binding);
    }
    if (review === undefined) {
      throw new Error(
        '「' + binding.label + '」没有待审核的交付：只有上一单真的交付了（deliverable: true）才需要审核；'
        + 'failed / blocked / interrupted 不需要。',
      );
    }
    plan.push({ binding, verdict, note });
  }
  if (plan.length === 0) throw new Error('reviews 是空的：至少给一项 { target, verdict }。');

  const support = goalSupport(ctx);
  const results = [];
  for (const item of plan) {
    service.takeReview(ownerId, item.binding.id);
    /*
     * 审核完就把那个已完成的 goal 清掉：GoalBar 上的「待审核」随之消失，目标也不再
     * 占着「complete 只能被 create 替换」的位置。清不掉（目标已清、会话读不到）不回滚
     * 审核记录 —— 记录已经落账，用户还可以在目标条上点「审核完成」收尾。
     */
    if (support !== null) {
      try {
        const agent = await resolveTargetAgent(support, item.binding);
        const view = support.goals.get(agent);
        if (view !== undefined && view !== null && view.phase === 'complete') {
          support.goals.clear(agent, { id: view.id, revision: view.revision });
        }
      } catch {
        /* 留给目标条上的「审核完成」按钮。 */
      }
    }
    results.push({
      target: item.binding.label,
      status: item.verdict,
      deliverable: false,
      reply: '',
      progress: '',
      interruptedBy: '',
      note: item.verdict === 'accepted'
        ? '审核通过。现在可以给这个目标派新任务。'
        : '已记录驳回。用 dispatch_task 带 task 把具体缺口发回去'
          + (item.note === '' ? '。' : '：' + item.note),
    });
  }
  return {
    status: 'reviewed',
    results,
    stillRunning: 0,
    note: '审核已记录。通过的目标可以派新任务；驳回的目标请带着 note 里的具体缺口重派。',
  };
}
