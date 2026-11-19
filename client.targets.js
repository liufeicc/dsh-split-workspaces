/**
 * 派单目标记录的客户端 store。
 *
 * 目标是什么：用户在「新建会话」里选「新建目标」时创建的真实会话。它和普通会话
 * 一样存在于 Host，但多一条**目标记录**；这条记录只解决显示问题：
 *
 *   - 普通空白会话在任务分派和平铺会话菜单里都不显示；
 *   - 带目标记录的空会话要显示成「未命名目标」，让用户可以先建目标、再连线。
 *
 * 记录本身由 Host 持久化（`storages/pane_dispatch_targets.json`），这个 store 只是
 * 一份客户端镜像 + 乐观更新的协调层。加载失败时**保留已有数据**，不把界面上的
 * 目标清空。
 *
 * 加载方式：入口 `client.js` 用 `require.async('./client.targets.js')` 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.targets.js',
  factory() {
    /** 目标记录的标准形状校验 —— 全 store 只从这里认字段。 */
    function normalizeTarget(row) {
      if (row === null || typeof row !== 'object') return undefined;
      if (typeof row.id !== 'string' || row.id === '') return undefined;
      if (typeof row.workspaceId !== 'string' || row.workspaceId === '') return undefined;
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
      };
    }

    /** 把 `byId` 重新整理成稳定的 id 数组（按创建时间从早到晚）。 */
    function orderIds(byId) {
      return Object.keys(byId).sort((a, b) => (byId[a].createdAt ?? 0) - (byId[b].createdAt ?? 0));
    }

    /**
     * 创建目标 store。
     *
     * @param options - 三个远端动作：
     *   - `load()`：返回目标数组或 undefined（undefined = 读不到，保留现状）；
     *   - `add(sessionId, workspaceId)`：返回 `{ ok, reason? }`；
     *   - `remove(sessionId)`：返回 `{ ok, reason? }`。
     * @returns `{ getSnapshot, subscribe, load, addTarget, removeTarget, isTarget }`。
     */
    function createTargetStore(options) {
      const load = typeof options?.load === 'function' ? options.load : async () => undefined;
      const add = typeof options?.add === 'function' ? options.add : async () => ({ ok: false, reason: 'notMounted' });
      const remove = typeof options?.remove === 'function' ? options.remove : async () => ({ ok: false, reason: 'notMounted' });
      let snapshot = { status: 'idle', error: null, byId: {}, ids: [] };
      const listeners = new Set();

      function publish(next) {
        snapshot = next;
        for (const listener of listeners) {
          try {
            listener(snapshot);
          } catch {
            /* 单个订阅者出错不影响其他界面 */
          }
        }
      }

      function withTargets(byId, extra) {
        return {
          ...(extra ?? {}),
          byId,
          ids: orderIds(byId),
        };
      }

      return {
        getSnapshot() {
          return snapshot;
        },

        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },

        /** 从 Host 读回全部记录；读不到时保留现有数据，只把状态标成 error。 */
        async load() {
          if (snapshot.status === 'loading') return;
          publish({ ...snapshot, status: 'loading', error: null });
          let rows;
          try {
            rows = await load();
          } catch (reason) {
            rows = undefined;
          }
          if (rows === undefined) {
            publish({ ...snapshot, status: 'error', error: 'targets unavailable' });
            return;
          }
          const byId = {};
          for (const row of rows) {
            const target = normalizeTarget(row);
            if (target !== undefined) byId[target.id] = target;
          }
          publish(withTargets(byId, { status: 'ready', error: null }));
        },

        /**
         * 登记一个目标（乐观更新，Host 写失败时回滚）。
         *
         * @returns `{ ok, reason? }`。
         */
        async addTarget(sessionId, workspaceId) {
          if (typeof sessionId !== 'string' || sessionId === '') {
            return { ok: false, reason: 'invalid session id' };
          }
          if (typeof workspaceId !== 'string' || workspaceId === '') {
            return { ok: false, reason: 'invalid workspace id' };
          }
          const previous = snapshot;
          const existing = snapshot.byId[sessionId];
          const target = {
            id: sessionId,
            workspaceId,
            createdAt: existing === undefined ? Date.now() : existing.createdAt,
          };
          publish(withTargets({ ...snapshot.byId, [sessionId]: target }, snapshot));
          let result;
          try {
            result = await add(sessionId, workspaceId);
          } catch (reason) {
            result = { ok: false, reason: reason instanceof Error ? reason.message : String(reason) };
          }
          if (result === undefined || result.ok !== true) {
            publish(previous);
            return {
              ok: false,
              reason: result !== undefined && typeof result.reason === 'string' ? result.reason : 'addTarget failed',
            };
          }
          return { ok: true };
        },

        /**
         * 删除一个目标记录（乐观更新，Host 写失败时恢复）。
         *
         * @returns `{ ok, reason? }`。
         */
        async removeTarget(sessionId) {
          if (typeof sessionId !== 'string' || sessionId === '') return { ok: true };
          const existing = snapshot.byId[sessionId];
          if (existing === undefined) return { ok: true };
          const previous = snapshot;
          const byId = { ...snapshot.byId };
          delete byId[sessionId];
          publish(withTargets(byId, snapshot));
          let result;
          try {
            result = await remove(sessionId);
          } catch (reason) {
            result = { ok: false, reason: reason instanceof Error ? reason.message : String(reason) };
          }
          if (result === undefined || result.ok !== true) {
            publish(previous);
            return {
              ok: false,
              reason: result !== undefined && typeof result.reason === 'string' ? result.reason : 'removeTarget failed',
            };
          }
          return { ok: true };
        },

        /** 这个会话是不是目标（空白目标需要显示、普通新建不能复用）。 */
        isTarget(sessionId) {
          return snapshot.byId[sessionId] !== undefined;
        },
      };
    }

    return { createTargetStore };
  },
});
