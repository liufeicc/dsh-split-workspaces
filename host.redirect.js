/**
 * 多工作区平铺 —— 把 A 的「纠正」排队到正在跑的目标。
 *
 * 这是「A 看到过程稿之后能改方向」的落点。它刻意与「派新任务」分成两条路：
 *   - 不调用 `goals.create` —— 目标是同一个，纠正只是补充/修正方向；
 *   - 走 `sessions.prompt(..., mode: 'queue')` —— 排在目标当前轮之后，不打断当前轮；
 *   - 不写 `pending` —— 原来的后台监视/等待继续盯着，A 之后照常取结果。
 *
 * 用户手停的目标不会走到这里：那种目标已经有 `interrupted` 的 settled，分流阶段
 * 会把它当冲突拒绝，避免 A 越过用户去驱动目标。
 *
 * @module @local/dsh-split-workspaces/host-redirect
 */

import { randomUUID } from 'node:crypto';

import { STATUS_REDIRECTED } from './host.constants.js';
import { errorText, wrapRedirect } from './host.message.js';
import { goalSupport, resolveTargetAgent } from './host.wait.js';

/**
 * 把一批纠正依次排队到对应的运行中目标。
 *
 * 关键判断：投递前读一次 goal 的 phase。目标可能刚好在我们挂上纠正之前结束了 ——
 * 这时硬塞一条「纠正」会被当成一条新的用户消息，让目标再跑一轮无关的工作。
 * 这种情况下记成 `failed`，让 A 先取走结果。
 *
 * @param options.ctx - 宿主上下文。
 * @param options.service - 绑定表（用来取发起方显示名）。
 * @param options.ownerId - 发起方会话 id。
 * @param options.bindings - 正在跑的目标。
 * @param options.task - 纠正内容。
 * @param options.signal - 调用方取消信号。
 * @returns `{ status, results, stillRunning, note }`。
 */
export async function redirectBatch(options) {
  const { ctx, service, ownerId, bindings, task, signal } = options;
  const support = goalSupport(ctx);
  if (support === null) {
    throw new Error('这个部署没有目标服务，做不到中途纠正：请等目标跑完、拿到结论后再处理。');
  }
  const ownerLabel = service.labels.get(ownerId) ?? ownerId;
  const results = [];
  let redirected = 0;
  for (const binding of bindings) {
    try {
      const agent = await resolveTargetAgent(support, binding);
      let view;
      try {
        view = support.goals.get(agent);
      } catch {
        view = undefined;
      }
      if (view === undefined || view === null || view.phase !== 'active') {
        results.push({
          target: binding.label,
          status: 'failed',
          deliverable: false,
          reply: '',
          progress: '',
          interruptedBy: '',
          note: '目标已经不在运行中，不能纠正；先取走它的结果，或按新任务重新派。',
        });
        continue;
      }
      const requestId = randomUUID();
      const accepted = await support.sessions.prompt(
        {
          requestId,
          sessionId: binding.id,
          mode: 'queue',
          content: [{ type: 'text', text: wrapRedirect(task, ownerLabel) }],
        },
        signal,
      );
      if (accepted === undefined || accepted === null || accepted.accepted !== true) {
        throw new Error('目标没有接受这条纠正。');
      }
      redirected += 1;
      results.push({
        target: binding.label,
        status: STATUS_REDIRECTED,
        deliverable: false,
        reply: '',
        progress: '',
        interruptedBy: '',
        note: '纠正已排队到目标的下一轮，不是立即打断。目标仍在跑；你可以继续做别的，之后用 dispatch_task 取结果。',
      });
    } catch (reason) {
      results.push({
        target: binding.label,
        status: 'failed',
        deliverable: false,
        reply: errorText(reason),
        progress: '',
        interruptedBy: '',
        note: '纠正没有送出去。',
      });
    }
  }
  if (redirected === 0) {
    throw new Error(results.map((item) => item.reply || item.note).join('\n'));
  }
  return {
    status: redirected === results.length ? STATUS_REDIRECTED : 'partial',
    results,
    stillRunning: redirected,
    note: '纠正已经排队，目标会在下一轮看到；不是立即打断。'
      + '你可以继续做不依赖它的部分，之后用 dispatch_task 取结果。',
  };
}