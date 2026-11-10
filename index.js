/**
 * 多工作区平铺 —— Host 半边：把「窗格 A 把任务派给窗格 B」接上。
 *
 * ## 为什么这一段必须在 Host 上
 *
 * 「派任务」要由 **A 的模型**发起（它得先理解要派什么），而模型能看见的只有工具；
 * 工具只能在 Host 进程里注册，浏览器插件注册不了。所以插件在 Host 侧提供两样东西：
 *
 *   1. `paneDispatch` 服务 —— 客户端在界面上勾选了「A 可以派给谁」之后，把这个
 *      绑定关系同步过来，存在内存里；
 *   2. `dispatch_task` 工具 —— A 的模型调用它时，Host 负责把任务投进目标会话、
 *      等目标那一轮跑完、把它的回复原样交回去。
 *
 * ## 一次可以派给多个目标
 *
 * 界面允许 A 同时连出多条箭头，一次调用也可以把同一件事拆给多个目标（`targets` 数组，
 * 见 `matchBinding` 的解析规则）。这些目标**同时**开工，每个目标一条独立等待。
 *
 * 「什么时候算这一批结束」由 `wait` 决定：`all`（默认）等全部有结论，`any` 第一个有
 * 结论就返回、其余留给下一次续等，`none` 根本不等（派完就走 / 只看一眼）。
 *
 * ## 派完就走，但收尾前一定被拉回来
 *
 * `wait: none` 把任务派出去就返回，A 可以先做自己的事。但结果不能就这么丢了：
 * `agent/turn-stopping` 会在 A 正要结束回合时触发，此时还有未结清的派单就往 `next-step`
 * inbox 里 `inject()` 一条提醒 —— agent loop 随后**重新检查** inbox，于是这个回合继续
 * 走一步，A 回头把结论收掉。同回合按 turn 去重，取完即不再提醒。
 *
 * ## 投递与等待的机制
 *
 *   - **投递**走 `ctx.sessionController.prompt()`：它和用户在 B 的输入框里打字是
 *     同一条链路 —— 校验、写进 B 的收件箱、必要时唤醒冷会话、落盘。所以 B 的对话里
 *     会出现一条「用户消息」，并自动开始跑。Host 这一侧不自己拼事件、不碰 B 的日志。
 *   - **等待**靠 `ctx.on('session/event', …)`：先认出我们自己那条消息（它的
 *     `source.rpcId` 就是本次生成的一次性 id），再从那条消息之后的事件里收集助手回复，
 *     直到 `turn/end`。用 rpcId 认领而不是「投递后第一个 turn/end」，是因为 B 可能
 *     正忙：我们的消息会排在它当前那一轮后面，直接取第一个结束信号会拿到**别人**的
 *     结果。
 *   - **取消**跟着 `exec.signal` 走：用户在 A 那边按停止，等待立即结束；但**不会**去
 *     停 B —— B 是独立会话，它不该因为 A 放弃等待就被掐断。
 *
 * ## 已知边界
 *
 *   - `turn/end` 只说明「这一轮停了」，不说明「任务做成了」。B 如果反问，反问就是
 *     这一轮的回复；所以任务包装里明确要求它别反问（见 `wrapTask`）。
 *   - 同一个目标一次只接一件事：它还在跑上一件时再派会被直接拒绝，不会排队。
 *   - 同一时刻 A 只挂一次派单调用（工具默认独占执行）；不同会话之间互不影响。
 *   - 绑定表落盘在 Host 的 storages 下：重启 Host 与刷新页面都不会丢（前者靠启动时读盘，
 *     后者靠客户端挂载时 `list()` 一遍再采纳）。
 *
 * ## 文件组织
 *
 * 本文件只做装配：注册服务、挂工具、维护生命周期。具体实现按职责分散在同目录：
 *
 *   - `host.constants.js` —— 服务键、远端方法清单、超时与长度上限；
 *   - `host.store.js` —— 绑定表的落盘与读回；
 *   - `host.layout.js` —— 平铺布局的落盘与读回（$DSH_HOME/storages/pane_layout.json）；
 *   - `host.service.js` —— `PaneDispatchService`（绑定表与派单状态）；
 *   - `host.message.js` —— 分派链路上的纯函数（包装任务、匹配目标、取文本）；
 *   - `host.wait.js` —— 投递与等待（目标模式 / 普通投递两条路）；
 *   - `host.batch.js` —— 一批目标的调度与收尾（预检、并发等待、all/any）；
 *   - `host.watch.js` —— 派出去之后的盯与认（后台监视、重启后认回孤儿单子）；
 *   - `host.tool.js` —— 面向模型的 `dispatch_task` 工具定义。
 *
 * 下面仍把原有的公共符号原样转出去，`test/dispatch-contract.mjs` 等既有用例
 * 继续 `import('../index.js')` 就能拿到同一套东西。
 *
 * @module @local/dsh-split-workspaces/host
 */

import { REMOTE_MARKERS, REMOTE_METHODS, SERVICE_KEY, TOOL_NAME } from './host.constants.js';
import { adoptOrphanGoals } from './host.watch.js';
import { errorText, noticeMessage } from './host.message.js';
import { PaneDispatchService } from './host.service.js';
import { createDispatchTool } from './host.tool.js';

/** 本行的 Loader row id 与插件名（必须与 cordis.patch.yml 里那一行一致）。 */
export const name = 'split-workspaces';

/**
 * 激活前必须就绪的服务。
 *
 * 只列 `tools`：没有工具注册表，这个插件的全部意义就不存在。`sessionController`
 * 刻意**不**写进来 —— 精简宿主可能没装它，那种情况下插件应当照常加载，只是工具被
 * 调用时明确回答「这个部署没有会话服务」，而不是让整个平铺面板跟着加载失败。
 */
export const inject = ['tools'];

/**
 * 注册服务与工具。
 *
 * 生命周期用 `ctx.effect` 包住：热重载或插件卸载时，工具要从注册表摘掉、绑定要清空，
 * 否则下一份实例会看到上一份的残留。
 *
 * @param ctx - 本行的宿主上下文。
 */
export function apply(ctx) {
  const service = new PaneDispatchService(ctx);
  Object.defineProperty(service, 'typertRemote', {
    configurable: true,
    value: Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY }),
  });
  Object.defineProperty(PaneDispatchService.prototype, REMOTE_METHODS, {
    configurable: true,
    value: REMOTE_MARKERS,
  });
  ctx.provide(SERVICE_KEY, service);
  ctx.logger?.info?.('split-workspaces: 任务分派已激活（工具 ' + TOOL_NAME + '）');

  ctx.effect(() => {
    /*
     * 每个「连了箭头」的会话拿到一份**自己的**工具定义：名字相同、描述不同。
     *
     * dsh-tools 的契约是「作用域工具遮蔽同名全局工具」，于是：
     *   - 没连箭头的会话 → 走全局那份，描述里告诉它「还没有目标」；
     *   - 连了箭头 → 走自己的那份，描述里直接列出可派对象。
     * 目标名单写在 schema 里，模型在**规划阶段**就能看见，不必先失败一次才知道。
     *
     * 名单只在用户改箭头时变（人工动作，频率极低），所以不会造成提示词缓存抖动。
     */
    const scoped = new Map();
    const agents = ctx.get('agents');

    /** 按会话当前的绑定重建它的作用域工具；没有绑定时撤掉，让全局那份露出来。 */
    const refresh = (agentId) => {
      const previous = scoped.get(agentId);
      if (previous !== undefined) {
        scoped.delete(agentId);
        try {
          previous();
        } catch {
          /* 旧工具的 disposer 失败不该拦着新的一版装上 */
        }
      }
      if (typeof agentId !== 'string' || agentId === '') return;
      const roster = service.bindings.get(agentId);
      if (roster === undefined || roster.length === 0) return;
      const agent = agents === undefined || agents === null || typeof agents.get !== 'function'
        ? undefined
        : agents.get(agentId);
      if (agent === undefined || agent === null || agent.ctx === undefined) return;
      try {
        scoped.set(agentId, agent.ctx.tools.register(createDispatchTool(service, agentId)));
      } catch (reason) {
        ctx.logger?.warn?.('split-workspaces: 注册作用域委派工具失败: ' + errorText(reason));
      }
      /*
       * 顺手认领一次「可能因 Host 重启而丢掉的派单记录」。
       *
       * 为什么在这里：收尾提醒（下面 `agent/turn-stopping`）数的是 `pending`，而 `pending`
       * 只活在内存里。重启后如果只有「调用工具时」才认领，A 在自己回合里干完别的事、
       * 还没回头调工具就要结束回合时，`outstanding` 是空的 —— 提醒不会响，A 也不会想起来
       * 去收结果。所以趁会话创建/绑定变化时先认回来。
       *
       * 不 await：`refresh` 是同步的，认领要读目标状态。失败就静默跳过，真正要用的那一刻
       * （`dispatch_task` 续等）还会再认一次，那里才是兜底。
       */
      void adoptOrphanGoals(ctx, service, agentId).catch(() => {});
    };

    const offs = [];
    offs.push(ctx.on('agent/created', ({ agent }) => refresh(agent.id)));
    offs.push(ctx.on('agent/disposed', ({ agent }) => {
      const previous = scoped.get(agent.id);
      if (previous === undefined) return;
      scoped.delete(agent.id);
      try {
        previous();
      } catch {
        /* 会话都没了，卸载失败无所谓 */
      }
    }));
    offs.push(service.onChange((ownerId) => refresh(ownerId)));

    /*
     * 收尾前的自动检测：A 干完自己的事、正要结束回合时，如果手上还有派出去没取结果的
     * 任务，就在这里把它拉回来。
     *
     * 为什么必须是这个钩子，而不是「等空闲了再 followup」：`agent/turn-stopping` 触发
     * 之后，agent loop 会**再检查一次** inbox；此时 `inject()` 写进 `next-step` 的消息
     * 会让这个回合继续走一步，而不是结束。于是 A 是在**同一个回合里**回头收结果，
     * 不需要等用户再开口，也不需要把我们自己伪装成一次新的用户输入。
     *
     * 只在还有未结清的派单时才注入；注入后同一个回合不再重复注入（按 turn 去重），
     * 所以即使模型无视提醒，也不会在同一轮里反复被拉回来。
     */
    const nudgedTurn = new Map();
    offs.push(ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      const ownerId = agent?.id;
      if (typeof ownerId !== 'string' || ownerId === '') return;
      const outstanding = service.outstanding(ownerId);
      if (outstanding.length === 0) return;
      if (nudgedTurn.get(ownerId) === turn) return;
      nudgedTurn.set(ownerId, turn);
      const names = outstanding
        .map((item) => service.bindings.get(ownerId)?.find((target) => target.id === item.key.split('\u0000')[1])?.label)
        .filter((label) => typeof label === 'string');
      const text = [
        '[任务分派 · 收尾提醒]',
        '你手上还有 ' + String(outstanding.length) + ' 个派出去的任务没取结果'
          + (names.length === 0 ? '。' : '（' + names.join('、') + '）。'),
        '结束这个回合之前，请调用 dispatch_task 并省略 task 与 targets 把它们收掉：',
        '- 想等它们做完就省略 wait（默认 all），会阻塞到有结论；',
        '- 只想看一眼就传 wait: none，不会阻塞。',
        '不接受「先不管」—— 这些结果如果不取，用户永远看不到。',
      ].join('\n');
      try {
        agent.inject(noticeMessage(text, '还有派出去的任务没取结果'));
      } catch (reason) {
        ctx.logger?.warn?.('split-workspaces: 收尾提醒注入失败: ' + errorText(reason));
      }
    }));

    const unregister = ctx.tools.register(createDispatchTool(service));

    // 本行可能晚于会话加载（热重载、插件晚装），对已有活会话补挂一次。
    for (const agent of agents === undefined || typeof agents.list !== 'function' ? [] : agents.list()) {
      refresh(agent.id);
    }

    return () => {
      for (const off of offs) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      for (const dispose of scoped.values()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      scoped.clear();
      try {
        unregister();
      } catch {
        /* 卸载失败不该阻断后续清理 */
      }
      service.clear();
    };
  }, 'split-workspaces: dispatch tool');
}

/* ------------------------------------------------------------------ *
 * 公共符号转出：保持拆分前的导出面完全不变
 * ------------------------------------------------------------------ */

export { DISPATCH_SLICE_MS, DISPATCH_TIMEOUT_MS, SERVICE_KEY, TOOL_NAME } from './host.constants.js';
export { PaneDispatchService } from './host.service.js';
export { assistantText, describeCandidates, matchBinding, wrapTask } from './host.message.js';
export {
  deliverAndWait,
  goalSupport,
  resolveTargetAgent,
  runningText,
  waitForGoal,
  waitForTurn,
} from './host.wait.js';
export {
  createDispatchTool,
  dispatchDescription,
  explainNoTarget,
} from './host.tool.js';
export {
  batchStatus,
  isSuccessStatus,
  isTerminalStatus,
  normalizeWait,
  runBatch,
} from './host.batch.js';
export { adoptOrphanGoals } from './host.watch.js';
export { resolveRequested } from './host.tool.js';
