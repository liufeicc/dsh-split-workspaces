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

/** `wait` 的两档：等全部到终态，还是第一个到终态就返回。 */
export const WAIT_ALL = 'all';
export const WAIT_ANY = 'any';

/** 一条委派说明的最大长度（字符）—— 与客户端 `EDGE_NOTE_MAX` 保持一致。 */
export const EDGE_NOTE_MAX = 200;

/** 落盘格式版本。读到更早/更新的版本时按「读不懂就当作空表」处理，不猜。 */
export const STORE_VERSION = 1;
