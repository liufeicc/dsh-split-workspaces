/**
 * 平铺面板的「会话视图」块：每个窗格自己的视图标签栏。
 *
 * 背景：窗格里的对话本体复用共享的 `conversation.content` Factory，而 Git 面板等
 * 插件注册的是 `conversation.view` 子槽位（主对话 header 里的“对话 / 轨迹 / Git”
 * 那排标签）。平铺窗格不渲染主对话 header，于是这些视图在窗格里根本没有入口。
 *
 * 本块只做两件事，且都不复制任何插件自己的界面：
 *   1. 从 `conversation.view` 槽位读出当前已注册的视图清单（id + 标签），包装成
 *      一个可订阅的小数据源；注册表、语言或“开发者工具”开关变化时通知窗格重渲染；
 *   2. 生成窗格主体：在 Factory 内容上方加一条标签栏，把用户选中的视图 id 作为
 *      owner prop 传给 `conversation.session`（平台的默认视图区正是读这个 prop）。
 *
 * 关键的零影响约束：没装额外视图插件时，槽位里只有 Chat 一个视图（甚至一个都没有）。
 * 这时本块不渲染标签栏，并且仍然把 `chat`（或什么都不传）交给平台 —— 与改造前
 * 写死 Chat 的行为完全一致，平铺面板不会因为“没装 Git 插件”而变样。
 *
 * 加载方式：入口 `client.js` 通过 `require.async('./client.views.js')` 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.views.js',
  factory(require) {
    const React = require('react');
    const { useMemo, useState, useSyncExternalStore } = React;
    const h = React.createElement;

    /**
     * 解析槽位注册项上的 `label`。
     *
     * 平台自己的解析规则就是“函数就调用一次、否则原样返回”（见
     * `@deepseek-ai/dsh-client-ui-slots` 的 `resolveSlotLabel`）。这里不 require 那个
     * 模块，只复刻这一行行为：少一个运行时依赖，插件在精简客户端里也能加载。
     * 标签函数抛错或返回空值时回落到视图 id —— 标签栏上宁可见到一个 id，也不能
     * 因为某个第三方视图的文案函数坏了就让整条标签栏消失。
     *
     * @param entry - `conversation.view` 的已注册项（`{ options }`）。
     * @returns 可显示的文字。
     */
    function labelOf(entry) {
      const id = entry.options.id;
      const label = entry.options.label;
      try {
        const value = typeof label === 'function' ? label() : label;
        return typeof value === 'string' && value !== '' ? value : id;
      } catch {
        return id;
      }
    }

    /**
     * 建一个“当前有哪些会话视图”的小数据源。
     *
     * 为什么不用 React state 存在某个组件里：视图清单是全局注册表的事实，任何窗格
     * 都可能同时需要它；做成 source 后，每个窗格各自订阅、各自重渲染，注册表变化
     * 时不会互相牵动。`getVersion()` 返回单调递增的整数，正好满足
     * `useSyncExternalStore` 对“快照必须可比较”的要求；真正的清单由 `read()` 现算，
     * 因为标签文案可能随语言变化。
     *
     * @param ctx - 插件上下文（需要 `slots` / `locale`，`configForms` 可选）。
     * @returns `{ subscribe, getVersion, read }`。
     */
    function createViewTabs(ctx) {
      let version = 0;
      const listeners = new Set();
      const bump = () => {
        version += 1;
        // 复制一份再遍历：订阅者在通知里退订时不能影响这一轮通知。
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            /* 某个窗格的重渲染出错不该拖垮其它窗格 */
          }
        }
      };
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      const getVersion = () => version;

      /**
       * 开发者工具开关：平台主对话用它决定是否显示“轨迹”视图。
       *
       * 可能拿不到这个服务（精简客户端 / 测试替身），拿不到时按 platform 的默认值
       * `false` 处理，也就是不显示轨迹。这个判断每次读清单时现算，不缓存，避免
       * 用户刚在设置里打开开关、标签栏却还按旧值渲染。
       */
      const developerToolsEnabled = () => {
        const service = ctx.get('configForms');
        const enabled = service?.developerTools?.enabled;
        return enabled?.getSnapshot?.() === true;
      };

      /** 现算当前可显示的视图清单，顺序沿用槽位注册表自己的顺序。 */
      const read = () => {
        const showTrajectory = developerToolsEnabled();
        const tabs = [];
        for (const entry of ctx.slots.entries('conversation.view')) {
          const id = entry.options?.id;
          // 平台只投影带 id 的注册项；没有 id 的条目无法被 `only` 选中。
          if (id === undefined) continue;
          // 与平台主对话 header 的过滤规则保持一致：未开启开发者工具时不显示轨迹。
          if (!showTrajectory && id === 'trajectory') continue;
          tabs.push({ id, label: labelOf(entry) });
        }
        return tabs;
      };

      /*
       * 订阅三个会改变清单外观的来源：
       *   - 视图注册表：装/卸插件时增删标签；
       *   - 语言：标签函数返回的文案会变；
       *   - 开发者工具开关（可选）：决定轨迹标签是否出现。
       *
       * 全部挂在本插件自己的 effect 生命周期里，插件卸载时一次清干净。
       */
      const disposers = [];
      if (typeof ctx.slots.subscribe === 'function') {
        disposers.push(ctx.slots.subscribe('conversation.view', bump));
      }
      if (typeof ctx.locale?.subscribe === 'function') {
        disposers.push(ctx.locale.subscribe(bump));
      }
      if (typeof ctx.inject === 'function') {
        const disposeInject = ctx.inject(['configForms'], (scope) => {
          scope.effect(() => {
            const enabled = scope.get('configForms')?.developerTools?.enabled;
            return enabled === undefined ? undefined : enabled.subscribe(bump);
          }, 'split-workspaces: developer-tools view tabs');
        });
        if (typeof disposeInject === 'function') disposers.push(disposeInject);
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch {
            /* 卸载阶段服务可能已经先走，清理失败不需要再把插件拖垮 */
          }
        }
        listeners.clear();
      }, 'split-workspaces: view tabs');

      return { subscribe, getVersion, read };
    }

    /**
     * 生成窗格主体组件。
     *
     * @param deps.css - class 名对照表。
     * @param deps.cx - class 名拼接工具。
     * @param deps.viewTabs - `createViewTabs` 的返回值。
     * @returns 注册到 `split-workspaces.pane` 的 React 组件。
     */
    function createPaneBody({ css, cx, viewTabs }) {
      /**
       * 建一个只负责“把当前选中的视图 id 传给平台会话区”的局部视图组件。
       *
       * 为什么每次选中变化都生成一个新组件：平台 Factory 的 `views` 局部槽位是
       * 一个组件类型，选中视图是它闭包里的常量；换视图换组件类型，平台会重新
       * 挂载视图区，正好让 Git 面板按自己的生命周期初始化。它不复制 Git 面板，
       * 只把 `view` 这个 owner prop 递给 `conversation.session`。
       *
       * @param activeId - 当前选中的视图 id，`null` 表示交给平台默认解析。
       */
      function makeViews(activeId) {
        function PaneConversationViews(props) {
          return props.renderSlot('conversation.session', activeId === null ? {} : { view: activeId });
        }
        PaneConversationViews.displayName = 'PaneConversationViews';
        return PaneConversationViews;
      }

      /**
       * 窗格主体。
       *
       * 标签栏只在“有会话、会话不空白、至少两个视图”时出现；其余情况只是把
       * 原来的 Factory 内容包在一个布局壳里，壳本身不改变任何视觉。
       */
      function PaneBody(props) {
        // 订阅视图清单：注册表 / 语言 / 开发者工具变化时本组件重渲染。
        useSyncExternalStore(viewTabs.subscribe, viewTabs.getVersion, viewTabs.getVersion);
        const tabs = viewTabs.read();
        const [selectedId, setSelectedId] = useState(null);
        /*
         * 选中的视图可能刚刚被卸载（例如 Git 插件被停用），也可能初始时还没拿到清单。
         * 回退顺序与平台一致：用户选过的 → Chat → 第一个可用视图 → 交给平台默认。
         */
        const active = tabs.find((tab) => tab.id === selectedId)
          ?? tabs.find((tab) => tab.id === 'chat')
          ?? tabs[0]
          ?? null;
        const activeId = active === null ? null : active.id;
        const views = useMemo(() => makeViews(activeId), [activeId]);
        const factoryOptions = useMemo(() => ({ slots: { views } }), [views]);
        const session = props.useSession((value) => value);
        const settling = session === undefined || session.openState === 'loading';
        /*
         * 空白会话不显示标签栏：与主对话 header 的规则一致（第一条消息发出前
         * 只有 Hero 和输入框，没有视图标签）。会话一开始，标签栏自动出现。
         */
        const showTabs = !settling && session?.blank !== true && tabs.length > 1;
        const content = h('div', { className: css.paneViewContent },
          props.renderFactorySlot('conversation.content', {
            variant: 'embedded',
            phase: settling ? 'settling' : 'active',
            hero: false,
          }, factoryOptions));
        return h('div', { className: css.paneViewShell },
          showTabs
            ? h('div', {
                className: css.paneViewTabs,
                role: 'tablist',
                'aria-label': props.t('pane.views'),
              }, tabs.map((tab) => h('button', {
                key: tab.id,
                type: 'button',
                role: 'tab',
                'aria-selected': tab.id === activeId,
                className: cx(css.paneViewTab, tab.id === activeId && css.paneViewTabActive),
                onClick: () => setSelectedId(tab.id),
              }, tab.label)))
            : null,
          content);
      }
      PaneBody.displayName = 'PaneBody';
      return PaneBody;
    }

    return { createViewTabs, createPaneBody };
  },
});
