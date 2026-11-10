/**
 * 离线契约测试：平铺窗格里的“会话视图”标签栏。
 *
 * 这块逻辑的价值全在边界上，所以断言围绕三类事实展开：
 *   1. 没装额外视图插件（0 个或只有 Chat）时，窗格必须与改造前完全一致：
 *      不出现标签栏，并且仍然把 `chat`（或什么都不传）交给平台；
 *   2. 装了 Git 之类的视图后，每格出现标签栏，点哪个就把哪个视图 id
 *      作为 `conversation.session` 的 owner prop 传下去；
 *   3. 视图注册表、语言变化时，清单和标签栏要跟着变；
 *      选中的视图消失时回落到 Chat，而不是留一个空白窗格；
 *   4. “轨迹”只在主对话提供，平铺窗格即使注册了它也固定不列。
 *
 * 用 `node test/views-contract.mjs` 单独运行。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReactStub, byClass, createStubContext, findAll, loadBundle, mount } from './harness.mjs';
import { check, report } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const mod = await loadBundle(join(here, '..', 'client.js'), { react: ReactStub });
const mods = await mod.test.chunks;
const { createViewTabs, createPaneBody } = mods.views;
const { css, cx } = mods.styles;

/** 造一条 `conversation.view` 注册项。 */
const entry = (id, label) => ({ options: { id, label } });

/**
 * 用给定注册项造一个视图清单源，并记录它订阅到的两个来源（注册表 / 语言），
 * 供“变化后要通知”这类断言主动触发。
 *
 * @param entries - 当前注册项数组（可以随测试替换）。
 */
function makeSource(entries) {
  const stub = createStubContext();
  const notifications = { slots: undefined, locale: undefined };
  stub.ctx.slots.entries = () => entries;
  stub.ctx.slots.subscribe = (_key, listener) => {
    notifications.slots = listener;
    return () => {};
  };
  stub.ctx.locale.subscribe = (listener) => {
    notifications.locale = listener;
    return () => {};
  };
  const viewTabs = createViewTabs(stub.ctx);
  return { stub, viewTabs, notifications };
}

/**
 * 挂载一个窗格主体，返回渲染树、最近一次 Factory 调用与手动重渲染入口。
 *
 * @param viewTabs - 视图清单源。
 * @param options.blank - 当前会话是否空白（未发第一条消息）。
 * @param options.openState - 会话打开状态；默认 ready。
 */
function mountPane(viewTabs, { blank = false, openState = 'ready' } = {}) {
  const PaneBody = createPaneBody({ css, cx, viewTabs });
  const factoryCalls = [];
  const props = {
    sessionId: 's1',
    t: (key) => (key === 'pane.views' ? '会话视图' : key),
    useSession: (selector) => selector({ openState, blank }),
    renderFactorySlot: (name, input, options) => {
      factoryCalls.push({ name, input, options });
      return { type: 'div', props: { 'data-factory': name }, children: [] };
    },
  };
  const instance = mount(PaneBody, props);
  return {
    instance,
    props,
    factoryCalls,
    lastFactoryCall: () => factoryCalls[factoryCalls.length - 1],
    /** 让清单源变化后再渲染一次，模拟父级重渲染。 */
    rerender: () => instance.render(),
  };
}

/** 渲染树里的视图标签按钮（标签栏之外的按钮不会出现在这个组件里）。 */
const tabButtons = (tree) => findAll(tree, (node) => node.type === 'button');
/** 渲染树里的标签栏容器。 */
const tabBar = (tree) => findAll(tree, byClass(css.paneViewTabs))[0];

/**
 * 调一次 Factory 的局部 `views` 组件，看它把哪个视图 id 交给平台。
 *
 * @param call - 最近一次 `renderFactorySlot` 的记录。
 * @returns `{ key, owner }`。
 */
function renderedSessionView(call) {
  return call.options.slots.views({
    renderSlot: (key, owner) => ({ key, owner }),
  });
}

// --- 1. 没有额外视图：必须与改造前一致 --------------------------------------------

{
  const { viewTabs } = makeSource([]);
  check('没有任何会话视图时清单为空', viewTabs.read().length === 0);
  const pane = mountPane(viewTabs);
  check('没有会话视图时不渲染标签栏', tabBar(pane.instance.tree) === undefined);
  check('没有会话视图时仍然渲染 conversation.content Factory', pane.lastFactoryCall().name === 'conversation.content' && pane.lastFactoryCall().input.variant === 'embedded');
  const submitted = renderedSessionView(pane.lastFactoryCall());
  check('没有会话视图时不强行指定视图，交给平台默认解析', submitted.key === 'conversation.session' && Object.keys(submitted.owner).length === 0, JSON.stringify(submitted));
}

{
  const { viewTabs } = makeSource([entry('chat', () => '对话')]);
  const pane = mountPane(viewTabs);
  check('只有 Chat 时不渲染标签栏', tabBar(pane.instance.tree) === undefined);
  const submitted = renderedSessionView(pane.lastFactoryCall());
  check('只有 Chat 时仍像改造前一样显式传 chat', submitted.key === 'conversation.session' && submitted.owner.view === 'chat', JSON.stringify(submitted));
}

// --- 2. Chat + Git：标签栏出现并真的切视图 ----------------------------------------

{
  const { viewTabs, notifications } = makeSource([
    entry('chat', () => '对话'),
    entry('git-panel', () => 'Git'),
  ]);
  check('清单只投影带 id 的注册项并保留槽位顺序', viewTabs.read().map((tab) => tab.id).join(',') === 'chat,git-panel');
  check('标签文案来自注册项自己的 label 函数', viewTabs.read()[1].label === 'Git');

  const pane = mountPane(viewTabs);
  const bar = tabBar(pane.instance.tree);
  check('有两个视图时出现标签栏', bar !== undefined && bar.props.role === 'tablist');
  check('标签栏有两个标签', tabButtons(pane.instance.tree).length === 2);
  check('默认选中对话', tabButtons(pane.instance.tree)[0].props['aria-selected'] === true && tabButtons(pane.instance.tree)[1].props['aria-selected'] === false);
  check('默认把 chat 交给平台', renderedSessionView(pane.lastFactoryCall()).owner.view === 'chat');

  const gitButton = tabButtons(pane.instance.tree)[1];
  check('第二个标签的文字是 Git', gitButton.children[0] === 'Git');
  gitButton.props.onClick();
  pane.instance.flush();
  check('点 Git 后把 git-panel 交给平台', renderedSessionView(pane.lastFactoryCall()).owner.view === 'git-panel', JSON.stringify(renderedSessionView(pane.lastFactoryCall())));
  check('点 Git 后标签栏选中态跟着走', tabButtons(pane.instance.tree)[1].props['aria-selected'] === true && tabButtons(pane.instance.tree)[0].props['aria-selected'] === false);

  tabButtons(pane.instance.tree)[0].props.onClick();
  pane.instance.flush();
  check('点回对话后把 chat 交给平台', renderedSessionView(pane.lastFactoryCall()).owner.view === 'chat');

  // 清单源的通知要能推进版本（useSyncExternalStore 靠它重渲染）。
  let notified = 0;
  const unsubscribe = viewTabs.subscribe(() => {
    notified += 1;
  });
  const before = viewTabs.getVersion();
  notifications.slots();
  check('视图注册表变化时推进版本并通知订阅者', viewTabs.getVersion() === before + 1 && notified === 1);
  notifications.locale();
  check('语言变化时也推进版本', viewTabs.getVersion() === before + 2);
  const beforeUnsubscribe = notified;
  unsubscribe();
  notifications.slots();
  check('退订后不再收到通知', notified === beforeUnsubscribe, 'notified=' + String(notified));
}

// --- 3. 空会话 / 会话加载中：不显示标签栏 ------------------------------------------

{
  const { viewTabs } = makeSource([entry('chat', () => '对话'), entry('git-panel', () => 'Git')]);
  const blankPane = mountPane(viewTabs, { blank: true });
  check('空白会话不显示标签栏', tabBar(blankPane.instance.tree) === undefined);
  check('空白会话仍把 chat 交给平台', renderedSessionView(blankPane.lastFactoryCall()).owner.view === 'chat');

  const loadingPane = mountPane(viewTabs, { openState: 'loading' });
  check('会话加载中不显示标签栏', tabBar(loadingPane.instance.tree) === undefined);
  check('会话加载中传 settling 阶段给 Factory', loadingPane.lastFactoryCall().input.phase === 'settling');
}

// --- 4. 视图消失后的回退 ----------------------------------------------------------

{
  let entries = [entry('chat', () => '对话'), entry('git-panel', () => 'Git')];
  const { viewTabs } = makeSource(entries);
  // 让 entries 的读取跟随可变数组。
  const source = {
    ...viewTabs,
    read: () => {
      const tabs = [];
      for (const item of entries) tabs.push({ id: item.options.id, label: item.options.label() });
      return tabs;
    },
  };
  const pane = mountPane(source);
  tabButtons(pane.instance.tree)[1].props.onClick();
  pane.instance.flush();
  check('先切到 Git', renderedSessionView(pane.lastFactoryCall()).owner.view === 'git-panel');

  entries = [entry('chat', () => '对话')];
  pane.rerender();
  check('Git 视图消失后回落到对话', renderedSessionView(pane.lastFactoryCall()).owner.view === 'chat');
  check('Git 消失后标签栏只剩对话（只有一个所以整条隐藏）', tabBar(pane.instance.tree) === undefined);
}

// --- 5. 轨迹固定不出现在平铺窗格 ------------------------------------------------

{
  const entries = [entry('chat', () => '对话'), entry('trajectory', () => '轨迹'), entry('git-panel', () => 'Git')];
  const { viewTabs } = makeSource(entries);
  check('平铺窗格不列出轨迹，只保留对话与 Git', viewTabs.read().map((tab) => tab.id).join(',') === 'chat,git-panel');

  // 只有“轨迹”作为额外视图时，窗格等价于只有 Chat：整条标签栏仍然隐藏。
  const onlyTrajectory = makeSource([entry('chat', () => '对话'), entry('trajectory', () => '轨迹')]);
  check('只有轨迹时标签栏仍然隐藏（清单里只剩对话）', onlyTrajectory.viewTabs.read().length === 1);
  const onlyTrajectoryPane = mountPane(onlyTrajectory.viewTabs);
  check('只有轨迹时窗格不渲染标签栏', tabBar(onlyTrajectoryPane.instance.tree) === undefined);
}

// --- 6. 坏标签函数与缺 id 的防御 ---------------------------------------------------

{
  const bad = entry('broken', () => {
    throw new Error('label failed');
  });
  const noLabel = entry('plain');
  const noId = { options: { label: '无 id' } };
  const { viewTabs } = makeSource([bad, noLabel, noId]);
  const tabs = viewTabs.read();
  check('标签函数抛错时回落到视图 id', tabs[0].id === 'broken' && tabs[0].label === 'broken');
  check('没有 label 时用视图 id 当标签', tabs[1].label === 'plain');
  check('没有 id 的注册项被忽略', tabs.length === 2);
}

report();
