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
    // 布局持久化：桌面版重启后端口会变，localStorage 的 origin 读不到旧数据，
    // 所以布局必须跟着 profile 落到 Host 的 storages 下。
    Object.freeze({ method: 'readLayout', invocation: Object.freeze({ kind: 'direct' }) }),
    Object.freeze({ method: 'writeLayout', invocation: Object.freeze({ kind: 'direct' }) }),
    Object.freeze({ method: 'clearLayout', invocation: Object.freeze({ kind: 'direct' }) }),
  ]),
});

/** 模型面向的工具名。 */
export const TOOL_NAME = 'dispatch_task';

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

/** 一条「纠正」已经排队到目标下一轮（不是立即打断，也不是新任务）。 */
export const STATUS_REDIRECTED = 'redirected';

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

/** 落盘格式版本。读到更早/更新的版本时按「读不懂就当作空表」处理，不猜。 */
export const STORE_VERSION = 1;
