/**
 * SKILL 开关块：读宿主「每个工作区启用了技能库里的哪些技能」，并把勾选写回去。
 *
 * 与隔壁 `client.mcp.js` 是同一个形状（都是**按工作区**的宿主策略），差别只在内容：
 *
 *   - MCP 管的是「哪些服务器的工具可见」，开关项来自宿主报的服务器清单；
 *   - SKILL 管的是「技能目录里哪些技能可见」，开关项来自**技能目录自身的扫描结果**。
 *
 * 因此本块比 MCP 那块多两件事：
 *   1. 技能有**描述**，勾选列表要能看出每个技能是干什么的（MCP 只需要一个名字）；
 *   2. 技能目录可以为空、可以不存在、也可以有写坏的文件 —— 这几种情况都要在弹层里
 *      说清楚，否则用户只会看到一片空白，不知道是自己没建文件还是插件没生效。
 *
 * 数据归属：技能目录（`dir`）由「设置 → 技能」维护，本块只读它、用来解释「为什么
 * 列表里只有这些」；本块唯一会写的是**某个工作区的勾选集合**。
 *
 * 加载方式：入口 `client.js` 用 `require.async('./client.skill.js')` 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.skill.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 远端命名空间键（也是宿主服务键）。 */
    const SKILL_REMOTE_KEY = 'remote.skillWorkspace';

    /** 把任意抛出物转成一句人能读的话。 */
    function errorText(reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }

    /**
     * 读宿主的技能库清单与各工作区选择。
     *
     * 服务没挂上**不是故障**：那说明技能库插件没装或其客户端半边还没挂载完，界面上
     * 应当静默处理，因此单独用一个 `notMounted` 理由区分开，不当作错误上报。
     *
     * @param service - 惰性取到的远端命名空间，可能仍是 undefined。
     * @returns `{ ok: true, library }` 或 `{ ok: false, reason }`。
     */
    async function readLibrary(service) {
      if (service === undefined || service === null) return { ok: false, reason: 'notMounted' };
      let result;
      try {
        result = await service.list({});
      } catch (reason) {
        return { ok: false, reason: errorText(reason) };
      }
      if (result !== null && result !== undefined && result.ok === true) return { ok: true, library: result.value };
      const error = result === null || result === undefined ? undefined : result.error;
      if (error !== undefined && error !== null && error.code === 'gateway/invocation-unavailable') {
        return { ok: false, reason: 'notMounted' };
      }
      return { ok: false, reason: error === undefined || error === null ? 'unknown' : (error.message ?? String(error)) };
    }

    /**
     * 把某个工作区的勾选写回宿主。
     *
     * 宿主会顺手落盘，并让技能注册表失效，因此调用返回后**下一个回合**就能看到效果。
     *
     * @param service - 远端命名空间。
     * @param workspace - 工作区绝对路径（与会话 cwd 同一个字符串）。
     * @param selected - 勾选的技能名数组。
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
      if (result !== null && result !== undefined && result.ok === true) {
        const value = result.value;
        return { ok: true, selected: value !== undefined && Array.isArray(value.selected) ? value.selected : selected };
      }
      const error = result === null || result === undefined ? undefined : result.error;
      return { ok: false, reason: error === undefined || error === null ? 'unknown' : (error.message ?? String(error)) };
    }

    /**
     * 某个工作区当前勾选的技能。
     *
     * **没有条目 = 空数组 = 全不选**，这是产品决定（未配置的工作区不暴露任何技能），
     * 不是「数据缺失」。
     *
     * @param snapshot - store 快照。
     * @param path - 工作区绝对路径。
     * @returns 勾选的技能名数组。
     */
    function selectionOf(snapshot, path) {
      if (path === undefined || path === null) return [];
      const byWorkspace = snapshot === undefined ? undefined : snapshot.byWorkspace;
      const entry = byWorkspace === undefined ? undefined : byWorkspace[path];
      return Array.isArray(entry) ? entry : [];
    }

    /**
     * 整块棋盘共用一份技能状态。
     *
     * 与 MCP 那块同构：`generation` 保证并发载入只有最新一次能写入结果；勾选走**乐观
     * 更新**（先动界面、写失败再回滚），否则每勾一下都要等一个远端往返。
     *
     * @param getService - 惰性解析远端命名空间的函数。
     * @returns 一个快照 store：`{ getSnapshot, subscribe, load, setSelection }`。
     */
    function createSkillStore(getService) {
      let snapshot = { status: 'idle', dir: '', skills: [], byWorkspace: {}, errors: [], error: null, reason: null };
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
          const library = await readLibrary(getService());
          if (current !== generation) return;
          if (!library.ok) {
            const notMounted = library.reason === 'notMounted';
            publish({
              ...snapshot,
              status: notMounted ? 'unavailable' : 'error',
              error: notMounted ? null : library.reason,
              reason: library.reason,
            });
            return;
          }
          const value = library.library === undefined || library.library === null ? {} : library.library;
          const skills = Array.isArray(value.skills) ? value.skills : [];
          const byWorkspace = value.byWorkspace !== null && typeof value.byWorkspace === 'object' ? value.byWorkspace : {};
          publish({
            status: skills.length === 0 ? 'empty' : 'ready',
            dir: typeof value.dir === 'string' ? value.dir : '',
            skills,
            byWorkspace,
            errors: Array.isArray(value.errors) ? value.errors : [],
            error: null,
            reason: null,
          });
        },
        /**
         * 切换某个工作区里一个技能的勾选状态。
         * @param path - 工作区绝对路径。
         * @param selected - 切换后的完整勾选列表。
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

    /**
     * 造「技能勾选列表」组件。
     *
     * 为什么不像 MCP 那样直接吐一串 `MenuItem`：技能必须能看出描述。`MenuItem` 的
     * 右侧 `hint` 位很窄，塞一句描述会挤成一团，所以这里自己排两行（名字 + 描述），
     * 勾选框沿用菜单那套 `CheckGlyph`，视觉上与隔壁 MCP 的勾选行是同一个东西。
     *
     * @param deps.css - class 名对照表。
     * @param deps.cx - class 名拼接工具。
     * @param deps.menu - 菜单零件（取 `CheckGlyph`）。
     * @returns 组件 `SkillControl`。
     */
    function createSkillControl({ css, cx, menu }) {
      const { CheckGlyph, Popover, SkillGlyph } = menu;

      /**
       * 弹层内容：说明 + 状态 + 勾选行。
       *
       * props：
       *   - workspacePath：当前窗格所属工作区的绝对路径；
       *   - skills / byWorkspace / status / error：store 快照切片；
       *   - dir：技能目录（用于说明与空状态文案）；
       *   - fileErrors：写坏的文件；
       *   - onToggle(selected)：勾选变化时回调。
       */
      function SkillControl(props) {
        const { workspacePath, skills, byWorkspace, status, error, dir, fileErrors, onToggle, t } = props;
        const selected = workspacePath === undefined || byWorkspace === undefined || byWorkspace === null
          ? []
          : (Array.isArray(byWorkspace[workspacePath]) ? byWorkspace[workspacePath] : []);
        const note = (text, key) => h('div', { key, className: css.menuNote }, text);
        const rows = [];
        rows.push(note(t('pane.skillNote'), 'note'));
        if (dir !== undefined && dir !== '') {
          rows.push(note(t('pane.skillDir') + '：' + dir, 'dir'));
        }
        if (status === 'error' && error !== null && error !== undefined) {
          rows.push(note(t('pane.skillFailed') + ': ' + error, 'err'));
        }
        if (status === 'unavailable') {
          rows.push(note(t('pane.skillUnavailable'), 'unavailable'));
        }
        if (status === 'empty' || (status === 'ready' && skills.length === 0)) {
          rows.push(note(t('pane.skillEmpty'), 'empty'));
        }
        if (workspacePath === undefined) {
          rows.push(note(t('pane.skillNoWorkspace'), 'noWorkspace'));
        }
        for (const skill of skills) {
          const on = selected.includes(skill.name);
          rows.push(h('button', {
            key: 'skill:' + skill.name,
            type: 'button',
            role: 'menuitemcheckbox',
            'aria-checked': on,
            className: cx(css.skillRow, on && css.skillRowOn),
            onClick: () => {
              if (workspacePath === undefined) return;
              const next = on
                ? selected.filter((name) => name !== skill.name)
                : [...selected, skill.name];
              onToggle(workspacePath, next);
            },
          },
            h('span', { className: css.menuItemCheck, 'aria-hidden': true }, on ? CheckGlyph() : null),
            h('span', { className: css.skillText },
              h('span', { className: css.skillName }, skill.name),
              h('span', { className: css.skillDesc }, String(skill.description ?? '')),
            ),
          ));
        }
        if (Array.isArray(fileErrors) && fileErrors.length > 0) {
          rows.push(note(t('pane.skillFileErrors').replace('{n}', String(fileErrors.length)), 'fileErrors'));
          for (const [index, entry] of fileErrors.slice(0, 5).entries()) {
            rows.push(note(String(entry.path) + ' —— ' + String(entry.message), 'fileError:' + index));
          }
        }
        return rows;
      }

      /**
       * 标题栏上的**整个 SKILL 开关**（图标按钮 + 弹层）。
       *
       * 放在本块而不是 `client.pane.js` 里，有两个原因：
       *   1. 窗格块本来就过长了，弹层的内容与状态都在本块，逻辑应当待在一起；
       *   2. 纯图标 + 悬停提示里带已选数量的写法只此一处，窗格那边只留一行调用。
       *
       * @param props - `{ workspacePath, skills, byWorkspace, status, error, dir, fileErrors, t, onToggle, onReload }`。
       * @returns 一个 `Popover` 元素。
       */
      function skillPopover(props) {
        const { workspacePath, skills, byWorkspace, status, error, dir, fileErrors, t, onToggle, onReload } = props;
        const selected = workspacePath === undefined || byWorkspace === undefined || byWorkspace === null
          ? []
          : (Array.isArray(byWorkspace[workspacePath]) ? byWorkspace[workspacePath] : []);
        return h(Popover, {
          key: 'skill',
          /*
           * 纯图标：标题栏里已经排了「分屏 / 模式 / MCP / 会话」几个控件，再占一段文字就把
           * 窗格标题挤没了。已选数量放 `title`（悬停提示）里，不丢信息。
           */
          icon: h(SkillGlyph, null),
          title: selected.length === 0
            ? t('pane.skillHint')
            : t('pane.skillHint') + '（' + t('pane.skillSelected') + ' ' + selected.length + '）',
          align: 'end',
          onOpenChange: (next) => {
            /*
             * **每次打开都重读**，不像 MCP 那样只在状态不健康时才读。
             *
             * 理由是技能清单会在本插件看不见的地方变：
             *   - 用户刚在「设置 → 技能」里把目录换掉（设置页与棋盘是两个客户端模块，
             *     那边不会通知这里）；
             *   - 用户刚往目录里丢了一个新的 SKILL.md（磁盘变化没有事件）。
             * 这两种情况下，缓存里那份清单就是错的；而它**看起来完全正常**（状态是
             * ready），用户只会觉得"我明明放了技能，为什么不显示"，刷新页面才发现是缓存。
             *
             * 代价是一次本地 IPC + 一次目录扫描（宿主侧有一秒缓存），对一个用户主动
             * 点开的弹层来说可以忽略。用这个换「永远不显示过期清单」，值。
             */
            if (next === true) onReload();
          },
        }, () => [
          h(SkillControl, {
            key: 'skillControl',
            workspacePath,
            skills,
            byWorkspace,
            status,
            error,
            dir,
            fileErrors,
            t,
            onToggle,
          }),
        ]);
      }

      return { SkillControl, skillPopover };
    }

    return { SKILL_REMOTE_KEY, errorText, readLibrary, writeSelection, selectionOf, createSkillStore, createSkillControl };
  },
});
