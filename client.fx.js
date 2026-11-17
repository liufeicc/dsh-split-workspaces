/**
 * 派单光效：主窗格边框亮一下 → 一颗小流星直线飞向目标窗格内的随机落点 →
 * 目标窗格边框亮一下。
 *
 * 视觉约定：
 *   - 7px 白心光点，外面裹一团 120px 的金色柔光，后面拖 96px 的渐隐光带；
 *   - **直线飞行**，不再盘旋；落点在目标窗格内随机（四周留 20% 边距）；
 *   - 边框高亮用独立的覆盖框（不依赖窗格自身的 box-shadow），确保一定看得见；
 *   - 多个目标**串行**：上一颗到达后，下一颗才发射；
 *   - 主/目标窗格没铺开时，用棋盘边缘作为起点/终点；两端都没有时不播；
 *   - 整个平铺面板不在屏幕上（棋盘元素不存在/尺寸为 0）时不播。
 *
 * 这一块只做 DOM 表现，不认识 React、也不碰派单逻辑。触发由棋盘层轮询
 * `paneDispatch.pullVisual` 得到的事件，调用 `play()` 播放。
 * `dispose()` 会清掉所有流星/高亮框与定时器。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-workspaces/client.fx.js',
  factory() {
    /** 光点飞行时长（毫秒）。 */
    const FLIGHT_MS = 2400;
    /** 源/目标边框高亮时长。 */
    const PULSE_MS = 1200;
    /** 源窗格的 RGB（青色，与面板强调色一致）。 */
    const SOURCE_RGB = '94,231,255';
    /** 目标窗格/流星的 RGB（金色）。 */
    const TARGET_RGB = '255,210,122';

    /** 把数值限制在闭区间里。 */
    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    /** 元素可见矩形；尺寸太小（隐藏/折叠）时视为不可见。 */
    function rectOf(element) {
      if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') return null;
      const rect = element.getBoundingClientRect();
      return rect.width < 2 || rect.height < 2 ? null : rect;
    }

    /** 矩形中心。 */
    function center(rect) {
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    /**
     * 生成一条直线路径。保留 `random` / `bounds` 形参是为了向后兼容，
     * 现在不再使用（用户明确要求直线飞行，落点随机在目标窗格上做）。
     */
    function dispatchPath(from, to) {
      return {
        d: 'M ' + from.x + ' ' + from.y + ' L ' + to.x + ' ' + to.y,
        from,
        to,
        points: [from, to],
      };
    }

    /**
     * 目标窗格内的随机落点。
     *
     * 四周留 20% 边距，避免光点贴着窗格边缘停下；`random` 可注入，测试可以
     * 固定到 0 / 1 检查边界。
     */
    function randomPointIn(rect, random = Math.random) {
      const insetX = rect.width * 0.2;
      const insetY = rect.height * 0.2;
      return {
        x: rect.left + insetX + random() * Math.max(0, rect.width - insetX * 2),
        y: rect.top + insetY + random() * Math.max(0, rect.height - insetY * 2),
      };
    }

    /**
     * 棋盘边缘上、朝向 `toward` 的落点。
     *
     * 用于「窗格没铺开」的两端：主窗格缺失时从棋盘边缘飞入，目标缺失时飞向
     * 棋盘边缘。按从棋盘中心指向目标的射线与棋盘边框求交，取最近的边。
     */
    function boardEdge(boardRect, toward) {
      const mid = center(boardRect);
      const dx = toward.x - mid.x;
      const dy = toward.y - mid.y;
      if (dx === 0 && dy === 0) return mid;
      const scaleX = dx === 0 ? Infinity : (boardRect.width / 2) / Math.abs(dx);
      const scaleY = dy === 0 ? Infinity : (boardRect.height / 2) / Math.abs(dy);
      const scale = Math.min(scaleX, scaleY);
      return { x: mid.x + dx * scale, y: mid.y + dy * scale };
    }

    /**
     * 创建派单光效播放器。
     *
     * @param deps.doc - 文档（测试可注入）。
     * @param deps.win - 窗口（测试可注入）。
     * @returns `{ play, dispose }`。
     */
    function createDispatchFx(deps = {}) {
      const documentRef = deps.doc ?? (typeof document === 'undefined' ? null : document);
      const windowRef = deps.win ?? (typeof window === 'undefined' ? null : window);
      if (documentRef === null || windowRef === null) {
        return { play() {}, dispose() {} };
      }
      let disposed = false;

      const reducedMotion = () => typeof windowRef.matchMedia === 'function'
        && windowRef.matchMedia('(prefers-reduced-motion: reduce)').matches === true;

      /**
       * 窗格边框高亮。
       *
       * 不再直接给窗格做 box-shadow 动画：窗格本身已经有边框/阴影/选中态，
       * 直接动画容易被覆盖或裁剪，上一版就出现了「完全没闪」。这里改成在
       * body 上临时盖一个和窗格等大的描边框，位置/圆角从窗格现读，动画结束
       * 就移除 —— 不依赖 React，也不改窗格样式。
       */
      const flash = (element, rgb, duration) => {
        if (disposed) return;
        const rect = rectOf(element);
        if (rect === null) return;
        const radius = typeof windowRef.getComputedStyle === 'function'
          ? windowRef.getComputedStyle(element).borderRadius
          : '';
        const box = documentRef.createElement('div');
        box.className = 'dshSplitWs_fxFlash';
        box.style.left = rect.left + 'px';
        box.style.top = rect.top + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
        if (radius !== '') box.style.borderRadius = radius;
        box.style.borderColor = 'rgba(' + rgb + ',.95)';
        documentRef.body.appendChild(box);
        const animation = box.animate([
          {
            opacity: 0,
            boxShadow: '0 0 0 0 rgba(' + rgb + ',0), 0 0 0 0 rgba(' + rgb + ',0), inset 0 0 0 0 rgba(' + rgb + ',0)',
          },
          {
            opacity: 1,
            boxShadow: '0 0 0 3px rgba(' + rgb + ',.95), 0 0 56px 16px rgba(' + rgb + ',.6), inset 0 0 30px rgba(' + rgb + ',.5)',
            offset: 0.28,
          },
          {
            opacity: 0,
            boxShadow: '0 0 0 0 rgba(' + rgb + ',0), 0 0 0 0 rgba(' + rgb + ',0), inset 0 0 0 0 rgba(' + rgb + ',0)',
          },
        ], { duration, easing: 'ease-out' });
        const remove = () => box.remove();
        animation.finished.then(remove).catch(remove);
      };

      /**
       * 整个窗格抖一下：像被炮弹震到。位移很快衰减，只影响绘制，不改布局。
       */
      const shake = (element) => {
        if (element === null || element === undefined || typeof element.animate !== 'function') return;
        /*
         * 用独立的 `translate` 属性，而不是 `transform`：窗格可能已经有
         * transform（拖动/布局），两者叠加时 translate 仍能稳定生效。
         * 位移比上一版更大、持续时间更长，确保肉眼能看到「整个框晃了一下」。
         */
        element.animate([
          { translate: '0 0' },
          { translate: '-7px 4px' },
          { translate: '6px -3px' },
          { translate: '-4px -2px' },
          { translate: '2px 2px' },
          { translate: '0 0' },
        ], { duration: 500, easing: 'ease-out' });
      };

      /**
       * 整个窗格被一层半透明白光罩住，然后慢慢消失。
       *
       * 用独立覆盖层而不是改窗格背景：不碰 React、不影响内容对比度，
       * 白光只存在约 1 秒。
       */
      const veil = (element) => {
        const rect = rectOf(element);
        if (rect === null) return;
        const radius = typeof windowRef.getComputedStyle === 'function'
          ? windowRef.getComputedStyle(element).borderRadius
          : '';
        const layer = documentRef.createElement('div');
        layer.className = 'dshSplitWs_fxHit';
        layer.style.left = rect.left + 'px';
        layer.style.top = rect.top + 'px';
        layer.style.width = rect.width + 'px';
        layer.style.height = rect.height + 'px';
        if (radius !== '') layer.style.borderRadius = radius;
        documentRef.body.appendChild(layer);
        const animation = layer.animate([
          { opacity: 0 },
          { opacity: 0.58, offset: 0.28 },
          { opacity: 0 },
        ], { duration: 1200, easing: 'ease-out' });
        const remove = () => layer.remove();
        animation.finished.then(remove).catch(remove);
      };

      /**
       * 光点命中目标：边框高亮 + 整个窗格抖动 + 半透明白光罩住后慢慢消失。
       */
      const impact = (element, rgb) => {
        flash(element, rgb, PULSE_MS);
        if (reducedMotion()) return;
        shake(element);
        veil(element);
      };

      /**
       * 发一颗流星。
       *
       * @returns Promise：飞行结束（或减少动态时立即完成）后 resolve，
       *   让调用方可以串行发射下一颗。
       */
      const launch = (fromPoint, toPoint, targetElement) => new Promise((resolve) => {
        if (disposed) {
          resolve();
          return;
        }
        const path = dispatchPath(fromPoint, toPoint);
        const comet = documentRef.createElement('div');
        comet.className = 'dshSplitWs_fxComet';
        comet.style.offsetPath = "path('" + path.d + "')";
        const glow = documentRef.createElement('div');
        glow.className = 'dshSplitWs_fxGlow';
        const tail = documentRef.createElement('div');
        tail.className = 'dshSplitWs_fxTail';
        const tailCore = documentRef.createElement('div');
        tailCore.className = 'dshSplitWs_fxTailCore';
        const head = documentRef.createElement('div');
        head.className = 'dshSplitWs_fxHead';
        comet.append(glow, tail, tailCore, head);
        documentRef.body.appendChild(comet);
        const finish = () => {
          comet.remove();
          impact(targetElement, TARGET_RGB);
          resolve();
        };
        if (reducedMotion()) {
          finish();
          return;
        }
        const flight = comet.animate(
          [{ offsetDistance: '0%' }, { offsetDistance: '100%' }],
          { duration: FLIGHT_MS, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' },
        );
        flight.finished.then(finish).catch(finish);
      });

      /**
       * 播放一次派单效果。
       *
       * @param event.sourceSessionId - 发起方会话 id。
       * @param event.targetSessionIds - 目标会话 id 数组。
       * @param event.elementForSession - 把会话 id 映射到当前窗格 DOM 的函数；没铺开时返回 null。
       */
      function play({ sourceSessionId, targetSessionIds, elementForSession } = {}) {
        if (disposed) return;
        const board = documentRef.querySelector('.dshSplitWs_board') ?? documentRef.querySelector('[data-split-board]');
        const boardRect = rectOf(board);
        if (boardRect === null) return;
        const resolve = typeof elementForSession === 'function' ? elementForSession : () => null;
        const sourceElement = resolve(sourceSessionId);
        const sourceRect = rectOf(sourceElement);
        const targets = Array.isArray(targetSessionIds) ? targetSessionIds : [];
        const targetElements = targets.map((sessionId) => resolve(sessionId));
        const targetRects = targetElements.map((element) => rectOf(element));
        if (sourceRect === null && targetRects.every((rect) => rect === null)) return;

        flash(sourceElement, SOURCE_RGB, PULSE_MS);
        const jobs = [];
        targetElements.forEach((element, index) => {
          const targetRect = targetRects[index];
          let fromPoint;
          let toPoint;
          if (targetRect !== null) {
            // 落点在目标窗格内随机；起点固定是源窗格中心。
            toPoint = randomPointIn(targetRect);
            fromPoint = sourceRect !== null
              ? center(sourceRect)
              : boardEdge(boardRect, toPoint);
          } else if (sourceRect !== null) {
            // 目标窗格没显示：从主窗格飞向棋盘最近的边缘。
            const sourceCenter = center(sourceRect);
            const boardCenter = center(boardRect);
            const toward = {
              x: sourceCenter.x + (sourceCenter.x - boardCenter.x || boardRect.width * 0.25),
              y: sourceCenter.y + (sourceCenter.y - boardCenter.y || boardRect.height * 0.25),
            };
            fromPoint = sourceCenter;
            toPoint = boardEdge(boardRect, toward);
          } else {
            return;
          }
          jobs.push({ fromPoint, toPoint, element });
        });
        /*
         * 串行发射：上一颗流星落地后再发下一颗。
         */
        let chain = Promise.resolve();
        for (const job of jobs) {
          chain = chain.then(() => {
            if (disposed) return undefined;
            return launch(job.fromPoint, job.toPoint, job.element);
          });
        }
      }

      /** 清理所有流星与高亮框；面板卸载时调用。 */
      function dispose() {
        disposed = true;
        for (const node of documentRef.querySelectorAll('.dshSplitWs_fxComet')) node.remove();
        for (const node of documentRef.querySelectorAll('.dshSplitWs_fxFlash')) node.remove();
        for (const node of documentRef.querySelectorAll('.dshSplitWs_fxHit')) node.remove();
      }

      return { play, dispose };
    }

    return { createDispatchFx, dispatchPath, randomPointIn, boardEdge };
  },
});
