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
      /*
       * 所有会话正文（主界面与平铺面板）自带「站酷快乐体」。
       *
       * 字体由 Host 半边的 /split-workspaces-fonts 前缀路由提供（入口 `index.js` 的
       * `registerFontRoutes`）—— 客户端代码块路由只服务 client.*.js，字体文件不是
       * 代码块，所以单独挂一条。字体加载失败时下面的 font-family 会自然退回系统
       * 黑体，不影响任何文字出现。
       *
       * 两个 @font-face 用 unicode-range 分工：中文与全角标点走简体中文子集，
       * 拉丁字母、数字与半角标点走 5KB 的拉丁子集。这样英文/代码里的数字不会被
       * 中文字体里那套更「圆」的拉丁字形拖慢辨识。
       */
      "@font-face{font-family:'SplitWorkspaceKuaile';font-style:normal;font-weight:400;font-display:swap;src:url('/split-workspaces-fonts/zcool-kuaile-chinese-simplified.woff2?v=1') format('woff2');unicode-range:U+2E80-2EFF,U+3000-303F,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FE30-FE4F,U+FF00-FFEF,U+20000-2FA1F;}",
      "@font-face{font-family:'SplitWorkspaceKuaile';font-style:normal;font-weight:400;font-display:swap;src:url('/split-workspaces-fonts/zcool-kuaile-latin.woff2?v=1') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}",
      /*
       * 工作站点的字体只用在平铺面板的标题、按钮、菜单上（见下面的 .dshSplitWs_root
       * 与 .dshSplitWs_popoverList）。**会话正文保持系统原字体**：正文里已经有一层
       * 独立于面板的字体规则，强行覆盖会把代码块里的中英文混排弄乱，因此不在
       * [data-conversation-content] 上做任何字体设置。
       */
      // 本面板的强调色变量：优先用主题的蓝色强调 token，取不到时退回同色系的静态蓝，
      // 绝不退回 --dsw-alias-brand-primary（它在深色主题里是近白的中性填充色，会白底白字）。
      // 平铺面板的标题、按钮、菜单也用这套字体；会话正文由上面那条全局规则统一负责。
      '.dshSplitWs_root{--dshSplitWs-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-static-deepseek-500));--dsw-font-family:"SplitWorkspaceKuaile","ZCOOL KuaiLe","Noto Sans CJK SC","Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;box-sizing:border-box;position:relative;display:flex;flex-direction:column;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}',
      // 任务分派浮窗：绝对定位在面板内，拖动条负责移动，PaneFrame 负责全部会话交互。
      '.dshSplitWs_floatingPane{position:absolute;display:flex;flex-direction:column;border:1px solid rgba(94,231,255,.35);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#0b1422);box-shadow:0 24px 60px rgba(0,0,0,.55),0 0 0 1px rgba(94,231,255,.08);overflow:hidden}',
      // 最上层浮窗：很淡的香槟金细边框，不加外发光，避免抢对话内容的注意力。
      '.dshSplitWs_floatingPaneActive{border-color:rgba(214,197,155,.55);box-shadow:0 0 0 1px rgba(214,197,155,.12),0 24px 60px rgba(0,0,0,.55)}',
      '.dshSplitWs_floatingPaneActive .dshSplitWs_floatingBar{background:linear-gradient(90deg,rgba(214,197,155,.06),rgba(167,139,250,.06));border-bottom-color:rgba(214,197,155,.16)}',
      '.dshSplitWs_floatingPaneActive .dshSplitWs_floatingTitle{color:#e3d8bf}',
      '.dshSplitWs_floatingBar{flex:none;display:flex;align-items:center;gap:8px;height:26px;padding:0 14px 0 12px;background:linear-gradient(90deg,rgba(94,231,255,.12),rgba(167,139,250,.08));border-bottom:1px solid rgba(94,231,255,.16);color:var(--dsw-alias-label-primary,#e7f7ff);font-size:11px;cursor:move;user-select:none;touch-action:none}',
      '.dshSplitWs_floatingTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:.05em}',
      '.dshSplitWs_floatingClose{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#8fa8bf);font:inherit;font-size:15px;line-height:18px;cursor:pointer}',
      '.dshSplitWs_floatingClose:hover{background:rgba(255,107,138,.16);color:#ff8aa0}',
      /*
       * 内容层显式建立独立层叠上下文（position + z-index:0）：
       * 平台输入框/滚动区内部可能带很高的 z-index，若这里不隔离，那些元素会直接
       * 跟缩放热区在同一个上下文里比大小，把浮窗底部的热区盖住 —— 表现就是
       * 「左边/右边能拖，底部和左下角拖不动」。
       */
      '.dshSplitWs_floatingBody{position:relative;z-index:0;flex:1;min-height:0;display:flex}',
      '.dshSplitWs_floatingBody .dshSplitWs_pane{flex:1;height:100%;min-height:0;border-radius:0}',
      // 缩放热区：四条边 + 四个角。顶部条本身仍用于移动，只有最上面 5px 是 n 缩放，
      // 左右上角分别让出 12px 给 ne/nw，避免和条上的关闭按钮/标题抢点击。
      // z-index 必须高于内容层（0）一个数量级，否则会被会话视图里的高 z-index 元素吃掉。
      '.dshSplitWs_floatResize{position:absolute;z-index:20;touch-action:none;background:transparent}',
      '.dshSplitWs_floatResize[data-dir=e]{top:14px;right:0;bottom:16px;width:9px;cursor:ew-resize}',
      '.dshSplitWs_floatResize[data-dir=w]{top:14px;left:0;bottom:16px;width:9px;cursor:ew-resize}',
      '.dshSplitWs_floatResize[data-dir=s]{left:16px;right:16px;bottom:0;height:10px;cursor:ns-resize}',
      '.dshSplitWs_floatResize[data-dir=n]{top:0;left:12px;right:12px;height:5px;cursor:ns-resize}',
      '.dshSplitWs_floatResize[data-dir=se]{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}',
      '.dshSplitWs_floatResize[data-dir=sw]{left:0;bottom:0;width:16px;height:16px;cursor:nesw-resize}',
      '.dshSplitWs_floatResize[data-dir=ne]{right:0;top:0;width:12px;height:12px;cursor:nesw-resize}',
      '.dshSplitWs_floatResize[data-dir=nw]{left:0;top:0;width:12px;height:12px;cursor:nwse-resize}',
      '.dshSplitWs_floatResize:hover{background:rgba(94,231,255,.22)}',
      '.dshSplitWs_floatResize[data-dir=se]::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-right:1px solid rgba(94,231,255,.6);border-bottom:1px solid rgba(94,231,255,.6)}',
      '.dshSplitWs_floatResize[data-dir=sw]::after{content:"";position:absolute;left:3px;bottom:3px;width:7px;height:7px;border-left:1px solid rgba(94,231,255,.6);border-bottom:1px solid rgba(94,231,255,.6)}',
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
      '.dshSplitWs_pane{position:relative;flex:1 1 0;min-width:0;display:flex;flex-direction:column;min-height:0;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1)}',
      // 目标创建后的轻提示：只占一条，不抢对话区高度。
      '.dshSplitWs_paneNotice{flex:none;padding:5px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dshSplitWs-accent) 10%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // 「新建会话 / 新建目标」选择框：覆盖当前窗格，点击遮罩取消。
      '.dshSplitWs_newSessionOverlay{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(3,8,14,.58)}',
      '.dshSplitWs_newSessionBox{width:min(340px,100%);display:flex;flex-direction:column;gap:8px;padding:14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 18px 48px rgba(0,0,0,.42)}',
      '.dshSplitWs_newSessionTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dshSplitWs_newSessionOption{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:9px 11px;border:.5px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}',
      '.dshSplitWs_newSessionOption:hover{border-color:var(--dshSplitWs-accent);background:color-mix(in srgb,var(--dshSplitWs-accent) 8%,var(--dsw-alias-bg-layer-1))}',
      '.dshSplitWs_newSessionOptionLabel{font-size:12.5px;font-weight:600;line-height:18px}',
      '.dshSplitWs_newSessionOptionHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dshSplitWs_newSessionCancel{align-self:flex-end;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dshSplitWs_newSessionCancel:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
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
      // 保存按钮现在是一个图标按钮：尺寸交给 `.dshSplitWs_iconButton`，这里只补状态色。
      '.dshSplitWs_saveLayout{min-width:0;justify-content:center}',
      '.dshSplitWs_saveLayout[data-state=saved]{color:var(--dsw-alias-state-success-primary)}',
      '.dshSplitWs_saveSpinner{animation:dshSplitWsSpin .9s linear infinite}',
      '@keyframes dshSplitWsSpin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.dshSplitWs_saveSpinner{animation:none}}',
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
      // 浮窗标题栏里的会话名：只读，长得像触发器但没有下拉与点击。
      '.dshSplitWs_sessionLabel{display:inline-flex;align-items:center;max-width:190px;height:26px;padding:0 6px;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
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
      // 菜单 portal 在 document.body 下，不在 .dshSplitWs_root 的继承链里，字体要单独声明。
      '.dshSplitWs_popoverList{--dsw-font-family:"SplitWorkspaceKuaile","ZCOOL KuaiLe","Noto Sans CJK SC","Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;position:fixed;top:0;left:0;z-index:1000;min-width:min(240px,calc(100vw - 16px));max-width:min(420px,calc(100vw - 16px));max-height:min(340px,calc(100vh - 16px));overflow-y:auto;padding:4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 32px rgba(0,0,0,.28);font-family:var(--dsw-font-family)}',
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
      /* 左侧入口组：视频与图片编辑并排。auto 外边距放在组上，不能放在单个按钮上。 */
      '.dshSplitWs_graphActions{display:flex;flex:none;align-items:center;gap:8px;margin-right:auto}',
      '.dshSplitWs_graphVideoButton{flex:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.dshSplitWs_graphVideoButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}',
      '.dshSplitWs_graphVideoButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dshSplitWs_graphVideoButton:disabled{opacity:.5;cursor:not-allowed}',
      '.dshSplitWs_graphVideoIcon{display:inline-flex;flex:none;align-items:center;color:var(--dsw-alias-brand-primary)}',
      '.dshSplitWs_graphReject{flex:none;color:var(--dsw-alias-state-error-primary)}',
      '.dshSplitWs_graphDegraded{flex:none;color:var(--dsw-alias-state-warning-primary,#b8860b)}',
      // 左右两块：左边是二级会话选择器（固定宽），右边是画布（吃掉剩余宽度）。
      '.dshSplitWs_graphBody{position:relative;flex:1;min-height:0;display:flex}',
      '.dshSplitWs_graphPicker{flex:none;width:224px;min-height:0;box-sizing:border-box;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dshSplitWs_graphPickerHead{flex:none;display:flex;flex-direction:column;gap:2px;padding:10px 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dshSplitWs_graphPickerHeadTop{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dshSplitWs_graphPickerTitle{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshSplitWs_graphPickerCollapse{flex:none;width:22px;height:22px;padding:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:20px;cursor:pointer}',
      '.dshSplitWs_graphPickerCollapse:hover{color:var(--dsw-alias-label-primary);border-color:var(--dshSplitWs-accent)}',
      '.dshSplitWs_graphPickerExpand{position:absolute;left:8px;top:8px;z-index:5;width:26px;height:26px;padding:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:24px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}',
      '.dshSplitWs_graphPickerExpand:hover{color:var(--dsw-alias-label-primary);border-color:var(--dshSplitWs-accent)}',
      '.dshSplitWs_graphPickerHint{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary)}',
      '.dshSplitWs_graphPickerScroll{flex:1;min-height:0;overflow:auto;padding:6px}',
      '.dshSplitWs_graphPickerEmpty{padding:16px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:center}',
      '.dshSplitWs_graphPickerGroup{display:flex;flex-direction:column}',
      '.dshSplitWs_graphPickerGroupHead{display:flex;align-items:center;gap:4px;width:100%;box-sizing:border-box;padding:3px 4px 3px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;user-select:none}',
      '.dshSplitWs_graphPickerGroupHead:hover{background:var(--dsw-alias-bg-layer-2)}',
      // 展开/收起只由这一块承担，右侧两个创建图标是它的兄弟节点（不能嵌套按钮）。
      '.dshSplitWs_graphPickerGroupToggle{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:2px 0;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dshSplitWs_graphPickerGroupActions{flex:none;display:flex;align-items:center;gap:2px}',
      /*
       * 工作区行右侧的「创建会话 / 创建员工」图标。默认半透明常驻（不是只在 hover
       * 时才出现），否则用户根本不知道这里有入口；悬停或聚焦时压亮。
       */
      '.dshSplitWs_graphPickerGroupAction{display:flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;box-sizing:border-box;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:.72;transition:opacity .12s ease,color .12s ease,background .12s ease}',
      '.dshSplitWs_graphPickerGroupAction:hover{opacity:1;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}',
      '.dshSplitWs_graphPickerGroupAction:focus-visible{outline:2px solid var(--dshSplitWs-accent);outline-offset:1px;opacity:1}',
      '.dshSplitWs_graphPickerGroupAction:disabled{opacity:.32;cursor:default}',
      '.dshSplitWs_graphPickerChevron{flex:none;width:12px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:18px}',
      '.dshSplitWs_graphPickerGroupLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}',
      '.dshSplitWs_graphPickerItems{display:flex;flex-direction:column;gap:1px;padding:2px 0 4px}',
      '.dshSplitWs_graphPickerItem{display:flex;align-items:center;gap:6px;box-sizing:border-box;margin-left:12px;padding:5px 8px;border:.5px solid transparent;border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:grab;user-select:none}',
      '.dshSplitWs_graphPickerItem:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshSplitWs_graphPickerItem:active{cursor:grabbing}',
      '.dshSplitWs_graphPickerItem:focus-visible{outline:2px solid var(--dshSplitWs-accent);outline-offset:1px}',
      '.dshSplitWs_graphScroll{flex:1;min-width:0;min-height:0;overflow:auto;padding:10px}',
      '.dshSplitWs_graphScroll[data-drop=true]{outline:2px dashed var(--dshSplitWs-accent);outline-offset:-4px}',
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
      /*
       * 改卡片名称的弹层。
       *
       * 遮罩铺满 `graphBody`（左侧选择器 + 画布），因此点画布别处、点选择器都会被
       * 当成「取消」；面板本身 stopPropagation，点输入框与按钮不会误关。
       * 层级比箭头编辑面板高一层：改名是短暂模态，编辑面板是常驻浮层。
       */
      '.dshSplitWs_graphRenameBackdrop{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(4,8,14,.55);backdrop-filter:blur(2px)}',
      '.dshSplitWs_graphRenamePanel{width:min(360px,100%);display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px rgba(0,0,0,.45)}',
      '.dshSplitWs_graphRenameTitle{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshSplitWs_graphRenameHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dshSplitWs_graphRenameInput{width:100%;box-sizing:border-box;padding:7px 9px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}',
      '.dshSplitWs_graphRenameInput:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,var(--dshSplitWs-accent));outline-offset:1px}',
      '.dshSplitWs_graphRenameError{font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-error-primary);word-break:break-word}',
      '.dshSplitWs_graphRenameActions{display:flex;align-items:center;justify-content:flex-end;gap:8px}',
      '.dshSplitWs_graphRenameActions .dshSplitWs_button{width:auto;min-width:64px}',
      '.dshSplitWs_graphEdgeDelete{pointer-events:auto;cursor:pointer}',
      '.dshSplitWs_graphEdgeDelete circle{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l2);stroke-width:1}',
      '.dshSplitWs_graphEdgeDelete path{stroke:var(--dsw-alias-label-secondary);stroke-width:1.4;stroke-linecap:round}',
      '.dshSplitWs_graphEdgeDelete:hover circle{fill:var(--dsw-alias-state-error-primary);stroke:var(--dsw-alias-state-error-primary)}',
      '.dshSplitWs_graphEdgeDelete:hover path{stroke:var(--dsw-static-neutral-00)}',
      '.dshSplitWs_graphCard{position:absolute;display:flex;flex-direction:row;gap:0;box-sizing:border-box;padding:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;overflow:hidden}',
      '.dshSplitWs_graphCardBody{display:flex;flex:1 1 auto;flex-direction:column;gap:4px;min-width:0;padding:10px 12px}',
      // 右上角有动作按钮时，正文右侧让出按钮那一列，标题不会被压住。
      '.dshSplitWs_graphCard[data-actions=true] .dshSplitWs_graphCardBody{padding-right:28px}',
      // 左侧小人：固定宽度，竖线只占视觉宽度；整块不接收指针，点击仍落在卡片上。
      '.dshSplitWs_graphCardAgent{position:relative;flex:none;display:flex;align-items:center;justify-content:center;width:46px;color:var(--card-accent,var(--dshSplitWs-accent));opacity:.42;pointer-events:none}',
      '.dshSplitWs_graphCardAgent::before{content:"";position:absolute;right:0;top:10px;bottom:10px;width:1px;background:var(--dsw-alias-border-l1)}',
      '.dshSplitWs_graphCardAgent svg{width:40px;height:45px;overflow:visible;shape-rendering:crispEdges}',
      /*
       * 小人：静止时就是原来的 12×16 剪影；运行中才播放「砌墙」动画。
       *
       * 砖块和人物同色系：人物实心 currentColor，砖用同一颜色的两档透明度，
       * 所以在青色/紫色等任意强调色下都成立。墙底用固定深色挡住后面的腿。
       */
      '.dshSplitWs_masonBody{fill:currentColor}',
      '.dshSplitWs_masonEye{fill:var(--dshSplitWs-mason-base,#0a1220)}',
      '.dshSplitWs_masonWall{opacity:0}',
      '.dshSplitWs_masonBrickBase{fill:var(--dshSplitWs-mason-base,#0a1220)}',
      '.dshSplitWs_masonBrickShadow{fill:var(--dshSplitWs-mason-base,#0a1220)}',
      '.dshSplitWs_masonBrick{opacity:0}',
      '.dshSplitWs_masonBrickTop{fill:currentColor;opacity:.55}',
      '.dshSplitWs_masonBrickFace{fill:currentColor;opacity:.38}',
      '.dshSplitWs_masonSweatLayer{opacity:0}',
      '.dshSplitWs_masonZzz{display:none}',
      '.dshSplitWs_graphCard[data-running="false"] .dshSplitWs_masonZzz{display:block;fill:#ffffff;transform-box:fill-box;transform-origin:50% 50%;animation:dshSplitWsMasonZzz 2.4s ease-out infinite;animation-delay:var(--zzz-delay,0s)}',
      '.dshSplitWs_masonSweat{fill:#e9feff;opacity:0}',
      /*
       * 运行中才挂动画。动画时间轴固定 5.6 秒：
       *   - 0.35s 起每 0.45s 落一块砖，共七块（最后一块 3.05s）；
       *   - 4.15–4.55s 整面墙淡出；
       *   - 4.55s 之后空墙等下一轮。
       * 每块砖的出现时刻由内联的 --brick-delay 错开，共用同一条 keyframes。
       */
      '.dshSplitWs_graphCard[data-running=true] .dshSplitWs_masonBack{animation:dshSplitWsMasonPress 5.3s linear infinite}',
      '.dshSplitWs_graphCard[data-running=true] .dshSplitWs_masonWall{animation:dshSplitWsMasonWallCycle 5.3s linear infinite}',
      '.dshSplitWs_graphCard[data-running=true] .dshSplitWs_masonBrick{animation-name:var(--brick-anim,dshSplitWsMasonBrick0);animation-duration:5.3s;animation-timing-function:linear;animation-iteration-count:infinite;animation-fill-mode:both}',
      '.dshSplitWs_graphCard[data-running=true] .dshSplitWs_masonSweatLayer{animation:dshSplitWsMasonSweatWindow 5.3s linear infinite}',
      '.dshSplitWs_graphCard[data-running=true] .dshSplitWs_masonSweat{animation:dshSplitWsMasonSweat 1.5s linear infinite;animation-delay:var(--sweat-delay,0s)}',
      '.dshSplitWs_graphCard[data-running=true] .dshSplitWs_masonEye{animation:dshSplitWsMasonBlink 2.9s steps(1,end) infinite}',
      // 运行中的小人亮起，和原来的静态点亮规则一致。
      '.dshSplitWs_graphCard[data-running=true] .dshSplitWs_graphCardAgent{opacity:1}',
      '.dshSplitWs_graphCard[data-running=true] .dshSplitWs_graphCardAgent::before{background:var(--dshSplitWs-accent);opacity:.55}',
      '.dshSplitWs_graphCard[data-running=true] .dshSplitWs_graphCardAgent svg{filter:drop-shadow(0 0 5px currentColor)}',
      '.dshSplitWs_graphCard:hover{border-color:var(--dshSplitWs-accent)}',
      '.dshSplitWs_graphCard[data-running=true]{border-color:var(--dshSplitWs-accent)}',
      // 从左侧拖进来、还没连线的卡片：虚线边框，和已经进入树的实线卡片区分开。
      '.dshSplitWs_graphCard[data-staged=true]{border-style:dashed;border-color:var(--dshSplitWs-accent)}',
      '.dshSplitWs_graphCard[data-staged=true] .dshSplitWs_graphCardTitle{padding-right:16px}',
      '.dshSplitWs_graphCardEmpty{cursor:default;opacity:.62}',
      '.dshSplitWs_graphCardEmpty:hover{border-color:var(--dsw-alias-border-l1)}',
      '.dshSplitWs_graphCardWorkspace{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshSplitWs_graphCardTitle{font-size:13px;line-height:19px;font-weight:550;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.dshSplitWs_graphCardMeta{display:flex;align-items:center;gap:6px;margin-top:auto;font-size:11px;line-height:16px;flex-wrap:wrap}',
      '.dshSplitWs_graphCardRunning{color:var(--dshSplitWs-accent)}',
      '.dshSplitWs_graphCardStaged{color:var(--dshSplitWs-accent)}',
      // 目标/审核状态徽标：同一套胶囊，颜色由 data-tone 决定。
      '.dshSplitWs_graphCardState{flex:none;padding:0 6px;border:1px solid currentColor;border-radius:999px;font-size:10px;line-height:14px;opacity:.92}',
      '.dshSplitWs_graphPickerCardState{flex:none;margin-left:auto;padding:0 5px;border:1px solid currentColor;border-radius:999px;font-size:9px;line-height:13px;opacity:.9}',
      '.dshSplitWs_graphCardState[data-tone=running],.dshSplitWs_graphPickerCardState[data-tone=running]{color:#5ee7ff}',
      '.dshSplitWs_graphCardState[data-tone=paused],.dshSplitWs_graphPickerCardState[data-tone=paused]{color:#ffd166}',
      '.dshSplitWs_graphCardState[data-tone=blocked],.dshSplitWs_graphPickerCardState[data-tone=blocked]{color:#ff7a8a}',
      '.dshSplitWs_graphCardState[data-tone=complete],.dshSplitWs_graphPickerCardState[data-tone=complete]{color:#6ef0b8}',
      '.dshSplitWs_graphCardState[data-tone=review],.dshSplitWs_graphPickerCardState[data-tone=review]{color:#c4a7ff;background:rgba(167,139,250,.1)}',
      /*
       * 卡片右上角的动作区：改名 / 移出画布 / 删除。
       *
       * 三个按钮放进同一个纵向容器，谁出现谁消失都不需要重算「下一个放第几行」；
       * 平时淡一点，悬停卡片或键盘聚焦时整块变清楚。
       */
      '.dshSplitWs_graphCardActions{position:absolute;top:5px;right:5px;z-index:2;display:flex;flex-direction:column;align-items:center;gap:4px;opacity:.72;transition:opacity .12s ease}',
      '.dshSplitWs_graphCard:hover .dshSplitWs_graphCardActions,.dshSplitWs_graphCardActions:focus-within{opacity:1}',
      '.dshSplitWs_graphCardRename{width:18px;height:18px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;cursor:pointer}',
      '.dshSplitWs_graphCardRename:hover{color:var(--dshSplitWs-accent);background:var(--dsw-alias-bg-layer-1)}',
      '.dshSplitWs_graphCardRename:focus-visible{outline:2px solid var(--dshSplitWs-accent);outline-offset:1px}',
      // 待连线卡片的「移出画布」。
      '.dshSplitWs_graphCardRemove{width:18px;height:18px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:18px;text-align:center;cursor:pointer}',
      '.dshSplitWs_graphCardRemove:hover{color:var(--dsw-alias-label-primary)}',
      '.dshSplitWs_graphCardRemove:focus-visible{outline:2px solid var(--dshSplitWs-accent);outline-offset:1px}',
      '.dshSplitWs_graphCardDelete{width:18px;height:18px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;text-align:center;cursor:pointer}',
      '.dshSplitWs_graphCardDelete:hover{color:var(--dsw-alias-state-error-primary);background:rgba(255,77,109,.15)}',
      // 出线端口：右边缘中点上那个圆点，拖动起点。命中区比看上去大（14px），
      // 因为 6px 的圆在触控板上很难一次按准。
      '.dshSplitWs_graphPort{position:absolute;right:-7px;top:50%;transform:translateY(-50%);width:14px;height:14px;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:50%;background:var(--dsw-alias-bg-base);cursor:crosshair;touch-action:none}',
      '.dshSplitWs_graphCard:hover .dshSplitWs_graphPort{border-color:var(--dshSplitWs-accent);background:var(--dshSplitWs-accent)}',
      '.dshSplitWs_graphPort:focus-visible{outline:2px solid var(--dshSplitWs-accent);outline-offset:1px}',
      '.dshSplitWs_graphEmpty{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}',
      // ── 设计模式：科幻主题 ──
      // 只作用在 `.dshSplitWs_graphWrap` 内部；平铺模式与插件其它部分完全不受影响。
      // 深色底 + 青/紫霓虹，卡片带发光边框与入场动效；文字用固定浅色，因此在浅色
      // 主题下这块画布也保持一致（它本来就是一块“控制台”，不是文档区）。
      '.dshSplitWs_graphWrap{--sw-neon:#5ee7ff;--sw-neon-2:#a78bfa;--sw-line:rgba(94,231,255,.2);--sw-glow:rgba(94,231,255,.35);--sw-bg:#070b14;--sw-text:#dff4ff;--sw-muted:#7c98b3;--sw-card:linear-gradient(155deg,rgba(18,32,52,.94),rgba(8,14,24,.96));position:relative;color:var(--sw-text);background:radial-gradient(900px 420px at 88% -12%,rgba(94,231,255,.12),transparent 62%),radial-gradient(640px 380px at 104% 52%,rgba(255,122,217,.08),transparent 62%),radial-gradient(760px 460px at -8% 108%,rgba(167,139,250,.12),transparent 60%),var(--sw-bg)}',
      '.dshSplitWs_graphBar{position:relative;z-index:1;color:var(--sw-muted);background:linear-gradient(180deg,rgba(10,18,32,.86),rgba(10,18,32,.32))}',
      '.dshSplitWs_graphBar::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,transparent,var(--sw-neon),var(--sw-neon-2),#ff7ad9,transparent);opacity:.55}',
      '.dshSplitWs_graphReject{color:#ff6b8a;text-shadow:0 0 10px rgba(255,107,138,.45)}',
      '.dshSplitWs_graphDegraded{color:#ffc46b}',
      '.dshSplitWs_graphBody{position:relative;z-index:1}',
      '.dshSplitWs_graphScroll{background-image:radial-gradient(circle,rgba(94,231,255,.13) 1px,transparent 1px);background-size:22px 22px;background-attachment:local}',
      '.dshSplitWs_graphScroll[data-drop=true]{outline:1px dashed rgba(94,231,255,.7);outline-offset:-5px;box-shadow:inset 0 0 42px rgba(94,231,255,.10);animation:dshSplitWsDropPulse 1.4s ease-in-out infinite}',
      // 左侧选择器：深色玻璃面板，标题带一枚呼吸光点。
      '.dshSplitWs_graphPicker{width:236px;border-right:1px solid var(--sw-line);background:linear-gradient(180deg,rgba(10,18,32,.92),rgba(6,11,20,.94));backdrop-filter:blur(6px)}',
      '.dshSplitWs_graphPickerHead{border-bottom:1px solid var(--sw-line);background:linear-gradient(180deg,rgba(94,231,255,.06),transparent)}',
      '.dshSplitWs_graphPickerTitle{color:var(--sw-text);font-size:11px;letter-spacing:.16em;text-transform:uppercase}',
      '.dshSplitWs_graphPickerTitle::before{content:"";display:inline-block;width:6px;height:6px;margin-right:8px;border-radius:50%;background:var(--sw-neon);box-shadow:0 0 10px var(--sw-neon);vertical-align:1px;animation:dshSplitWsBlink 2.4s ease-in-out infinite}',
      '.dshSplitWs_graphPickerHint{color:var(--sw-muted);font-size:10.5px;letter-spacing:.03em}',
      '.dshSplitWs_graphPickerGroup{margin-bottom:2px}',
      '.dshSplitWs_graphPickerGroupHead{padding:5px 5px 5px 8px;border-radius:8px;color:var(--sw-text);font-size:11.5px;letter-spacing:.05em;transition:background .18s ease,box-shadow .18s ease}',
      '.dshSplitWs_graphPickerGroupHead:hover{background:color-mix(in srgb,var(--pick-accent,var(--sw-neon)) 12%,transparent);box-shadow:inset 0 0 18px color-mix(in srgb,var(--pick-accent,var(--sw-neon)) 10%,transparent)}',
      '.dshSplitWs_graphPickerGroupAction{color:var(--sw-muted);opacity:.7}',
      '.dshSplitWs_graphPickerGroupAction:hover{opacity:1;color:var(--sw-text);background:color-mix(in srgb,var(--pick-accent,var(--sw-neon)) 16%,transparent);box-shadow:inset 0 0 10px color-mix(in srgb,var(--pick-accent,var(--sw-neon)) 12%,transparent)}',
      '.dshSplitWs_graphPickerGroupAction:focus-visible{outline-color:var(--pick-accent,var(--sw-neon))}',
      '.dshSplitWs_graphPickerGroupAction:disabled{opacity:.3;box-shadow:none}',
      '.dshSplitWs_graphPickerGroupOpen .dshSplitWs_graphPickerChevron{transform:rotate(90deg)}',
      '.dshSplitWs_graphPickerChevron{color:var(--pick-accent,var(--sw-neon));transition:transform .22s ease;filter:drop-shadow(0 0 4px var(--sw-glow))}',
      '.dshSplitWs_graphPickerGroupLabel{font-weight:600}',
      '.dshSplitWs_graphPickerDot{flex:none;width:4px;height:4px;border-radius:50%;background:var(--sw-neon-2);box-shadow:0 0 8px rgba(167,139,250,.7);opacity:.8}',
      '.dshSplitWs_graphPickerItems{padding:4px 0 8px;animation:dshSplitWsFadeIn .24s ease both}',
      // 会话卡片：左侧一道霓虹竖线，悬停轻微上浮并扫过一道光。
      '.dshSplitWs_graphPickerItem{position:relative;display:flex;flex-direction:column;gap:3px;margin:0 0 6px 10px;padding:9px 10px 8px;border:1px solid rgba(94,231,255,.16);border-radius:10px;background:linear-gradient(150deg,rgba(18,32,52,.85),rgba(8,14,24,.9));box-shadow:0 4px 14px rgba(0,0,0,.3),inset 0 0 18px rgba(94,231,255,.04);align-items:stretch;cursor:grab;user-select:none;overflow:hidden;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease;animation:dshSplitWsCardIn .26s cubic-bezier(.2,.8,.2,1) backwards}',
      // 每张会话卡片右上角的删除入口：普通会话、空白会话、员工目标统一走这里。
      '.dshSplitWs_graphPickerActions{position:absolute;top:4px;right:4px;z-index:2;display:flex;align-items:center;gap:3px;opacity:.75;transition:opacity .12s ease}',
      '.dshSplitWs_graphPickerItem:hover .dshSplitWs_graphPickerActions,.dshSplitWs_graphPickerActions:focus-within{opacity:1}',
      '.dshSplitWs_graphPickerRename{width:18px;height:18px;padding:0;border:0;border-radius:5px;background:rgba(94,231,255,.08);color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;cursor:pointer}',
      '.dshSplitWs_graphPickerRename:hover{background:rgba(94,231,255,.2);color:var(--dshSplitWs-accent,var(--sw-neon))}',
      '.dshSplitWs_graphPickerRename:focus-visible{outline:2px solid var(--dshSplitWs-accent);outline-offset:1px}',
      '.dshSplitWs_graphPickerDelete{width:18px;height:18px;padding:0;border:0;border-radius:5px;background:rgba(255,77,109,.08);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dshSplitWs_graphPickerDelete:hover{background:rgba(255,77,109,.2);color:var(--dsw-alias-state-error-primary)}',
      /*
       * 两个动作按钮并排占约 39px，标题/工作区那一行要给它让位，否则长名字会被
       * 按钮压住（`overflow:hidden` 会直接裁掉，而不是显示省略号）。
       */
      '.dshSplitWs_graphPickerCardTopWithDelete{padding-right:44px}',
      '.dshSplitWs_graphPickerItem::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:2px;border-radius:2px;background:var(--pick-accent,var(--sw-neon));opacity:.75;box-shadow:0 0 10px var(--pick-accent,var(--sw-glow))}',
      '.dshSplitWs_graphPickerItem::after{content:"";position:absolute;right:-30%;top:-60%;width:60%;height:220%;background:linear-gradient(90deg,transparent,rgba(94,231,255,.10),transparent);transform:rotate(18deg);opacity:0;transition:opacity .2s ease;pointer-events:none}',
      '.dshSplitWs_graphPickerItem:hover{transform:translateY(-1px);border-color:var(--pick-accent,var(--sw-neon));box-shadow:0 8px 22px rgba(0,0,0,.42),0 0 18px color-mix(in srgb,var(--pick-accent,var(--sw-neon)) 25%,transparent),inset 0 0 20px color-mix(in srgb,var(--pick-accent,var(--sw-neon)) 8%,transparent)}',
      '.dshSplitWs_graphPickerItem:hover::after{opacity:1}',
      '.dshSplitWs_graphPickerItem:active{cursor:grabbing;transform:scale(.985)}',
      '.dshSplitWs_graphPickerItem:focus-visible{outline:2px solid var(--sw-neon);outline-offset:2px}',
      '.dshSplitWs_graphPickerCardTop{display:flex;align-items:center;gap:6px;min-width:0}',
      '.dshSplitWs_graphPickerCardWorkspace{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--sw-muted);font-size:9.5px;line-height:14px;letter-spacing:.14em;text-transform:uppercase}',
      '.dshSplitWs_graphPickerCardRun{flex:none;width:5px;height:5px;border-radius:50%;background:var(--sw-neon);box-shadow:0 0 8px var(--sw-neon);animation:dshSplitWsBlink 1.8s ease-in-out infinite}',
      '.dshSplitWs_graphPickerCardTitle{color:var(--sw-text);font-size:12.5px;line-height:18px;font-weight:600;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.dshSplitWs_graphPickerCardHint{display:flex;align-items:center;gap:4px;color:var(--sw-muted);font-size:10px;line-height:14px;opacity:.75}',
      '.dshSplitWs_graphPickerCardHintText{flex:1;min-width:0}',
      '.dshSplitWs_graphPickerCardArrow{flex:none;color:var(--pick-accent,var(--sw-neon));opacity:.72;transition:transform .18s ease,opacity .18s ease}',
      '.dshSplitWs_graphPickerItem:hover .dshSplitWs_graphPickerCardArrow{transform:translate(1px,-1px);opacity:1}',
      '.dshSplitWs_graphPickerEmpty{color:var(--sw-muted);letter-spacing:.03em}',
      '.dshSplitWs_graphPickerScroll{scrollbar-width:thin;scrollbar-color:rgba(94,231,255,.25) transparent}',
      '.dshSplitWs_graphPickerScroll::-webkit-scrollbar,.dshSplitWs_graphScroll::-webkit-scrollbar{width:8px;height:8px}',
      '.dshSplitWs_graphPickerScroll::-webkit-scrollbar-thumb,.dshSplitWs_graphScroll::-webkit-scrollbar-thumb{background:rgba(94,231,255,.22);border-radius:8px}',
      '.dshSplitWs_graphPickerScroll::-webkit-scrollbar-track,.dshSplitWs_graphScroll::-webkit-scrollbar-track{background:transparent}',
      // 画布卡片：霓虹边框、顶部一道细光、悬停上浮发光。
      '.dshSplitWs_graphCard{border:1px solid rgba(94,231,255,.22);border-radius:12px;background:var(--sw-card);color:var(--sw-text);box-shadow:0 10px 28px rgba(0,0,0,.35),inset 0 0 24px rgba(94,231,255,.04);transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease;animation:dshSplitWsCardIn .28s cubic-bezier(.2,.8,.2,1) backwards}',
      '.dshSplitWs_graphCard::before{content:"";position:absolute;left:10px;right:10px;top:0;height:1px;background:linear-gradient(90deg,transparent,var(--card-accent,var(--sw-neon)),transparent);opacity:.5;pointer-events:none}',
      '.dshSplitWs_graphCard:hover{transform:translateY(-2px);border-color:var(--card-accent,var(--sw-neon));box-shadow:0 14px 32px rgba(0,0,0,.45),0 0 24px color-mix(in srgb,var(--card-accent,var(--sw-neon)) 25%,transparent)}',
      '.dshSplitWs_graphCard[data-running=true]{border-color:var(--card-accent,var(--sw-neon));box-shadow:0 10px 28px rgba(0,0,0,.4),0 0 22px color-mix(in srgb,var(--card-accent,var(--sw-neon)) 28%,transparent)}',
      '.dshSplitWs_graphCard[data-staged=true]{border-style:dashed;border-color:rgba(167,139,250,.6);box-shadow:0 10px 28px rgba(0,0,0,.38),0 0 20px rgba(167,139,250,.12);animation:dshSplitWsCardIn .28s cubic-bezier(.2,.8,.2,1) backwards,dshSplitWsStaged 2.6s ease-in-out infinite}',
      '.dshSplitWs_graphCardWorkspace{color:var(--sw-muted);font-size:9.5px;line-height:14px;letter-spacing:.14em;text-transform:uppercase}',
      '.dshSplitWs_graphCardTitle{color:var(--sw-text);font-size:13px;line-height:19px}',
      '.dshSplitWs_graphCardMeta{color:var(--sw-muted)}',
      '.dshSplitWs_graphCardRunning{color:var(--sw-neon)}',
      '.dshSplitWs_graphCardStaged{color:var(--sw-neon-2);text-shadow:0 0 8px rgba(167,139,250,.5)}',
      // 左侧像素小人：用赛博主题的青色；运行中沿竖线加一段渐隐光，和运行边框同色。
      '.dshSplitWs_graphWrap .dshSplitWs_graphCardAgent{color:var(--card-accent,var(--sw-neon));opacity:.4}',
      '.dshSplitWs_graphWrap .dshSplitWs_graphCardAgent::before{background:var(--sw-line)}',
      '.dshSplitWs_graphWrap .dshSplitWs_graphCard[data-running=true] .dshSplitWs_graphCardAgent{opacity:1}',
      '.dshSplitWs_graphWrap .dshSplitWs_graphCard[data-running=true] .dshSplitWs_graphCardAgent::before{background:linear-gradient(180deg,transparent,rgba(94,231,255,.6),transparent);opacity:1}',
      '.dshSplitWs_graphWrap .dshSplitWs_graphCard[data-running=true] .dshSplitWs_graphCardAgent svg{filter:drop-shadow(0 0 7px rgba(94,231,255,.65))}',
      '.dshSplitWs_graphCardRemove{background:rgba(94,231,255,.08);color:var(--sw-muted);border:1px solid rgba(94,231,255,.18)}',
      '.dshSplitWs_graphCardRemove:hover{background:rgba(255,107,138,.16);color:#ff8aa0;border-color:rgba(255,107,138,.5)}',
      '.dshSplitWs_graphPort{border:1px solid rgba(94,231,255,.65);background:#0b1422;box-shadow:0 0 8px rgba(94,231,255,.5);transition:transform .16s ease,box-shadow .16s ease,background .16s ease}',
      '.dshSplitWs_graphCard:hover .dshSplitWs_graphPort{background:var(--card-accent,var(--sw-neon));box-shadow:0 0 14px var(--card-accent,var(--sw-neon));transform:translateY(-50%) scale(1.15)}',
      '.dshSplitWs_graphEdge{stroke-width:1.4;filter:drop-shadow(0 0 2px rgba(255,255,255,.18))}',
      '.dshSplitWs_graphEdgeFlow{stroke-width:3.2;stroke-dasharray:2 98;stroke-linecap:round;pointer-events:none;animation:dshSplitWsFlow 1.9s linear infinite}',
      '.dshSplitWs_graphEdgePending{stroke:var(--sw-neon);stroke-dasharray:6 5;animation:dshSplitWsDash 1s linear infinite}',
      '.dshSplitWs_graphArrow{fill:var(--sw-neon);filter:drop-shadow(0 0 3px rgba(94,231,255,.4))}',
      '.dshSplitWs_graphEdgeEdit circle:first-child{fill:#0b1422;stroke:rgba(94,231,255,.5)}',
      '.dshSplitWs_graphEdgeEdit circle:not(:first-child){fill:var(--sw-neon)}',
      '.dshSplitWs_graphEdgeEdit:hover circle:first-child{fill:var(--sw-neon);stroke:var(--sw-neon)}',
      '.dshSplitWs_graphEdgeEdit:hover circle:not(:first-child){fill:#041018}',
      '.dshSplitWs_graphEdgeNote{background:rgba(9,16,28,.92);border:1px solid rgba(94,231,255,.22);color:var(--sw-muted);box-shadow:0 0 12px rgba(94,231,255,.08)}',
      '.dshSplitWs_graphEdgeEditor{background:rgba(8,14,26,.96);border-color:rgba(94,231,255,.25);box-shadow:0 16px 42px rgba(0,0,0,.5),0 0 24px rgba(94,231,255,.08);backdrop-filter:blur(8px)}',
      '.dshSplitWs_graphEdgeEditorTitle{color:var(--sw-text);letter-spacing:.04em}',
      '.dshSplitWs_graphEdgeEditorHint{color:var(--sw-muted)}',
      '.dshSplitWs_graphEdgeEditorInput{background:rgba(4,9,18,.8);border-color:rgba(94,231,255,.2);color:var(--sw-text)}',
      '.dshSplitWs_graphEdgeEditorInput:focus-visible{outline-color:var(--sw-neon)}',
      '.dshSplitWs_graphEdgeEditorActions .dshSplitWs_button{background:rgba(94,231,255,.08);border-color:rgba(94,231,255,.25);color:var(--sw-text)}',
      '.dshSplitWs_graphEdgeEditorActions .dshSplitWs_button:hover{background:rgba(94,231,255,.16)}',
      '.dshSplitWs_graphEdgeEditorActions .dshSplitWs_primary{background:linear-gradient(135deg,var(--sw-neon),var(--sw-neon-2));border-color:transparent;color:#041018;font-weight:600}',
      '.dshSplitWs_graphDiagnostic{background:rgba(9,16,28,.8);color:var(--sw-muted);border:1px solid rgba(94,231,255,.12);letter-spacing:.03em}',
      '.dshSplitWs_graphEmpty{flex-direction:column;gap:12px;color:var(--sw-muted);letter-spacing:.04em;text-align:center;padding:0 24px;pointer-events:none}',
      '.dshSplitWs_graphEmpty::before{content:"";width:42px;height:42px;border:1px dashed rgba(94,231,255,.35);border-radius:12px;box-shadow:0 0 18px rgba(94,231,255,.1);animation:dshSplitWsFloat 3s ease-in-out infinite}',
      '@keyframes dshSplitWsCardIn{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '@keyframes dshSplitWsFadeIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}',
      '@keyframes dshSplitWsDash{to{stroke-dashoffset:-22}}',
      '@keyframes dshSplitWsFlow{from{stroke-dashoffset:0}to{stroke-dashoffset:-100}}',
      '@keyframes dshSplitWsBlink{0%,100%{opacity:.45}50%{opacity:1}}',
      '@keyframes dshSplitWsDropPulse{0%,100%{box-shadow:inset 0 0 30px rgba(94,231,255,.07)}50%{box-shadow:inset 0 0 48px rgba(94,231,255,.16)}}',
      '@keyframes dshSplitWsStaged{0%,100%{box-shadow:0 10px 28px rgba(0,0,0,.38),0 0 18px rgba(167,139,250,.10)}50%{box-shadow:0 10px 28px rgba(0,0,0,.38),0 0 28px rgba(167,139,250,.22)}}',
      '@keyframes dshSplitWsFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
      // ── 小人砌墙动画（详见 client.graph.view.js 的 agentGlyph） ──
      // 砖：落下 2px 并淡入；之后一直可见，由上层 wall 的淡出统一收尾。
      // 砖：出现之前一直透明，出现后保持到墙淡出。每条 keyframes 对应一块砖，
      // 百分比就是它的落定时刻（1.5s / 1.95s / … / 4.2s，周期 6.5s）。
      '@keyframes dshSplitWsMasonBrick0{0%,17.7%{opacity:0;transform:translateY(-2px)}18.9%{opacity:1;transform:translateY(0)}100%{opacity:1;transform:translateY(0)}}',
      '@keyframes dshSplitWsMasonBrick1{0%,26.2%{opacity:0;transform:translateY(-2px)}27.4%{opacity:1;transform:translateY(0)}100%{opacity:1;transform:translateY(0)}}',
      '@keyframes dshSplitWsMasonBrick2{0%,34.7%{opacity:0;transform:translateY(-2px)}35.9%{opacity:1;transform:translateY(0)}100%{opacity:1;transform:translateY(0)}}',
      '@keyframes dshSplitWsMasonBrick3{0%,43.1%{opacity:0;transform:translateY(-2px)}44.3%{opacity:1;transform:translateY(0)}100%{opacity:1;transform:translateY(0)}}',
      '@keyframes dshSplitWsMasonBrick4{0%,51.6%{opacity:0;transform:translateY(-2px)}52.8%{opacity:1;transform:translateY(0)}100%{opacity:1;transform:translateY(0)}}',
      '@keyframes dshSplitWsMasonBrick5{0%,60.1%{opacity:0;transform:translateY(-2px)}61.3%{opacity:1;transform:translateY(0)}100%{opacity:1;transform:translateY(0)}}',
      '@keyframes dshSplitWsMasonBrick6{0%,68.6%{opacity:0;transform:translateY(-2px)}69.8%{opacity:1;transform:translateY(0)}100%{opacity:1;transform:translateY(0)}}',
      // 墙：砌满后整面墙往下沉 3px 并淡出。
      '@keyframes dshSplitWsMasonWallCycle{0%,90.6%{opacity:1;transform:translateY(0)}96.3%,100%{opacity:0;transform:translateY(3px)}}',
      // 汗滴：向下淌 4px 并淡出；横向摆动靠 --sweat-sway。
      '@keyframes dshSplitWsMasonZzz{0%{opacity:0;transform:translate(0,2px) scale(var(--zzz-scale,1))}10%{opacity:.9}80%{opacity:.5}100%{opacity:0;transform:translate(4px,-6px) scale(var(--zzz-scale,1))}}',
      '@keyframes dshSplitWsMasonSweat{0%{opacity:0;transform:translate(0,0)}10%{opacity:1}70%{opacity:1}100%{opacity:0;transform:translate(var(--sweat-sway,0),4px)}}',
      // 汗滴只在砌墙那一段露出来：1.0s 开始淡入、3.7s 淡出，其余时间整组隐藏。
      '@keyframes dshSplitWsMasonSweatWindow{0%,18.9%{opacity:0}20.5%{opacity:1}68.2%{opacity:1}70%,100%{opacity:0}}',
      // 眨眼：每 2.9 秒闭一次，用 steps 让它保持像素感。
      '@keyframes dshSplitWsMasonBlink{0%,96%{fill:var(--dshSplitWs-mason-base,#0a1220)}97%,99%{fill:currentColor}100%{fill:var(--dshSplitWs-mason-base,#0a1220)}}',
      // 用力：每块砖落定时整个人物往下压 1px（七次脉冲，对齐砖的出现节拍）。
      '@keyframes dshSplitWsMasonPress{0%,17.9%{transform:translateY(0)}18.9%{transform:translateY(1px)}20.9%{transform:translateY(0)}26.4%{transform:translateY(0)}27.4%{transform:translateY(1px)}29.4%{transform:translateY(0)}34.9%{transform:translateY(0)}35.9%{transform:translateY(1px)}37.9%{transform:translateY(0)}43.3%{transform:translateY(0)}44.3%{transform:translateY(1px)}46.3%{transform:translateY(0)}51.8%{transform:translateY(0)}52.8%{transform:translateY(1px)}54.8%{transform:translateY(0)}60.3%{transform:translateY(0)}61.3%{transform:translateY(1px)}63.3%{transform:translateY(0)}68.8%{transform:translateY(0)}69.8%{transform:translateY(1px)}71.8%{transform:translateY(0)}100%{transform:translateY(0)}}',
      // 说明徽标：只占一个小胶囊，不再铺开正文压住卡片；悬停看全文，点击打开编辑面板。
      '.dshSplitWs_graphEdgeNote{display:flex;align-items:center;gap:5px;max-width:none;overflow:visible;padding:2px 8px;border-radius:999px;background:rgba(9,16,28,.92);border:1px solid rgba(94,231,255,.22);color:var(--sw-muted);font-size:10px;line-height:14px;white-space:nowrap;cursor:pointer;pointer-events:auto;box-shadow:0 0 12px rgba(94,231,255,.08);transition:color .15s ease,border-color .15s ease,box-shadow .15s ease,transform .15s ease}',
      '.dshSplitWs_graphEdgeNote:hover{color:var(--sw-text);border-color:var(--sw-neon);box-shadow:0 0 16px rgba(94,231,255,.22);transform:translate(-50%,-50%) scale(1.04)}',
      '.dshSplitWs_graphEdgeNote:focus-visible{outline:2px solid var(--sw-neon);outline-offset:2px}',
      '.dshSplitWs_graphEdgeNoteDot{flex:none;width:4px;height:4px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor}',
      '.dshSplitWs_graphEdgeNoteText{letter-spacing:.04em}',
      '@media (prefers-reduced-motion:reduce){.dshSplitWs_graphWrap *{animation:none !important;transition:none !important}}',
      `
/* ══════════════════════════════════════════════════════════════════
   科幻主题：平铺面板（深色控制台）
   - 只在 .dshSplitWs_root 内覆盖 token，主界面其它区域不受影响；
   - 用完整深色主题 token 让共享会话内容也切到深色；
   - 动效只有：边框流光、活动窗格呼吸、菱形节点呼吸、顶栏左右扫光。
   ══════════════════════════════════════════════════════════════════ */
.dshSplitWs_root{
  --dsw-static-amber-100:#fef5e7;--dsw-static-amber-400:#f7ad31;--dsw-static-amber-500:#f59e0b;--dsw-static-amber-600:#dd8629;--dsw-static-amber-900:#27241f;--dsw-static-blue-100:#dbeafe;--dsw-static-blue-300:#93c5fd;--dsw-static-blue-400:#60a5fa;--dsw-static-blue-450:#4d93f8;--dsw-static-blue-500:#3b82f6;--dsw-static-blue-50:#eff6ff;--dsw-static-blue-50p:#eaf3ff;--dsw-static-blue-600:#2563eb;--dsw-static-blue-75:#e5f0ff;--dsw-static-blue-800:#1e40af;--dsw-static-blue-900:#0e3074;--dsw-static-blue-950:#172554;--dsw-static-deepseek-100:#e4edfd;--dsw-static-deepseek-200:#d3e2ff;--dsw-static-deepseek-300:#b7c8fe;--dsw-static-deepseek-400:#7aaaff;--dsw-static-deepseek-450:#5686fe;--dsw-static-deepseek-500:#4176e6;--dsw-static-deepseek-50:#edf3fe;--dsw-static-deepseek-600:#4868b2;--dsw-static-deepseek-700-delete:#2f4c8f;--dsw-static-deepseek-800:#34415b;--dsw-static-deepseek-900:#283142;--dsw-static-green-100:#e6faed;--dsw-static-green-400:#4ed17e;--dsw-static-green-500:#22c55e;--dsw-static-green-500-a08:#22c55e14;--dsw-static-green-500-a12:#22c55e1f;--dsw-static-green-900:#233c2c;--dsw-static-neutral-00:#fff;--dsw-static-neutral-1000:#000;--dsw-static-neutral-100:#f5f5f5;--dsw-static-neutral-150:#ededed;--dsw-static-neutral-200:#e5e5e5;--dsw-static-neutral-250:#dcdcdc;--dsw-static-neutral-300:#d4d4d4;--dsw-static-neutral-400:#a2a4a6;--dsw-static-neutral-500:#7f8287;--dsw-static-neutral-50:#fafafa;--dsw-static-neutral-550:#65676b;--dsw-static-neutral-600:#545557;--dsw-static-neutral-700:#3c3c3d;--dsw-static-neutral-800:#292929;--dsw-static-neutral-850:#212123;--dsw-static-neutral-900:#0f0f0f;--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-1000:#0f1115;--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-150:#e9ecf2;--dsw-static-neutral-bluish-200:#e1e5ee;--dsw-static-neutral-bluish-300:#cfd3d6;--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-500:#979da6;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-60:#f9fafb;--dsw-static-neutral-bluish-700:#61666b;--dsw-static-neutral-bluish-750:#43454a;--dsw-static-neutral-bluish-75:#f1f3f5;--dsw-static-neutral-bluish-800:#353638;--dsw-static-neutral-bluish-850:#2c2c2e;--dsw-static-neutral-bluish-875:#232324;--dsw-static-neutral-bluish-900:#1b1b1c;--dsw-static-neutral-bluish-950:#151517;--dsw-static-red-100:#fee2e2;--dsw-static-red-400:#f25a5a;--dsw-static-red-400-a12:#f25a5a1f;--dsw-static-red-500:#ef4444;--dsw-static-red-50:#fef2f2;--dsw-static-red-600:#ec1313;--dsw-static-red-600-a08:#ec131314;--dsw-static-red-900:#570c0c;--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950);--dsw-alias-bg-document-preview:var(--dsw-static-neutral-bluish-950);--dsw-alias-bg-document-selection:color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent);--dsw-alias-label-document-preview:var(--dsw-static-neutral-bluish-300);--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-875);--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-850);--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-mask-1:#00000080;--dsw-alias-bg-mask-2:#0003;--dsw-alias-bg-mask-3:#0000007a;--dsw-alias-bg-mask-photo:#000000e0;--dsw-alias-bg-mask-drop:#272730b3;--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-multi-select:var(--dsw-static-neutral-850);--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-700);--dsw-alias-bg-skeleton:#ffffff14;--dsw-alias-border-inverted2:#ffffff14;--dsw-alias-border-inverted:#ffffff0f;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2-darkmode-thin:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l3:#ffffff29;--dsw-alias-border-l4:#fff3;--dsw-alias-brand-primary-invert:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-primary-new-colorprimary-new-color:var(--dsw-static-deepseek-450);--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-text:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-contrast-fill:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-elevated-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-floating-fill:var(--dsw-static-neutral-bluish-850);--dsw-alias-button-floating-hover:var(--dsw-static-neutral-bluish-800);--dsw-alias-button-ghost-active-border:var(--dsw-static-neutral-bluish-600);--dsw-alias-button-ghost-active-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-ghost-active-hover:var(--dsw-static-neutral-bluish-700);--dsw-alias-button-info-fill:var(--dsw-static-deepseek-400);--dsw-alias-button-info-hover:var(--dsw-static-deepseek-500);--dsw-alias-button-primary-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);--dsw-alias-button-primary-hover:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-tool-bar-fill-invisible:#1f1f1f5c;--dsw-alias-button-tool-bar-fill:#54555780;--dsw-alias-button-tool-bar-hover:#54555799;--dsw-alias-interactive-bg-active:#ffffff24;--dsw-alias-interactive-bg-hover-accent:#ffffff3d;--dsw-alias-interactive-bg-hover-danger:#f25a5a26;--dsw-alias-interactive-bg-hover-solid:var(--dsw-static-neutral-bluish-800);--dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-deep-diving:color-mix(in srgb, var(--dsw-static-deepseek-450) 55%, var(--dsw-static-neutral-bluish-400));--dsw-alias-label-deep-diving-shimmer:color-mix(in srgb, var(--dsw-static-blue-300) 65%, var(--dsw-static-deepseek-400));--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-label-primary-bluish:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-label-primary-foreground:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-800);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);--dsw-alias-label-shimmer:color-mix(in srgb, var(--dsw-static-neutral-00) 45%, transparent);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);--dsw-alias-menu-icon:var(--dsw-alias-label-primary-dimmed);--dsw-alias-link:var(--dsw-static-deepseek-400);--dsw-alias-markdown-citation:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-block-banner:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-code-block:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-code-segment-selected:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-segment-unselected:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-inline-code:var(--dsw-static-neutral-800);--dsw-alias-markdown-placeholder:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-tag:var(--dsw-static-neutral-bluish-850);--dsw-alias-scrollbar-bg-l1:var(--dsw-static-neutral-700);--dsw-alias-scrollbar-bg-l2:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l1:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l2:var(--dsw-static-neutral-550);--dsw-alias-state-business-primary:var(--dsw-static-deepseek-400);--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-800);--dsw-alias-code-diff-added:var(--dsw-static-green-500-a12);--dsw-alias-code-diff-deleted:var(--dsw-static-red-400-a12);--dsw-alias-file-diff-added-bg:#1f3124;--dsw-alias-file-diff-added-gutter:#132016;--dsw-alias-file-diff-added-marker:#41c977;--dsw-alias-file-diff-deleted-bg:#3c1f1b;--dsw-alias-file-diff-deleted-gutter:#28130e;--dsw-alias-file-diff-deleted-marker:#fa423e;--dsw-alias-state-error-primary:var(--dsw-static-red-400);--dsw-alias-state-error-secondary:var(--dsw-static-red-400);--dsw-alias-state-idle-primary:var(--dsw-static-neutral-600);--dsw-alias-state-success-primary:var(--dsw-static-green-500);--dsw-alias-state-success-secondary:var(--dsw-static-green-400);--dsw-alias-state-success-tertiary:var(--dsw-static-green-900);--dsw-alias-state-warn-label:var(--dsw-static-amber-600);--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);--dsw-alias-state-warn-secondary:var(--dsw-static-amber-400);--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-900);--dsw-alias-switch-thumb:var(--dsw-static-neutral-bluish-400);--dsw-alias-toast-bg:var(--dsw-static-neutral-bluish-750);--dsw-alias-toast-label:var(--dsw-static-neutral-bluish-00);--dsw-alias-turn-trigger-bg:var(--dsw-alias-interactive-bg-hover);--dsw-alias-turn-trigger-bg-hover:var(--dsw-alias-interactive-bg-active);--dsw-alias-tooltip-bg:var(--dsw-static-neutral-bluish-750);--dsw-alias-tooltip-key-bg:color-mix(in srgb, var(--dsw-alias-tooltip-bg), white 18%);--dsw-specific-bubble-highlight:var(--dsw-static-neutral-bluish-750);--dsw-specific-bubble:var(--dsw-static-neutral-bluish-850);--dsw-specific-input-major:var(--dsw-static-neutral-bluish-850);--dsw-specific-login-input:var(--dsw-static-neutral-bluish-900);--dsw-menu-surface-fill:#43454a73;--dsw-alias-menu-group-header-fill:#303136f0;--dsw-specific-menu:var(--dsw-menu-surface-fill);--dsw-specific-selector:var(--dsw-static-neutral-bluish-800);--dsw-specific-sidebar-fill:var(--dsw-static-neutral-bluish-900);--dsw-specific-sidebar-nav-item-active-accent:var(--dsw-static-neutral-bluish-800);--dsw-specific-sidebar-nav-item-active:var(--dsw-static-neutral-bluish-750);--dsw-specific-sidebar-nav-item-hover:var(--dsw-static-neutral-bluish-850);--dsw-specific-tip:var(--dsw-static-neutral-bluish-800);--dsw-specific-menu:#303136f0;--dsw-alias-onboarding-card-fill:color-mix(in srgb, var(--dsw-static-neutral-bluish-850) 80%, transparent);--dsw-alias-onboarding-secondary-fill:#48494c;--dsw-alias-onboarding-checkbox-border:var(--dsw-alias-border-l2);--dsw-linear-gradient-think:linear-gradient(180deg, #151517 20.19%, #15151700 100%);--dsw-linear-think-select:linear-gradient(180deg, #232325 20.19%, #23232500 100%);--shiki-token-constant:#4dabf7;--shiki-token-string:#69db7c;--shiki-token-comment:#adb5bd;--shiki-token-keyword:#faa2c1;--shiki-token-parameter:#ffa94d;--shiki-token-function:#b197fc;--shiki-token-string-expression:#8ce99a;--shiki-token-punctuation:#ced4da;--shiki-token-link:#74c0fc;
  --dshSciNeon:#5ee7ff;
  --dshSciNeon2:#a78bfa;
  --dshSciOrange:#ff7a1a;
  --dshSciLine:#1a2b41;
  --dshSciLine2:#24425f;
  --dshSciText:#dceaf7;
  --dshSciMuted:#7c98b3;
  --dsw-alias-bg-base:#05080e;
  --dsw-alias-bg-layer-1:#0a1220;
  --dsw-alias-bg-layer-2:#0e1929;
  --dsw-alias-bg-layer-3:#122033;
  --dsw-alias-bg-layer-4:#16263b;
  --dsw-alias-bg-overlay:#0b1423;
  --dsw-alias-bg-skeleton:#ffffff10;
  --dsw-alias-border-l1:#1a2b41;
  --dsw-alias-border-l2:#24425f;
  --dsw-alias-border-l3:#2f5373;
  --dsw-alias-label-primary:#dceaf7;
  --dsw-alias-label-secondary:#9fb6c9;
  --dsw-alias-label-tertiary:#6f8aa0;
  --dsw-alias-label-quaternary:#526a80;
  --dsw-alias-label-caption:#6f8aa0;
  --dsw-alias-brand-primary:#5ee7ff;
  --dsw-alias-brand-primary-new-colorprimary-new-color:#5ee7ff;
  --dsw-alias-state-business-primary:#5ee7ff;
  --dsw-alias-state-error-primary:#ff4d6d;
  --dsw-alias-state-success-primary:#3ddc97;
  --dsw-alias-state-warning-primary:#ffb454;
  --dsw-alias-state-warn-primary:#ffb454;
  --dsw-alias-state-idle-primary:#526a80;
  --dsw-specific-bubble:#0e1929;
  --dsw-specific-bubble-highlight:#122033;
  --dsw-specific-input-major:#0b1423;
  --dsw-alias-markdown-code-block:#05080e;
  --dsw-alias-markdown-code-block-banner:#0a1220;
  --dsw-alias-markdown-inline-code:#0e1929;
  --dsw-alias-markdown-tag:#101c2d;
  --dsw-alias-markdown-placeholder:#0a1220;
  --dsw-alias-scrollbar-bg-l1:#142638;
  --dsw-alias-scrollbar-bg-l2:#1a2b41;
  --dsw-alias-scrollbar-hover-l1:#24425f;
  --dsw-alias-scrollbar-hover-l2:#2f5373;
  --dsw-alias-interactive-bg-hover:#ffffff0d;
  --dsw-alias-interactive-bg-active:#ffffff14;
  --dsw-alias-interactive-bg-hover-solid:#122033;
  color-scheme:dark;
  background:#05080e;
  color:var(--dsw-alias-label-primary);
}

/* ── 面板头 ── */
.dshSplitWs_head{
  position:relative;
  z-index:2;
  align-items:center;
  padding:12px 22px 11px;
  background:linear-gradient(180deg,rgba(8,14,24,.96),rgba(5,9,16,.90));
  border-bottom:1px solid rgba(94,231,255,.16);
  box-shadow:0 10px 30px rgba(0,0,0,.35);
}
[data-platform=darwin] .dshSplitWs_head{padding-top:calc(10px + var(--dsh-frame-top-clearance,0px))}
.dshSplitWs_head::after{
  content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(94,231,255,.6) 22%,rgba(167,139,250,.28) 56%,transparent);
  background-size:220% 100%;
  animation:dshSciHeadSweep 7s linear infinite;
}
.dshSplitWs_title{
  position:relative;margin:0;padding-top:11px;
  font-size:17px;line-height:1.2;font-weight:600;letter-spacing:.06em;color:#eef8ff;
  text-shadow:0 0 18px rgba(94,231,255,.18);
}
.dshSplitWs_title::before{
  content:"WORKSPACE GRID · NODES";
  position:absolute;left:0;top:0;
  font-family:ui-monospace,"Nimbus Mono PS","Courier New",monospace;
  font-size:8.5px;line-height:1;font-weight:400;letter-spacing:.24em;
  color:#5ee7ff;opacity:.8;white-space:nowrap;
}
.dshSplitWs_headActions{gap:8px}
.dshSplitWs_head .dshSplitWs_iconButton{
  width:28px;height:28px;border:1px solid transparent;border-radius:3px;color:#7c98b3;
}
.dshSplitWs_head .dshSplitWs_iconButton:hover:not(:disabled){
  color:#5ee7ff;border-color:rgba(94,231,255,.28);background:rgba(94,231,255,.05);
  box-shadow:0 0 10px rgba(94,231,255,.08);
}
.dshSplitWs_modes{
  display:inline-flex;align-items:center;gap:2px;padding:2px;
  border:1px solid #1a2b41;border-radius:3px;background:rgba(4,8,14,.5);
}
.dshSplitWs_mode{
  padding:4px 10px;border:0;border-radius:2px;background:transparent;
  color:#7c98b3;font:inherit;font-size:11.5px;line-height:1.4;cursor:pointer;
  transition:color .15s ease,background .15s ease,box-shadow .15s ease;
}
.dshSplitWs_mode:hover{color:#c7e6f8}
.dshSplitWs_mode[aria-pressed=true]{
  background:linear-gradient(180deg,rgba(94,231,255,.18),rgba(94,231,255,.05));
  color:#dff8ff;box-shadow:0 0 14px rgba(94,231,255,.15),inset 0 0 12px rgba(94,231,255,.06);
  text-shadow:0 0 10px rgba(94,231,255,.35);
}
.dshSplitWs_headError{
  position:relative;z-index:2;
  background:rgba(255,77,109,.04);
  border-bottom:1px solid rgba(255,77,109,.18);
}

/* ── 棋盘 ── */
.dshSplitWs_board{
  position:relative;
  padding:12px 14px 14px;
  counter-reset:dshSciNode;
  background:
    radial-gradient(ellipse 50% 35% at 14% -6%,rgba(94,231,255,.10),transparent 62%),
    radial-gradient(ellipse 42% 32% at 92% 108%,rgba(167,139,250,.08),transparent 62%),
    radial-gradient(circle,rgba(94,231,255,.18) 1px,transparent 1.15px) 0 0/22px 22px,
    #05080e;
}

/* ── 窗格 ── */
.dshSplitWs_pane{
  position:relative;
  counter-increment:dshSciNode;
  border:1px solid #24425f;
  border-radius:16px;
  background:
    radial-gradient(circle at 50% 0%,rgba(94,231,255,.035),transparent 62%),
    linear-gradient(180deg,rgba(12,22,38,.94),rgba(6,11,20,.97));
  box-shadow:0 12px 30px rgba(0,0,0,.42),inset 0 0 38px rgba(56,140,200,.035);
}

.dshSplitWs_pane[data-drop=true]{
  border-color:#5ee7ff;
  box-shadow:0 0 0 2px rgba(94,231,255,.65),0 0 30px rgba(94,231,255,.25);
}
.dshSplitWs_pane::before{
  content:"";position:absolute;inset:0;z-index:6;padding:1px;border-radius:5px;pointer-events:none;
  background:conic-gradient(from var(--dshSciRing,0deg),transparent 0deg 205deg,rgba(94,231,255,.65) 248deg,rgba(94,231,255,.06) 286deg,transparent 326deg 360deg);
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;
  mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  mask-composite:exclude;
  animation:dshSciRingSpin 7s linear infinite;
  opacity:.9;
}

@property --dshSciRing{syntax:"<angle>";initial-value:0deg;inherits:false}
@keyframes dshSciRingSpin{to{--dshSciRing:360deg}}


/* ── 窗格标题栏 ── */
.dshSplitWs_paneHead{
  position:relative;
  gap:4px;
  padding:18px 5px 6px 10px;
  border-bottom:1px solid #1a2b41;
  background:linear-gradient(180deg,rgba(12,21,35,.92),rgba(8,14,24,.75));
  color:#dceaf7;
  cursor:grab;
}
.dshSplitWs_paneHead::before{
  content:"●  NODE " counter(dshSciNode,decimal-leading-zero);
  position:absolute;left:10px;top:4px;
  font-family:ui-monospace,"Nimbus Mono PS","Courier New",monospace;
  font-size:8px;line-height:1.4;letter-spacing:.18em;
  color:#5ee7ff;opacity:.8;pointer-events:none;white-space:nowrap;
}
.dshSplitWs_paneHead::after{
  content:"";position:absolute;left:0;right:0;top:0;height:1px;pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(94,231,255,.45),transparent);
  opacity:.55;
}
.dshSplitWs_pane[data-active=true] .dshSplitWs_paneHead{
  border-bottom-color:transparent;
  background:linear-gradient(180deg,rgba(26,20,18,.94),rgba(12,12,16,.82));
  color:#eef8ff;
}
.dshSplitWs_pane[data-active=true] .dshSplitWs_paneHead::before{
  content:"●  NODE " counter(dshSciNode,decimal-leading-zero) "  /  ACTIVE";
  color:#ffb066;opacity:.9;
}
.dshSplitWs_pane[data-active=true] .dshSplitWs_paneHead::after{
  background:linear-gradient(90deg,transparent,rgba(255,122,26,.7),transparent);
  opacity:.9;
}
.dshSplitWs_wsName{font-size:13.5px;line-height:1.4;font-weight:600;letter-spacing:.01em;color:#e9f4ff}
.dshSplitWs_wsPath{
  font-family:ui-monospace,"Nimbus Mono PS","Courier New",monospace;
  font-size:8.5px;line-height:1.5;color:#7c98b3;
}
.dshSplitWs_pane[data-active=true] .dshSplitWs_wsName{color:#eef8ff}
.dshSplitWs_pane[data-active=true] .dshSplitWs_wsPath{color:#9fb6c9;opacity:1}
.dshSplitWs_pane .dshSplitWs_iconButton{width:24px;height:24px;color:#6d8499;border-radius:3px}
.dshSplitWs_pane .dshSplitWs_iconButton:hover:not(:disabled){
  color:#5ee7ff;background:rgba(94,231,255,.06);box-shadow:0 0 10px rgba(94,231,255,.08);
}
.dshSplitWs_pane[data-active=true] .dshSplitWs_iconButton{color:#8fa8bd;opacity:1}
.dshSplitWs_pane[data-active=true] .dshSplitWs_iconButton:hover:not(:disabled){
  color:#ffb066;background:rgba(255,122,26,.08);opacity:1;
}
.dshSplitWs_pane[data-active=true] .dshSplitWs_iconButtonOpen{
  background:rgba(255,122,26,.1);color:#ffb066;opacity:1;
}
.dshSplitWs_trigger{height:22px;padding:0 5px;border:1px solid transparent;border-radius:3px;color:#7c98b3;font-size:10.5px}
.dshSplitWs_trigger:hover:not(:disabled){color:#5ee7ff;background:rgba(94,231,255,.05)}
.dshSplitWs_triggerOpen{border-color:#24425f;background:rgba(10,18,30,.8);color:#dceaf7}
.dshSplitWs_pane[data-active=true] .dshSplitWs_trigger{color:#8fa8bd;opacity:1}
.dshSplitWs_pane[data-active=true] .dshSplitWs_trigger:hover:not(:disabled){
  color:#ffb066;background:rgba(255,122,26,.06);
}
.dshSplitWs_pane[data-active=true] .dshSplitWs_triggerOpen{
  background:rgba(255,122,26,.08);border-color:rgba(255,122,26,.25);color:#ffb066;
}

/* ── 会话视图标签 ── */
.dshSplitWs_paneViewTabs{
  background:rgba(8,14,24,.5);
  border-bottom:1px solid #1a2b41;
  padding:0 14px;gap:16px;
}
.dshSplitWs_paneViewTab{
  padding:5px 0 7px;font-size:11.5px;letter-spacing:.06em;color:#6d8499;
}
.dshSplitWs_paneViewTab:hover{color:#c7e6f8}
.dshSplitWs_paneViewTabActive{color:#5ee7ff}
.dshSplitWs_paneViewTabActive::after{background:#5ee7ff;box-shadow:0 0 8px rgba(94,231,255,.6)}
.dshSplitWs_pane[data-active=true] .dshSplitWs_paneViewTabActive{color:#ffb066}
.dshSplitWs_pane[data-active=true] .dshSplitWs_paneViewTabActive::after{
  background:#ff7a1a;box-shadow:0 0 8px rgba(255,122,26,.6);
}

/* ── 内容区 ── */
/*
 * 内容区背景：每个窗格按自己的 --dshSplitWs-pane-tint 做一层「半透明彩色玻璃」。
 *
 * 不是把整块底色染成一个实心色，而是：
 *   1. 左上角一团柔光（径向渐变，最高 20% 色相），向右下淡出；
 *   2. 顶部一条很薄的色雾（线性渐变，8% → 透明），把标题栏与内容区接起来；
 *   3. 最底层仍是原来的深色 #05080e。
 * 色相只出现在这三层半透明渐变里，所以靠近底部的正文区几乎回到原深色，
 * 待久了不会觉得在看一块彩色纸。
 *
 * 会话根与气泡的背景 token 也改成半透明深色（rgba），让渐变透上来：
 *   - bg-base 只留 48% 深色遮罩，是「玻璃」的厚度；
 *   - 气泡 / 输入框 / 代码块保持接近原色的深色，只掺 6%~8% 色相，
 *     避免整段对话连同气泡一起变成色块（这是第一版最难看的地方）。
 *
 * 文字 token 基本不动：正文 #dceaf7、次要 #9fb6c9 在每一层上对比度都 > 7:1；
 * 只有三级文字（时间戳、状态、路径）从 #6f8aa0 提亮到 #839db2 —— 原色在
 * 左上角最亮的 20% 光晕上只有约 3.9:1，提亮后最差也有 4.6:1。
 */
.dshSplitWs_paneBody{
  color-scheme:dark;
  background:
    radial-gradient(125% 78% at 0% 0%,
      color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 20%,transparent) 0%,
      color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 7%,transparent) 36%,
      transparent 68%),
    linear-gradient(180deg,
      color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 8%,transparent) 0%,
      transparent 44%),
    #05080e;
  --dsw-alias-bg-base:color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 5%,rgba(5,8,14,.44));
  --dsw-alias-bg-layer-1:color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 8%,rgba(10,18,32,.68));
  --dsw-alias-bg-layer-2:color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 10%,rgba(14,25,41,.8));
  --dsw-specific-bubble:color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 5%,rgba(14,25,41,.9));
  --dsw-specific-input-major:color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 6%,rgba(11,20,35,.9));
  --dsw-alias-markdown-code-block:rgba(5,8,14,.72);
  --dsw-alias-markdown-code-block-banner:rgba(10,18,32,.78);
  --dsw-alias-markdown-inline-code:rgba(14,25,41,.8);
  --dsw-alias-label-tertiary:#839db2;
  --dsw-alias-label-caption:#839db2;
}
.dshSplitWs_paneViewContent{
  background:transparent;scrollbar-width:thin;
  scrollbar-color:color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 26%,transparent) transparent;
}
.dshSplitWs_paneViewContent *{
  scrollbar-width:thin;
  scrollbar-color:color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 26%,transparent) transparent;
}
.dshSplitWs_paneBody ::-webkit-scrollbar{width:8px;height:8px}
.dshSplitWs_paneBody ::-webkit-scrollbar-thumb{
  border-radius:8px;
  background:color-mix(in srgb,var(--dshSplitWs-pane-tint,#5ee7ff) 24%,transparent);
}
.dshSplitWs_paneBody ::-webkit-scrollbar-track{background:transparent}
.dshSplitWs_paneError{
  background:rgba(255,77,109,.05);border-bottom:1px solid rgba(255,77,109,.22);color:#ff8ba0;
}
.dshSplitWs_paneEmpty{color:#7c98b3}

/* ── 正文逐行浮现（主界面与平铺面板的助手正文） ── */
/*
 * 让助手正文按「段落 / 列表项 / 标题 / 引用 / 代码块 / 表格」逐块淡入上浮，
 * 每块 2 秒。相比原来整条消息一起出现，视觉上就是一行接一行浮现：
 *   - Markdown 的每个 <p>、<li>、<h*> 是独立块，各自有自己的动画；
 *   - 同一段落内部的自动换行仍是一个块（浏览器排版结果，CSS 无法拆成视觉行）；
 *   - 用户消息（user）、工具调用（tool-call）、思考过程（reasoning）不命中；
 *   - 行内节点（strong/em/code/span）不单独动画，避免逐字抖动。
 *
 * 流式输出时新段落是新建节点，播放一次；已有段落由 React 复用，不会每来
 * 一个 token 重播。用 both 让每块在动画开始前保持透明。
 *
 * 第一条选择器覆盖主界面会话（以及平铺面板里的会话，它们同样带
 * [data-conversation-content]）；第二条保留给没有这个属性的旧会话根。
 */
@keyframes dshSplitWsTextRise{
  from{opacity:0;transform:translateY(6px)}
  to{opacity:1;transform:translateY(0)}
}
[data-conversation-content] [data-chat-flow-key][data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"]) :is(p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,table),
.dshSplitWs_paneBody [data-chat-flow-key][data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"]) :is(p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,table){
  animation:dshSplitWsTextRise 2s cubic-bezier(.2,.8,.2,1) both;
}
@media (prefers-reduced-motion:reduce){
  [data-conversation-content] [data-chat-flow-key][data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"]) :is(p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,table),
  .dshSplitWs_paneBody [data-chat-flow-key][data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"]) :is(p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,table){animation:none !important}
}

/* ── 派单流星 ── */
/*
 * 光点是一个 1px 定位容器：offset-path 由 client.fx.js 随机生成，容器沿路径
 * 移动并自动转向。头部 7px 白心；外面一圈 76px 金色柔光；后面两条（粗光带 +
 * 白色亮芯）形成流星尾巴。没有轨迹线。
 */
.dshSplitWs_fxComet{
  position:fixed;left:0;top:0;width:1px;height:1px;
  offset-rotate:auto;pointer-events:none;z-index:2147483000;
  will-change:offset-distance;mix-blend-mode:screen;
}
.dshSplitWs_fxGlow{
  position:absolute;left:0;top:0;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;
  background:radial-gradient(circle,rgba(255,245,205,.5) 0%,rgba(255,210,122,.25) 40%,rgba(255,190,60,0) 75%);
  filter:blur(8px);pointer-events:none;
}
.dshSplitWs_fxHead{
  position:absolute;left:0;top:0;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;
  background:radial-gradient(circle,#fff 0 30%,#fff3c4 48%,#ffd27a 70%,rgba(255,170,40,0) 100%);
  box-shadow:0 0 8px #fff,0 0 22px #ffd27a,0 0 46px rgba(255,190,60,.95);
}
.dshSplitWs_fxTail{
  position:absolute;left:-96px;top:-2px;width:96px;height:4px;border-radius:999px;
  background:linear-gradient(90deg,rgba(255,190,60,0) 0%,rgba(255,210,122,.18) 38%,rgba(255,235,190,.75) 84%,rgba(255,255,255,.95) 100%);
  filter:blur(1px);
}
.dshSplitWs_fxTailCore{
  position:absolute;left:-72px;top:-.75px;width:72px;height:1.5px;border-radius:999px;
  background:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,250,220,.9) 100%);
  filter:blur(.3px);
}
/*
 * 窗格边框高亮：一个和窗格等大的独立描边框，盖在 body 上。
 * 不走窗格自己的 box-shadow，避免被选中态/overflow 吃掉；颜色由 JS 按源/目标设置。
 */
.dshSplitWs_fxFlash{
  position:fixed;box-sizing:border-box;border:3px solid transparent;border-radius:10px;
  pointer-events:none;z-index:2147483000;mix-blend-mode:screen;
  will-change:opacity,box-shadow;
}
/*
 * 命中白光：盖住整个窗格的半透明白色层，出现很快、消失较慢。
 * 放在边框高亮下面，边框仍然看得见。
 */
.dshSplitWs_fxHit{
  position:fixed;box-sizing:border-box;background:#fff;border-radius:10px;
  pointer-events:none;z-index:2147482999;will-change:opacity;
}

/* ── 分隔条：发光竖线 + 呼吸菱形 ── */
.dshSplitWs_splitter::before{
  content:"";position:absolute;left:50%;top:50%;width:5px;height:5px;
  transform:translate(-50%,-50%) rotate(45deg);
  border:1px solid rgba(94,231,255,.55);background:#05080e;
  box-shadow:0 0 8px rgba(94,231,255,.35);
  animation:dshSciSplit 3.2s ease-in-out infinite;
  pointer-events:none;
}
.dshSplitWs_splitterLine{
  width:1px;height:34px;border-radius:0;
  background:linear-gradient(180deg,transparent,rgba(94,231,255,.28),transparent);
}
.dshSplitWs_splitter[data-dir=col] .dshSplitWs_splitterLine{
  width:34px;height:1px;
  background:linear-gradient(90deg,transparent,rgba(94,231,255,.28),transparent);
}
.dshSplitWs_splitter:hover .dshSplitWs_splitterLine,
.dshSplitWs_splitter:focus-visible .dshSplitWs_splitterLine,
.dshSplitWs_splitterActive .dshSplitWs_splitterLine{
  background:rgba(94,231,255,.6);transform:none;box-shadow:0 0 10px rgba(94,231,255,.35);
}
@keyframes dshSciHeadSweep{from{background-position:120% 0}to{background-position:-120% 0}}
@keyframes dshSciSplit{
  0%,100%{transform:translate(-50%,-50%) rotate(45deg) scale(1);box-shadow:0 0 8px rgba(94,231,255,.3)}
  50%{transform:translate(-50%,-50%) rotate(45deg) scale(1.25);box-shadow:0 0 16px rgba(94,231,255,.6)}
}

@media (max-width:1320px){
  .dshSplitWs_title{font-size:15px}
  .dshSplitWs_wsName{font-size:13px}
  .dshSplitWs_paneHead{padding-top:16px}
}
@media (prefers-reduced-motion:reduce){
  .dshSplitWs_head::after,
  .dshSplitWs_pane::before,
  .dshSplitWs_splitter::before{animation:none !important}
}
`,
    ].join('');

    /** class 名对照表：组件里统一用这里的名字，避免散落的裸字符串。 */
    const css = {
      root: 'dshSplitWs_root',
      floatingPane: 'dshSplitWs_floatingPane',
      floatingPaneActive: 'dshSplitWs_floatingPaneActive',
      floatingBar: 'dshSplitWs_floatingBar',
      floatingTitle: 'dshSplitWs_floatingTitle',
      floatingClose: 'dshSplitWs_floatingClose',
      floatingBody: 'dshSplitWs_floatingBody',
      floatResize: 'dshSplitWs_floatResize',
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
      paneNotice: 'dshSplitWs_paneNotice',
      newSessionOverlay: 'dshSplitWs_newSessionOverlay',
      newSessionBox: 'dshSplitWs_newSessionBox',
      newSessionTitle: 'dshSplitWs_newSessionTitle',
      newSessionOption: 'dshSplitWs_newSessionOption',
      newSessionOptionLabel: 'dshSplitWs_newSessionOptionLabel',
      newSessionOptionHint: 'dshSplitWs_newSessionOptionHint',
      newSessionCancel: 'dshSplitWs_newSessionCancel',
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
      saveLayout: 'dshSplitWs_saveLayout',
      saveSpinner: 'dshSplitWs_saveSpinner',
      primary: 'dshSplitWs_primary',
      iconButton: 'dshSplitWs_iconButton',
      iconButtonOpen: 'dshSplitWs_iconButtonOpen',
      popover: 'dshSplitWs_popover',
      trigger: 'dshSplitWs_trigger',
      triggerOpen: 'dshSplitWs_triggerOpen',
      triggerLabel: 'dshSplitWs_triggerLabel',
      sessionLabel: 'dshSplitWs_sessionLabel',
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
      graphActions: 'dshSplitWs_graphActions',
      graphVideoButton: 'dshSplitWs_graphVideoButton',
      graphVideoIcon: 'dshSplitWs_graphVideoIcon',
      graphReject: 'dshSplitWs_graphReject',
      graphDegraded: 'dshSplitWs_graphDegraded',
      graphScroll: 'dshSplitWs_graphScroll',
      graphCanvas: 'dshSplitWs_graphCanvas',
      graphSvg: 'dshSplitWs_graphSvg',
      graphEdge: 'dshSplitWs_graphEdge',
      graphEdgeFlow: 'dshSplitWs_graphEdgeFlow',
      graphEdgePending: 'dshSplitWs_graphEdgePending',
      graphArrow: 'dshSplitWs_graphArrow',
      graphDiagnostic: 'dshSplitWs_graphDiagnostic',
      graphEdgeEdit: 'dshSplitWs_graphEdgeEdit',
      graphEdgeNote: 'dshSplitWs_graphEdgeNote',
      graphEdgeNoteDot: 'dshSplitWs_graphEdgeNoteDot',
      graphEdgeNoteText: 'dshSplitWs_graphEdgeNoteText',
      graphEdgeEditor: 'dshSplitWs_graphEdgeEditor',
      graphEdgeEditorTitle: 'dshSplitWs_graphEdgeEditorTitle',
      graphEdgeEditorHint: 'dshSplitWs_graphEdgeEditorHint',
      graphEdgeEditorInput: 'dshSplitWs_graphEdgeEditorInput',
      graphEdgeEditorActions: 'dshSplitWs_graphEdgeEditorActions',
      graphEdgeDelete: 'dshSplitWs_graphEdgeDelete',
      graphBody: 'dshSplitWs_graphBody',
      graphPicker: 'dshSplitWs_graphPicker',
      graphPickerHead: 'dshSplitWs_graphPickerHead',
      graphPickerTitle: 'dshSplitWs_graphPickerTitle',
      graphPickerHeadTop: 'dshSplitWs_graphPickerHeadTop',
      graphPickerCollapse: 'dshSplitWs_graphPickerCollapse',
      graphPickerExpand: 'dshSplitWs_graphPickerExpand',
      graphPickerHint: 'dshSplitWs_graphPickerHint',
      graphPickerScroll: 'dshSplitWs_graphPickerScroll',
      graphPickerEmpty: 'dshSplitWs_graphPickerEmpty',
      graphPickerGroup: 'dshSplitWs_graphPickerGroup',
      graphPickerGroupHead: 'dshSplitWs_graphPickerGroupHead',
      graphPickerGroupToggle: 'dshSplitWs_graphPickerGroupToggle',
      graphPickerGroupActions: 'dshSplitWs_graphPickerGroupActions',
      graphPickerGroupAction: 'dshSplitWs_graphPickerGroupAction',
      graphPickerGroupOpen: 'dshSplitWs_graphPickerGroupOpen',
      graphPickerChevron: 'dshSplitWs_graphPickerChevron',
      graphPickerGroupLabel: 'dshSplitWs_graphPickerGroupLabel',
      graphPickerDot: 'dshSplitWs_graphPickerDot',
      graphPickerItems: 'dshSplitWs_graphPickerItems',
      graphPickerItem: 'dshSplitWs_graphPickerItem',
      graphPickerCardTop: 'dshSplitWs_graphPickerCardTop',
      graphPickerCardWorkspace: 'dshSplitWs_graphPickerCardWorkspace',
      graphPickerCardRun: 'dshSplitWs_graphPickerCardRun',
      graphPickerCardTitle: 'dshSplitWs_graphPickerCardTitle',
      graphPickerCardHint: 'dshSplitWs_graphPickerCardHint',
      graphPickerCardHintText: 'dshSplitWs_graphPickerCardHintText',
      graphPickerCardArrow: 'dshSplitWs_graphPickerCardArrow',
      graphCard: 'dshSplitWs_graphCard',
      graphCardEmpty: 'dshSplitWs_graphCardEmpty',
      graphCardBody: 'dshSplitWs_graphCardBody',
      graphCardAgent: 'dshSplitWs_graphCardAgent',
      mason: 'dshSplitWs_mason',
      masonBack: 'dshSplitWs_masonBack',
      masonBody: 'dshSplitWs_masonBody',
      masonEye: 'dshSplitWs_masonEye',
      masonWall: 'dshSplitWs_masonWall',
      masonBrickBase: 'dshSplitWs_masonBrickBase',
      masonBrickShadow: 'dshSplitWs_masonBrickShadow',
      masonBrick: 'dshSplitWs_masonBrick',
      masonBrickTop: 'dshSplitWs_masonBrickTop',
      masonBrickFace: 'dshSplitWs_masonBrickFace',
      masonSweatLayer: 'dshSplitWs_masonSweatLayer',
      masonZzz: 'dshSplitWs_masonZzz',
      masonSweat: 'dshSplitWs_masonSweat',
      graphCardWorkspace: 'dshSplitWs_graphCardWorkspace',
      graphCardTitle: 'dshSplitWs_graphCardTitle',
      graphCardMeta: 'dshSplitWs_graphCardMeta',
      graphCardRunning: 'dshSplitWs_graphCardRunning',
      graphCardStaged: 'dshSplitWs_graphCardStaged',
      graphCardState: 'dshSplitWs_graphCardState',
      graphPickerCardState: 'dshSplitWs_graphPickerCardState',
      graphPickerDelete: 'dshSplitWs_graphPickerDelete',
      graphPickerCardTopWithDelete: 'dshSplitWs_graphPickerCardTopWithDelete',
      graphCardActions: 'dshSplitWs_graphCardActions',
      graphCardRename: 'dshSplitWs_graphCardRename',
      graphPickerActions: 'dshSplitWs_graphPickerActions',
      graphPickerRename: 'dshSplitWs_graphPickerRename',
      graphRenameBackdrop: 'dshSplitWs_graphRenameBackdrop',
      graphRenamePanel: 'dshSplitWs_graphRenamePanel',
      graphRenameTitle: 'dshSplitWs_graphRenameTitle',
      graphRenameHint: 'dshSplitWs_graphRenameHint',
      graphRenameInput: 'dshSplitWs_graphRenameInput',
      graphRenameError: 'dshSplitWs_graphRenameError',
      graphRenameActions: 'dshSplitWs_graphRenameActions',
      graphCardRemove: 'dshSplitWs_graphCardRemove',
      graphCardDelete: 'dshSplitWs_graphCardDelete',
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
