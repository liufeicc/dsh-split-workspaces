/**
 * 多工作区平铺 —— 面向模型的 `dispatch_task` 工具。
 *
 * 工具描述是整套「让 A 知道该派给谁」的核心：模型不会主动派活，除非描述里同时给了
 * 「现在能派给谁」「他们各自在做什么」「什么时候该派」「这一批什么时候算完」。所以对
 * 连了箭头的会话，注册的是一份带目标名单的**作用域工具**（遮蔽同名全局工具）；没连
 * 箭头的人拿到通用那份。
 *
 * 本文件只做三件事：解析参数（把名字/序号解析成目标）、校验、把结果整形成返回值。
 * 真正的调度在 `host.batch.js`，投递与等待在 `host.wait.js`。
 *
 * @module @local/dsh-split-workspaces/host.tool
 */

import { MAX_BATCH_TARGETS, MAX_TASK_CHARS, TOOL_NAME } from './host.constants.js';
import { normalizeWait, runBatch, runReviews } from './host.batch.js';
import { adoptOrphanGoals } from './host.watch.js';
import { describeCandidates, matchBinding } from './host.message.js';

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
    return '还没确定要派给哪个目标，请用 targets 指定：\n' + describeCandidates(bindings);
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
 * 把模型给的目标名（序号 / 完整标题 / 标题的一部分 / 会话 id）解析成绑定对象。
 *
 * 任何一个名字认不出来都**整批拒绝**：猜错方向的代价是任务投给了不该投的会话，
 * 比让模型重试一次贵得多。
 *
 * @param bindings - 这个会话可派的目标。
 * @param rawTargets - 模型给的字符串数组。
 * @returns 去重后的绑定数组（保持模型给的顺序）。
 */
function pickTargets(bindings, rawTargets) {
  const out = [];
  const seen = new Set();
  for (const raw of rawTargets) {
    const binding = matchBinding(bindings, raw);
    if (binding === null) {
      throw new Error(
        '没认出要派给哪个目标：' + String(raw) + '。当前可派的是：\n' + describeCandidates(bindings),
      );
    }
    if (seen.has(binding.id)) continue;
    seen.add(binding.id);
    out.push(binding);
  }
  return out;
}

/**
 * 这个会话此刻还在跑的那些派单。
 *
 * 续等（不给 task）且没指定 targets 时用它：只等真正在跑的目标，而不是把全部可派
 * 目标都列一遍 —— 后者会让「等一个从没派过的目标」变成一次白等。
 *
 * @param service - 绑定表。
 * @param ownerId - 发起方会话 id。
 * @param bindings - 这个会话可派的目标。
 * @returns 有进行中派单的绑定。
 */
function pendingTargets(service, ownerId, bindings) {
  return bindings.filter((binding) => service.pending.has(ownerId + '\u0000' + binding.id));
}

/**
 * 决定这一次到底操作哪些目标。
 *
 * 三种来路，顺序即优先级：
 *   1. 显式给了 targets → 逐个解析；
 *   2. 没给 targets 但给了 task → 派给全部可派目标（只有一个时就是它）；
 *   3. 都没给 → 续等这个会话所有还在跑的目标。
 *
 * @returns 目标数组；空数组表示「没法决定，由调用方报错」。
 */
export function resolveRequested(service, ownerId, bindings, rawTargets, hasTask) {
  const list = Array.isArray(rawTargets) ? rawTargets : [];
  if (list.length > 0) return pickTargets(bindings, list);
  if (hasTask) return bindings.length === 1 ? bindings.slice() : [];
  return pendingTargets(service, ownerId, bindings);
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
    '把可以独立完成的任务交给其他会话执行，等它们停下后把结论拿回来。',
    '这不是「给对方发个消息」，而是「把这段工作交出去、由它做完」。',
    '',
    '任务会以**目标**的形式交给对方：它被设成那个会话的目标，会持续朝它推进，直到达成或卡住。',
    '',
    '## 什么时候用',
    '用户在「任务分派」里给这个会话连了箭头，就是把这部分工作授权出去：只要目标空闲、',
    '任务能拆成相对独立的块，就**优先派出去**，不要因为「自己做更快」而留着自己做。',
    '一轮里先把可并行的部分拆出来，**尽量一次派满所有合适的空闲目标**（targets 列全）；',
    '不要一次只派一个、等它回来再派下一个 —— 那会让其余空闲目标干等。',
    '只有这些情况才不派或少派：目标在忙、文件/资源冲突、任务强依赖前一件、',
    '或目标的分工说明里明确不负责这块。没有连箭头时调用会直接报错，不要试图绕过它。',
    '',
    '## 分配策略',
    '1. 先看下面的「当前可派目标」，按分工说明把活拆成与空闲目标数量匹配的独立块；',
    '2. 能并行的块写成**同一次** dispatch_task 的 targets 数组，让它们同时开工；',
    '3. 这一批派完还有剩余、而结果里提示「还有目标空闲」时，接着把剩余块派出去；',
    '   不要停下来自己顺手做完 —— 用户连箭头就是希望这些活由它们承担；',
    '4. 没有合适的块就不要硬塞，但要在汇报里说清「剩下哪些没派、为什么」。',
    '',
    '## 派之前',
    '对方看不到你当前对话的历史，只能看到你写的那段文字。三样必须写清：背景、要产出什么、',
    '**怎么算做完**。',
    '「怎么算做完」要写成**可检验**的条款，不要写「做好一点」「尽量完善」这类空话。例如：',
    '- 「`npm test` 全绿，且新增的 3 个用例在 test/ 下能单独跑通」；',
    '- 「README 里补了『部署』一节，含 3 个命令示例」；',
    '- 「这个函数在空输入下返回空数组，并有对应单测」。',
    '写得含糊，你只能拿回一份同样含糊的结论 —— 那不是对方偷懒，是你没给它可执行的标准。',
    '',
    '## 拿到结论之后',
    '不要直接把结论转述给用户，先自己复核一遍：',
    '- 结论对每一条验收标准都给了证据（跑了什么、看到什么、改了哪些文件）吗？',
    '- 哪些条目只说了「已完成」却没有任何证据？那几条基本等于没做。',
    '- 结论里有没有把「任务简介」当成「完成结果」交回来？',
    '不达标就**带着具体缺口重新派**：点名哪一条没有证据、期望看到什么。',
    '不要笼统地说「再做一遍」—— 那只会换来同一次偷懒。只有确实达标了，才把结论转述给用户。',
    '',
    '## 先审核，再派新任务',
    '每单**真正交付**（deliverable: true）之后，这个目标进入「待审核」：不记录审核结论，就不能再给它派新任务，',
    '工具会直接拒绝。审核用 reviews 参数记录，审核与派单**必须分成两次调用**：',
    '- `reviews: [{ target: "1", verdict: "accepted", note: "验收依据…" }]` —— 通过，之后可以派新任务；',
    '- `reviews: [{ target: "1", verdict: "rejected", note: "缺哪条证据、期望看到什么" }]` —— 驳回，',
    '  之后用 dispatch_task 带 task 把具体缺口发回去（对方正在跑时就是纠正）。驳回必须写 note。',
    'failed / blocked / interrupted 不是交付，不需要审核。审核按目标记：审了 B 只放行 B，不影响 C、D。',
    '待审核状态会落盘，Host 重启后仍然有效；上一单的结论也留在目标会话的历史里，随时可以回去复核。',
    '',
    '## 过程稿与纠正',
    '目标还在跑时，results 里的 progress 是**过程稿**，deliverable 为 false：它可能被后面推翻，',
    '不能当成交付结论写进你的输出，也不能据此宣布完成。',
    '过程稿可以用来判断方向。方向不对时，用 dispatch_task 带 task、targets 指向同一个目标发纠正：',
    '纠正会先停止目标的当前轮，再把纠正作为一条新消息重新提交，并重新启动目标（若它因此暂停）；',
    '不新建目标；返回 status: redirected。',
    '一次调用里不要把「纠正正在跑的目标」和「给空闲目标派新任务」混在一起 —— 同一个 task 会有',
    '两种语义，请分成两次调用。',
    '',
    '## 用户手动停止目标',
    '用户可能在界面上按停止，把目标接管过去。这时结果里的 status 是 interrupted，',
    'interruptedBy 是 user，这一单**没有交付**：不要拿过程稿当结论，也不要越过用户去纠正它。',
    '你可以继续做不依赖它的部分；等用户处理完，再按用户的指示重新派或续等。',
    '',
    '## 一次派给多个目标',
    'targets 可以给多个（最多 ' + MAX_BATCH_TARGETS + ' 个）：这些目标**同时**开工，不是排队。',
    '每个目标一次只能接一件事：它正在跑时再给 task 会被当成「纠正」（先停当前轮，不会新建目标）；',
    '要派一件全新的任务，先等它结束并取走结果。',
    '可派目标多于一个时，必须用 targets 指明派给谁（这次要用的目标一次列全），不会替你猜；',
    '多个空闲目标能并行时，优先一次列全，而不是一次只点一个。',
    '给了 task 时，targets 里要么全是空闲目标（新派），要么全是正在跑的目标（纠正）；',
    '两种混在一起会被拒绝 —— 同一个 task 不能同时对两个目标有两种语义。',
    '',
    '## wait：这一批什么时候返回',
    '- all（默认）：等这一批**全部**有交付结论才返回。要拿到每个目标的完整结论，就用它。',
    '- any：第一个目标有交付结论就返回，其余还在跑（results 里标成 running，带过程稿，留到下一次续等）。',
    '  只有「谁先回来就先看谁」时才用 any。它**不会**让整批更快拿全结果 —— 反而要多调几次、',
    '  每次都得重发一遍这份描述，更费 token。',
    '- none：**不等**。给了 task、目标又空闲，就是「派完就走」（立刻返回 status: dispatched）；',
    '  给了 task、目标正在跑，就是「停当前轮后重新提交纠正」（status: redirected）；没给 task 就是「看一眼状态」。',
    '',
    '## 派完就走（wait: none）之后怎么收尾',
    '派出去的任务不会自己消失：只要还有没取结果的，**这个回合结束前会被提醒一次**，',
    '提醒你回来调用 dispatch_task（省略 task 与 targets）把结论收掉。',
    '所以你可以放心地先干自己的事 —— 但别指望回合就这么结束，该收的还是要收。',
    '中途想看一眼也可以随时调用（同样省略 task 与 targets，配 wait: none 就不会阻塞）。',
    '',
    '## 调用行为',
    '每次调用最多等 5 分钟一段（wait: none 不等，立刻返回）：',
    '- 这一批在这段时间内都有了交付结论 → 直接返回，status 是 complete / partial / failed / interrupted；',
    '- 还没完 → 返回**目前的进度**：status 是 running，deliverable 为 false，内容是标注过的过程稿；',
    '只要状态还是 running，就**必须继续调用**（省略 task 与 targets）接着等，直到状态不再是 running。',
    '不要把它当成失败，也不要停下来问用户要不要继续等 —— 用户要的就是「一直盯到它做完」。',
    '要求目标此刻空闲才接新单；续等不受这条限制。目标正在跑回合时带 task 会被当成纠正（先停当前轮），而不是拒绝。',
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
  base.push('每条后面是用户写的分工说明 —— 按它来决定派给谁。targets 里每一项用序号或标题的一部分即可：');
  for (let index = 0; index < roster.length; index += 1) {
    const item = roster[index];
    const note = item.note === undefined || item.note === ''
      ? '（用户还没写说明 —— 不确定就别派）'
      : item.note;
    base.push((index + 1) + ') ' + item.label + ' —— ' + note);
  }
  base.push('（名单不显示忙闲 —— 那会让描述每轮都变、拖垮提示词缓存；每次派单的结果里会列出还有谁空闲。）');
  return base.join('\n');
}

/**
 * 构造模型面向的那次工具调用说明。
 *
 * 描述里必须写清四件事，否则模型会拿它当「给用户发消息」用：
 *   1. 它把任务交给**用户在平铺面板里连出去的另一个会话**；
 *   2. 可以一次派给多个，这些目标同时开工；
 *   3. 它会**一直等到这一批有结论**才返回；
 *   4. 多个目标时用 `targets` 指定派给谁（序号或标题）。
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
          description: '要交给目标完成的任务正文。写清楚背景、目标产物和验收标准；对方看不到当前会话的历史。续等时省略。',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: '派给哪些目标，每项可以是界面上的序号、完整标题、标题的一部分或会话 id。'
            + '可派目标多于一个时必须指明；只有一个时可以省略。没给 task 时省略表示接着等所有还在跑的目标。'
            + '有多个空闲目标且活能拆开时，把它们一次列全，优先并行分配。',
        },
        wait: {
          type: 'string',
          enum: ['all', 'any', 'none'],
          description: '这一批什么时候返回。all（默认）等全部有结论；any 第一个有结论就返回；'
            + 'none 不等 —— 给了 task 就是派完就走，没给 task 就是只看一眼状态。',
        },
        reviews: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              target: { type: 'string', description: '要审核的目标：序号、标题或会话 id。' },
              verdict: {
                type: 'string',
                enum: ['accepted', 'rejected'],
                description: 'accepted = 验收通过；rejected = 驳回。',
              },
              note: { type: 'string', description: '审核依据；驳回时必填，写清缺哪条证据、期望看到什么。' },
            },
            required: ['target', 'verdict'],
            additionalProperties: false,
          },
          description: '审核上一单的交付结论（每项 target + verdict + note）。与 task 互斥，必须单独调用；'
            + '只有 deliverable: true 的上一单需要审，未审核前不能再给同一个目标派新任务。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                target: { type: 'string' },
                status: { type: 'string' },
                deliverable: { type: 'boolean' },
                reply: { type: 'string' },
                progress: { type: 'string' },
                interruptedBy: { type: 'string' },
                note: { type: 'string' },
              },
              required: ['target', 'status', 'deliverable', 'reply', 'progress', 'interruptedBy', 'note'],
              additionalProperties: false,
            },
          },
          stillRunning: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['status', 'results', 'stillRunning', 'note'],
        additionalProperties: false,
      },
      render(_args, value) {
        const head = '整批状态：' + value.status
          + (value.stillRunning > 0 ? '（还有 ' + String(value.stillRunning) + ' 个在做）' : '');
        const lines = [head];
        for (const item of value.results) {
          let flag = '未交付';
          if (item.status === 'accepted') flag = '审核通过';
          else if (item.status === 'rejected') flag = '审核驳回';
          else if (item.deliverable === true) flag = '已交付';
          else if (item.interruptedBy === 'user') flag = '用户手动停止，未交付';
          lines.push('', '—— ' + item.target + '：' + item.status + '（' + flag + '）');
          if (typeof item.progress === 'string' && item.progress !== '') lines.push(item.progress);
          else if (item.reply !== '') lines.push(item.reply);
          else if (item.status !== 'accepted' && item.status !== 'rejected') lines.push('（没有可读的结论）');
          if (item.note !== '') lines.push(item.note);
        }
        if (value.note !== '') lines.push('', value.note);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const task = typeof args?.task === 'string' ? args.task.trim() : '';
      const ownerId = exec?.agent?.id;
      if (typeof ownerId !== 'string' || ownerId === '') {
        throw new Error('这个工具只能在会话里由模型调用。');
      }
      if (task.length > MAX_TASK_CHARS) {
        throw new Error('任务正文超过 ' + MAX_TASK_CHARS + ' 字符，请拆小一点再派。');
      }

      const bindings = service.bindings.get(ownerId) ?? [];
      const hasTask = task !== '';
      /*
       * 审核走单独的一条路：带 reviews 时不允许再带 task/targets，强制「先审后派」。
       * 不把两件事揉进一次调用，审核记录才是一条明确的决策，而不是派单前的勾选。
       */
      const rawReviews = Array.isArray(args?.reviews) ? args.reviews : [];
      if (rawReviews.length > 0) {
        if (hasTask) throw new Error('审核与派单要分开调用：带 reviews 时不要带 task。');
        if (Array.isArray(args?.targets) && args.targets.length > 0) {
          throw new Error('审核用 reviews 里的 target 指名目标，不要同时给 targets。');
        }
        if (rawReviews.length > MAX_BATCH_TARGETS) {
          throw new Error('一次最多审核 ' + MAX_BATCH_TARGETS + ' 个目标，请分几批。');
        }
        return runReviews({ service, ownerId, bindings, reviews: rawReviews });
      }
      /*
       * 续等（不给 task）时先认领一次「可能因 Host 重启而丢掉的记录」。
       *
       * `pending` 只在内存里，而目标会话的 goal 在 DSH 的目标服务里、重启不丢。少了这一步，
       * 重启后回来收结果会被当成「从没派过」而直接报错 —— 活已经干完，结论却永远拿不到。
       *
       * 放在这里而不是插件启动时：目标服务此刻一定就绪，而且只有真要用的时候才付
       * 「唤醒绑定目标」这笔成本。
       */
      if (!hasTask) await adoptOrphanGoals(service.ctx, service, ownerId);
      const requested = resolveRequested(service, ownerId, bindings, args?.targets, hasTask);
      if (requested.length === 0) {
        /*
         * 续等时「没有在跑的目标」与「不知道派给谁」是两件事：前者给一句能指导下一步的
         * 话，后者才走 explainNoTarget 那三条病因。
         */
        if (!hasTask) {
          throw new Error(
            '没有可接着等的派单：这个会话当前没有已派出、还没取结果的任务。'
            + '要派新任务就必须给出 task；省略 task 只用于「接着等上一次派出去的那件事」。',
          );
        }
        throw new Error(explainNoTarget(service, ownerId, bindings));
      }
      if (requested.length > MAX_BATCH_TARGETS) {
        throw new Error('一次最多派给 ' + MAX_BATCH_TARGETS + ' 个目标，请分几批派。');
      }

      return runBatch({
        ctx: service.ctx,
        service,
        ownerId,
        bindings: requested,
        task,
        wait: normalizeWait(args?.wait),
        signal: exec.signal,
      });
    },
  };
}
