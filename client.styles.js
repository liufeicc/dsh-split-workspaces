/**
 * 平铺面板的样式块。
 *
 * 这一块只提供两样东西，不含任何逻辑，因此可以被入口块与视图块共用：
 *   - `CSS`：整张样式表文本，由入口块插进 `<style>` 标签；
 *   - `css`：class 名对照表，避免在组件里写裸字符串；
 *   - `cx`：把若干 class 名拼成一个字符串的小工具。
 *
 * 所有颜色都取自主题 token（`--dsw-*`），因此浅色与深色主题下都成立。
 *
 * 加载方式：入口 `client.js` 通过 `require.async('./client.styles.js')` 取得本块，
 * 因此这里注册的 id 必须是「入口 id + 文件名」。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.styles.js',
  factory() {
    const CSS = [
      // 本面板的强调色变量：优先用主题的蓝色强调 token，取不到时退回同色系的静态蓝，
      // 绝不退回 --dsw-alias-brand-primary（它在深色主题里是近白的中性填充色，会白底白字）。
      '.dshSplitWs_root{--dshSplitWs-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-static-deepseek-500));box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dshSplitWs_head{flex:none;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:14px 20px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '[data-platform=darwin] .dshSplitWs_head{padding-top:calc(14px + var(--dsh-frame-top-clearance,0px))}',
      '.dshSplitWs_headMain{min-width:0}',
      '.dshSplitWs_title{margin:0;font-size:16px;font-weight:600;line-height:24px}',
      '.dshSplitWs_headActions{display:flex;align-items:center;gap:8px;flex:none}',
      '.dshSplitWs_headError{flex:none;display:flex;align-items:center;gap:8px;padding:6px 14px 6px 20px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dshSplitWs_headErrorText{flex:1;min-width:0;word-break:break-word}',
      '.dshSplitWs_board{flex:1;min-height:0;display:flex;padding:10px;overflow:auto}',
      '.dshSplitWs_boardEmpty{flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px;text-align:center;color:var(--dsw-alias-label-secondary)}',
      '.dshSplitWs_boardTree{display:flex;flex:1 1 0;min-width:0;min-height:0}',
      '.dshSplitWs_split{display:flex;flex:1 1 0;min-width:0;min-height:0}',
      '.dshSplitWs_splitRow{flex-direction:row}',
      '.dshSplitWs_splitCol{flex-direction:column}',
      '.dshSplitWs_splitChild{display:flex;flex-basis:0;min-width:0;min-height:0}',
      '.dshSplitWs_splitter{position:relative;flex:none;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;touch-action:none}',
      '.dshSplitWs_splitter[data-dir=row]{width:12px;cursor:col-resize}',
      '.dshSplitWs_splitter[data-dir=col]{height:12px;cursor:row-resize}',
      '.dshSplitWs_splitterLine{display:block;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background .12s ease,transform .12s ease}',
      '.dshSplitWs_splitter[data-dir=row] .dshSplitWs_splitterLine{width:4px;height:34px}',
      '.dshSplitWs_splitter[data-dir=col] .dshSplitWs_splitterLine{height:4px;width:34px}',
      '.dshSplitWs_splitter:hover .dshSplitWs_splitterLine,.dshSplitWs_splitter:focus-visible .dshSplitWs_splitterLine,.dshSplitWs_splitterActive .dshSplitWs_splitterLine{background:var(--dsw-alias-brand-primary);transform:scale(1.08)}',
      '.dshSplitWs_splitter:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      // 窗格本身永远是一圈细边框：焦点只用标题栏表达，不给整块窗格加高亮框。
      '.dshSplitWs_pane{flex:1 1 0;min-width:0;display:flex;flex-direction:column;min-height:0;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      // 标题栏是**拖动交换位置**的把手：光标是「抓住」，触摸拖动不被浏览器的滚动手势抢走。
      // 里面的文字不参与选择（见下面 wsName/wsPath 那条），否则拖动会顺手拖出一段选区。
      '.dshSplitWs_paneHead{flex:none;display:flex;align-items:center;gap:6px;padding:6px 6px 6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);cursor:grab;touch-action:none}',
      // 拖动交换位置的两个视觉状态，都只加在窗格自己身上（不动标题栏配色）：
      //   - 被搬动的那一格淡下去，表示「它正被拎着走」；
      //   - 松手会落在的那一格亮一圈强调色，让人在松手前就知道会换到哪儿。
      // 圈用**纯强调色**，不掺透明度：离线测试按 WCAG 的「非文字 3:1」逐主题算过 ——
      // 强调色对棋盘底色是 4.2:1（浅色）/ 5.4:1（深色）；掺到 45% 之后浅色主题下只剩
      // 1.6:1，白底上一圈淡蓝等于没画。
      '.dshSplitWs_pane[data-dragging=true]{opacity:.6}',
      '.dshSplitWs_pane[data-drop=true]{border-color:var(--dshSplitWs-accent);box-shadow:0 0 0 2px var(--dshSplitWs-accent)}',
      // 焦点窗格：整条标题栏是**蓝色渐变 + 白字**。
      //
      // 两个细节都是踩过坑之后定下来的：
      //   1. 底色必须用蓝色强调 token，不能用 --dsw-alias-brand-primary（深色主题里它是近白
      //      的中性填充色，配白字就是白底白字）；
      //   2. 渐变两端由强调色与静态黑 token 混出来，把蓝压深一些，白字在整条渐变上的
      //      对比度都稳在 4.5:1 以上（纯 #5686fe 配白字只有 3.3:1，偏糊）。
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_paneHead{border-bottom-color:transparent;background:linear-gradient(90deg,color-mix(in srgb,var(--dshSplitWs-accent) 62%,var(--dsw-static-neutral-1000)) 0%,color-mix(in srgb,var(--dshSplitWs-accent) 74%,var(--dsw-static-neutral-1000)) 55%,color-mix(in srgb,var(--dshSplitWs-accent) 84%,var(--dsw-static-neutral-1000)) 100%);color:var(--dsw-static-neutral-00)}',
      '.dshSplitWs_pane[data-dragging=true] .dshSplitWs_paneHead{cursor:grabbing}',
      // 标题栏上的文字（工作区名与路径）不参与选择：整条标题栏都是拖动把手，
      // 能选中就意味着「按住标题栏拖」会先拖出一段蓝色选区，看着像界面坏了。
      // 路径在侧边栏与「添加工作区」菜单里都能选中复制，不差标题栏这一处。
      '.dshSplitWs_paneHeading{flex:1;min-width:0;display:flex;flex-direction:column;gap:0;user-select:none}',
      '.dshSplitWs_wsName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;line-height:18px}',
      '.dshSplitWs_wsPath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      // 标题栏里的文字只继承标题栏的颜色（白），明细信息靠透明度拉开层次，
      // 不在这里写死颜色，所以以后改标题栏配色只需改上面那一条。
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_wsName{color:inherit}',
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_wsPath{color:inherit;opacity:.8}',
      '.dshSplitWs_paneBody{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}',
      // 窗格自己的会话视图标签栏。壳与内容都显式撑满：标签栏出现/消失时只有
      // 上方多一条固定高度的条，对话内容仍然吃到剩余高度，不会因为外层多包两层
      // div 就把高度算丢。没有额外视图插件时标签栏不渲染，壳本身只是透明布局层。
      '.dshSplitWs_paneViewShell{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.dshSplitWs_paneViewTabs{flex:none;display:flex;align-items:center;gap:18px;padding:0 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow-x:auto;overflow-y:hidden;scrollbar-width:none}',
      '.dshSplitWs_paneViewTabs::-webkit-scrollbar{display:none}',
      '.dshSplitWs_paneViewTab{flex:none;position:relative;padding:6px 0 8px;border:0;border-radius:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;font-weight:500;line-height:16px;white-space:nowrap;cursor:pointer}',
      '.dshSplitWs_paneViewTab:hover{color:var(--dsw-alias-label-primary)}',
      // 选中态与主对话 header 的标签一致：底部一条 2px 的主题强调色。
      '.dshSplitWs_paneViewTab::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:transparent}',
      '.dshSplitWs_paneViewTabActive{color:var(--dsw-alias-state-business-primary)}',
      '.dshSplitWs_paneViewTabActive::after{background:var(--dsw-alias-state-business-primary)}',
      '.dshSplitWs_paneViewTab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-radius:4px}',
      '.dshSplitWs_paneViewContent{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.dshSplitWs_paneEmpty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dshSplitWs_paneError{flex:none;padding:6px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dshSplitWs_button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer}',
      '.dshSplitWs_button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dshSplitWs_button:disabled{opacity:.55;cursor:default}',
      '.dshSplitWs_button:focus-visible,.dshSplitWs_trigger:focus-visible,.dshSplitWs_iconButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshSplitWs_primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}',
      '.dshSplitWs_primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary)}',
      '.dshSplitWs_iconButton{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dshSplitWs_iconButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dshSplitWs_iconButton:disabled{opacity:.5;cursor:default}',
      '.dshSplitWs_iconButtonOpen{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      // 焦点标题栏上的按钮（图标按钮，以及下面同款的模式/会话下拉触发器）：文字与图标
      // 只继承标题栏的白，底色则一律**黑色压深**。
      //
      // 这里换过一次方向，原因值得留档：原先 hover/展开的底色是拿 `currentColor` 调淡 ——
      // 在焦点标题栏上 currentColor 就是白，于是「白 24% 压出来的浅灰蓝底」配白字实测只有
      // 3.5:1，看着就是一块灰底、字糊在上面。改成黑底后同一处白字分别是 11.2:1（hover）
      // 与 21:1（展开），而 hover（黑 50%，底仍透出一点蓝）与展开（纯黑，最实）也分得开。
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_iconButton{color:inherit;opacity:.9}',
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_iconButton:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-static-neutral-1000) 50%,transparent);color:inherit;opacity:1}',
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_iconButton:disabled{color:inherit;opacity:.45}',
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_iconButtonOpen{background:var(--dsw-static-neutral-1000);color:inherit;opacity:1}',
      '.dshSplitWs_popover{position:relative;display:inline-flex}',
      '.dshSplitWs_trigger{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:26px;padding:0 8px;border:.5px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}',
      '.dshSplitWs_trigger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dshSplitWs_trigger:disabled{opacity:.5;cursor:default}',
      '.dshSplitWs_triggerOpen{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dshSplitWs_triggerLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 焦点标题栏里的模式/会话触发器：同样只继承标题栏颜色（黑底白字，见上面那段说明），
      // 键盘焦点圈也改成 currentColor 才看得见。
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_trigger{color:inherit;opacity:.9}',
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_trigger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-static-neutral-1000) 50%,transparent);color:inherit;opacity:1}',
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_triggerOpen{border-color:transparent;background:var(--dsw-static-neutral-1000);color:inherit;opacity:1}',
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_trigger:disabled{color:inherit;opacity:.45}',
      '.dshSplitWs_pane[data-active=true] .dshSplitWs_trigger:focus-visible,.dshSplitWs_pane[data-active=true] .dshSplitWs_iconButton:focus-visible{outline-color:currentColor}',
      // 弹出菜单的**面板底色**：用「抬升表面」那支 token（深色主题 #2c2c2e / 浅色主题 #fff），
      // 不用 --dsw-alias-bg-overlay —— 它在深色主题里是 #61666b 的中灰，白字压上去糊成一片，
      // 次要文字（「当前」「当前会话已开始…」）更是只有 3.3:1，用户反馈就是「灰得看不清字」。
      /*
       * 弹出菜单 portal 到 body 后用 fixed 定位，由 client.menu.js 按触发器位置计算
       * top/left；这里只留「不超出视口」的兜底尺寸。原来的 absolute + 窗格
       * `overflow:hidden` 会在窄窗格里把菜单裁掉。
       */
      '.dshSplitWs_popoverList{position:fixed;top:0;left:0;z-index:1000;min-width:min(240px,calc(100vw - 16px));max-width:min(420px,calc(100vw - 16px));max-height:min(340px,calc(100vh - 16px));overflow-y:auto;padding:4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 32px rgba(0,0,0,.28)}',
      '.dshSplitWs_menuItem{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer}',
      // 菜单项 hover：底色不能再用 bg-layer-2（那正是面板自己的底色，压上去等于没反应），
      // 改成拿 currentColor 调淡 —— 深色主题下是白字提亮、浅色主题下是黑字压暗，两种主题都看得见。
      '.dshSplitWs_menuItem:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
      '.dshSplitWs_menuItemActive{color:var(--dsw-alias-brand-primary)}',
      '.dshSplitWs_menuItemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshSplitWs_menuItemHint{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshSplitWs_menuItemCheck{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary)}',
      // 「一行两件事」的菜单行（会话列表：左边切过去、右边删掉它）。
      // 行容器只负责并排；`menuItem` 在行里改成「吃掉剩余宽度」，否则它自带的
      // width:100% 会把删除按钮挤出可视区。
      '.dshSplitWs_menuRow{display:flex;align-items:center;gap:2px}',
      '.dshSplitWs_menuRow .dshSplitWs_menuItem{flex:1 1 auto;width:auto;min-width:0}',
      // 删除按钮：平时是次要文字色（不抢会话名），悬停才亮成错误色 —— 破坏性动作的
      // 颜色要在「准备按下去」时出现，而不是让一整列红图标把菜单变成警告牌。
      // 底色与 menuItem 同一套算法（currentColor 调淡），两种主题都看得见。
      '.dshSplitWs_menuDelete{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dshSplitWs_menuDelete:hover{background:color-mix(in srgb,currentColor 8%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dshSplitWs_menuDelete:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshSplitWs_menuNote{padding:7px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      // 技能勾选行：比普通菜单行高一点，因为要排两行（名字 + 描述）。
      // 勾选位复用 menuItemCheck，所以和 MCP 那几行看起来是同一套多选控件。
      '.dshSplitWs_skillRow{display:flex;align-items:flex-start;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}',
      '.dshSplitWs_skillRow:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
      '.dshSplitWs_skillRow:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.dshSplitWs_skillRow .dshSplitWs_menuItemCheck{margin-top:2px}',
      '.dshSplitWs_skillText{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.dshSplitWs_skillName{font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshSplitWs_skillDesc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.dshSplitWs_glyph{display:block}',
      // ── 顶部模式切换（平铺 / 设计）──
      // 两个互斥选项的段控件。选中项用强调色底 + 白字，未选中是透明的次要文字。
      // 底色用 --dshSplitWs-accent（见文件头），不用 --dsw-alias-brand-primary ——
      // 后者在深色主题里是近白填充色，配白字会白底白字。
      '.dshSplitWs_modes{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.dshSplitWs_mode{padding:4px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.dshSplitWs_mode:hover{color:var(--dsw-alias-label-primary)}',
      '.dshSplitWs_mode[aria-pressed=true]{background:var(--dshSplitWs-accent);color:var(--dsw-static-neutral-00)}',
      '.dshSplitWs_mode:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      // ── 设计模式：委派图 ──
      // 画布左下角的一行自诊断：构建标记 / 关系数 / 会话数 / 同步状态。
      '.dshSplitWs_graphDiagnostic{position:sticky;left:0;bottom:0;display:inline-block;margin:6px 0 0 4px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}',
      '.dshSplitWs_graphWrap{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.dshSplitWs_graphBar{flex:none;display:flex;align-items:center;gap:12px;padding:8px 20px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dshSplitWs_graphHint{flex:1;min-width:0}',
      '.dshSplitWs_graphReject{flex:none;color:var(--dsw-alias-state-error-primary)}',
      '.dshSplitWs_graphDegraded{flex:none;color:var(--dsw-alias-state-warning-primary,#b8860b)}',
      '.dshSplitWs_graphScroll{flex:1;min-height:0;overflow:auto;padding:10px}',
      '.dshSplitWs_graphCanvas{position:relative;min-width:100%;min-height:100%}',
      // SVG 层是纯装饰（不接收指针），所以整块 `pointer-events:none`；唯一例外是每条边
      // 中点那个删除按钮 —— 它要能点，单独把指针事件打开。
      '.dshSplitWs_graphSvg{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}',
      '.dshSplitWs_graphEdge{stroke:var(--dsw-alias-border-l2);stroke-width:1.6;stroke-linecap:round}',
      '.dshSplitWs_graphEdgePending{stroke:var(--dshSplitWs-accent);stroke-dasharray:5 4}',
      '.dshSplitWs_graphArrow{fill:var(--dsw-alias-label-secondary)}',
      '.dshSplitWs_graphEdgeEdit{pointer-events:auto;cursor:pointer}',
      '.dshSplitWs_graphEdgeEdit circle:first-child{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l2);stroke-width:1}',
      '.dshSplitWs_graphEdgeEdit circle:not(:first-child){fill:var(--dsw-alias-label-secondary)}',
      '.dshSplitWs_graphEdgeEdit:hover circle:first-child{fill:var(--dshSplitWs-accent);stroke:var(--dshSplitWs-accent)}',
      '.dshSplitWs_graphEdgeEdit:hover circle:not(:first-child){fill:var(--dsw-static-neutral-00)}',
      // 箭头上的说明标签：只是说明，不接收指针（点击要落到箭头或卡片上）。
      '.dshSplitWs_graphEdgeNote{position:absolute;transform:translate(-50%,-50%);max-width:220px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}',
      // 说明编辑面板：位置就是那条边中点，用户不会搞不清在改哪一条。
      '.dshSplitWs_graphEdgeEditor{position:absolute;transform:translate(-50%,8px);width:280px;display:flex;flex-direction:column;gap:6px;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.24);z-index:2}',
      '.dshSplitWs_graphEdgeEditorTitle{font-size:12.5px;line-height:18px;font-weight:550}',
      '.dshSplitWs_graphEdgeEditorHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dshSplitWs_graphEdgeEditorInput{width:100%;min-height:64px;resize:vertical;box-sizing:border-box;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}',
      '.dshSplitWs_graphEdgeEditorInput:focus-visible{outline:2px solid var(--dshSplitWs-accent);outline-offset:1px}',
      '.dshSplitWs_graphEdgeEditorActions{display:flex;align-items:center;gap:6px}',
      '.dshSplitWs_graphEdgeEditorActions .dshSplitWs_button{flex:1 1 auto;width:auto;min-width:0}',
      '.dshSplitWs_graphEdgeDelete{pointer-events:auto;cursor:pointer}',
      '.dshSplitWs_graphEdgeDelete circle{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l2);stroke-width:1}',
      '.dshSplitWs_graphEdgeDelete path{stroke:var(--dsw-alias-label-secondary);stroke-width:1.4;stroke-linecap:round}',
      '.dshSplitWs_graphEdgeDelete:hover circle{fill:var(--dsw-alias-state-error-primary);stroke:var(--dsw-alias-state-error-primary)}',
      '.dshSplitWs_graphEdgeDelete:hover path{stroke:var(--dsw-static-neutral-00)}',
      '.dshSplitWs_graphCard{position:absolute;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;overflow:hidden}',
      '.dshSplitWs_graphCard:hover{border-color:var(--dshSplitWs-accent)}',
      '.dshSplitWs_graphCard[data-running=true]{border-color:var(--dshSplitWs-accent)}',
      '.dshSplitWs_graphCardEmpty{cursor:default;opacity:.62}',
      '.dshSplitWs_graphCardEmpty:hover{border-color:var(--dsw-alias-border-l1)}',
      '.dshSplitWs_graphCardWorkspace{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshSplitWs_graphCardTitle{font-size:13px;line-height:19px;font-weight:550;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.dshSplitWs_graphCardMeta{display:flex;align-items:center;gap:6px;margin-top:auto;font-size:11px;line-height:16px}',
      '.dshSplitWs_graphCardRunning{color:var(--dshSplitWs-accent)}',
      // 出线端口：右边缘中点上那个圆点，拖动起点。命中区比看上去大（14px），
      // 因为 6px 的圆在触控板上很难一次按准。
      '.dshSplitWs_graphPort{position:absolute;right:-7px;top:50%;transform:translateY(-50%);width:14px;height:14px;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:50%;background:var(--dsw-alias-bg-base);cursor:crosshair;touch-action:none}',
      '.dshSplitWs_graphCard:hover .dshSplitWs_graphPort{border-color:var(--dshSplitWs-accent);background:var(--dshSplitWs-accent)}',
      '.dshSplitWs_graphPort:focus-visible{outline:2px solid var(--dshSplitWs-accent);outline-offset:1px}',
      '.dshSplitWs_graphEmpty{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}',
    ].join('');

    /** class 名对照表：组件里统一用这里的名字，避免散落的裸字符串。 */
    const css = {
      root: 'dshSplitWs_root',
      head: 'dshSplitWs_head',
      headMain: 'dshSplitWs_headMain',
      title: 'dshSplitWs_title',
      headActions: 'dshSplitWs_headActions',
      headError: 'dshSplitWs_headError',
      headErrorText: 'dshSplitWs_headErrorText',
      board: 'dshSplitWs_board',
      boardEmpty: 'dshSplitWs_boardEmpty',
      boardTree: 'dshSplitWs_boardTree',
      split: 'dshSplitWs_split',
      splitRow: 'dshSplitWs_splitRow',
      splitCol: 'dshSplitWs_splitCol',
      splitChild: 'dshSplitWs_splitChild',
      splitter: 'dshSplitWs_splitter',
      splitterLine: 'dshSplitWs_splitterLine',
      splitterActive: 'dshSplitWs_splitterActive',
      pane: 'dshSplitWs_pane',
      paneHead: 'dshSplitWs_paneHead',
      paneHeading: 'dshSplitWs_paneHeading',
      wsName: 'dshSplitWs_wsName',
      wsPath: 'dshSplitWs_wsPath',
      paneBody: 'dshSplitWs_paneBody',
      paneViewShell: 'dshSplitWs_paneViewShell',
      paneViewTabs: 'dshSplitWs_paneViewTabs',
      paneViewTab: 'dshSplitWs_paneViewTab',
      paneViewTabActive: 'dshSplitWs_paneViewTabActive',
      paneViewContent: 'dshSplitWs_paneViewContent',
      paneEmpty: 'dshSplitWs_paneEmpty',
      paneError: 'dshSplitWs_paneError',
      button: 'dshSplitWs_button',
      primary: 'dshSplitWs_primary',
      iconButton: 'dshSplitWs_iconButton',
      iconButtonOpen: 'dshSplitWs_iconButtonOpen',
      popover: 'dshSplitWs_popover',
      trigger: 'dshSplitWs_trigger',
      triggerOpen: 'dshSplitWs_triggerOpen',
      triggerLabel: 'dshSplitWs_triggerLabel',
      popoverList: 'dshSplitWs_popoverList',
      menuItem: 'dshSplitWs_menuItem',
      menuItemActive: 'dshSplitWs_menuItemActive',
      menuItemLabel: 'dshSplitWs_menuItemLabel',
      menuItemHint: 'dshSplitWs_menuItemHint',
      menuItemCheck: 'dshSplitWs_menuItemCheck',
      menuRow: 'dshSplitWs_menuRow',
      menuDelete: 'dshSplitWs_menuDelete',
      menuNote: 'dshSplitWs_menuNote',
      skillRow: 'dshSplitWs_skillRow',
      skillRowOn: 'dshSplitWs_skillRowOn',
      skillText: 'dshSplitWs_skillText',
      skillName: 'dshSplitWs_skillName',
      skillDesc: 'dshSplitWs_skillDesc',
      glyph: 'dshSplitWs_glyph',
      modes: 'dshSplitWs_modes',
      mode: 'dshSplitWs_mode',
      graphWrap: 'dshSplitWs_graphWrap',
      graphBar: 'dshSplitWs_graphBar',
      graphHint: 'dshSplitWs_graphHint',
      graphReject: 'dshSplitWs_graphReject',
      graphDegraded: 'dshSplitWs_graphDegraded',
      graphScroll: 'dshSplitWs_graphScroll',
      graphCanvas: 'dshSplitWs_graphCanvas',
      graphSvg: 'dshSplitWs_graphSvg',
      graphEdge: 'dshSplitWs_graphEdge',
      graphEdgePending: 'dshSplitWs_graphEdgePending',
      graphArrow: 'dshSplitWs_graphArrow',
      graphDiagnostic: 'dshSplitWs_graphDiagnostic',
      graphEdgeEdit: 'dshSplitWs_graphEdgeEdit',
      graphEdgeNote: 'dshSplitWs_graphEdgeNote',
      graphEdgeEditor: 'dshSplitWs_graphEdgeEditor',
      graphEdgeEditorTitle: 'dshSplitWs_graphEdgeEditorTitle',
      graphEdgeEditorHint: 'dshSplitWs_graphEdgeEditorHint',
      graphEdgeEditorInput: 'dshSplitWs_graphEdgeEditorInput',
      graphEdgeEditorActions: 'dshSplitWs_graphEdgeEditorActions',
      graphEdgeDelete: 'dshSplitWs_graphEdgeDelete',
      graphCard: 'dshSplitWs_graphCard',
      graphCardEmpty: 'dshSplitWs_graphCardEmpty',
      graphCardWorkspace: 'dshSplitWs_graphCardWorkspace',
      graphCardTitle: 'dshSplitWs_graphCardTitle',
      graphCardMeta: 'dshSplitWs_graphCardMeta',
      graphCardRunning: 'dshSplitWs_graphCardRunning',
      graphPort: 'dshSplitWs_graphPort',
      graphEmpty: 'dshSplitWs_graphEmpty',
    };

    /** 把若干 class 名拼成一个字符串，自动丢掉空值。 */
    function cx(...values) {
      return values.filter(Boolean).join(' ');
    }

    return { CSS, css, cx };
  },
});
