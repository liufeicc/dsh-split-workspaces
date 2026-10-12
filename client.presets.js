/**
 * Agent 模式（预设）块：读 Host 的模式清单、把模式应用到会话、并缓存成一份共享快照。
 *
 * 约定与来源：
 *   - 清单来自 `remote.agentPresets.list()`，与侧边栏新建任务用的是同一份 Host 花名册；
 *   - 内置模式自己不带名字（只有 id），所以显示文案由本插件词典提供；
 *   - Host 只允许给「还没跑过回合」的空白会话换模式，一旦会话开始过，换模式会被拒绝，
 *     这里把拒绝理由原样返回，由窗格自己展示，而不是抛异常。
 *
 * 加载方式：入口 `client.js` 通过 `require.async('./client.presets.js')` 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.presets.js',
  factory() {
    /** 内置模式的显示文案键；自定义模式自带名字，不走这里。 */
    const BUILT_IN_PRESET_KEYS = {
      standard: 'preset.standard',
      ptc: 'preset.ptc',
      minimal: 'preset.minimal',
      cordis: 'preset.cordis',
    };

    /** 把任意抛出物转成一句人能读的话。 */
    function errorText(reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }

    /** 生成一个模式的展示名：内置走词典，自定义用它自己声明的名字，都没有就退回 id。 */
    function presetName(option, t) {
      if (option.name === undefined || option.name === '') {
        const key = BUILT_IN_PRESET_KEYS[option.id];
        if (key !== undefined) return t(key);
        return option.id;
      }
      return option.name;
    }

    /**
     * 读 Host 的模式清单。
     *
     * 没有挂预设注册表的部署会返回 `gateway/invocation-unavailable`，这属于
     * 「本来就没有模式可选」，不是故障，因此按空清单处理。
     *
     * @returns `{ ok: true, presets }` 或 `{ ok: false, reason }`。
     */
    async function readPresetRoster(agentPresets) {
      let result;
      try {
        result = await agentPresets.list();
      } catch (reason) {
        return { ok: false, reason: errorText(reason) };
      }
      if (result.ok) return { ok: true, presets: result.value.presets };
      if (result.error.code === 'gateway/invocation-unavailable') return { ok: true, presets: [] };
      return { ok: false, reason: result.error.message };
    }

    /**
     * 把某个模式应用到指定会话。Host 拒绝时返回原因而不是抛异常。
     * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
     */
    async function selectPreset(agentPresets, sessionId, presetId) {
      let result;
      try {
        result = await agentPresets.select(sessionId, presetId);
      } catch (reason) {
        return { ok: false, reason: errorText(reason) };
      }
      if (result.ok) return { ok: true };
      const details = result.error.details;
      const reason = details !== undefined && details !== null && typeof details.reason === 'string'
        ? details.reason
        : result.error.message;
      return { ok: false, reason };
    }

    /** 会话记录里已经生效的模式（没有记录时返回 undefined）。 */
    function presetOfSession(summary) {
      const value = summary === undefined ? undefined : summary.projectionValues?.agentPreset;
      return typeof value === 'string' ? value : undefined;
    }

    /**
     * 整块棋盘共用一份模式清单。
     *
     * 所有窗格读同一份快照，因此一次载入只问 Host 一次；`generation` 保证
     * 并发载入时只有最新那一次能写入结果。
     */
    function createPresetStore(agentPresets) {
      let snapshot = { status: 'idle', options: [], defaultId: '', error: null };
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
        /** 载入清单：坏掉的模式直接丢掉，全部坏掉时视为「没有模式可选」。 */
        async load() {
          const current = ++generation;
          if (snapshot.status !== 'loading') publish({ ...snapshot, status: 'loading', error: null });
          const roster = await readPresetRoster(agentPresets);
          if (current !== generation) return;
          if (!roster.ok) {
            publish({ ...snapshot, status: 'error', error: roster.reason });
            return;
          }
          const options = [];
          let defaultId = '';
          for (const preset of roster.presets) {
            if (preset.broken !== undefined) continue;
            options.push({ id: preset.id, name: preset.name, description: preset.description });
            if (preset.isDefault === true) defaultId = preset.id;
          }
          if (defaultId === '') defaultId = options.length === 0 ? '' : options[0].id;
          publish({
            status: options.length === 0 ? 'unavailable' : 'ready',
            options,
            defaultId,
            error: null,
          });
        },
      };
    }

    return { BUILT_IN_PRESET_KEYS, errorText, presetName, readPresetRoster, selectPreset, presetOfSession, createPresetStore };
  },
});
