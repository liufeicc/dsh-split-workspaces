/**
 * 多工作区平铺 —— 绑定关系与派单状态的宿主服务。
 *
 * 整个插件在 Host 侧只有一张表：`ownerId → Array<{ id, label, note? }>`，外加两个
 * 辅助索引（显示名、进行中的派单）。客户端是选择的唯一权威，每次把完整集合推上来；
 * 这里只负责「原样存住、落盘、通知订阅者」。
 *
 * 服务本身不投递、不等待 —— 那是 `host.wait.js` 与 `host.tool.js` 的事。这样
 * 「表怎么存」与「任务怎么送」可以分别测。
 *
 * @module @local/dsh-split-workspaces/host-service
 */

import { DISPATCH_SLICE_MS } from './host.constants.js';
import { loadStore, makeTarget, saveStore } from './host.store.js';

/**
 * 绑定关系与工具执行的全部状态。
 *
 * 只有一张表：`ownerId → Array<{ id, label, note? }>`。`ownerId` 是发起方的会话 id，
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
    /*
     * 箭头被删掉就是授权被撤回，「还在等这个目标」也必须一起作废。
     *
     * 不清的话，模型下次「省略 task 接着等」会等一个已经不该再等的目标 —— 而用户在
     * 界面上看到的是「这条箭头我已经删了」。
     */
    const kept = new Set(next.map((item) => item.id));
    for (const key of [...this.pending.keys()]) {
      const [pendingOwner, target] = key.split('\u0000');
      if (pendingOwner === owner && !kept.has(target)) this.pending.delete(key);
    }
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
