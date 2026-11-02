/**
 * 多工作区平铺 —— 面向模型的 `dispatch_task` 工具。
 *
 * 工具描述是整套「让 A 知道该派给谁」的核心：模型不会主动派活，除非描述里同时给了
 * 「现在能派给谁」「他们各自在做什么」「什么时候该派」。所以对连了箭头的会话，注册的
 * 是一份带目标名单的**作用域工具**（遮蔽同名全局工具）；没连箭头的人拿到通用那份。
 *
 * 工具执行本身只做三件事：找出这一次派给谁、把任务交出去、把结论整理成返回值。
 * 真正的投递与等待在 `host.wait.js`。
 *
 * @module @local/dsh-split-workspaces/host-tool
 */

import { MAX_TASK_CHARS, TOOL_NAME } from './host.constants.js';
import { describeCandidates, errorText, matchBinding, wrapTask } from './host.message.js';
import {
  deliverAndWait,
  goalSupport,
  resolveTargetAgent,
  runningText,
  waitForGoal,
} from './host.wait.js';

/**
 * 「派不出去」时到底该让用户做什么 —— 三种病因，三句话。
 *
 * 这段之所以值得写得这么细：第一次真机联调时，A 连着失败四次而用户以为已经派成了。
 * 原来的措辞只有一句「用户还没有画箭头」，无法区分「界面根本没同步到 Host」与
 * 「箭头画给了别的窗格」，用户照着它去检查只会越查越远。
 *
 * @param service - 绑定表（要读它的诊断计数与派出方名单）。
 * @param ownerId - 发起方会话 id。
 * @param bindings - 这个会话自己的绑定。
 * @returns 一整句可直接抛给模型、也适合原样转述给用户的话。
 */
export function explainNoTarget(service, ownerId, bindings) {
  if (Array.isArray(bindings) && bindings.length > 0) {
    return '当前绑定了多个目标，请用 target 指定其中之一：\n' + describeCandidates(bindings);
  }
  const setCount = service?.stats?.set ?? 0;
  if (setCount === 0) {
    return [
      '没有确定要派给哪个会话：Host 一次都还没收到过界面的绑定同步。',
      '请让用户确认两件事：(1) 已经刷新过页面、并且「多工作区平铺」面板顶部能看到「平铺 | 设计」两个按钮；',
      '(2) 在「设计」里从这个会话所在的卡片右边缘圆点拖一条箭头到目标卡片上。',
    ].join('');
  }
  const relations = typeof service?.relations === 'function' ? service.relations() : [];
  const drawn = relations.length === 0
    ? 'Host 上现在一条委派关系都没有。'
    : 'Host 上现在只有这些委派关系：' + relations.map((item) => '「' + item.from + '」→「' + item.to.join('」「') + '」').join('；') + '。';
  return [
    '没有确定要派给哪个会话：以这个会话（' + ownerId + '）为起点的箭头一条都没有。',
    drawn,
    '请让用户核对：发起这次调用的会话，是不是就是那条箭头**起点**那张卡片。',
    '如果对不上，就在「多工作区平铺 → 设计」里把箭头从发起调用的那个会话所在的卡片连出去。',
  ].join('');
}

/**
 * 这段工具描述是整套「让 A 知道该派给谁」的核心。
 *
 * 背景：工具本身只是「能调」，但模型要**主动**派活，得同时具备三样东西 ——
 *   1. 知道自己现在能派给谁（否则它得先失败一次才知道）；
 *   2. 知道那些会话各自在做什么（否则无从选择）；
 *   3. 一条「什么时候该派、什么时候不要派」的判断准则（否则它会一直自己做）。
 *
 * 所以对**已经连了箭头的会话**，注册的是一份 agent 作用域的工具（遮蔽同名的全局工具），
 * 描述里直接列出目标名单。没有连箭头的会话拿到的是全局那份通用描述。
 *
 * 刻意**不**把对方「忙不忙」写进描述：那会随每一轮变化而改写工具 schema，等于每次
 * 都让这个会话的提示词缓存失效。忙闲交给调用时的错误返回处理（那段话也说清了）。
 *
 * @param service - 绑定表。
 * @param ownerId - 发起方会话 id；undefined 表示生成通用的那份（全局工具）。
 * @returns 完整的工具描述。
 */
export function dispatchDescription(service, ownerId) {
  const roster = typeof ownerId === 'string' && ownerId !== '' ? (service.bindings.get(ownerId) ?? []) : [];
  const base = [
    '把一项可以独立完成的任务交给另一个会话执行，等它停下后把结论拿回来。',
    '这不是「给对方发个消息」，而是「把这段工作交出去、由它做完」。',
    '',
    '任务会以**目标**的形式交给对方：它被设成那个会话的目标，会持续朝它推进，直到达成或卡住。',
    '',
    '## 什么时候用',
    '只有当用户在「任务分派」里给这个会话连了箭头、并且这份工作按那个分工确实更适合交给',
    '对方做时才用。不要为了用而用 —— 大部分事情你自己做完更快。',
    '没有连箭头时调用会直接报错，不要试图绕过它。',
    '',
    '## 派之前',
    '背景、要产出什么、怎么算做完，三样都要写清。对方看不到你当前对话的历史，只能看到你写的',
    '这段文字；写得含糊，拿回来的结论也会含糊。',
    '',
    '## 调用行为',
    '每次调用最多等 5 分钟：',
    '- 对方在这段时间内做完了 → 直接返回它的结论；',
    '- 还没做完 → 返回**目前的进度**，status 是 running；',
    '只要状态还是 running，就**必须继续调用**（省略 task）接着等，直到状态不再是 running 才算结束。',
    '不要把它当成失败，也不要停下来问用户要不要继续等 —— 用户要的就是「一直盯到它做完」。',
    '要求对方此刻空闲才接新单；续等不受这条限制。对方正在跑回合时会直接报错而不是排队。',
  ];
  if (roster.length === 0) {
    base.push('');
    base.push('## 当前可派目标');
    base.push('这个会话还没有连任何委派箭头。如果用户问起，告诉 ta 在「多工作区平铺 → 任务分派」里');
    base.push('从这个会话连一条箭头出去，并在箭头上写清对方适合做什么。');
    return base.join('\n');
  }
  base.push('');
  base.push('## 当前可派目标');
  base.push('每条后面是用户写的分工说明 —— 按它来决定派给谁。target 用序号或标题的一部分即可：');
  for (let index = 0; index < roster.length; index += 1) {
    const item = roster[index];
    const note = item.note === undefined || item.note === ''
      ? '（用户还没写说明 —— 不确定就别派）'
      : item.note;
    base.push((index + 1) + ') ' + item.label + ' —— ' + note);
  }
  return base.join('\n');
}

/**
 * 构造模型面向的那次工具调用说明。
 *
 * 描述里必须写清三件事，否则模型会拿它当「给用户发消息」用：
 *   1. 它把任务交给**用户在平铺面板里勾选的另一个会话**；
 *   2. 它会**一直等到对方停下来**才返回；
 *   3. 绑定多个目标时用 `target` 指定派给谁（序号或标题）。
 *
 * @param service - 绑定表。
 * @returns 一个可以直接交给 `ctx.tools.register()` 的工具定义。
 */
export function createDispatchTool(service, ownerId) {
  return {
    name: TOOL_NAME,
    description: dispatchDescription(service, ownerId),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '要交给对方完成的任务正文。写清楚背景、目标产物和验收标准；对方看不到当前会话的历史。',
        },
        target: {
          type: 'string',
          description: '派给哪一个绑定目标。省略时只在恰好绑定了一个目标的情况下有效；否则会返回候选列表。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          status: { type: 'string' },
          reply: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['target', 'status', 'reply', 'note'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = ['分派给：' + value.target, '状态：' + value.status];
        lines.push(value.reply === '' ? '（对方还没有产出可读的文字）' : '\n' + value.reply);
        if (value.note !== '') lines.push('\n' + value.note);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const task = typeof args?.task === 'string' ? args.task.trim() : '';
      const ownerId = exec?.agent?.id;
      if (typeof ownerId !== 'string' || ownerId === '') {
        throw new Error('这个工具只能在会话里由模型调用。');
      }
      const bindings = service.bindings.get(ownerId) ?? [];
      const binding = matchBinding(bindings, args?.target);
      if (binding === null) throw new Error(explainNoTarget(service, ownerId, bindings));
      /*
       * 传给目标会话的「谁派的」必须是**显示名**而不是会话 id —— 这句话是写给目标
       * 会话的模型看的，一串 `session-xxxx` 对它没有任何信息量。名字由客户端随绑定
       * 同步上来（`ownerLabel`），没有时才退回 id。
       */
      const ownerLabel = service.labels.get(ownerId) ?? ownerId;

      const key = ownerId + '\u0000' + binding.id;
      const pending = service.pending.get(key);
      if (pending === undefined && task === '') {
        throw new Error('第一次派任务必须给出 task；省略 task 只用于「接着等上一次派出去的那件事」。');
      }
      if (task.length > MAX_TASK_CHARS) throw new Error('任务正文超过 ' + MAX_TASK_CHARS + ' 字符，请拆小一点再派。');

      const support = goalSupport(service.ctx);
      let outcome;
      if (support === null) {
        // 老部署没有目标服务：只能走普通消息投递（那条路按「一轮结束」收尾）。
        outcome = await deliverAndWait(service.ctx, binding, task, ownerLabel, exec.signal);
      } else {
        /*
         * 续等时不查「对方忙不忙」—— 它当然在忙，那正是我们在等的事。
         * 这个检查只对「新派一单」有意义：目标必须空闲才接得下这一单。
         */
        if (pending === undefined) {
          const busy = runningText(service.ctx, binding);
          if (busy !== null) throw new Error(busy);
        }
        const agent = await resolveTargetAgent(support, binding);
        if (pending === undefined) {
          /*
           * 创建目标必须在**调用 waitForGoal 之前**：`waitForGoal` 一进来就会读一次
           * 状态，如果那时目标还不存在，它会当成「目标已被清除」立刻收尾。
           */
          let created;
          try {
            created = support.goals.create(agent, { objective: wrapTask(task, ownerLabel) });
          } catch (reason) {
            throw new Error(
              '目标会话「' + binding.label + '」当前的目标没法替换（' + errorText(reason) +
              '）。请先在那个会话里结束或清除它现有的目标，再派新的。',
            );
          }
          service.pending.set(key, {
            goalId: created === undefined || created === null ? undefined : created.id,
            startedAt: Date.now(),
          });
        }
        outcome = await waitForGoal(service.ctx, agent, exec.signal, { sliceMs: service.sliceMs });
        if (outcome.status !== 'running') service.pending.delete(key);
      }

      /*
       * 卡住时把原因附在结论后面：这段话会原样进发起方的对话，只说「status: blocked」
       * 对它没有任何帮助。
       */
      const reason = typeof outcome.reason === 'string' && outcome.reason !== '' ? outcome.reason : '';
      const reply = reason === '' ? outcome.reply : (outcome.reply === '' ? '' : outcome.reply + '\n\n') + '（' + reason + '）';
      const note = outcome.status === 'running'
        ? '对方还在做（已到第 ' + String(outcome.rounds ?? 0) + ' 轮）。继续调用 dispatch_task 并省略 task，接着等下一段，直到状态不再是 running。'
        : '';
      return { target: binding.label, status: outcome.status, reply, note };
    },
  };
}
