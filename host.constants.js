/**
 * 多工作区平铺 —— Host 半边的常量与线上协议标记。
 *
 * 这些值是 Host、客户端与 Typert 网关之间的契约：服务键、远端方法清单、工具名、
 * 超时与长度上限。集中在一处，是为了「改一个数」只有一个地方要动，也避免各个
 * 实现文件为了一个常量互相 import，绕出一圈依赖。
 *
 * 常量本身不带行为，因此这个文件不 import 任何同目录模块。
 *
 * @module @local/dsh-split-workspaces/host-constants
 */

/** Cordis 服务键 / Typert 命名空间 / 线上命名空间（三者同名，客户端据此解析）。 */
export const SERVICE_KEY = 'paneDispatch';

/** Gateway 读取 Service 远端方法标记的原型属性名。 */
export const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/** 本服务暴露给客户端的方法（形状与 `@Remote('x')` 记录的一致）。 */
export const REMOTE_MARKERS = Object.freeze({
  version: 1,
  methods: Object.freeze([
    Object.freeze({ method: 'list', invocation: Object.freeze({ kind: 'direct' }) }),
    Object.freeze({ method: 'set', invocation: Object.freeze({ kind: 'direct' }) }),
    // 派单视觉事件：客户端每 300ms 取一次增量，用来播放「光点从主窗格飞到目标窗格」。
    Object.freeze({ method: 'pullVisual', invocation: Object.freeze({ kind: 'direct' }) }),
    // 任务分派卡片状态：目标阶段与待审核计数，客户端按需轮询。
    Object.freeze({ method: 'readStates', invocation: Object.freeze({ kind: 'direct' }) }),
    // 派单目标的独立记录：创建即落盘，不跟画布布局一起保存。
    Object.freeze({ method: 'listTargets', invocation: Object.freeze({ kind: 'direct' }) }),
    Object.freeze({ method: 'addTarget', invocation: Object.freeze({ kind: 'direct' }) }),
    Object.freeze({ method: 'removeTarget', invocation: Object.freeze({ kind: 'direct' }) }),
    // 布局持久化：桌面版重启后端口会变，localStorage 的 origin 读不到旧数据，
    // 所以布局必须跟着 profile 落到 Host 的 storages 下。
    Object.freeze({ method: 'readLayout', invocation: Object.freeze({ kind: 'direct' }) }),
    Object.freeze({ method: 'writeLayout', invocation: Object.freeze({ kind: 'direct' }) }),
  ]),
});

/** 模型面向的工具名。 */
export const TOOL_NAME = 'dispatch_task';

/** 只读汇报工具名。 */
export const REPORT_TOOL_NAME = 'report_task';

/**
 * 「咨询」工具名。
 *
 * 与 `dispatch_task` / `report_task` 分开：咨询走的是**真实投递**
 * （`sessionController.prompt()`），但不建 goal、不进入派单状态机。
 * 如果把它塞进 `dispatch_task` 的某个 mode，模型会在「派活」与「问问题」
 * 之间反复选错；单独一只短工具边界最清楚。
 */
export const CONSULT_TOOL_NAME = 'consult_task';

/**
 * 停止 / 唤醒工具名。
 *
 * 单独一只工具，而不是给 `dispatch_task` 加 `action`：`dispatch_task` 已经有
 * 「新派 / 续等 / 审核 / 纠正」四种含义，再混进控制语义，模型很容易把「停止」
 * 当成「派一个新任务」。控制工具的描述只讲停止与唤醒，短而明确。
 */
export const CONTROL_TOOL_NAME = 'control_task';

/** 控制动作：停止当前任务。 */
export const ACTION_STOP = 'stop';

/** 控制动作：唤醒暂停的原目标。 */
export const ACTION_RESUME = 'resume';

/**
 * 一次最多向几个目标要汇报。
 *
 * 每个目标都是一次独立的模型请求；8 个已经是一次工具调用能接受的上限。再多就分批，
 * 否则一次调用的 token、延迟和上下文都会同时膨胀。
 */
export const MAX_REPORT_TARGETS = 8;

/** 汇报要求正文的长度上限（字符）。 */
export const MAX_REPORT_ASK_CHARS = 4000;

/**
 * 单个目标汇报请求的超时。
 *
 * 汇报是「读历史 + 生成一段总结」，通常几秒到几十秒；60 秒还没回来就先把这一个目标
 * 记成 timeout，其它目标不受影响。
 */
export const REPORT_TIMEOUT_MS = 300 * 1000;

/** 单份汇报返回给 A 的最大字符数，防止一份总结撑爆 A 的上下文。 */
export const REPORT_MAX_CHARS = 4000;

/** 喂给汇报助手的历史条数上限。 */
export const REPORT_HISTORY_MESSAGES = 40;

/**
 * 一次最多向几个目标咨询。
 *
 * 与派单/汇报保持一致：8 个已经是一次工具调用能接受的上限。咨询是并行的一轮
 * 问答，再多会让等待面与结果长度一起膨胀。
 */
export const MAX_CONSULT_TARGETS = 8;

/** 咨询问题正文的长度上限（字符）。 */
export const MAX_CONSULT_QUESTION_CHARS = 8000;

/**
 * 单个目标咨询一轮的超时。
 *
 * 咨询是「目标读文件/跑命令后回答一个问题」，通常几秒到几分钟；10 分钟还没回来，
 * 多半是目标卡在某个长命令或网络请求上。超时不等于失败：已收到的文本会作为
 * 「过程稿」返回，让 A 决定要不要重问。
 */
export const CONSULT_TIMEOUT_MS = 10 * 60 * 1000;

/** 喂给汇报助手的历史字符上限（大会话兜底）。 */
export const REPORT_HISTORY_CHARS = 120000;

/**
 * 一次工具调用最多等多久：5 分钟一段。
 *
 * 为什么是「分段」而不是「总时长上限」：真实任务经常超过 20 分钟，一次调用憋到超时再
 * 报失败，会让派单方以为任务黄了 —— 而对方其实一直在做。所以每到 5 分钟就**带着当前
 * 进度返回**，模型再调一次接着等。这样：
 *   - 永远不会因为「等太久」误判失败；
 *   - 每 5 分钟给派单方一次可见的进度；
 *   - 单次调用仍然有界，不会把 A 的回合无限挂住。
 */
export const DISPATCH_SLICE_MS = 5 * 60 * 1000;

/**
 * 没有目标服务时（老部署）的兜底等待上限。
 *
 * 那条路走的是普通消息投递，拿不到目标状态，只能等一轮结束，因此保留一个总上限。
 */
export const DISPATCH_TIMEOUT_MS = 20 * 60 * 1000;

/** 单次任务正文的长度上限（字符）。超出直接拒绝，避免把一条超大消息塞进别人的会话。 */
export const MAX_TASK_CHARS = 20000;

/**
 * 一次调用最多同时派给几个目标。
 *
 * 上限不只是防滥用：每个目标都会挂一条 `session/event` 订阅与一个切片定时器，
 * 一次几十个会让这一轮的收尾变得很重；而真要用到 8 个以上并行子任务时，
 * 更合适的是分几批派（每批的结论也更清楚）。
 */
export const MAX_BATCH_TARGETS = 8;

/**
 * 目标被**用户手动停止**时的状态。
 *
 * 与 `paused` 的区别是「谁停的、这一单算不算交付」：`paused` 是 goal 的持久阶段，
 * 可能是用户执行 `/goal pause`，也可能是别的插件暂停；`interrupted` 特指「用户在界面上
 * 按了停止，把目标接管过去了」。对派单方 A 来说，后者必须明确成「这一单没交付，别拿
 * 过程稿当结论」。
 */
export const STATUS_INTERRUPTED = 'interrupted';

/** 一条「纠正」已经停止目标当前轮，并作为新消息重新提交（不是新任务）。 */
export const STATUS_REDIRECTED = 'redirected';

/**
 * 插件停止目标当前轮时写进 `turn/end` 的取消原因。
 *
 * 必须是 `hook` 而不是 `user`：`aborted.user` 在 A 的后台监视/等待里代表
 * 「用户接管了这一单」。插件发起的纠正不能冒充用户，否则 A 会把自己的停止
 * 误读成用户抢单。
 */
export const REDIRECT_CANCEL_REASON = 'pane-dispatch-redirect';

/**
 * 纠正时等目标当前轮真正停下来的上限。
 *
 * 只用来等 `turn/end` 收尾，不是任务超时：正常情况下几毫秒就回来了。设上限是
 * 防止某个不响应 abort 的工具把「停一下再重发」挂死；超时后照常重发，只是
 * 个别目标轮的 disarm 竞争会留给后续事件处理。
 */
export const REDIRECT_STOP_TIMEOUT_MS = 3000;

/**
 * 插件停止目标当前轮时写进 `turn/end` 的取消原因。
 *
 * 与纠正分开一个理由：纠正的停止紧接着要重发一条消息，停止的停止要留在暂停态。
 * 分开之后，测试和日志都能一眼看出这次停轮是哪种操作；两边都不冒充 `user`，
 * 所以 A 的后台监视不会把插件自己的动作读成「用户抢单」。
 */
export const STOP_CANCEL_REASON = 'pane-dispatch-stop';

/**
 * 「停止」等目标真正停下来的上限。
 *
 * 比纠正的 3 秒长得多：纠正只是把「停轮 → 重发」的交接等完，3 秒是防挂死的兜底；
 * 停止要等目标把正在跑的工具真的收尾，一次长命令、一次网络请求都可能超过 3 秒。
 * 30 秒足够大多数工具收尾，又不至于把主会话的回合挂太久。
 *
 * 超时**不是失败**，而是「还没确认停下」：目标已经 disarm，不会再自动开新轮，
 * 后台监视会接着等它真正 idle。
 */
export const STOP_TIMEOUT_MS = 30 * 1000;

/**
 * 停止成功后的状态：目标已暂停，不会自动推进。
 *
 * 沿用 `paused` 这个词，与 `classifyGoal`、DSH 目标栏的「已暂停的目标」保持同一套
 * 语义。它**不是交付**：`deliverable` 必须为 false。
 */
export const STATUS_PAUSED = 'paused';

/**
 * 停止请求已经发出，但时限内没确认目标真的停下。
 *
 * 这是独立的词，不能并进 `paused`：主会话必须知道「还没停」，否则它会以为可以
 * 立刻派新任务或把当前文本当结论。目标此时已经不会再自动开新轮，只是当前回合
 * 还在收尾（或者卡在某个不响应中止的工具里）。
 */
export const STATUS_STOPPING = 'stopping';

/** 已经唤醒一个暂停的原目标，它会从原 objective 继续。 */
export const STATUS_RESUMED = 'resumed';

/** `wait` 的三档：等全部、等第一个、或者根本不等。 */
export const WAIT_ALL = 'all';
export const WAIT_ANY = 'any';
/**
 * `none`：派完就走，或者查一下就走。
 *
 * 有 `task` 时它表示「交给对方就返回，我不等」；没有 `task` 时它表示「看一眼现在
 * 什么状态，别阻塞我」。同一个值在两个方向上语义一致 —— 都是「不阻塞」。
 */
export const WAIT_NONE = 'none';

/**
 * 后台盯着已派出目标的复查间隔。
 *
 * 只是用来看「目标结束没有」的重读周期，不是等待上限：真正的结束信号仍然来自
 * 会话事件，这个间隔只决定「一直没事件时多久重读一次状态」。
 */
export const ASYNC_RECHECK_MS = 30 * 1000;

/** 后台监视最长盯多久。兜底用，防止目标读不到状态时永远占着一条订阅。 */
export const ASYNC_MAX_MS = 24 * 60 * 60 * 1000;

/** 一条委派说明的最大长度（字符）—— 与客户端 `EDGE_NOTE_MAX` 保持一致。 */
export const EDGE_NOTE_MAX = 200;

/**
 * 派出去的任务，其 goal objective 的固定开头。
 *
 * 这个前缀有个超出「给人看」的用途：`pending`（谁派了谁、结论收没收）只活在内存里，
 * 而 goal 活在 DSH 的目标服务里、重启不丢。Host 重启之后，就靠这个前缀去问目标会话
 * 「你现在的目标是不是我派的」，把散掉的单子认回来 —— 不需要另存一份状态。
 *
 * 所以它是**协议的一部分**，不是文案：改它会让重启前的派单认不回来。
 */
export const DISPATCH_TAG = '[任务分派]';

/**
 * 咨询消息的固定开头。
 *
 * 与 `DISPATCH_TAG` 分开：目标模型看到这两个前缀就知道自己面对的是「派活」还是
 * 「回答问题」。它只是文案，不参与重启认领，所以改它不会破坏派单恢复。
 */
export const CONSULT_TAG = '[任务分派 · 咨询]';

/** 落盘格式版本。读到更早/更新的版本时按「读不懂就当作空表」处理，不猜。 */
export const STORE_VERSION = 1;
