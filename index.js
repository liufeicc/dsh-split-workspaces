/**
 * 多工作区平铺 —— Host 半边：把「窗格 A 把任务派给窗格 B」接上。
 *
 * ## 为什么这一段必须在 Host 上
 *
 * 「派任务」要由 **A 的模型**发起（它得先理解要派什么），而模型能看见的只有工具；
 * 工具只能在 Host 进程里注册，浏览器插件注册不了。所以本文件提供两样东西：
 *
 *   1. `paneDispatch` 服务 —— 客户端在界面上勾选了「A 可以派给谁」之后，把这个
 *      绑定关系同步过来，存在内存里；
 *   2. `dispatch_task` 工具 —— A 的模型调用它时，Host 负责把任务投进目标会话、
 *      等目标那一轮跑完、把它的回复原样交回去。
 *
 * ## 一次只派一个任务，但可以预先绑定多个目标
 *
 * 界面允许 A 同时勾上 B、C 两个窗格，但每次工具调用**只向一个会话投递**：同时向两个
 * 会话投递、再把两份回复揉成一段，会让「这次干完了没有」变得没法回答。绑定多个目标
 * 时，模型用 `target` 参数指定这一次派给谁（序号 / 标题都可以，见 `matchBinding`）。
 *
 * ## 投递与等待的机制
 *
 *   - **投递**走 `ctx.sessionController.prompt()`：它和用户在 B 的输入框里打字是
 *     同一条链路 —— 校验、写进 B 的收件箱、必要时唤醒冷会话、落盘。所以 B 的对话里
 *     会出现一条「用户消息」，并自动开始跑。本文件不自己拼事件、不碰 B 的日志。
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
 *   - 同一时刻 A 最多挂一个等待（工具默认独占执行）；不同会话之间互不影响。
 *   - 绑定关系只在内存里：重启 Host 后清空，页面刷新不会丢（客户端会重新读一次）。
 *
 * @module @local/dsh-split-workspaces/host
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

/** Cordis 服务键 / Typert 命名空间 / 线上命名空间（三者同名，客户端据此解析）。 */
export const SERVICE_KEY = 'paneDispatch';

/** Gateway 读取 Service 远端方法标记的原型属性名。 */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/** 本服务暴露给客户端的方法（形状与 `@Remote('x')` 记录的一致）。 */
const REMOTE_MARKERS = Object.freeze({
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

/**
 * 绑定目标的标准形状 —— 全插件只在这一个地方构造它。
 *
 * 为什么值得单独抽出来：这个「{ id, label, note? }」在整条链路上要构造**四次**
 * —— 读盘、装进绑定表、远程 `set`、远程 `list`。2026-11-02 就因为漏了其中一处
 * （装表那步只取了 id 和 label），出现了「箭头回来了、线上的说明没了」；更糟的是
 * 下一次落盘会按内存里的样子重写文件，把说明**永久**抹掉。
 * 收成一个函数，就不会再漏第二次。
 *
 * @param id - 目标会话 id。
 * @param label - 显示名；空时退回 id。
 * @param note - 用户写的分工说明；空白表示没有。
 * @returns 冻结前的普通对象。
 */
function makeTarget(id, label, note) {
  const target = { id, label: typeof label === 'string' && label !== '' ? label : id };
  if (typeof note === 'string' && note !== '') target.note = note.slice(0, EDGE_NOTE_MAX);
  return target;
}

/** 单次任务正文的长度上限（字符）。超出直接拒绝，避免把一条超大消息塞进别人的会话。 */
const MAX_TASK_CHARS = 20000;

/** 一条委派说明的最大长度（字符）—— 与客户端 `EDGE_NOTE_MAX` 保持一致。 */
const EDGE_NOTE_MAX = 200;

/** 落盘格式版本。读到更早/更新的版本时按「读不懂就当作空表」处理，不猜。 */
const STORE_VERSION = 1;

/** DSH 主目录。 */
function dshHome() {
  const home = process.env.DSH_HOME;
  return home === undefined || home === '' ? join(homedir(), '.dsh') : home;
}

/** 绑定表的落盘位置。 */
function storePath() {
  return join(dshHome(), 'storages', 'pane_dispatch_bindings.json');
}

/**
 * 从磁盘读回绑定表。
 *
 * 为什么这件事必须落在 **Host** 而不是浏览器：委派关系是「这个部署里谁可以把任务派给
 * 谁」，跟哪台机器、哪个浏览器打开界面没有关系。存浏览器 localStorage 的话，换个浏览器
 * 或者换台机器就看不见自己画的树了。
 *
 * 读不懂（文件缺失、JSON 坏了、版本对不上、字段形状不对）一律当作空表：一份读不出来的
 * 配置不该让整个插件加载失败，用户的损失只是「箭头没了」，重新画就行。
 *
 * @returns `{ owners: Array<{ id, label, targets }> }`。
 */
function loadStore() {
  const empty = { version: STORE_VERSION, owners: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(storePath(), 'utf8'));
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object') return empty;
  if (parsed.version !== STORE_VERSION) return empty;
  const owners = [];
  for (const row of Array.isArray(parsed.owners) ? parsed.owners : []) {
    if (row === null || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (id === '') continue;
    const targets = [];
    const seen = new Set();
    for (const item of Array.isArray(row.targets) ? row.targets : []) {
      if (item === null || typeof item !== 'object') continue;
      const targetId = typeof item.id === 'string' ? item.id.trim() : '';
      if (targetId === '' || targetId === id || seen.has(targetId)) continue;
      seen.add(targetId);
      targets.push(makeTarget(targetId, item.label, item.note));
    }
    if (targets.length === 0) continue;
    owners.push({ id, label: typeof row.label === 'string' && row.label !== '' ? row.label : id, targets });
  }
  return { version: STORE_VERSION, owners };
}

/**
 * 把绑定表写回磁盘。
 *
 * 走「临时文件 + rename」：rename 在同一个文件系统里是原子的，所以进程正好在写的中间被
 * 杀掉时，磁盘上留下的是**上一份完整文件**，而不是半截 JSON。这个插件每次改动都写一次，
 * 数据量只有几百字节，不值得为它引入防抖。
 *
 * @param owners - `[{ id, label, targets }]`。
 * @returns 是否写成功；失败**不抛**（调用方是用户点一下箭头，不该因此报错）。
 */
function saveStore(owners) {
  const file = storePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid;
    writeFileSync(temp, JSON.stringify({ version: STORE_VERSION, owners }, null, 2), 'utf8');
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 绑定关系与工具执行的全部状态。
 *
 * 只有一张表：`ownerId → Array<{ id, label }>`。`ownerId` 是发起方的会话 id，
 * 数组是**按用户在界面上勾选的顺序**排的 —— 这个顺序同时就是 `target` 参数里
 * 数字序号的依据（1 是第一个）。
 */
export class PaneDispatchService {
  /** @param ctx - 本行的宿主上下文。 */
  constructor(ctx) {
    this.ctx = ctx;
    /** ownerId → 绑定数组。 */
    this.bindings = new Map();
    /**
     * 诊断计数：客户端到底有没有跟 Host 对过话。
     *
     * 为什么值得记：绑定表**只有一条来路** —— 浏览器在设计模式里画完箭头，通过
     * `paneDispatch.set` 推上来。于是「工具说没有箭头」有两种完全不同的病因：
     *   - `set` 一次都没发生过 → 界面那半边没同步（客户端没重载、远端命名空间没挂上）；
     *   - `set` 发生过，但表里没有这个会话 → 箭头画给了别的窗格，或者方向反了。
     * 这两件事用户要做的事完全不一样，所以错误信息里必须能分开。
     */
    this.stats = { list: 0, set: 0 };
    /** 绑定变化后的回调（apply 用它在有活的会话时重建作用域工具）。 */
    this.listeners = new Set();
    /** ownerId → 这个会话的显示名（客户端随每次同步带上来）。 */
    this.labels = new Map();
    /**
     * 进行中的派单：`「owner\u0000target」 → { goalId, startedAt }`。
     *
     * 它的唯一作用是区分「这是新派一单」还是「接着等上一单」：
     *   - 新派：查对方空闲、创建目标；
     *   - 续等：不查空闲、不重建目标，只再等 5 分钟。
     * 目标终态时条目被删掉，于是下一次调用又回到「新派」。
     */
    this.pending = new Map();
    /** 一段等多久。测试里会把它压到几十毫秒。 */
    this.sliceMs = DISPATCH_SLICE_MS;
    /*
     * 启动时把上次的绑定表读回来。
     *
     * 这样「重启 Host」与「刷新页面」都不会丢掉用户画的树 —— 前者靠这里，后者靠客户端
     * 挂载时 `list()` 一遍再采纳（见 `client.view.js`）。
     */
    const stored = loadStore();
    for (const owner of stored.owners) {
      this.bindings.set(owner.id, owner.targets.map((item) => Object.freeze(makeTarget(item.id, item.label, item.note))));
      this.labels.set(owner.id, owner.label);
    }
  }

  /**
   * 订阅「某个发起方的绑定变了」。
   * @param listener - 收到 ownerId；抛错会被吞掉，不影响其它订阅者。
   * @returns 取消订阅。
   */
  onChange(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 把当前内存里的绑定表原样写成落盘格式。 */
  snapshotOwners() {
    const owners = [];
    for (const [id, targets] of this.bindings) {
      owners.push({
        id,
        label: this.labels.get(id) ?? id,
        targets: targets.map((item) => (item.note === undefined
          ? { id: item.id, label: item.label }
          : { id: item.id, label: item.label, note: item.note })),
      });
    }
    return owners;
  }

  /**
   * 现有的委派关系，写成 `派出方 → 目标1、目标2` 的样子。
   *
   * 这里必须**分别**取派出方名与目标名。第一版写错过：遍历的是目标数组却当成派出方
   * 报出去，于是错误信息说「箭头是从 A 出发的」，而 A 其实是目标 —— 用户照着这句去
   * 检查，越查越远。
   *
   * @returns 每项 `{ from, to: string[] }`。
   */
  relations() {
    const list = [];
    for (const [owner, targets] of this.bindings) {
      const from = this.labels.get(owner) ?? owner;
      list.push({ from, to: targets.map((item) => item.label) });
    }
    return list;
  }

  /**
   * 整体替换某个会话的绑定集合（客户端每次勾选/取消都发完整的一份）。
   *
   * 为什么是「整体替换」而不是「增删一项」：客户端才是选择的唯一权威，它手里的状态
   * 就是用户看到的状态；让它每次把完整集合发过来，「Host 与界面不一致」这类问题从
   * 结构上就不存在。
   *
   * @param request - `{ owner, targets: [{ id, label }] }`。
   * @returns `{ ok: true, count }`。
   */
  set(request) {
    this.stats.set += 1;
    const owner = typeof request?.owner === 'string' ? request.owner.trim() : '';
    if (owner === '') throw new Error('paneDispatch.set 需要 owner（发起方会话 id）');
    const ownerLabel = typeof request?.ownerLabel === 'string' ? request.ownerLabel.trim() : '';
    if (ownerLabel !== '') this.labels.set(owner, ownerLabel);
    const raw = Array.isArray(request?.targets) ? request.targets : [];
    const seen = new Set();
    const next = [];
    for (const item of raw) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (id === '' || id === owner || seen.has(id)) continue;
      seen.add(id);
      const label = typeof item?.label === 'string' ? item.label.trim() : '';
      next.push(Object.freeze(makeTarget(id, label, item?.note)));
    }
    if (next.length === 0) {
      this.bindings.delete(owner);
      this.labels.delete(owner);
    } else this.bindings.set(owner, next);
    // 每次改动都落盘：箭头是人工一条条画的，频率极低，不值得为它做防抖。
    this.saved = saveStore(this.snapshotOwners());
    for (const listener of [...this.listeners]) {
      try {
        listener(owner);
      } catch {
        /* 一个订阅者出错不该影响绑定本身已经写入的事实 */
      }
    }
    return { ok: true, count: next.length, saved: this.saved };
  }

  /**
   * 列出全部绑定，供客户端启动时重建界面。
   *
   * 为什么需要它：绑定存在 Host 内存里，而浏览器页面刷新会丢掉客户端状态。没有
   * `list`，用户刷新一次页面之后，「分派给谁」的勾选就看起来被清空了，而工具其实
   * 还认得目标 —— 两边不一致比清空更难排查。
   *
   * @returns `{ targets: [{ owner, items: [{ id, label }] }] }`。
   */
  /**
   * 读出全部绑定。
   *
   * `request` 这个形参**现在没用到，但必须留着**：
   * Typert 网关按**宿主方法的签名**校验调用参数，客户端描述符里声明了名为 `request`
   * 的参数、实际也会发 `{ request: {} }`，宿主这边少一个形参就会被判成
   * `args fields do not match the descriptor: unexpected "request"`。
   *
   * 这个错误真机上出现过：`set` 有形参所以一直正常，`list` 没有，于是**箭头能存下来、
   * 却永远读不回去**（刷新/重启就"没了"）。留着它也给将来的筛选条件留了位置。
   *
   * @param request - 目前忽略；将来可放「只要某个发起方的绑定」之类的筛选。
   * @returns `{ targets: [{ owner, ownerLabel, items }] }`。
   */
  list(request) {
    void request;
    this.stats.list += 1;
    const targets = [];
    for (const [owner, items] of this.bindings) {
      targets.push({
        owner,
        ownerLabel: this.labels.get(owner) ?? owner,
        items: items.map((item) => makeTarget(item.id, item.label, item.note)),
      });
    }
    return { targets };
  }

  /** 插件卸载时清空，避免热重载留下上一份绑定。 */
  clear() {
    this.bindings.clear();
    this.labels.clear();
    this.pending.clear();
  }
}

/**
 * 把任意抛出物转成一句能放进错误里的文字。
 * @param reason - 捕获到的异常。
 * @returns 字符串。
 */
function errorText(reason) {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * 从一条助手消息里取出纯文本。
 *
 * 只拼 `type: 'text'` 的块：图片、工具调用块对「回传给分派方」没有意义，混进去只会
 * 让 A 的模型读到一堆 JSON。
 *
 * @param data - `assistant/message` 事件的数据。
 * @returns 拼好的文本；没有文本块时返回空字符串。
 */
export function assistantText(data) {
  const content = data?.message?.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.trim() === '') continue;
    parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * 把模型给出的任务正文包装成一条**自解释**的用户消息。
 *
 * 三个必须写进去的信息：
 *   1. 这条消息来自另一个会话（不然目标模型会以为用户在跟它说话，然后反问「你说的
 *      B 是谁」）；
 *   2. 直接做、别反问（反问会让「一轮结束」被当成任务完成，把问题当成结论回传）；
 *   3. 结束时给一段结论（这段结论就是回给分派方的东西）。
 *
 * @param task - 模型给出的任务正文。
 * @param sourceLabel - 发起方会话的显示名。
 * @returns 完整的用户消息文本。
 */
export function wrapTask(task, sourceLabel) {
  const from = sourceLabel === undefined || sourceLabel === null || sourceLabel === ''
    ? '另一个会话'
    : '会话「' + sourceLabel + '」';
  return [
    '[任务分派]',
    '这条任务由' + from + '通过平铺面板的委派箭头派给你，不是当前用户输入的。',
    '',
    task,
    '',
    '—— 请直接执行上面的任务。如果需要澄清，按最合理的假设继续做，不要停下来反问；',
    '完成后用一段话给出结论，这段结论会回传给派单的会话。',
  ].join('\n');
}

/**
 * 在绑定集合里找出这一次要派给谁。
 *
 * 匹配顺序是「先精确、后宽松」，每一步只在**唯一命中**时接受：
 *   1. 空值：只有一个绑定时直接用它；多个绑定返回 `null` 让调用方报错列候选；
 *   2. 精确的 label（界面上的显示名）或会话 id；
 *   3. 纯数字：按界面上勾选的顺序取第 n 个（从 1 开始）；
 *   4. label 的唯一子串。
 *
 * 为什么宽到「子串」：模型看到的是候选列表里的完整标题（形如「修复登录 / my-app」），
 * 它复述时经常只带其中一半；要求逐字相同会让它反复失败。
 *
 * @param bindings - 绑定数组。
 * @param raw - 模型给的 target 参数（可能是 undefined）。
 * @returns 命中的绑定，或 `null`（调用方负责报错）。
 */
export function matchBinding(bindings, raw) {
  if (!Array.isArray(bindings) || bindings.length === 0) return null;
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (text === '') return bindings.length === 1 ? bindings[0] : null;
  const exact = bindings.filter((item) => item.label === text || item.id === text);
  if (exact.length === 1) return exact[0];
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    if (index >= 0 && index < bindings.length) return bindings[index];
  }
  const partial = bindings.filter((item) => item.label.includes(text));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * 候选列表的展示文本（错误信息与工具结果共用）。
 * @param bindings - 绑定数组。
 * @returns 形如 `1) 标题` 的若干行；没有绑定时给一句说明。
 */
export function describeCandidates(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) return '当前没有绑定任何可派发的会话。';
  return bindings.map((item, index) => (index + 1) + ') ' + item.label).join('\n');
}

/**
 * 目标会话此刻是不是正忙；忙的话返回一句可以直接抛出去的说明。
 *
 * 为什么**拒绝**而不是排队：用户对这套功能的前提说得很清楚 ——「B、C 要空闲」。
 * 排队看似更宽容，实际会让「一轮结束」这个唯一的结果信号变得不可靠：我们的消息排在
 * 别人那一轮后面时，`turn/end` 先到的是**别人**的结束，于是取回来的回复对不上人。
 * 与其猜，不如如实拒绝，让人等目标空闲了再派。
 *
 * 冷会话（`ctx.agents.get` 取不到）一律当作空闲：它没有活着的回合，唤醒就是一次
 * 干净的新轮次，不会撞上别人的结束信号。
 *
 * @param ctx - 宿主上下文。
 * @param binding - 目标绑定 `{ id, label }`。
 * @returns 忙的时候是一句人话，空闲时 null。
 */
export function runningText(ctx, binding) {
  const agents = ctx.get('agents');
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return null;
  let live;
  try {
    live = agents.get(binding.id);
  } catch {
    return null;
  }
  if (live === undefined || live === null) return null;
  if (live.status !== 'running') return null;
  return '目标会话「' + binding.label + '」正在跑一个回合，暂时不能接任务。等它闲下来再派。';
}

/**
 * 等目标会话把「我们投进去的那条消息」跑完。
 *
 * 事件筛选的两道闸：
 *   - `user/message` 且 `source.rpcId === requestId` —— 认领我们这条消息，记下它的
 *     seq。在它之前的事件一律不收集（那可能是目标会话上一轮还在跑）。
 *   - 认领之后、seq 更大的 `assistant/message` 收集文本；遇到 `turn/end` 收尾。
 *
 * 三种结束方式：
 *   - 正常：返回那一轮的结束原因（completed / aborted / error / blocked）；
 *   - 超时：返回 `timeout`，并带上已经收到的文本（有总比没有强）；
 *   - 取消：返回 `cancelled`，同样带上已收到的文本。
 *
 * @param ctx - 宿主上下文（用来订阅 `session/event`）。
 * @param targetId - 目标会话 id。
 * @param requestId - 本次投递的一次性 id（会写进消息的 rpcId）。
 * @param signal - 调用方的取消信号。
 * @returns `{ status, reply }`。
 */
export function waitForTurn(ctx, targetId, requestId, signal) {
  return new Promise((resolve) => {
    let claimed = false;
    let acceptSeq = -1;
    let lastText = '';
    let settled = false;
    let timer = null;
    let off = () => {};
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        off();
      } catch {
        /* 取消订阅失败不该盖住结果 */
      }
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ status: 'cancelled', reply: lastText });
    off = ctx.on('session/event', (session, event) => {
      if (settled || session === undefined || event === undefined) return;
      if (session.id !== targetId) return;
      if (event.type === 'user/message') {
        const source = event.data === undefined ? undefined : event.data.source;
        if (source !== undefined && source !== null && source.rpcId === requestId) {
          claimed = true;
          acceptSeq = event.seq;
        }
        return;
      }
      if (!claimed || event.seq <= acceptSeq) return;
      if (event.type === 'assistant/message') {
        const text = assistantText(event.data);
        if (text !== '') lastText = text;
        return;
      }
      if (event.type === 'turn/end') {
        const kind = event.data?.reason?.kind;
        finish({ status: typeof kind === 'string' ? kind : 'completed', reply: lastText });
      }
    });
    if (signal.aborted) {
      finish({ status: 'cancelled', reply: '' });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish({ status: 'timeout', reply: lastText }), DISPATCH_TIMEOUT_MS);
    /*
     * 兜底定时器**不许吊住事件循环**：它最长 20 分钟，而它唯一的作用是「万一没人叫醒
     * 这个 Promise」。在长驻宿主里这没什么，但在短命进程（离线测试、一次性脚本）里，
     * 一个没人再等的计时器会让进程白白挂 20 分钟才退出。
     */
    timer.unref?.();
  });
}

/**
 * 等目标会话把「目标」推进到终态。
 *
 * 与 `waitForTurn` 的区别在于「完成」的定义：一轮结束不等于任务做完 —— 目标模式的价值
 * 恰恰是它会在多轮里继续推进。所以这里等的是 **goal 的 phase 离开 active**
 * （complete / blocked / paused），而不是某一个 turn/end。
 *
 * 两个细节：
 *   - 每收到一条该会话的事件就读一次 goal：goal 变化本身就是会话事件，不必自己维护状态；
 *   - 助手文本取**最后一个非空**的：目标的最后一轮通常就是结论，中途那些「继续查…」
 *     不是用户要的。
 *
 * @param ctx - 宿主上下文。
 * @param agent - 目标会话的活 agent。
 * @param signal - 调用方取消信号。
 * @returns `{ status, reply, reason }`；`status` 是 goal 的终态或 `timeout`/`cancelled`。
 */
export function waitForGoal(ctx, agent, signal, options) {
  const goals = ctx.get('goals');
  const sliceMs = options?.sliceMs ?? DISPATCH_SLICE_MS;
  const sessionId = agent.session === undefined ? undefined : agent.session.id;
  return new Promise((resolve) => {
    let lastText = '';
    let settled = false;
    let timer = null;
    let off = () => {};
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        off();
      } catch {
        /* 取消订阅失败不该盖住结果 */
      }
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ status: 'cancelled', reply: lastText, reason: '', rounds: rounds() });
    /**
     * 读一次目标状态。
     * 读不到（agent 已不是活实例）时返回 `{ phase: null }` —— 表示「不知道」，继续等。
     * 目标被清掉（`undefined`）时返回 `{ phase: 'cleared' }` —— 这是一种终态。
     */
    const read = () => {
      try {
        const view = goals.get(agent);
        if (view === undefined || view === null) return { phase: 'cleared', rounds: 0, reason: '' };
        const reason = view.blockedReason === undefined || view.blockedReason === null
          ? ''
          : (view.blockedReason.explanation ?? view.blockedReason.code ?? '');
        return { phase: view.phase, rounds: view.roundsStarted ?? 0, reason };
      } catch {
        return { phase: null, rounds: 0, reason: '' };
      }
    };
    const rounds = () => read().rounds;
    /** 到了终态就收尾；`active` 不算终态。 */
    const settleIfTerminal = () => {
      const current = read();
      if (current.phase === null || current.phase === 'active') return false;
      finish({ status: current.phase, reply: lastText, reason: current.reason, rounds: current.rounds });
      return true;
    };
    off = ctx.on('session/event', (session, event) => {
      if (settled || session === undefined || sessionId === undefined || session.id !== sessionId) return;
      if (event !== undefined && event.type === 'assistant/message') {
        const text = assistantText(event.data);
        if (text !== '') lastText = text;
      }
      // 任何事件之后都重读一次：目标的推进与结束都体现在会话日志里。
      settleIfTerminal();
    });
    if (signal.aborted) {
      finish({ status: 'cancelled', reply: '', reason: '', rounds: 0 });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    /*
     * 进来先看一眼：目标可能在我们挂上监听之前就结束了（两次调用之间对方刚好做完）。
     * 少了这一步，续等的那一次会白等满 5 分钟才报「还在跑」。
     */
    if (settleIfTerminal()) return;
    timer = setTimeout(() => {
      const current = read();
      if (current.phase === null || current.phase === 'active') {
        // 还在跑：带着目前的进度返回，让派单方看见进展并决定是否接着等。
        finish({ status: 'running', reply: lastText, reason: '', rounds: current.rounds });
        return;
      }
      finish({ status: current.phase, reply: lastText, reason: current.reason, rounds: current.rounds });
    }, sliceMs);
    timer.unref?.();
  });
}

/**
 * 把任务当作「目标」交给目标会话。
 *
 * 为什么走 `resolveAgent` 而不是直接 `agents.get`：目标可能是冷会话，需要按控制器自己的
 * 策略（预设、子代理归属）把它唤醒。`resolveAgent` 正是这条公开入口。
 *
 * @param ctx - 宿主上下文。
 * @param binding - 目标绑定。
 * @param objective - 写进目标的目标描述。
 * @param signal - 调用方取消信号。
 * @returns `{ status, reply, reason }`，或 `null` 表示这个部署没有目标服务、应回落到普通投递。
 */
export function goalSupport(ctx) {
  const sessions = ctx.get('sessionController');
  const goals = ctx.get('goals');
  if (goals === undefined || goals === null || typeof goals.create !== 'function') return null;
  if (sessions === undefined || sessions === null || typeof sessions.resolveAgent !== 'function') return null;
  return { sessions, goals };
}

/**
 * 唤醒目标会话并拿到它的活 agent。
 *
 * 走 `resolveAgent` 而不是 `agents.get`：目标可能是冷会话，需要按控制器自己的策略
 * （预设、子代理归属）把它唤醒 —— 这正是那条公开入口做的事。
 *
 * @param support - `goalSupport()` 的返回值。
 * @param binding - 目标绑定。
 * @returns 活的 agent。
 */
export async function resolveTargetAgent(support, binding) {
  const resolved = await support.sessions.resolveAgent(binding.id);
  if (resolved === undefined || resolved === null) {
    throw new Error('无法唤醒目标会话「' + binding.label + '」。');
  }
  if (resolved.error !== undefined) {
    const message = resolved.error.message ?? resolved.error.code ?? '未知原因';
    throw new Error('无法唤醒目标会话「' + binding.label + '」：' + message);
  }
  return resolved.agent;
}

/**
 * 把一条任务投递给目标会话并等它停下来。
 *
 * 顺序很关键：**先装监听、再投递**。反过来的话，目标会话很快的那一轮可能在
 * `prompt()` 的 Promise 兑现之前就跑完并发出 `turn/end`，我们就永远等不到了。
 *
 * 投递失败时，那条「等待」必须被主动取消 —— 否则它会一直挂到 20 分钟超时，白白占着
 * 一个订阅。这里用一个内部 AbortController 把两条路并起来。
 *
 * @param ctx - 宿主上下文。
 * @param binding - 目标绑定 `{ id, label }`。
 * @param task - 任务正文（已由模型给出）。
 * @param sourceLabel - 发起方的显示名。
 * @param signal - 调用方取消信号。
 * @returns `{ status, reply }`。
 */
export async function deliverAndWait(ctx, binding, task, sourceLabel, signal) {
  const busy = runningText(ctx, binding);
  if (busy !== null) throw new Error(busy);
  const sessions = ctx.get('sessionController');
  if (sessions === undefined || sessions === null || typeof sessions.prompt !== 'function') {
    throw new Error('这个部署没有会话服务（sessionController），没法向另一个会话投递任务。');
  }
  const requestId = randomUUID();
  const inner = new AbortController();
  const onOuterAbort = () => inner.abort();
  if (signal.aborted) inner.abort();
  signal.addEventListener('abort', onOuterAbort, { once: true });
  const waiting = waitForTurn(ctx, binding.id, requestId, inner.signal);
  let accepted;
  try {
    /*
     * 第二个参数是 **AbortSignal**，不是消息来源。
     *
     * `SessionController.prompt(request, signal)` 的第一行就是 `signal.throwIfAborted()`
     * （见 dsh-api-session-controller 的 lib/index.js），而 `user-rpc` 那条消息来源是
     * 它自己用 `request.requestId` 拼出来的 —— 所以这里只交信号，不交 source。
     * 传错会得到「signal.throwIfAborted is not a function」，也就是这条注释的由来。
     *
     * 交的是 `inner.signal`（已与调用方信号联动）：用户在 A 那边按停止时，正在进行的
     * 投递也会被取消，而不是先把消息塞进 B 再丢掉等待。
     */
    accepted = await sessions.prompt(
      {
        requestId,
        sessionId: binding.id,
        mode: 'queue',
        content: [{ type: 'text', text: wrapTask(task, sourceLabel) }],
      },
      inner.signal,
    );
  } catch (reason) {
    inner.abort();
    await waiting.catch(() => undefined);
    throw new Error('向目标会话投递任务失败：' + errorText(reason));
  }
  if (accepted === undefined || accepted === null || accepted.accepted !== true) {
    inner.abort();
    await waiting.catch(() => undefined);
    throw new Error('目标会话没有接受这条任务。');
  }
  /*
   * 联动必须在**整个等待期间**都挂着，所以解绑放在这里而不是 `finally`。
   *
   * 踩过的坑：第一版把 `signal.removeEventListener` 写进 `prompt()` 那一段的
   * `finally`，于是投递一返回联动就断了 —— 用户在 A 那边按停止时，正在等 B 的这个
   * 等待收不到任何通知，会一直挂到 20 分钟兜底。而「投递完成后等 B 跑完」正是这段
   * 功能里**最长**、也最需要能取消的那一段。
   */
  try {
    return await waiting;
  } finally {
    signal.removeEventListener('abort', onOuterAbort);
  }
}

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
