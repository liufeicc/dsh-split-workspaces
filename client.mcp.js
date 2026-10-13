/**
 * MCP 工具开关块：读宿主「每个工作区选中了哪些 MCP 服务器」，并把用户的勾选写回去。
 *
 * 与隔壁 `client.presets.js` 的两点关键区别：
 *   1. **键是工作区路径，不是窗格或会话。** MCP 可见性是工作区级的宿主策略
 *      （宿主按会话的 `session.header.cwd` 施加限制），所以同一工作区的所有窗格
 *      天然共享同一份选择 —— 改一处，全部跟着变。窗格只负责把它渲染出来。
 *   2. **远端命名空间不是 dsh 自带的。** `remote.mcpWorkspace` 由
 *      `@local/dsh-mcp-workspace-policy` 的客户端半边挂载，因此它**不能**写进本插件的
 *      `inject` 列表（那会在挂载完成前形成先有鸡还是先有蛋的死锁），只能在调用时
 *      用 `ctx.get(...)` 惰性解析。所以这里接的是一个 `getService()` 函数而不是服务对象。
 *
 * 加载方式：入口 `client.js` 用 `require.async('./client.mcp.js')` 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.mcp.js',
  factory() {
    /** 远端命名空间键（也是宿主服务键）。 */
    const MCP_REMOTE_KEY = 'remote.mcpWorkspace';

    /** 把任意抛出物转成一句人能读的话。 */
    function errorText(reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }

    /**
     * 读宿主的服务器清单与各工作区选择。
     *
     * 服务没挂上**不是故障**：那说明策略包没装或它的客户端半边还没挂载完，
     * 与「本来就没有 MCP」在界面上应当是同一种静默处理，因此单独用一个
     * `notMounted` 理由区分开，不当作错误上报。
     *
     * @param service - 惰性取到的远端命名空间，可能仍是 undefined。
     * @returns `{ ok: true, roster }` 或 `{ ok: false, reason }`。
     */
    async function readRoster(service) {
      if (service === undefined || service === null) return { ok: false, reason: 'notMounted' };
      let result;
      try {
        result = await service.list({});
      } catch (reason) {
        return { ok: false, reason: errorText(reason) };
      }
      if (result.ok) return { ok: true, roster: result.value };
      if (result.error.code === 'gateway/invocation-unavailable') return { ok: false, reason: 'notMounted' };
      return { ok: false, reason: result.error.message };
    }

    /**
     * 把某个工作区的选择写回宿主。宿主会顺手落盘，并**立刻**对该工作区的所有活会话
     * 重挂工具限制，因此调用返回后界面上的选择就是已生效的选择。
     *
     * @param service - 远端命名空间。
     * @param workspace - 工作区绝对路径（与会话 cwd 同一个字符串）。
     * @param selected - 选中的服务器名数组。
     * @returns `{ ok: true, selected }` 或 `{ ok: false, reason }`。
     */
    async function writeSelection(service, workspace, selected) {
      if (service === undefined || service === null) return { ok: false, reason: 'notMounted' };
      let result;
      try {
        result = await service.set({ workspace, selected });
      } catch (reason) {
        return { ok: false, reason: errorText(reason) };
      }
      if (result.ok) {
        const value = result.value;
        return { ok: true, selected: value !== undefined && Array.isArray(value.selected) ? value.selected : selected };
      }
      return { ok: false, reason: result.error.message };
    }

    /**
     * 某个工作区当前选中的服务器。
     *
     * **没有条目 = 空数组 = 全不选**，这是产品决定（未配置的工作区不暴露任何 MCP 工具），
     * 不是"数据缺失"。
     *
     * @param snapshot - store 快照。
     * @param path - 工作区绝对路径。
     * @returns 选中的服务器名数组。
     */
    function selectionOf(snapshot, path) {
      if (path === undefined || path === null) return [];
      const byWorkspace = snapshot === undefined ? undefined : snapshot.byWorkspace;
      const entry = byWorkspace === undefined ? undefined : byWorkspace[path];
      return Array.isArray(entry) ? entry : [];
    }

    /**
     * 整块棋盘共用一份 MCP 状态。
     *
     * `generation` 保证并发载入时只有最新那一次能写入结果（照 `client.presets.js` 的做法）。
     * 勾选走**乐观更新**：先动界面让点击立刻有反馈，写宿主失败再回滚并把原因交给窗格 ——
     * 否则每次勾选都要等一个远端往返，手感会很糟。
     *
     * @param getService - 惰性解析远端命名空间的函数（见文件头第 2 点）。
     * @returns 一个快照 store：`{ getSnapshot, subscribe, load, setSelection }`。
     */
    function createMcpStore(getService) {
      let snapshot = { status: 'idle', servers: [], byWorkspace: {}, error: null, reason: null };
      const listeners = new Set();
      let generation = 0;
      const publish = (next) => {
        snapshot = next;
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        /** 读一次清单。服务没挂上时记为 `unavailable`（静默），其它失败记为 `error`。 */
        async load() {
          const current = ++generation;
          if (snapshot.status !== 'loading') publish({ ...snapshot, status: 'loading', error: null, reason: null });
          const roster = await readRoster(getService());
          if (current !== generation) return;
          if (!roster.ok) {
            const notMounted = roster.reason === 'notMounted';
            publish({
              ...snapshot,
              status: notMounted ? 'unavailable' : 'error',
              error: notMounted ? null : roster.reason,
              reason: roster.reason,
            });
            return;
          }
          const value = roster.roster === undefined || roster.roster === null ? {} : roster.roster;
          const servers = Array.isArray(value.servers) ? value.servers : [];
          const byWorkspace = value.byWorkspace !== null && typeof value.byWorkspace === 'object' ? value.byWorkspace : {};
          publish({
            status: servers.length === 0 ? 'empty' : 'ready',
            servers,
            byWorkspace,
            error: null,
            reason: null,
          });
        },
        /**
         * 切换某个工作区里一个服务器的选中状态。
         * @param path - 工作区绝对路径。
         * @param selected - 切换后的完整选中列表。
         * @returns `{ ok: true }` 或 `{ ok: false, reason }`（失败时已回滚）。
         */
        async setSelection(path, selected) {
          const previous = selectionOf(snapshot, path);
          publish({ ...snapshot, byWorkspace: { ...snapshot.byWorkspace, [path]: selected }, error: null });
          const result = await writeSelection(getService(), path, selected);
          if (!result.ok) {
            publish({ ...snapshot, byWorkspace: { ...snapshot.byWorkspace, [path]: previous }, error: result.reason });
            return { ok: false, reason: result.reason };
          }
          publish({ ...snapshot, byWorkspace: { ...snapshot.byWorkspace, [path]: result.selected }, error: null });
          return { ok: true };
        },
      };
    }

    return { MCP_REMOTE_KEY, errorText, readRoster, writeSelection, selectionOf, createMcpStore };
  },
});
