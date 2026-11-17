/**
 * motion.js —— 科幻概念稿的轻量动效
 *
 * 三件事：
 *   1. 给每个节点补一层「沿边框转动的光」；
 *   2. 鼠标跟随的柔光 + 背景星尘粒子（canvas，固定种子，低透明度）；
 *   3. 支持 ?t=秒数 —— 把所有 CSS 动画定格到某一时刻，
 *      用来给无头浏览器批量截图、合成 GIF 演示。
 */
(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const params = new URLSearchParams(location.search);
  const fixedT = params.has('t') ? Math.max(0, parseFloat(params.get('t'))) : null;

  /* ── 1. 节点光环 / 扫描线 ── */
  document.querySelectorAll('.node').forEach((node) => {
    if (!node.querySelector('.node-ring')) {
      const ring = document.createElement('span');
      ring.className = 'node-ring';
      ring.setAttribute('aria-hidden', 'true');
      node.appendChild(ring);
    }
  });

  /* ── 2. 鼠标柔光 ── */
  const glow = document.getElementById('cursor-glow');
  if (glow) {
    if (fixedT !== null) {
      // 截图模式固定在画面上半部，避免正好压住某一段正文
      document.documentElement.style.setProperty('--cx', '42vw');
      document.documentElement.style.setProperty('--cy', '46vh');
    } else {
      window.addEventListener('pointermove', (e) => {
        document.documentElement.style.setProperty('--cx', `${e.clientX}px`);
        document.documentElement.style.setProperty('--cy', `${e.clientY}px`);
      }, { passive: true });
    }
  }

  /* ── 3. 星尘粒子 ── */
  const canvas = document.getElementById('fx-canvas');
  if (!canvas || reduced) {
    freezeForCapture();
    return;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    freezeForCapture();
    return;
  }

  const COLORS = [
    [77, 215, 255],
    [167, 139, 250],
    [56, 189, 248],
    [255, 180, 84],
  ];

  let W = 0;
  let H = 0;
  let DPR = 1;
  let particles = [];
  let raf = 0;
  let started = performance.now();

  // 固定种子：不同 ?t= 截图的粒子初始位置一致，GIF 才连贯
  function mulberry32(a) {
    return () => {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const rnd = mulberry32(20261113);
    const count = Math.round(Math.min(64, Math.max(32, (W * H) / 44000)));
    particles = Array.from({ length: count }, () => ({
      x: rnd() * W,
      y: rnd() * H,
      r: 0.8 + rnd() * 1.6,
      vx: (rnd() - 0.5) * 0.045,
      vy: -0.025 - rnd() * 0.08,
      a: 0.3 + rnd() * 0.5,
      ph: rnd() * Math.PI * 2,
      c: COLORS[Math.floor(rnd() * COLORS.length)],
    }));
  }

  const mod = (n, m) => ((n % m) + m) % m;

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    const pts = [];

    for (const p of particles) {
      const x = mod(p.x + p.vx * t * 60, W);
      const y = mod(p.y + p.vy * t * 60, H);
      const tw = 0.55 + 0.45 * Math.sin(t * 1.6 + p.ph);
      const alpha = p.a * tw;
      pts.push({ x, y });
      ctx.beginPath();
      ctx.arc(x, y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.c[0]},${p.c[1]},${p.c[2]},${alpha.toFixed(3)})`;
      ctx.fill();
    }

    ctx.lineWidth = 0.5;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const dx = pts[i].x - pts[j].x;
        const dy = pts[i].y - pts[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 10500) {
          const alpha = (1 - d2 / 10500) * 0.09;
          ctx.strokeStyle = `rgba(77,215,255,${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(pts[i].x, pts[i].y);
          ctx.lineTo(pts[j].x, pts[j].y);
          ctx.stroke();
        }
      }
    }
  }

  function loop(now) {
    draw((now - started) / 1000);
    raf = requestAnimationFrame(loop);
  }

  resize();
  window.addEventListener('resize', () => {
    resize();
    if (fixedT !== null) draw(fixedT);
    else draw((performance.now() - started) / 1000);
  }, { passive: true });

  if (fixedT !== null) {
    draw(fixedT);
  } else {
    draw(0);
    raf = requestAnimationFrame(loop);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else if (fixedT === null) {
      started = performance.now();
      raf = requestAnimationFrame(loop);
    }
  });

  /* ── 4. 截图模式：把 CSS 动画定格到指定秒数 ── */
  function freezeForCapture() {
    if (fixedT === null) return;
    const freeze = () => {
      document.getAnimations().forEach((anim) => {
        try {
          anim.currentTime = fixedT * 1000;
          anim.pause();
        } catch (err) {
          /* 某些浏览器不允许暂停，忽略 */
        }
      });
    };
    requestAnimationFrame(() => requestAnimationFrame(freeze));
    setTimeout(freeze, 450);
  }

  freezeForCapture();
})();
