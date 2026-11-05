/* Layout, tessellation and painted art.
   The art is painted once into small offscreen canvases and is never shown directly:
   it only tells each tile what colour to be. */
(function () {
  const VZ = (window.VZ = window.VZ || {});

  const STATIONS = [
    { id: 'bocca', f: 'BOCCA', p: 'INTAKE' },
    { id: 'disegno', f: 'DISEGNO', p: 'CONTRACT' },
    { id: 'cantiere', f: 'CANTIERE', p: 'BUILD' },
    { id: 'collaudo', f: 'COLLAUDO', p: 'PROVE' },
    { id: 'varo', f: 'VARO', p: 'LAUNCH' },
    { id: 'portolano', f: 'PORTOLANO', p: 'LEARN' },
  ];
  VZ.STATIONS = STATIONS;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let seedState = 7;
  const rnd = () => ((seedState = (seedState * 16807) % 2147483647) - 1) / 2147483646;

  function polyWalk(pts) {
    let len = 0;
    pts[0].s = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      pts[i].s = len;
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b.x - a.x, dy = b.y - a.y, m = Math.hypot(dx, dy) || 1;
      pts[i].tx = dx / m; pts[i].ty = dy / m;
    }
    pts.len = len;
    return pts;
  }

  VZ.pointAt = function (path, s) {
    s = clamp(s, 0, path.len);
    let lo = 0, hi = path.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (path[m].s < s) lo = m; else hi = m; }
    const a = path[lo], b = path[hi], u = (s - a.s) / Math.max(1e-3, b.s - a.s);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, tx: a.tx, ty: a.ty };
  };

  function deck(x, y, w, h, gap) {
    /* lamps, then reject / dial / approve, then talk, stacked to the thumb */
    const lampH = clamp(h * 0.165, 36, 46);
    const talkH = clamp(h * 0.235, 50, 64);
    const rowH = h - lampH - talkH - gap * 2;
    const lamps = [];
    const lw = (w - 5 * 6) / 6;
    for (let i = 0; i < 6; i++) lamps.push({ x: x + i * (lw + 6), y, w: lw, h: lampH });
    const d = Math.min(rowH, w * 0.32);
    const side = (w - d - 24) / 2;
    const ry = y + lampH + gap;
    return {
      lamps,
      reject: { x, y: ry, w: side, h: rowH },
      dial: { x: x + side + 12, y: ry + (rowH - d) / 2, w: d, h: d },
      approve: { x: x + side + d + 24, y: ry, w: side, h: rowH },
      talk: { x, y: ry + rowH + gap, w, h: talkH },
    };
  }

  VZ.layout = function (W, H, top, bottom) {
    const L = { W, H, top, bottom, stations: [] };
    L.wide = W >= 900 && H >= 620;
    L.side = !L.wide && W > H * 1.25;
    if (!L.wide) {
      const g = W < 380 ? 10 : 12;
      const full = W;
      const sideW = clamp(W * 0.42, 300, 380);
      const dh = L.side ? clamp(H * 0.56, 196, 232) : clamp(H * 0.276, 196, 232);
      const dy = H - bottom - 12 - dh;
      const cardH = clamp(H * 0.122, 90, 104);
      const cy = dy - 11 - cardH;
      if (L.side) {
        Object.assign(L, deck(W - sideW + g, dy, sideW - g * 2, dh, 8));
        L.card = { x: W - sideW + g, y: cy, w: sideW - g * 2, h: cardH };
        W = W - sideW;
      } else {
        Object.assign(L, deck(g, dy, W - g * 2, dh, 9));
        L.card = { x: g, y: cy, w: W - g * 2, h: cardH };
      }
      const worldB = L.side ? H : cy - 12;
      L.hud = { x: 0, y: 0, w: full, h: top + 40 };
      const skyB = L.hud.h + clamp((worldB - L.hud.h) * 0.165, 40, 86);
      L.world = { x: 0, y: 0, w: W, h: worldB };
      L.sky = { x: 0, y: L.hud.h, w: W, h: skyB - L.hud.h };
      L.cons = L.side ? { x: W, y: L.hud.h, w: full - W, h: H - L.hud.h } : { x: 0, y: worldB, w: W, h: H - worldB };
      const R = (worldB - skyB) / 3;
      L.R = R;
      L.regs = [0, 1, 2].map((i) => {
        const wt = skyB + i * R;
        return { wallTop: wt, waterTop: wt + R * 0.56, waterBot: wt + R };
      });
      L.band = R * 0.44;
      const cy0 = L.regs[0].waterTop + L.band / 2, cy1 = L.regs[1].waterTop + L.band / 2, cy2 = L.regs[2].waterTop + L.band / 2;
      const rad = R / 2, rx = W - rad - L.band * 0.5 - 3, lx = rad + L.band * 0.5 + 3;
      const pts = [];
      const push = (x, y) => pts.push({ x, y });
      for (let x = -70; x < rx; x += 2) push(x, cy0);
      for (let a = -Math.PI / 2; a < Math.PI / 2; a += 0.04) push(rx + Math.cos(a) * rad, (cy0 + cy1) / 2 + Math.sin(a) * rad);
      for (let x = rx; x > lx; x -= 2) push(x, cy1);
      for (let a = -Math.PI / 2; a > -Math.PI * 1.5; a -= 0.04) push(lx + Math.cos(a) * rad, (cy1 + cy2) / 2 + Math.sin(a) * rad);
      for (let x = lx; x < W + 90; x += 2) push(x, cy2);
      L.path = polyWalk(pts);
      const a = (W - 0) / 2;
      const px = [0.24, 0.66, 0.68, 0.30, 0.30, 0.72];
      const reg = [0, 0, 1, 1, 2, 2];
      STATIONS.forEach((st, i) => {
        const r = L.regs[reg[i]];
        const x = W * px[i];
        L.stations.push({ ...st, x, reg: reg[i], archW: R * 0.30, archH: R * 0.46, archB: r.waterTop - 1, plateY: r.wallTop + 11, y: r.waterTop + L.band / 2 });
      });
      /* find arc-length position of each station on the path */
      L.stations.forEach((st) => {
        let best = 1e9, s = 0;
        for (const p of L.path) { const d = Math.hypot(p.x - st.x, p.y - st.y); if (d < best) { best = d; s = p.s; } }
        st.s = s;
      });
      L.hullScale = Math.min(clamp(R / 136, 0.5, 1.5), W / 420);
      const big = clamp(W / 400, 1, 1.5);
      L.pitch = { water: 3.8 * big, wall: 4.2 * big, sky: 4.6 * big, cons: 6.0 * big, hud: 5.2 * big };
      L.plate = { w: 11.2 * big, h: 14.2 * big, gap: 0.6 };
      L.splate = { w: 10.6 * big, h: 13.6 * big, gap: 0.7 };
      L.hudt = { w: 9.6 * big, h: 13 * big, gap: 0.5 };
    } else {
      const consH = clamp(H * 0.345, 280, 330);
      const hudH = top + 52;
      const worldB = H - consH;
      L.hud = { x: 0, y: 0, w: W, h: hudH };
      L.world = { x: 0, y: 0, w: W, h: worldB };
      L.cons = { x: 0, y: worldB, w: W, h: consH };
      const skyH = (worldB - hudH) * 0.24;
      L.sky = { x: 0, y: hudH, w: W, h: skyH };
      const wt = hudH + skyH, wh = (worldB - hudH) * 0.42;
      L.regs = [{ wallTop: wt, waterTop: wt + wh, waterBot: worldB }];
      L.R = wh;
      const cy = wt + wh + (worldB - wt - wh) * 0.52;
      L.band = worldB - wt - wh;
      const pts = [];
      for (let x = -120; x < W + 160; x += 3) pts.push({ x, y: cy + Math.sin(x * 0.0062 + 0.5) * 14 });
      L.path = polyWalk(pts);
      STATIONS.forEach((st, i) => {
        const x = W * (0.085 + i * 0.166);
        let best = 1e9, s = 0;
        for (const p of L.path) { const d = Math.abs(p.x - x); if (d < best) { best = d; s = p.s; } }
        L.stations.push({ ...st, x, reg: 0, s, archW: 92, archH: wh * 0.66, archB: wt + wh - 1, plateY: wt + 18, y: cy });
      });
      L.hullScale = clamp((worldB - hudH) / 350, 1.1, 1.7);
      L.pitch = { water: 5.4, wall: 5.2, sky: 6.2, cons: 9.5, hud: 7 };
      L.plate = { w: 16.5, h: 21, gap: 1 };
      L.splate = { w: 16, h: 21, gap: 1 };
      L.hudt = { w: 13.5, h: 18, gap: 0.8 };
      const m = 18, gap = 18;
      const y = worldB + 24, h = consH - 24 - 16;
      const deckW = clamp(W * 0.33, 400, 480), feedW = clamp(W * 0.27, 300, 400);
      L.feed = { x: m, y, w: feedW, h };
      const cx = m + feedW + gap, cw = W - m * 2 - feedW - deckW - gap * 2;
      const cardH = clamp(h * 0.46, 112, 128);
      L.card = { x: cx, y, w: cw, h: cardH };
      L.detail = { x: cx, y: y + cardH + 14, w: cw, h: h - cardH - 14 };
      Object.assign(L, deck(W - m - deckW, y, deckW, h, 10));
    }
    return L;
  };

  /* ---------- Tessellation: rows first along forms, then filler, as a mosaicist works ---------- */
  VZ.tessellate = function (L) {
    seedState = 7;
    const W = Math.ceil(L.W), H = Math.ceil(L.H);
    const occ = new Uint8Array(W * H);
    const out = [];
    const put = (x, y, w, h, a) => { out.push(x, y, w, h, a, rnd() * 100); };
    function block(r, m) {
      for (let y = Math.max(0, Math.floor(r.y + m)); y < Math.min(H, r.y + r.h - m); y++)
        for (let x = Math.max(0, Math.floor(r.x + m)); x < Math.min(W, r.x + r.w - m); x++) occ[y * W + x] = 1;
    }
    function tryPlace(x, y, w, h, a, force) {
      if (x < -w || y < -w || x > W + w || y > H + w) return false;
      const c = Math.cos(a), s = Math.sin(a), hw = w / 2, hh = h / 2;
      const pts = [];
      for (let u = -hw + 0.4; u <= hw - 0.4 + 0.01; u += Math.max(1, (w - 0.8) / 4))
        for (let v = -hh + 0.4; v <= hh - 0.4 + 0.01; v += Math.max(1, (h - 0.8) / 3)) {
          const px = Math.round(x + u * c - v * s), py = Math.round(y + u * s + v * c);
          if (px >= 0 && py >= 0 && px < W && py < H) {
            if (occ[py * W + px] && !force) return false;
            pts.push(py * W + px);
          }
        }
      if (!pts.length && !force) return false;
      for (const p of pts) occ[p] = 1;
      put(x, y, w, h, a);
      return true;
    }
    function walk(pts, len, rowH, jit) {
      let i = 0, s = pts[0].s + rnd() * len;
      while (i < pts.length - 1) {
        const l = len * (0.78 + rnd() * 0.5);
        const mid = s + l / 2;
        while (i < pts.length - 1 && pts[i + 1].s < mid) i++;
        if (i >= pts.length - 1) break;
        const p = pts[i];
        tryPlace(p.x + (rnd() - 0.5) * jit, p.y + (rnd() - 0.5) * jit, l - 0.75, rowH - 0.75, Math.atan2(p.ty, p.tx) + (rnd() - 0.5) * 0.05);
        s += l;
      }
    }
    function fill(r, p, ratio) {
      let y = r.y + p * 0.5, row = 0;
      while (y < r.y + r.h) {
        let x = r.x - rnd() * p;
        while (x < r.x + r.w) {
          const l = p * (0.78 + rnd() * 0.46) * (ratio || 1);
          tryPlace(x + l / 2, y + (rnd() - 0.5) * 0.5, l - 0.75, p * (0.94 + rnd() * 0.1) - 0.75, (rnd() - 0.5) * 0.06);
          x += l;
        }
        y += p; row++;
      }
    }
    function arc(cx, cy, r, a0, a1, len, h) {
      const n = Math.max(2, Math.round((Math.abs(a1 - a0) * r) / len));
      for (let i = 0; i < n; i++) {
        const a = a0 + ((a1 - a0) * (i + 0.5)) / n + (rnd() - 0.5) * 0.015;
        const l = (Math.abs(a1 - a0) * r) / n;
        tryPlace(cx + Math.cos(a) * r, cy + Math.sin(a) * r, l - 0.7, h - 0.7, a + Math.PI / 2);
      }
    }

    for (const k of ['reject', 'approve', 'talk']) block(L[k], 4);
    for (const r of L.lamps) block(r, 3);
    {
      const d = L.dial, cx = d.x + d.w / 2, cy = d.y + d.h / 2, r = d.w / 2 - 3;
      for (let y = Math.floor(cy - r); y < cy + r; y++) for (let x = Math.floor(cx - r); x < cx + r; x++)
        if (x >= 0 && y >= 0 && x < W && y < H && (x - cx) ** 2 + (y - cy) ** 2 < r * r) occ[y * W + x] = 1;
    }
    if (L.feed) { block(L.feed, 6); block(L.detail, 6); }

    const p = L.pitch;
    /* water first: rows follow the street */
    if (!L.wide) {
      const hw = L.band / 2;
      for (let t = -hw + p.water / 2; t < hw; t += p.water) {
        const pts = L.path.map((q) => ({ x: q.x - q.ty * t, y: q.y + q.tx * t, s: 0 }));
        polyWalk(pts);
        walk(pts, p.water * 1.36, p.water, 0.25);
      }
      /* stone edge of the quay, two rows */
      for (const t of [hw + 2.2, -hw - 2.2]) {
        const pts = L.path.map((q) => ({ x: q.x - q.ty * t, y: q.y + q.tx * t, s: 0 }));
        polyWalk(pts);
        walk(pts, 9, 4.4, 0.2);
      }
    } else {
      const r = L.regs[0];
      for (let y = r.waterBot - p.water / 2; y > r.waterTop; y -= p.water) {
        const pts = [];
        const amp = 7 + 7 * Math.sin(y * 0.03);
        for (let x = -30; x < W + 30; x += 3) pts.push({ x, y: y + Math.sin(x * 0.012 + y * 0.012) * amp, s: 0 });
        polyWalk(pts);
        walk(pts, p.water * 1.4, p.water, 0.2);
      }
    }

    /* arches: voussoirs ring each window */
    for (const st of L.stations) {
      const hw = st.archW / 2, cy = st.archB - st.archH + hw;
      const q = L.pitch.wall;
      for (let i = 0; i < 3; i++) {
        arc(st.x, cy, hw + q * (i + 0.6), Math.PI, Math.PI * 2, q * 0.98, q);
      }
    }

    /* sky: rows bend around the moon */
    const mx = L.W * 0.64, my = L.hud.h + (L.wide ? 54 : 22);
    const skyB = L.sky.y + L.sky.h + 40;
    for (let r = 5; r < L.W * 1.25; r += p.sky) {
      const pts = [];
      for (let a = 0; a < Math.PI * 2; a += Math.min(0.2, 5 / r)) {
        const x = mx + Math.cos(a) * r, y = my + Math.sin(a) * r * 0.9;
        if (y > L.hud.h - 8 && y < skyB && x > -8 && x < L.W + 8) pts.push({ x, y, s: 0 });
        else if (pts.length > 1) { polyWalk(pts); walk(pts, p.sky * 1.3, p.sky, 0.3); pts.length = 0; }
      }
      if (pts.length > 1) { polyWalk(pts); walk(pts, p.sky * 1.3, p.sky, 0.3); }
    }

    /* walls and everything else */
    fill({ x: 0, y: L.sky.y, w: L.world.w, h: L.world.h - L.sky.y }, p.wall, 1.12);
    fill({ x: 0, y: 0, w: L.W, h: L.hud.h }, p.hud, 1.3);
    fill(L.cons, p.cons, 1.2);
    /* cut pieces close the gaps, as the setter would */
    fill({ x: 0, y: 0, w: L.W, h: L.H }, L.wide ? 3.6 : L.pitch.water * 0.7, 1);

    return new Float32Array(out);
  };

  /* ---------- Static painting ---------- */
  const P = {
    night: '#0B1F24', verd: '#3E8E7E', gold: '#D9A93A', verm: '#C8391F', ink: '#1B1A17', vellum: '#EFE4CB',
    brick: '#7E3B2B', brick2: '#6A2F24', brick3: '#94503A', stone: '#C9BC9C', stone2: '#A89B7D',
  };

  function archPath(c, x, b, w, h) {
    const r = w / 2, top = b - h + r;
    c.beginPath();
    c.moveTo(x - r, b);
    c.lineTo(x - r, top);
    c.arc(x, top, r, Math.PI, 0);
    c.lineTo(x + r, b);
    c.closePath();
  }

  function dentils(c, x, y, w, h, A, B) {
    c.fillStyle = A; c.fillRect(x, y, w, h);
    c.fillStyle = B;
    const n = Math.ceil(w / (h * 1.5));
    for (let i = 0; i < n; i++) {
      const u = x + i * h * 1.5;
      c.beginPath(); c.moveTo(u, y + h); c.lineTo(u + h * 0.75, y); c.lineTo(u + h * 1.5, y + h); c.closePath(); c.fill();
    }
  }

  VZ.paintStatic = function (L, div) {
    const W = L.W, H = L.H;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(W / div); cv.height = Math.ceil(H / div);
    const c = cv.getContext('2d', { willReadFrequently: false });
    c.scale(1 / div, 1 / div);

    /* sky */
    const skyTop = L.hud.h - 2, skyB = L.regs[0].waterTop;
    let g = c.createLinearGradient(0, skyTop, 0, skyB);
    g.addColorStop(0, '#0B2A38'); g.addColorStop(0.35, '#0F3F4B'); g.addColorStop(0.72, '#1C5F62'); g.addColorStop(1, '#3E8E7E');
    c.fillStyle = g; c.fillRect(0, skyTop, W, skyB - skyTop);
    /* moon: pale, never gold */
    const mx = W * 0.64, my = L.hud.h + (L.wide ? 54 : 22), mr = L.wide ? 34 : 15;
    [[mr * 2.5, '#17525A'], [mr * 1.85, '#256F70'], [mr * 1.34, '#5E9F90'], [mr, '#EFEBD8']].forEach(([r, col]) => {
      c.fillStyle = col; c.beginPath(); c.arc(mx, my, r, 0, Math.PI * 2); c.fill();
    });

    /* walls */
    L.regs.forEach((r, i) => {
      const y0 = r.wallTop, y1 = r.waterTop;
      g = c.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, L.wide ? '#8C4631' : '#8A4431'); g.addColorStop(1, P.brick2);
      c.fillStyle = g; c.fillRect(0, y0, W, y1 - y0);
      c.fillStyle = '#4D241C'; c.fillRect(0, y1, W, r.waterBot - y1 + (L.wide ? 0 : L.R * 0.56));
      /* brick courses, broken */
      const ch = L.pitch.wall * 2;
      for (let y = y0; y < y1; y += ch) {
        for (let x = (Math.floor((y - y0) / ch) % 2) * 9 - 20; x < W; x += 18 + rnd() * 16) {
          c.fillStyle = [P.brick3, P.brick, '#5D2A20'][(rnd() * 3) | 0];
          c.globalAlpha = 0.22;
          c.fillRect(x, y, 9 + rnd() * 10, ch * 0.5);
        }
      }
      c.globalAlpha = 1;
      /* stone cornice with crenellation on the top wall */
      c.fillStyle = P.stone; c.fillRect(0, y0, W, L.pitch.wall * 1.1);
      if (i === 0) {
        const m = L.wide ? 26 : 13;
        c.fillStyle = '#8A4431';
        for (let x = -m / 2; x < W; x += m * 2) {
          c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y0 - m * 0.7); c.lineTo(x + m / 2, y0 - m * 1.05); c.lineTo(x + m, y0 - m * 0.7); c.lineTo(x + m, y0); c.fill();
        }
      }
      /* blind windows along the wall */
      const ws = L.wide ? 48 : 24;
      for (let x = ws * 0.5; x < W; x += ws) {
        if (L.stations.some((s) => s.reg === i && Math.abs(s.x - x) < s.archW * 0.5 + ws * 0.7)) continue;
        c.fillStyle = '#2A1612';
        archPath(c, x, y0 + (y1 - y0) * 0.72, ws * 0.3, (y1 - y0) * 0.36);
        c.fill();
      }
    });

    /* quay stone and arches */
    for (const st of L.stations) {
      const hw = st.archW / 2, q = L.pitch.wall;
      /* striped voussoirs, the Venetian habit */
      const cy = st.archB - st.archH + hw;
      const n = 13;
      for (let i = 0; i < n; i++) {
        const a0 = Math.PI + (i / n) * Math.PI, a1 = Math.PI + ((i + 1) / n) * Math.PI;
        c.fillStyle = i % 2 ? '#B9AD90' : '#3E7D70';
        c.beginPath(); c.arc(st.x, cy, hw + q * 3, a0, a1); c.arc(st.x, cy, hw, a1, a0, true); c.closePath(); c.fill();
      }
      c.fillStyle = '#B9AD90';
      c.fillRect(st.x - hw - q * 3, cy, q * 3, st.archB - cy);
      c.fillRect(st.x + hw, cy, q * 3, st.archB - cy);
      c.fillStyle = '#0F1A1C';
      archPath(c, st.x, st.archB, st.archW, st.archH); c.fill();
    }

    /* water mask painted solid so the static layer has no holes */
    if (!L.wide) {
      c.strokeStyle = P.stone2; c.lineWidth = L.band + 8; c.lineJoin = 'round';
      c.beginPath(); L.path.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.stroke();
      c.strokeStyle = P.night; c.lineWidth = L.band;
      c.stroke();
    } else {
      const r = L.regs[0];
      c.fillStyle = P.stone; c.fillRect(0, r.waterTop - 5, W, 8);
      c.fillStyle = P.night; c.fillRect(0, r.waterTop + 3, W, r.waterBot - r.waterTop);
    }

    /* console ground: iron-gall tiles, two tones so it does not go flat */
    g = c.createLinearGradient(0, L.cons.y, 0, H);
    g.addColorStop(0, '#16262A'); g.addColorStop(1, '#101516');
    c.fillStyle = g; c.fillRect(L.cons.x, L.cons.y, L.cons.w, H - L.cons.y);

    /* resting ornament behind the slab: interlaced roundels, low contrast */
    if (L.card) {
      const rr = L.card.h * 0.46, y = L.card.y + L.card.h / 2, stepX = rr * 1.5;
      c.lineWidth = 7; c.strokeStyle = '#1F3B3C';
      for (let x = rr * 0.4; x < W + rr; x += stepX) { c.beginPath(); c.arc(x, y, rr, 0, 7); c.stroke(); }
    }

    /* HUD frieze */
    g = c.createLinearGradient(0, 0, 0, L.hud.h);
    g.addColorStop(0, '#0A1518'); g.addColorStop(1, '#10262A');
    c.fillStyle = g; c.fillRect(0, 0, W, L.hud.h);

    const bh = L.wide ? 10 : 7;
    dentils(c, 0, L.hud.h - bh, W, bh, '#1E2F31', P.verd);
    if (!L.side) {
      dentils(c, 0, L.cons.y, W, bh, '#23201B', P.vellum);
      c.fillStyle = P.verm; c.fillRect(0, L.cons.y + bh, W, L.wide ? 4 : 3);
    } else { c.fillStyle = P.verm; c.fillRect(L.cons.x, L.cons.y, 3, H); }

    /* data: water mask, along, across, sky mask */
    const dw = cv.width, dh = cv.height;
    const data = new Float32Array(dw * dh * 4);
    const bestD = new Float32Array(dw * dh).fill(1e9);
    if (!L.wide) {
      const hw = L.band / 2, rp = Math.ceil(hw / div) + 1;
      for (let i = 0; i < L.path.length; i += 2) {
        const p = L.path[i];
        const cx = Math.round(p.x / div), cy = Math.round(p.y / div);
        for (let y = Math.max(0, cy - rp); y <= Math.min(dh - 1, cy + rp); y++)
          for (let x = Math.max(0, cx - rp); x <= Math.min(dw - 1, cx + rp); x++) {
            const px = x * div - p.x, py = y * div - p.y, d = px * px + py * py;
            const k = y * dw + x;
            if (d < bestD[k] && d < hw * hw) {
              bestD[k] = d;
              data[k * 4] = 1; data[k * 4 + 1] = p.s; data[k * 4 + 2] = -px * p.ty + py * p.tx;
            }
          }
      }
    } else {
      const r = L.regs[0];
      for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        const py = y * div;
        if (py >= r.waterTop + 3 && py <= r.waterBot) {
          const k = (y * dw + x) * 4;
          data[k] = 1; data[k + 1] = x * div; data[k + 2] = py - r.waterTop;
        }
      }
    }
    const skyLimit = L.regs[0].wallTop - (L.wide ? 30 : 15);
    /* sky is whatever sits above the crenellated wall */
    const px = c.getImageData(0, 0, dw, dh).data;
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const py = y * div, k = (y * dw + x) * 4;
      if (py >= L.hud.h - 1 && py < L.regs[0].wallTop + 1) {
        const r = px[k], gg = px[k + 1], b = px[k + 2];
        const isBrick = r > gg + 25; /* merlons stay solid */
        if (!isBrick) data[k + 3] = 1;
      }
    }
    return { canvas: cv, data, dw, dh };
  };

  /* ---------- Hull atlas ---------- */
  const CELL_W = 256, CELL_H = 196, UNIT = 1.5;
  VZ.atlas = { CELL_W, CELL_H, cols: 4, rows: 3, W: CELL_W * 4, H: CELL_H * 6, unitW: CELL_W / UNIT, unitH: CELL_H / UNIT, ox: 0.5, oy: 0.70 };

  function hullOutline(c, cls) {
    c.beginPath();
    if (cls === 'gondola') {
      c.moveTo(-66, -26);
      c.quadraticCurveTo(-52, 8, -22, 10);
      c.lineTo(24, 10);
      c.quadraticCurveTo(56, 8, 70, -34);
      c.quadraticCurveTo(50, -15, 22, -14);
      c.lineTo(-22, -14);
      c.quadraticCurveTo(-48, -14, -66, -26);
    } else if (cls === 'galleass') {
      c.moveTo(-82, -44);
      c.lineTo(-54, -42); c.lineTo(-50, -20); c.lineTo(52, -20); c.lineTo(58, -32); c.lineTo(78, -32); c.lineTo(90, -20);
      c.lineTo(62, 4); c.quadraticCurveTo(54, 11, 36, 11);
      c.lineTo(-50, 11); c.quadraticCurveTo(-72, 11, -82, -44);
    } else {
      c.moveTo(-76, -36);
      c.quadraticCurveTo(-66, -17, -46, -17);
      c.lineTo(50, -17); c.quadraticCurveTo(64, -17, 84, -26);
      c.lineTo(60, 3); c.quadraticCurveTo(52, 11, 34, 11);
      c.lineTo(-46, 11); c.quadraticCurveTo(-68, 11, -76, -36);
    }
    c.closePath();
  }

  function paintHull(c, cls, stage, pal, mask) {
    const col = (v) => (mask ? '#000' : v);
    const G = (v) => (mask ? '#fff' : v);
    const line = (x0, y0, x1, y1, w, s) => { c.strokeStyle = s; c.lineWidth = w; c.lineCap = 'butt'; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); };
    const big = cls === 'galleass', tiny = cls === 'gondola';
    const masts = tiny ? [] : big ? [-30, 34] : [6];
    const deckY = big ? -20 : -17;
    const h = big ? 58 : 62;

    if (stage >= 1) masts.forEach((m) => line(m, deckY + 2, m, deckY - h, 6, col(pal.mast)));
    if (stage >= 2) masts.forEach((m) => {
      const top = deckY - h;
      line(m - 36, top + 34, m + 40, top + 2, 4.6, col(pal.mast));
    });
    if (stage >= 4) masts.forEach((m) => {
      const top = deckY - h;
      c.fillStyle = mask ? '#000' : pal.sail;
      c.beginPath();
      c.moveTo(m - 37, top + 36); c.lineTo(m + 41, top + 4); c.quadraticCurveTo(m + 50, top + 46, m + 18, deckY - 3); c.closePath();
      c.fill();
      c.save(); c.clip();
      c.fillStyle = G(pal.sail2);
      for (let k = 0; k < 3; k++) c.fillRect(m - 60, top + 18 + k * 19, 130, 8);
      c.restore();
    });
    /* stern shelter */
    if (!tiny) {
      c.fillStyle = col(pal.cabin);
      c.beginPath(); c.moveTo(-58, deckY + 1); c.lineTo(-56, deckY - 15); c.quadraticCurveTo(-36, deckY - 25, -20, deckY + 1); c.closePath(); c.fill();
    } else {
      c.fillStyle = col(pal.cabin); c.fillRect(-18, -29, 34, 16);
      line(-44, -18, -56, -46, 3.6, col(pal.mast));
    }
    c.fillStyle = G(pal.hull);
    hullOutline(c, cls); c.fill();
    c.save(); hullOutline(c, cls); c.clip();
    c.fillStyle = G(pal.strake);
    c.fillRect(-100, deckY - 1, 200, 5.4);
    c.fillStyle = G(pal.hull2);
    c.fillRect(-100, 5, 200, 12);
    c.restore();
    if (tiny) { /* ferro at the prow */
      line(66, -22, 73, -44, 5, G('#E9E0C8'));
    } else {
      c.fillStyle = G('#E7DFC8'); c.fillRect(big ? -81 : -77, big ? -55 : -46, 7, 9);
    }
  }

  VZ.paintHullCell = function (slot, cls, stage, pal) {
    const a = VZ.atlas;
    const cv = document.createElement('canvas');
    cv.width = CELL_W; cv.height = CELL_H * 2;
    const c = cv.getContext('2d');
    for (let m = 0; m < 2; m++) {
      c.save();
      c.translate(CELL_W * a.ox, CELL_H * a.oy + m * CELL_H);
      c.scale(UNIT, UNIT);
      paintHull(c, cls, stage, pal, m === 1);
      c.restore();
    }
    return { cv, x: (slot % a.cols) * CELL_W, y: Math.floor(slot / a.cols) * CELL_H * 2 };
  };

  VZ.hullPalettes = {
    aurora: { hull: '#7A3F28', hull2: '#2A1A14', strake: '#EFE4CB', mast: '#3A2A1E', rope: '#A9A58F', sail: '#F2EAD6', sail2: '#B83A22', cabin: '#B83A22' },
    fenice: { hull: '#744634', hull2: '#241815', strake: '#CFC2A4', mast: '#2F241C', rope: '#99917A', sail: '#D4CAB2', sail2: '#3E6F68', cabin: '#3E6F68' },
    murano: { hull: '#90643A', hull2: '#2A201A', strake: '#EFE4CB', mast: '#3A2A1E', rope: '#A7A38D', sail: '#F2EAD6', sail2: '#2F7D6E', cabin: '#2F7D6E' },
    lido: { hull: '#15191B', hull2: '#0D1012', strake: '#BDB49C', mast: '#3A2A1E', rope: '#928A74', sail: '#E8DFC8', sail2: '#555', cabin: '#6A3020' },
    torcello: { hull: '#9A623C', hull2: '#2C1E16', strake: '#E8DEC4', mast: '#3A2A1E', rope: '#A09A84', sail: '#F2EAD6', sail2: '#5B6E7A', cabin: '#5B6E7A' },
    burano: { hull: '#14181A', hull2: '#0D1012', strake: '#EFE4CB', mast: '#3A2A1E', rope: '#A9A58F', sail: '#F1E9D5', sail2: '#2F6B9A', cabin: '#2F6B9A' },
    buc: { hull: '#B02F1A', hull2: '#7E1F10', strake: '#F5E6B8', mast: '#D9A93A', rope: '#E9D9A9', sail: '#C8391F', sail2: '#D9A93A', cabin: '#C8391F' },
  };

  /* ---------- Movable type: Cardo fired into glass ---------- */
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789%.,-:/?·+';
  const GW = 64, GH = 84, GC = 9;
  VZ.glyphs = {};
  VZ.glyphW = {};
  VZ.paintGlyphs = function () {
    const rows = Math.ceil(CHARS.length / GC);
    const cv = document.createElement('canvas');
    cv.width = GW * GC; cv.height = GH * rows;
    const c = cv.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
    c.fillStyle = '#fff';
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.font = '700 66px Cardo, Georgia, serif';
    [...CHARS].forEach((ch, i) => {
      const x = (i % GC) * GW, y = Math.floor(i / GC) * GH;
      const wide = 'MW'.includes(ch);
      c.save();
      c.translate(x + GW / 2, y + GH * 0.76);
      if (wide) c.scale(0.8, 1);
      if ('%'.includes(ch)) c.scale(0.74, 0.9);
      c.fillText(ch, 0, 0);
      c.restore();
      const mw = c.measureText(ch).width * (wide ? 0.8 : '%'.includes(ch) ? 0.74 : 1);
      const f = Math.max(0.56, Math.min(1, mw / (GW * 0.72)));
      VZ.glyphW[ch] = f;
      VZ.glyphs[ch] = [(x + (GW * (1 - f)) / 2) / cv.width, y / cv.height, (GW * f) / cv.width, GH / cv.height];
    });
    return cv;
  };
})();
