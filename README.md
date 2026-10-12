English | [中文](README.zh-CN.md)

# dsh-split-workspaces

A local DSH plugin bundle: it tiles several workspaces **side by side and stacked** in the
main panel of the Harness Web UI, one workspace conversation per pane. Splitters can be
dragged to resize, title bars can be dragged to swap two panes' positions, and the pane
that currently holds focus is marked by a brand-coloured title bar.

## What it adds

- One row of icons in the sidebar (two tiled squares, right next to the Plugins icon);
  clicking it switches the main area to the **multi-workspace tiled** panel.
- The panel itself: at the top are `Add workspace` / `Even out` / `Close all`, below is the
  board — every pane has its own title bar (workspace name and path, the `Open directory`
  icon, the `Split` icon, mode selector, session selector, close), and inside the pane it
  reuses the shared `conversation.content` Factory (the `embedded` variant), mounted under an
  explicit `SessionProvider` binding, so each pane is a complete conversation (transcript,
  input box, streaming output).
- **The `Open directory` icon** (the folder to the right of the workspace name): clicking it
  hands **that pane's** workspace directory to the system file manager (Linux `xdg-open`,
  macOS Finder, Windows Explorer). It does not implement this machinery itself; instead it
  reuses the two methods of the already-installed Session remote namespace
  (`@deepseek-ai/dsh-api-session-controller`): `canOpenWorkspacePath()` first answers
  "can this deployment hand a path to the desktop" (a Linux container with no graphical
  environment answers false, which is exactly what "there is no file manager in front of
  you" means), and then `openWorkspacePath({ path })` **validates** in the composite
  filesystem that this path really is a directory the Host can open, and opens it according
  to the operating system's association — a directory's association is the file manager.
  So "which command to use to open it" has only one implementation and one set of
  validations, and this plugin does not have to add a row on the Host or make users restart.
  Availability is a deployment-level fact and is asked only once; a directory that is not in
  the Host mapping, a file manager that will not start, a deployment with no session
  service, or no graphical environment at all are each spelled out in the pane's own error
  line (the localised reason first, the Host's original text appended as detail).
- **How tiling works**: `Add workspace` always attaches the new pane to the right edge of
  the whole board; the **split menu on each pane's title bar has two steps**: the first step
  picks a direction (left, right, up, down), the second step picks **the workspace to put
  into the new pane**. Picking a direction does not split immediately, nor does it casually
  open another pane for the current pane's own workspace — the point of tiling is to spread
  **different** workspaces out. So any combination can be assembled, for example "two side
  by side on top, one below" = first split A downwards (pick C), then split A to the right
  (pick B). Besides listing the existing workspaces, the second step also has a
  `New workspace…` row for picking a brand-new directory directly. One icon button plus two
  menu steps saves more title-bar width than four buttons in a row.
- **Drag to resize**: between panes there is a draggable splitter; a left-right layout is
  dragged left-right, a top-bottom layout is dragged up-down. Double-clicking the splitter
  restores the even balance, and after focusing the splitter the arrow keys fine-tune it
  (hold Shift for a bigger step). The ratio is stored as "a percentage of the container", so
  the layout ratio is unchanged after the window is resized.
- **Drag the title bar to swap positions**: press and hold a pane's title bar (except the
  buttons, dropdowns and menu panels inside it), drag it onto **another pane** and release,
  and the two panes swap positions. During the drag only the drop-target pane lights up with
  an accent-coloured ring and the dragged pane fades out; **the swap happens only on
  release**; releasing over empty space does nothing. What it swaps is **positions**, not
  contents: each pane's workspace, session and preselected mode all travel with it, so the
  highlight and the keyboard caret also follow the dragged pane to its new position (after a
  swap the caret waits one frame before being placed back into its input box, for the same
  reason as "closing a pane waits one frame"). A press that moves less than 4 pixels still
  counts as a **single click** (lighting up the pane, handing over the caret), so the title
  bar remains the "click once to focus" handle. There is no Esc to cancel, no dragging to an
  edge to split, and no keyboard swap — those are all extra semantics beyond "swap only on
  release".
- **Focus highlight**: whichever pane you press the mouse in or Tab into becomes the current
  focus — only its **entire title bar is a blue gradient with white text** (workspace name,
  path, mode/session triggers and buttons all turn white together), while the pane itself
  keeps the same thin border as the other panes, with no highlight ring and no outer glow;
  when the focused pane is closed, focus automatically goes to the pane that takes its place.
- **The keyboard caret follows the highlight** (an invariant that must hold in both
  directions): when a pane lights up, the caret also enters its input box; conversely, when
  the user clicks on a **control** inside a pane (title-bar buttons, dropdowns, the copy
  button in a message, links, the input box itself), the caret stays there and is never
  stolen. Losing the first half produces very hard-to-self-diagnose bugs — you click into the
  right pane's message area, think you are talking to it, and the characters you type go
  somewhere else; losing the second half destroys the title bar's keyboard accessibility and
  its popup menus. When the user has just drag-selected a piece of text, nothing is touched
  at all (`focus()` wipes that selection out entirely, see pitfall 5). When the current pane
  is closed, the pane that replaces it takes over the caret **after the next reflow** (it is
  remounted; the reason is likewise in pitfall 5). When a pane has no typeable input box (no
  session yet, or the host is inert), only the highlight switches and the caret is left
  alone. The two ends of the gradient are mixed from the blue accent colour and a static
  black token (`color-mix`), which both produces the dark-to-light blue in the design and
  raises the white text's contrast above 4.5:1 — pure accent colour with white text is only
  3.3:1, which looks blurry. The offline tests compute the contrast of each end of the
  gradient and fail immediately below 4.5:1. The buttons on the focused title bar (the split
  icon, the mode/session dropdowns, close) use a **black darkening** on hover / when
  expanded, rather than a white wash: white text on "the pale grey-blue produced by washing
  white 24% over it" is only 3.5:1 and just looks like a grey patch with the text smeared on
  it; with a black base, hover is black 50% (the base still shows a hint of blue) and
  expanded is pure black, giving the same white text 11:1 and 21:1 respectively, and the
  offline tests compute each end the same way.
- **`Alt+arrow keys` moves focus**: pressing `Alt+←/→/↑/↓` gives focus to the pane at
  **the corresponding position in that direction**, and sends the keyboard caret into its
  input box as well (so you can type immediately after switching, without ever touching the
  mouse). The direction is decided by the panes' **rectangles**, not by the layout tree's
  nesting: a candidate must lie entirely beyond that direction and must overlap on the
  perpendicular axis; nearer wins → more overlap wins → better-centred wins. So in "top row
  A|B, bottom row C|D", A with `Alt+↓` can only reach C (D does not overlap A's row at all),
  and in the three-in-a-row "A | X | B", A with `Alt+→` reaches the adjacent X first rather
  than skipping over it. Pressing again at the far edge **does nothing** (it does not wrap
  around to the opposite side): cycling would make people lose their bearings among a screen
  full of panes. These four key bindings are also registered in the framework's shortcut
  roster, so they show up in **Settings → Shortcuts** and can no longer be assigned to
  another command.
- **The dropdown menu panel's background** uses the "raised surface"
  `--dsw-alias-bg-layer-2` (dark #2c2c2e / light #fff), not `--dsw-alias-bg-overlay` —
  the latter is a mid grey #61666b in the dark theme, leaving white text on the panel at only
  5.6:1 and secondary text ("current", "This session has already started…") at only
  3.9:1. After changing the background they are 13.3:1 and 9.3:1 respectively in the dark
  theme. Relatedly, menu items' hover was changed from `bg-layer-2` to `currentColor 8%`:
  the panel is itself `bg-layer-2`, so using it as the hover background is the same as
  nothing happening when you press.
- **An independent Agent mode selector per pane** (Standard / PTC / Minimal / Cordis, plus
  custom presets): it uses the same Host roster as creating a new task from the sidebar
  (`remote.agentPresets.list`), and shows both the mode the pane's current session is running
  in and the mode preselected for the next session.
- The `Add workspace` dropdown lists "workspaces that are not tiled yet" and also supports
  **creating** a workspace from the folder picker (`uiWorkspace.pickDirectory()`, or through
  the preload bridge under Desktop). The same "pick a directory → register a workspace"
  implementation also serves `New workspace…` in the split menu's second step, so there is
  only one picker and one failure handling in both places.

## Behaviour details

- Opening the board for the first time seeds it: the workspace containing the current session
  comes first, and another one is added, so it opens as two panes side by side rather than an
  empty area.
- How a pane decides which session to show:
  - **Following** panes (those spread out by `Add workspace`) follow that workspace's most
    recently updated session;
  - once a session is chosen manually (or a new one is created), the pane is pinned to that
    session;
  - **A freshly split** pane starts empty and prompts "Pick an existing session for this
    pane, or start a new one" — so two panes will not inexplicably show the same
    conversation. Which workspace it shows is what the split menu's second step selected.
- **The candidates in the split menu's second step**: it lists **all** workspaces, but those
  not yet tiled come first (the primary intent of splitting is to spread another workspace
  out), while those already tiled in other panes come later with the hint on the right
  changed to `open` (the rest show the path). Keeping already-tiled workspaces is
  deliberate: opening the same workspace in two panes to see two sessions is a legitimate
  use, and after all workspaces are tiled there is still some workspace left to choose for
  splitting. The `Back` row shows the currently selected direction on its right, so the
  second step also shows which way this split is going.
- **`New workspace…` in the second step**: it is present even when no workspace has ever been
  registered, so the board can still grow its first pane. Clicking it opens the folder picker,
  and the chosen directory is registered as a workspace and switched into the new pane
  directly; if the user cancels, nothing happens, and if the picker itself cannot be opened
  the pane states "The folder chooser could not open" rather than a vague add failure. The
  direction is captured into a local variable before the menu closes — closing the menu
  resets `splitDirection`, so by the time the picker returns it can no longer be read.
- The split menu is a **controlled** popup menu (the `Popover`'s `open` + `onOpenChange`):
  only this way can it be reset from the outside. Picking a direction, choosing a workspace,
  clicking elsewhere, pressing Esc — any of these closes it and resets the menu back to the
  first step, otherwise the next time it opens it would be stuck on the previously chosen
  direction. The offline tests have one assertion each for the two paths "after choosing a
  workspace" and "after closing by clicking elsewhere".
- Each pane separately holds a `ctx.sessions.retain(..., { source: 'splitWorkspaces' })`
  reference, so the sidebar's main selection is unaffected and multiple sessions can be open
  at the same time.
- **Dragging to swap positions does not reopen sessions**: what is swapped is the key of two
  leaves in the layout tree, while the pane records (workspace, session reference,
  preselected mode) do not change a single field, so the `useSessionReference` effect of
  either pane does not re-run even once — as long as the reference is not released, the
  conversation's history and local state stay entirely intact. This path only holds for
  splits **at the same level** (React only moves things by key between sibling nodes); a
  cross-level swap still rebuilds those two subtrees, see pitfall 6.
- The pane list and layout tree are kept in the plugin (not in React state), so switching
  back to the Conversation panel and back again does not lose them; only a page refresh
  resets them.
- Mode selection is **per pane**: while the session is still blank the selection takes effect
  immediately (`remote.agentPresets.select`); once the session has run a turn the Host
  refuses to change the label, so the selection is stashed, marked `next session` in the
  menu, and applied the next time that pane creates a new session. The reason for the
  refusal is shown on the pane and does not affect session creation.
- A deployment with no preset registry attached gets `gateway/invocation-unavailable`; the
  board keeps working as usual in that case, it simply does not show the mode selector.
- `Add workspace` does not casually create a session, nor does it switch the main panel away.
- **The scope of the focus keys is "this panel is on screen", not "focus is inside a pane"**:
  the listener is attached at the document's capture phase, and when the panel is not shown
  (the board root node's marker is absent) it does nothing at all, so cases like having
  clicked the board's empty area or having just switched over with the sidebar icon — where
  focus sits on `body` / the sidebar — still work. This one was reported back by a user from
  real testing, see pitfall 4 below. When an overlay (menu / dialog) covers the board, or
  when focus is in an input box outside the board, everything is let through: those keys
  belong to someone else (the key recording in "Settings → Shortcuts" happens inside an
  overlay). After switching, the keyboard caret follows into the target pane's input box;
  when the target pane has no session yet and no editable input box, only the highlight
  switches and the caret is **not** stolen from the previous pane.
- **Caret ownership when the mouse lights up a pane**: handing over the caret is attached to
  `click` (**not** `pointerdown`), and **two** kinds of landing points are given up — landing
  points that are controls (buttons / links / menu items / input boxes / editable areas), and
  the case where the user has just drag-selected a piece of text (the selection is not
  collapsed). The former is so as not to interrupt "the user is operating that control", the
  latter because `focus()` measurably wipes that selection out entirely. Both were measured
  in a real browser, see pitfall 5. `Tab`-ing into a pane only switches the highlight and
  does not move the caret: Tab's landing point is the browser's territory, and the title-bar
  buttons and the other focusable elements in the conversation area must all remain
  Tab-reachable.

## The six pitfalls we hit (read this before changing this code)

1. **Focus used the wrong colour token.** `--dsw-alias-brand-primary` is a **near-white**
   neutral fill in the dark theme (`--dsw-static-neutral-bluish-50`); using it as the
   focused title bar's background together with white text gives white on white. The blue
   accent colour is `--dsw-alias-brand-primary-new-colorprimary-new-color` (light #4176e6 /
   dark #5686fe), with the static `--dsw-static-deepseek-500` as fallback — do **not** fall
   back to that neutral fill. Two assertions in the offline tests guard this. In addition,
   white text directly on the pure accent colour is only 3.3:1, so both ends of the gradient
   must be mixed with black to deepen the blue.

2. **Optional children in the title bar must carry a key.** React matches sibling nodes
   without keys by position: once a child that "sometimes exists and sometimes does not" —
   such as the focus marker or the mode selector — appears/disappears, the positions shift,
   and React **reuses** the very button the user just pressed the mouse on as a different
   control, so the `click` lands on the wrong handler. The real symptom was "clicking `Split
   down` turns into `Split right`". Now the title bar, the error line and the conversation
   body all carry fixed keys, and the offline tests check "all keys present and unique" and
   "the title bar structure is exactly identical before and after a focus switch".

3. **Why the focus keys are Alt, and why they must be attached at the capture phase.** This
   group of keys has to work inside the input box too, and Chromium's contenteditable has
   already taken all the common arrow-key combinations: `Shift+←/→` selects character by
   character, `Shift+↑/↓` selects line by line, `Ctrl+←/→` moves the caret word by word,
   `Ctrl+↑/↓` jumps to the start/end of a paragraph, `Ctrl+Shift+←/→` selects word by word.
   So Shift or Ctrl alone combined with an arrow key would kill a high-frequency operation
   inside the input box. `Ctrl+Alt+arrow keys` looks like a way out, but in practice the
   desktop environment has taken it (GNOME/Unity's
   `switch-to-workspace-{left,right,up,down}` is exactly `Ctrl+Alt+arrow keys`, eaten at the
   window manager level so the page never receives it). **Only `Alt+arrow keys` has no
   native meaning inside the input box and is not taken by the desktop**, at the smallest
   cost; its only entanglement is `Alt+←/→` forward/back in the browser — which is why the
   handling must be attached at the **capture phase** and call `preventDefault()` (plus
   `stopPropagation()`, so the input box does not treat it as a caret operation a second
   time). `AltGraph` (which on some layouts equals Ctrl+Alt) and an in-progress IME
   composition are always let through, never stealing keys from the input method.

4. **The keyboard handling cannot be attached to the board node.** The first version attached
   it to the board root node's `onKeyDownCapture`, on the grounds that "only the capture
   phase can get the event before the input box does" — which is true, but it also hid a
   wrong assumption: that the event target is always inside the board. In practice, after
   clicking the board's empty space focus lands on `document.body`, and when you have just
   switched over with the sidebar icon focus is still on the sidebar button; in both cases
   the event does not flow through the board node (synthetic events are dispatched only along
   the target's ancestor chain), so none of the keys responded — what the user saw was "the
   `Alt+arrow keys` only work when focus is inside the input box". Now the listener is
   attached at the capture phase on `document` (still earlier than the input box), and it
   uses the board root node's marker to tell whether the panel is on screen: the main panel
   is rendered by key, so when you switch to another panel the board unmounts and the marker
   disappears with it, and the handling naturally stops working without any extra
   bookkeeping.

5. **"Lighting up a pane hands over the caret" involves two behaviours only a real browser
   can answer.** The offline tests' fake `document` cannot emulate the browser's **default
   actions**; these three were all measured with headless Chrome + CDP **trusted mouse
   input** (`node tools/browser-probe.mjs` re-runs the first two one by one; it does not need
   a DSH service):
   - **It cannot be attached to `pointerdown`**: when single-clicking a non-focusable element
     (a message paragraph is one), the default action of `mousedown` wipes the current focus
     to `body` — a caret produced by calling `focus()` inside `pointerdown` is erased by that
     very step right afterwards. Only attaching to `click` keeps it (`click` has no default
     action that changes focus afterwards).
   - **It cannot focus unconditionally**: calling `focus()` on a contenteditable inside
     `click` **wipes out entirely** a selection that was just dragged out (measured: the
     selection goes from `ectable text here` straight to empty and collapsed). That amounts
     to abolishing "select a message and copy it", so as long as the selection is not
     collapsed, nothing is touched. On a single click, the earlier `mousedown` has already
     cleared the old selection, so it will not be permanently broken because a stale
     selection happens to be left somewhere on the page.
   - **Closing a pane waits one frame**: the pane that takes over focus was originally nested
     in the split level that got collapsed, and after the layout tree collapses React cannot
     find the original subtree by key and can only rebuild it — focusing immediately would
     only focus an old input box that is about to be thrown away, and the caret would be gone
     as soon as the reflow finishes. Waiting one frame (`requestAnimationFrame`, falling back
     to `setTimeout` in environments without it) before focusing lands it on the input box
     that really exists and will keep existing.

6. **Swapping two panes' positions can only be done by "swapping keys", and React only moves
   things between sibling nodes.** Three implementations of the same effect existed, and only
   the third is correct:
   - **Swapping the workspaces / sessions in the two pane records**: both sides'
     `useSessionReference` effects re-run, and DSH's session-reference contract is "the last
     release tears down the session's local scope and history" — both conversations get
     reopened for nothing.
   - **Swapping whole leaves in the layout tree**: structural sharing breaks down and the
     whole path is rebuilt, so React cannot find the original subtree by key and can only
     unmount and rebuild it — likewise reopening for nothing.
   - **Swapping only the `key` of two leaves in the layout tree** (the model's `swapLeaves`,
     the store layer's `swapPanes`): the split levels and ratios and the pane records do not
     change a single field. So in React's eyes this is merely "two siblings at the same level
     exchanged keys", and it **moves those two subtrees as a whole**, without releasing the
     session references even once.

   The third also depends on one precondition: **a leaf pane must be a direct child of the
   split div**. Originally each child also had a placeholder div wrapped around it (the ratio
   was written on it), and React's key matching only happens under the same parent node — one
   level in between and it cannot match, so the swap silently degrades into a rebuild. Now
   the ratio is written on the pane's own `flexGrow` and the placeholder div is kept only for
   the subtree.

   **A cross-level swap (when the two parties are not in the same split level) is still a
   rebuild.** Swapping A and C in `A | (B/C)`, React cannot move a subtree under a different
   parent node and can only unmount and rebuild; measured, that pane flashes "Opening
   session…" (for small local sessions headless Chrome measured 50~245 ms across several
   runs, three to fifteen-odd frames), and the pane's scroll position and expanded tool
   output are also reset. A same-level swap (any two panes at the same level or adjacent
   levels) has none of these costs — which is the precondition for daring to offer
   "drag to swap positions"; the real-browser probe measures the two cases separately and
   reports them honestly: `node tools/swap-probe.mjs`. If one day the cross-level swap should
   also be spared this, the **session reference's lifecycle** would have to change (a
   reference to the same session shared among several panes, with the last release deferred
   by one task so that the unmount + remount within the same reflow cancel out), and the
   loss of scroll and expanded state caused by the rebuild itself would still be unavoidable
   — the cost is not small and the gain is only a few dozen milliseconds, so it is left
   undone for now.

## Files

The source is split into several files by responsibility (all far under 800 lines). DSH's
browser module system supports **in-package code blocks**: the entry requests files in the
same directory with `require.async('./client.xxx.js')`, and the host serves them at
`/plugins/<package name>/client.xxx.js?rev=<version>`, so the entry does not have to carry
the whole implementation.

- `client.js` — entry: loads the code blocks (styles / dictionaries / model / presets /
  menu / pane / view), registers the slot, injects the styles, registers `Alt+arrow keys` as
  the framework's fixed shortcut and installs its keyboard handling on the document; it also
  provides `openWorkspaceDirectory(path)` (going through
  `remote.session.openWorkspacePath`) for the pane's "Open directory" button.
- `client.view.js` — board layer: `Splitter` (the splitter bar), `PaneBody` (the conversation
  inside a pane), `SplitPanel` (renders panes and splitters from the layout tree, the panel's
  top actions, and the "on screen" marker on the board root node), `installPaneKeys` (the
  document-level `Alt+arrow keys` handling, delegating focus to the pane block's
  `focusPaneInput`).
- `client.pane.js` — pane layer: `PaneFrame` (workspace title, the **open-directory button**,
  split menu, mode, session, close) and the session reference it holds; the **drag-to-swap on
  the title bar** (pointer down grabs → the drag starts only past the threshold → hit testing
  finds the drop target → release swaps positions, plus "the click that just finished
  dragging no longer steals the caret"); plus the whole set of decisions for "lighting up a
  pane hands over the caret" (excluding controls, giving way to a selection, waiting one
  frame on pane close) and `focusPaneInput` (the `Alt+arrow keys` path uses it too).
- `client.menu.js` — menu parts: `Popover` (including the controlled open switch),
  `MenuItem`, and the svg icons used in various places (the tile icon, the split icon, the
  folder icon, the arrows).
- `client.model.js` — the pure model: the layout tree (split, collapse, balance, ratio
  clamping, **swapping the key of two leaves**), **pane geometry** (`layoutRects` converts
  the layout tree into rectangles, `neighborPane` finds the neighbour at "the corresponding
  position" by rectangle), the pane store (including `swapPanes`), the drag threshold, the
  "which session should be shown" decision, and the candidate workspaces for the split
  menu's second step (`splitCandidates`); it does not depend on React and can be tested
  directly in Node.
- `client.presets.js` — Agent modes: read the Host roster, apply a mode, share a snapshot.
- `client.styles.js` — the stylesheet and class names; colours only use theme tokens
  (`--dsw-*`).
- `client.dicts.js` — Chinese and English strings.
- `index.js` — the empty Host half: it only makes the Loader publish this row's `dsh.client`
  declaration to the browser roster. The "Open directory" button on a pane **does not need
  Host support** — it calls the already-installed Session remote namespace
  (`canOpenWorkspacePath` / `openWorkspacePath`), and adding a row of Host code to this
  plugin would only duplicate that implementation while also making the user restart once for
  it to take effect.
- `cordis.patch.yml` — inserts the single Host row.
- `locale/{en,zh}.json` — the display name and description on the plugin management page.
- `test/harness.mjs` — the offline test harness: simulates the browser module loader
  (including the `require.async` code-block rules), a React stand-in, and Context stand-ins
  (including records of `ctx.inject` and `registerFixed`).
- `test/board.mjs` — the shared test bench for the contract tests: assertion records
  (`check` / `report`), installing the plugin as a "board with two panes", colour contrast
  (WCAG), and small helpers for finding panes and menus in the render output.
- `test/layout-contract.mjs` — offline contract tests for tiling / focus highlight / the
  two-step split menu (including `New workspace…`) (`node test/layout-contract.mjs`).
- `test/drag-contract.mjs` — offline contract tests for the two kinds of dragging
  (`node test/drag-contract.mjs`): resizing with a splitter (including keyboard fine-tuning
  and double-click balance), and the whole chain of **drag-to-swap on the title bar**. The
  latter replaces only two browser-specific answers (`elementFromPoint` and `querySelector`)
  with a fake `document`; everything else is the real implementation (threshold, hit testing,
  drag visual markers, swap on release, the one-frame wait for the caret after a swap,
  cleanup on pointer cancel), and it specifically asserts that **not a single field of the
  pane records changed** — the gatekeeper for "a swap does not reopen conversations".
- `test/focus-contract.mjs` — offline contract tests for pane geometry, the neighbour
  decision and keyboard path of `Alt+arrow keys`, fixed-shortcut registration, and **caret
  ownership when lighting up a pane** (clicking a control does not steal it, clicking content
  hands it over, a drag-selection is given way to, closing a pane waits one frame)
  (`node test/focus-contract.mjs`).
- `test/preset-contract.mjs` — offline contract tests for the mode selector
  (`node test/preset-contract.mjs`).
- `test/open-contract.mjs` — offline contract tests for "opening the workspace directory with
  the file manager" (`node test/open-contract.mjs`): `remote.session` is replaced by a
  recording stand-in, so what is asserted are the calls the plugin **really makes** — first
  asking `canOpenWorkspacePath` (only once), then handing that pane's path to
  `openWorkspacePath` in the shape `{ path }`; and what each of the five failures (no session
  service, no graphical environment, the path fails validation, the open command fails, the
  connection dropped) actually says. The button's own structure, key, position and "disabled
  when the workspace is unknown" are here too.
- `tools/browser-probe.mjs` — a **real-browser** probe (requires a local `google-chrome`): it
  uses CDP trusted mouse input to measure, one by one, the browser default behaviours that
  "caret ownership" depends on, see pitfall 5. It is not part of the offline tests (those five
  remain dependency-free); run it by hand before changing this code
  (`node tools/browser-probe.mjs`).
- `tools/swap-probe.mjs` — a **real-browser** probe: it starts its own separate `dsh web`
  (without touching the window you have open) plus a headless Chrome, and really drags twice
  with **trusted mouse input** to measure three things the offline tests cannot answer — that
  hit testing stays accurate when the pointer is over another pane, that the swap exchanges
  "positions" (the rectangles exactly swap), and **whether the subtrees are moved or
  rebuilt** (tag the pane and its input box before the drag; if the tags are still there
  after the swap, they were moved; a cross-level swap is honestly reported as a rebuild, see
  pitfall 6). Along the way it captures the in-drag feedback as PNGs and prints the paths
  (`node tools/swap-probe.mjs`, about two minutes; set `DSH_SWAP_PROBE_URL` to reuse an
  already running service).

## Local development

The profile points at this directory with `link:`, and `dsh-client-hmr` polls the **entry**
`client.js` every 500 ms (mtime / ctime / size), so changing the entry reloads the browser
plugin automatically within about a second, with no build step.

Note: HMR only watches the entry file, while code-block URLs carry "a version derived from
the entry file's mtime / ctime / size", so **after changing a code block (`client.*.js`) you
must also touch the entry** (for example `touch client.js`, or edit a line of comments),
otherwise the browser will neither reload nor drop the cached old version:

```bash
touch client.js
```

When changing behaviour, also run the five offline tests (dependency-free, on the order of
seconds):

```bash
node test/layout-contract.mjs
node test/drag-contract.mjs
node test/focus-contract.mjs
node test/preset-contract.mjs
node test/open-contract.mjs
```

When you touch the "caret ownership" part, additionally run the real-browser probe (requires
`google-chrome`, about ten seconds):

```bash
node tools/browser-probe.mjs
```

When you touch the "drag to swap positions" part, run the other real-browser probe (requires
`google-chrome` and `dsh`; it starts its own separate web service, about two minutes):

```bash
node tools/swap-probe.mjs                                  # start its own service
DSH_SWAP_PROBE_URL='http://127.0.0.1:PORT/?token=…' \
  node tools/swap-probe.mjs                                # or reuse an already running service
```

To see this behaviour on a **real page**, you can click through it with another headless
client (it does not affect the window you have open): `dsh web --no-open --port 0` prints a
URL with a token; hand it to headless Chrome, then ① switch to the tiled panel ② click the
workspace name in some pane's title bar → the caret should enter that pane's input box
③ click the "Split" button in a title bar → focus should stay on the button and not enter the
input box ④ drag-select a piece of text inside a pane → the selection must still be there
(meaning the guard gave way to the selection) ⑤ click the current pane's close button → the
pane that takes its place should take over the caret on the next frame ⑥ press and hold some
pane's title bar, drag it onto another pane and release → the two panes swap positions and
**neither conversation is reopened** (look before and after at whether the messages in the
panes are still there and whether "Opening session…" flashes).

## License

This project is released under the MIT License. See [LICENSE](LICENSE) for details.
