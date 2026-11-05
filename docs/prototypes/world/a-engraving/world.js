/* Venezia, Direction A: The Engraving.
   world.js: composition, land, and the city cut in line once per layout. */
window.V = window.V || {};
(function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  V.clamp = clamp; V.lerp = lerp;
  V.rng = function (seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  };

  const GOLD = '#D9A93A', VERD = '#3E8E7E', VERL = '#6FB8A6', VELL = '#EFE4CB';
  const F_LAND = '#0A1C21', F_FRONT = '#0C2329', F_SIDE = '#102B2E', F_ROOF = '#0B2126';

  /* Two compositions of the same geography. Coordinates are design units.
     Street is the hull route, shaped like the reversed S of the Grand Canal. */
  const TALL = {
    w: 390, h: 470, k: 1, horizon: 106, canal: 42, sTop: .74, sBot: 1.02,
    street: [[432, 128], [340, 164], [240, 170], [150, 166], [84, 178], [42, 222], [80, 266], [150, 282], [228, 286], [298, 282], [352, 298], [374, 342], [334, 388], [234, 406], [160, 412], [104, 418], [92, 420]],
    st: { bocca: 1, disegno: 3, cantiere: 7, collaudo: 9, varo: 13, portolano: 15 },
    north: [[-10, 128], [40, 122], [92, 130], [150, 120], [210, 128], [262, 118], [320, 126], [400, 118]],
    south: [[400, 362], [352, 364], [300, 382], [246, 384], [190, 378], [130, 388], [70, 380], [24, 390], [-10, 386]],
    rii: [[[252, 170], [264, 118]], [[118, 166], [108, 118]], [[202, 284], [188, 224], [214, 168]], [[120, 278], [138, 330], [116, 390]], [[262, 286], [272, 336], [262, 388]]],
    porto: [66, 384],
    moon: [244, 72, 15], wind: [26, 90], rose: [322, 508, 40],
    labels: { bocca: [300, 200, 'c'], disegno: [146, 201, 'c'], cantiere: [128, 318, 'c'], collaudo: [335, 322, 'c'], varo: [234, 447, 'c'], portolano: [66, 447, 'c'] },
  };
  const WIDE = {
    w: 1080, h: 742, k: 1.34, horizon: 158, canal: 62, sTop: .72, sBot: 1.08,
    street: [[1140, 196], [944, 232], [800, 246], [640, 238], [440, 232], [250, 258], [188, 330], [262, 396], [440, 408], [600, 412], [772, 404], [932, 418], [1016, 486], [960, 566], [800, 606], [620, 622], [420, 640], [262, 664]],
    st: { bocca: 1, disegno: 3, cantiere: 8, collaudo: 10, varo: 15, portolano: 17 },
    north: [[-20, 196], [90, 184], [220, 196], [380, 182], [520, 192], [700, 178], [860, 190], [1000, 176], [1110, 186]],
    south: [[1110, 530], [1010, 540], [920, 566], [800, 570], [640, 576], [480, 566], [320, 584], [160, 572], [-20, 590]],
    rii: [[[700, 242], [716, 178]], [[330, 238], [320, 184]], [[520, 410], [506, 322], [540, 238]], [[350, 402], [366, 490], [340, 582]], [[690, 408], [712, 490], [690, 572]], [[860, 410], [872, 480], [850, 566]], [[900, 232], [908, 320], [870, 410]], [[130, 322], [60, 400], [90, 576]]],
    island: [[60, 668], [130, 640], [230, 646], [282, 672], [226, 706], [100, 708]],
    island2: [[820, 682], [890, 660], [980, 664], [1020, 690], [950, 716], [850, 714]],
    moon: [790, 92, 26], wind: [86, 124], rose: [1021, 917, 46],
    labels: { bocca: [912, 290, 'c'], disegno: [600, 292, 'c'], cantiere: [436, 464, 'c'], collaudo: [770, 462, 'c'], varo: [620, 668, 'c'], portolano: [176, 722, 'c'] },
  };

  V.makeLayout = function (W, H, mode, usable) {
    const P = mode === 'wide' ? WIDE : TALL;
    const sx = W / P.w, sy = usable / P.h;
    /* The sky keeps its height so the HUD and weather never collide; only the city compresses. */
    const skyH = P.horizon * Math.min(1, Math.max(sy, mode === 'wide' ? .62 : 1));
    const sy2 = (usable - skyH) / (P.h - P.horizon);
    const my = (y) => (y <= P.horizon ? y * skyH / P.horizon : skyH + (y - P.horizon) * sy2);
    const m = (p) => [p[0] * sx, my(p[1])];
    const L = { W, H, mode, P, sx, sy, usable,
      k: P.k * Math.min(sx, 1.25) * Math.min(1, Math.max(.8, sy + .1)),
      horizon: skyH, canal: P.canal * Math.min(sx, 1.15) * Math.min(1, sy + .1),
      street: P.street.map(m), north: P.north.map(m), south: P.south.map(m),
      rii: P.rii.map((r) => r.map(m)),
      island: P.island ? P.island.map(m) : null, island2: P.island2 ? P.island2.map(m) : null, porto: P.porto ? m(P.porto) : null,
      moon: [P.moon[0] * sx, my(P.moon[1]), P.moon[2] * Math.min(sx, 1.2)], wind: m(P.wind),
      rose: [P.rose[0] * sx, my(P.rose[1]), P.rose[2] * Math.min(sx, 1.2)],
      labels: {}, st: P.st };
    Object.keys(P.labels).forEach((k) => { L.labels[k] = m(P.labels[k]); });
    const topY = Math.min(...L.street.map((p) => p[1])), botY = Math.max(...L.street.map((p) => p[1]));
    L.scale = (y) => lerp(P.sTop, P.sBot, clamp((y - topY) / (botY - topY), 0, 1.25)) * L.k;
    L.at = (u) => {
      const s = L.street, n = s.length - 1;
      u = clamp(u, 0, n - .0001);
      const i = Math.floor(u), f = u - i;
      const p0 = s[Math.max(0, i - 1)], p1 = s[i], p2 = s[i + 1], p3 = s[Math.min(n, i + 2)];
      const cr = (a, b, c, d, t) => .5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      const dr = (a, b, c, d, t) => .5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t * t);
      return { x: cr(p0[0], p1[0], p2[0], p3[0], f), y: cr(p0[1], p1[1], p2[1], p3[1], f),
        a: Math.atan2(dr(p0[1], p1[1], p2[1], p3[1], f), dr(p0[0], p1[0], p2[0], p3[0], f)) };
    };
    return L;
  };

  function smoothPoly(c, pts, move) {
    if (move) c.moveTo(pts[0][0], pts[0][1]); else c.lineTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const e = pts[pts.length - 1]; c.lineTo(e[0], e[1]);
  }
  function landPath(c, L) {
    c.beginPath(); smoothPoly(c, L.north, true); smoothPoly(c, L.south, false); c.closePath();
    [L.island, L.island2].forEach((isl) => {
      if (!isl) return;
      const n = isl.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const s = mid(isl[n - 1], isl[0]); c.moveTo(s[0], s[1]);
      isl.forEach((p, i) => { const m = mid(p, isl[(i + 1) % n]); c.quadraticCurveTo(p[0], p[1], m[0], m[1]); });
      c.closePath();
    });
  }
  function streetPath(c, L) {
    const last = L.st.varo;   // past the Riva the street is open lagoon
    c.beginPath();
    for (let u = 0; u <= last - 1.5; u += .12) { const p = L.at(u); if (u === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y); }
  }
  function riiPath(c, L) {
    c.beginPath(); L.rii.forEach((r) => smoothPoly(c, r, true));
  }
  function paintLand(c, L, rim) {
    c.fillStyle = '#fff'; if (rim) c.fillStyle = F_LAND;
    landPath(c, L); c.fill();
    if (rim) { c.strokeStyle = GOLD; c.lineWidth = 1; c.globalAlpha = .75; c.stroke(); c.globalAlpha = 1; }
    c.globalCompositeOperation = 'destination-out';
    c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = '#000';
    streetPath(c, L); c.lineWidth = L.canal; c.stroke();
    riiPath(c, L); c.lineWidth = L.canal * .17; c.stroke();
    c.globalCompositeOperation = 'source-over';
  }

  /* Exact distance transform (Felzenszwalb), on a half-resolution grid. */
  function edt(land, w, h) {
    const INF = 1e9, g = new Float32Array(w * h), f = new Float32Array(Math.max(w, h)),
      d = new Float32Array(Math.max(w, h)), v = new Int32Array(Math.max(w, h)), z = new Float32Array(Math.max(w, h) + 1);
    for (let i = 0; i < w * h; i++) g[i] = land[i] ? 0 : INF;
    const pass = (n) => {
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < n; q++) {
        let s;
        do { const p = v[k]; s = (f[q] + q * q - f[p] - p * p) / (2 * q - 2 * p); } while (s <= z[k] && --k >= 0);
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
    };
    for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = g[x + y * w]; pass(h); for (let y = 0; y < h; y++) g[x + y * w] = d[y]; }
    for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = g[x + y * w]; pass(w); for (let x = 0; x < w; x++) g[x + y * w] = d[x]; }
    for (let i = 0; i < w * h; i++) g[i] = Math.sqrt(g[i]);
    return g;
  }

  /* Grid for placement and the field texture: R distance to land, G reflected city. */
  V.buildField = function (L, cityCanvas) {
    const S = 2, tw = Math.ceil(L.W / S), th = Math.ceil(L.H / S);
    const mc = document.createElement('canvas'); mc.width = tw; mc.height = th;
    const m = mc.getContext('2d', { willReadFrequently: true });
    m.scale(1 / S, 1 / S); paintLand(m, L, false);
    const a = m.getImageData(0, 0, tw, th).data, land = new Uint8Array(tw * th);
    for (let i = 0; i < tw * th; i++) land[i] = a[i * 4 + 3] > 127 ? 1 : 0;
    const dist = edt(land, tw, th);
    const grid = { S, tw, th, land, dist };
    grid.isLand = (x, y) => { const i = Math.floor(x / S), j = Math.floor(y / S); return i >= 0 && j >= 0 && i < tw && j < th && land[i + j * tw] === 1; };
    if (!cityCanvas) return grid;

    const lc = document.createElement('canvas'); lc.width = tw; lc.height = th;
    const lx = lc.getContext('2d', { willReadFrequently: true }); lx.imageSmoothingQuality = 'high';
    lx.drawImage(cityCanvas, 0, 0, tw, th);
    const px = lx.getImageData(0, 0, tw, th).data, lum = new Float32Array(tw * th);
    for (let i = 0; i < tw * th; i++) lum[i] = (px[i * 4] * .5 + px[i * 4 + 1] * .4 + px[i * 4 + 2] * .1) / 255 * (px[i * 4 + 3] / 255);
    const tex = new Uint8Array(tw * th * 4), hz = Math.ceil(L.horizon / S);
    for (let x = 0; x < tw; x++) {
      let last = -1;
      for (let y = 0; y < th; y++) {
        const i = x + y * tw;
        if (land[i]) last = y;
        let r = 0;
        if (!land[i] && last >= hz) {
          const dd = y - last, sy = last - dd;
          if (sy > 0) { const fall = Math.exp(-dd / 24); r = Math.min(1, lum[x + sy * tw] * 1.5) * fall; }
        }
        tex[i * 4] = Math.min(255, dist[i] / 36 * 255);
        tex[i * 4 + 1] = r * 255; tex[i * 4 + 3] = 255;
      }
    }
    grid.tex = tex;
    return grid;
  };

  /* ---------- line work primitives ---------- */
  function poly(c, pts) { c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.closePath(); }
  function hatch(c, pts, ang, sp, col, lw, r, alpha) {
    c.save(); poly(c, pts); c.clip();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    pts.forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = Math.hypot(x1 - x0, y1 - y0) / 2 + 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    c.strokeStyle = col; c.lineWidth = lw; c.globalAlpha = alpha == null ? 1 : alpha; c.beginPath();
    for (let o = -R; o < R; o += sp) {
      const j = r ? (r() - .5) * sp * .35 : 0, l = R * (r ? .9 + r() * .1 : 1);
      c.moveTo(cx - ca * l - sa * (o + j), cy - sa * l + ca * (o + j));
      c.lineTo(cx + ca * l - sa * (o + j), cy + sa * l + ca * (o + j));
    }
    c.stroke(); c.restore(); c.globalAlpha = 1;
  }
  function edge(c, pts, col, lw, alpha, close) {
    c.strokeStyle = col; c.lineWidth = lw; c.globalAlpha = alpha == null ? 1 : alpha; c.lineJoin = 'round';
    c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); if (close) c.closePath(); c.stroke(); c.globalAlpha = 1;
  }

  /* A box seen from above and to the south. side is +1 (east wall shows) or -1 (west). */
  function block(c, r, b) {
    const { x, y, w, h, d, side = 1, rh = 0, a = .8, roof = VERD, lit = .5 } = b;
    const dx = d * .56 * side, dy = -d * .4;
    const fl = [x, y], fr = [x + w, y], tl = [x, y - h], tr = [x + w, y - h];
    const bx = side > 0 ? x + w : x;
    const sb = [bx + dx, y + dy], st = [bx + dx, y - h + dy], fb = [bx, y], ft = [bx, y - h];
    c.fillStyle = F_SIDE; poly(c, [fb, sb, st, ft]); c.fill();
    hatch(c, [fb, sb, st, ft], 1.2, lerp(2.6, 1.15, lit), GOLD, .5, r, a * .85);
    edge(c, [fb, sb, st, ft], GOLD, .6, a, true);
    c.fillStyle = F_FRONT; poly(c, [fl, fr, tr, tl]); c.fill();
    edge(c, [fl, fr, tr, tl], GOLD, .6, a, true);
    if (!b.noWin) windows(c, r, x, y, w, h, a);
    if (rh > 0) {
      const r1 = [tl[0] + dx / 2, tl[1] + dy / 2 - rh], r2 = [tr[0] + dx / 2, tr[1] + dy / 2 - rh];
      const slope = [tl, tr, r2, r1];
      c.fillStyle = F_ROOF; poly(c, slope); c.fill();
      hatch(c, slope, Math.atan2(r1[1] - tl[1], r1[0] - tl[0]), 1.5, roof, .55, r, a);
      edge(c, slope, roof === GOLD ? GOLD : VERL, .55, a, true);
      const gabT = side > 0 ? [tr, st, r2] : [tl, st, r1];
      c.fillStyle = F_SIDE; poly(c, gabT); c.fill();
      hatch(c, gabT, 1.2, 1.3, GOLD, .5, r, a * .8);
      edge(c, gabT, GOLD, .55, a, true);
    } else {
      const roofP = side > 0 ? [tl, tr, st, [tl[0] + dx, tl[1] + dy]] : [tr, tl, st, [tr[0] + dx, tr[1] + dy]];
      c.fillStyle = F_ROOF; poly(c, roofP); c.fill();
      hatch(c, roofP, 0, 2, roof, .5, r, a * .6);
      edge(c, roofP, GOLD, .5, a, true);
    }
  }
  function windows(c, r, x, y, w, h, a) {
    const rows = Math.max(1, Math.floor(h / 6)), cols = Math.max(2, Math.floor(w / 3.2));
    c.strokeStyle = GOLD; c.lineWidth = .7; c.beginPath();
    for (let j = 0; j < rows; j++) {
      const wy = y - h + (j + .5) * h / rows;
      for (let i = 0; i < cols; i++) {
        if (r() < .32) continue;
        const wx = x + (i + .5) * w / cols;
        c.moveTo(wx, wy - 1.4); c.lineTo(wx, wy + 1.2);
      }
    }
    c.globalAlpha = a * .9; c.stroke(); c.globalAlpha = 1;
  }
  function arches(c, x, y, w, h, n, col, lw, a, pointed) {
    c.strokeStyle = col; c.lineWidth = lw; c.globalAlpha = a; c.beginPath();
    const aw = w / n;
    for (let i = 0; i < n; i++) {
      const ax = x + i * aw + aw * .14, bw = aw * .72, sp = y - h * .55;
      c.moveTo(ax, y); c.lineTo(ax, sp);
      if (pointed) { c.quadraticCurveTo(ax + bw * .08, y - h * .92, ax + bw / 2, y - h); c.quadraticCurveTo(ax + bw * .92, y - h * .92, ax + bw, sp); }
      else c.arc(ax + bw / 2, sp, bw / 2, Math.PI, 0);
      c.lineTo(ax + bw, y);
    }
    c.stroke(); c.globalAlpha = 1;
  }
  function crenels(c, x, y, w, n, h, col, a) {
    c.fillStyle = col; c.globalAlpha = a;
    const s = w / (n * 2 - 1);
    for (let i = 0; i < n; i++) c.fillRect(x + i * 2 * s, y - h, s, h);
    c.globalAlpha = 1;
  }
  function tower(c, r, x, y, w, h, a, o = {}) {
    const dx = w * .46 * (o.side || 1), dy = -w * .33, bx = (o.side || 1) > 0 ? x + w : x;
    const fb = [bx, y], sb = [bx + dx, y + dy], st = [bx + dx, y - h + dy], ft = [bx, y - h];
    c.fillStyle = F_SIDE; poly(c, [fb, sb, st, ft]); c.fill();
    hatch(c, [fb, sb, st, ft], Math.PI / 2, 1.0, GOLD, .55, r, a);
    edge(c, [fb, sb, st, ft], GOLD, .6, a, true);
    const f = [[x, y], [x + w, y], [x + w, y - h], [x, y - h]];
    c.fillStyle = F_FRONT; poly(c, f); c.fill();
    hatch(c, f, 0, 2.2, GOLD, .4, r, a * .55);
    edge(c, f, GOLD, .65, a, true);
    if (o.belfry !== false) {
      const by = y - h + (o.bh || h * .16);
      c.fillStyle = '#071417'; c.fillRect(x + .6, by - (o.bh || h * .16), w - 1.2, o.bh || h * .16);
      arches(c, x + .3, by, w - .6, (o.bh || h * .16) * .9, o.bn || 2, GOLD, .55, a, false);
    }
    if (o.cap !== false) {
      const tip = [x + w / 2 + dx / 2, y - h + dy / 2 - (o.ch || w * 1.5)];
      const lf = [[x, y - h], [x + w, y - h], tip], rf = [[bx, y - h], [bx + dx, y - h + dy], tip];
      c.fillStyle = F_SIDE; poly(c, rf); c.fill(); hatch(c, rf, 1, 1.0, VERL, .5, r, a);
      c.fillStyle = F_ROOF; poly(c, lf); c.fill(); hatch(c, lf, 1.9, 1.5, VERD, .5, r, a);
      edge(c, lf, VERL, .55, a, true); edge(c, rf, VERL, .55, a, true);
      return tip;
    }
    return null;
  }
  function dome(c, r, x, y, rad, a, col) {
    col = col || GOLD;
    c.fillStyle = F_ROOF; c.beginPath(); c.arc(x, y, rad, Math.PI, 0); c.closePath(); c.fill();
    c.save(); c.beginPath(); c.arc(x, y, rad, Math.PI, 0); c.closePath(); c.clip();
    c.strokeStyle = col; c.lineWidth = .55; c.globalAlpha = a; c.beginPath();
    for (let i = -6; i <= 6; i++) { const k = i / 6; c.moveTo(x, y - rad); c.quadraticCurveTo(x + k * rad * 1.45, y - rad * .55, x + k * rad, y); }
    for (let j = 1; j < 4; j++) { c.moveTo(x - rad, y - j * rad * .26); c.lineTo(x + rad, y - j * rad * .26); }
    c.stroke(); c.restore(); c.globalAlpha = a;
    c.strokeStyle = col; c.lineWidth = .7; c.beginPath(); c.arc(x, y, rad, Math.PI, 0); c.stroke();
    c.beginPath(); c.moveTo(x, y - rad); c.lineTo(x, y - rad * 1.32); c.stroke();
    c.fillStyle = col; c.beginPath(); c.arc(x, y - rad * 1.34, Math.max(.7, rad * .07), 0, 7); c.fill(); c.globalAlpha = 1;
  }

  /* ---------- the six stations ---------- */
  const Stations = {
    bocca(c, r, x, y, s, L) {
      // The Porta: two crenellated water towers either side of the canal.
      const gap = L.canal * .5 + 2;
      const north = y - gap, south = y + gap + 16 * s;
      tower(c, r, x - 9 * s, north, 18 * s, 40 * s, 1, { cap: false, belfry: false, side: -1 });
      crenels(c, x - 9 * s, north - 40 * s, 18 * s, 5, 2.4 * s, GOLD, 1);
      c.fillStyle = '#071417'; c.beginPath(); c.arc(x, north - 14 * s, 3.6 * s, Math.PI, 0); c.lineTo(x + 3.6 * s, north - 6 * s); c.lineTo(x - 3.6 * s, north - 6 * s); c.closePath(); c.fill();
      c.strokeStyle = GOLD; c.lineWidth = .7; c.stroke();
      return { after() {
        tower(c, r, x - 9 * s, south, 18 * s, 36 * s, 1, { cap: false, belfry: false, side: -1 });
        crenels(c, x - 9 * s, south - 36 * s, 18 * s, 5, 2.4 * s, GOLD, 1);
        // the lion's mouth, cut small and exact
        const lx = x, ly = south - 15 * s;
        c.fillStyle = F_FRONT; c.beginPath(); c.arc(lx, ly, 5.4 * s, 0, 7); c.fill();
        c.strokeStyle = GOLD; c.lineWidth = .65; c.stroke();
        c.beginPath();
        for (let i = 0; i < 14; i++) { const a = i / 14 * 6.28; c.moveTo(lx + Math.cos(a) * 3.8 * s, ly + Math.sin(a) * 3.8 * s); c.lineTo(lx + Math.cos(a) * 5.4 * s, ly + Math.sin(a) * 5.4 * s); }
        c.stroke();
        c.fillStyle = '#04100F'; c.fillRect(lx - 2.6 * s, ly + .6 * s, 5.2 * s, 1.5 * s);
        c.fillStyle = GOLD; c.fillRect(lx - 2 * s, ly - 1.8 * s, 1.1 * s, 1 * s); c.fillRect(lx + .9 * s, ly - 1.8 * s, 1.1 * s, 1 * s);
      } };
    },
    disegno(c, r, x, y, s) {
      // Palace of the contract: gothic arcades below, patterned wall above.
      const w = 84 * s, h = 30 * s, x0 = x - w / 2;
      block(c, r, { x: x0, y, w, h, d: 18 * s, rh: 5 * s, a: 1, lit: .7, noWin: true });
      arches(c, x0 + 1, y, w - 2, h * .3, 13, GOLD, .6, 1, true);
      c.strokeStyle = GOLD; c.lineWidth = .5; c.beginPath(); c.moveTo(x0, y - h * .34); c.lineTo(x0 + w, y - h * .34); c.moveTo(x0, y - h * .6); c.lineTo(x0 + w, y - h * .6); c.stroke();
      arches(c, x0 + 1, y - h * .34, w - 2, h * .24, 24, GOLD, .5, 1, true);
      const wall = [[x0, y - h * .6], [x0 + w, y - h * .6], [x0 + w, y - h], [x0, y - h]];
      hatch(c, wall, .9, 3.1, GOLD, .4, null, .75); hatch(c, wall, -.9, 3.1, GOLD, .4, null, .75);
      for (let i = 0; i < 6; i++) {
        const wx = x0 + (i + .5) * w / 6;
        c.fillStyle = '#071417'; c.fillRect(wx - 1.5 * s, y - h * .94, 3 * s, h * .28);
        c.strokeStyle = GOLD; c.lineWidth = .6; c.strokeRect(wx - 1.5 * s, y - h * .94, 3 * s, h * .28);
      }
      crenels(c, x0, y - h, w, 22, 1.8 * s, GOLD, .9);
    },
    cantiere(c, r, x, y, s) {
      // The tese: open gabled sheds, roofs running back in a sawtooth.
      const n = 5, bw = 22 * s, h = 16 * s, gab = 9 * s, d = 42 * s, dx = d * .5, dy = -d * .4, x0 = x - n * bw / 2;
      for (let i = 0; i < n; i++) {
        const a = x0 + i * bw, b = a + bw, m = a + bw / 2;
        const rf = [[m, y - h - gab], [b, y - h], [b + dx, y - h + dy], [m + dx, y - h - gab + dy]];
        const lf = [[a, y - h], [m, y - h - gab], [m + dx, y - h - gab + dy], [a + dx, y - h + dy]];
        c.fillStyle = F_SIDE; poly(c, lf); c.fill(); hatch(c, lf, 1.1, 1.05, GOLD, .5, r, .9); edge(c, lf, GOLD, .55, 1, true);
        c.fillStyle = F_ROOF; poly(c, rf); c.fill(); hatch(c, rf, 2.2, 1.9, VERD, .5, r, 1); edge(c, rf, VERL, .55, 1, true);
        const face = [[a, y], [b, y], [b, y - h], [m, y - h - gab], [a, y - h]];
        c.fillStyle = F_FRONT; poly(c, face); c.fill();
        // the bay: light is density, so the working shed is filled with close lines
        const bay = [[a + 3 * s, y], [b - 3 * s, y], [b - 3 * s, y - h * .7], [m, y - h * 1.05], [a + 3 * s, y - h * .7]];
        c.fillStyle = '#061315'; poly(c, bay); c.fill();
        hatch(c, bay, Math.PI / 2, i === 1 || i === 2 ? .9 : 1.9, GOLD, .55, r, i === 1 || i === 2 ? 1 : .55);
        edge(c, bay, GOLD, .6, 1, true); edge(c, face, GOLD, .65, 1, true);
      }
      // a crane on the quay
      const cx = x0 + n * bw + 6 * s;
      edge(c, [[cx, y], [cx, y - 34 * s], [cx - 20 * s, y - 28 * s]], VELL, .8, .9);
      edge(c, [[cx, y - 34 * s], [cx + 8 * s, y - 20 * s], [cx, y - 10 * s]], VELL, .55, .8);
      edge(c, [[cx - 20 * s, y - 28 * s], [cx - 20 * s, y - 12 * s]], VELL, .5, .8);
    },
    collaudo(c, r, x, y, s) {
      // The proving house: a hall and a square gate tower. No model decides here.
      block(c, r, { x: x - 34 * s, y, w: 44 * s, h: 22 * s, d: 16 * s, rh: 6 * s, a: 1, lit: .6, noWin: true });
      arches(c, x - 33 * s, y, 42 * s, 13 * s, 7, GOLD, .6, 1, false);
      tower(c, r, x + 12 * s, y, 16 * s, 46 * s, 1, { bn: 2, bh: 8 * s, ch: 16 * s });
      dome(c, r, x - 12 * s, y - 28 * s, 8 * s, 1, VERL);
    },
    varo(c, r, x, y, s) {
      // The Piazzetta: basilica domes, the great bell tower, two columns on the shore.
      const bx = x - 42 * s, by = y - 8 * s;
      block(c, r, { x: bx, y: by, w: 64 * s, h: 20 * s, d: 16 * s, rh: 0, a: 1, lit: .5, noWin: true, roof: GOLD });
      arches(c, bx + 1, by, 62 * s, 14 * s, 5, GOLD, .7, 1, false);
      dome(c, r, bx + 14 * s, by - 24 * s, 8.5 * s, 1);
      dome(c, r, bx + 34 * s, by - 28 * s, 11 * s, 1);
      dome(c, r, bx + 53 * s, by - 24 * s, 8.5 * s, 1);
      const tip = tower(c, r, x + 28 * s, y - 4 * s, 11 * s, 76 * s, 1, { bn: 3, bh: 7 * s, ch: 17 * s });
      if (tip) { c.strokeStyle = GOLD; c.lineWidth = .9; c.beginPath(); c.moveTo(tip[0], tip[1]); c.lineTo(tip[0], tip[1] - 5 * s); c.stroke(); }
      [x + 4 * s, x + 17 * s].forEach((cx) => {
        c.strokeStyle = VELL; c.lineWidth = 1.5 * s; c.beginPath(); c.moveTo(cx, y + 3 * s); c.lineTo(cx, y - 25 * s); c.stroke();
        c.fillStyle = VELL; c.fillRect(cx - 2 * s, y - 27 * s, 4 * s, 2 * s);
      });
      c.fillStyle = GOLD; c.beginPath(); c.arc(x + 4 * s, y - 29 * s, 1.6 * s, 0, 7); c.fill();
      c.fillRect(x + 16.2 * s, y - 31 * s, 1.6 * s, 4 * s);
    },
    portolano(c, r, x, y, s) {
      // The chart house, with a globe on its roof.
      block(c, r, { x: x - 22 * s, y, w: 34 * s, h: 14 * s, d: 12 * s, rh: 5 * s, a: 1, lit: .6 });
      tower(c, r, x + 14 * s, y, 11 * s, 30 * s, 1, { cap: false, bn: 2, bh: 6 * s });
      const gx = x + 20 * s, gy = y - 37 * s, gr = 6.5 * s;
      c.strokeStyle = GOLD; c.lineWidth = .7; c.beginPath(); c.arc(gx, gy, gr, 0, 7); c.stroke();
      c.lineWidth = .5; c.beginPath(); c.ellipse(gx, gy, gr, gr * .36, .3, 0, 7); c.moveTo(gx, gy - gr); c.ellipse(gx, gy, gr * .42, gr, 0, 0, 7); c.moveTo(gx + gr, gy); c.ellipse(gx, gy, gr, gr * .3, -.5, 0, 7); c.stroke();
    },
  };

  function alps(c, r, L) {
    const base = L.horizon, W = L.W, rise = 22 * Math.min(L.sy, 1.2) * (L.mode === 'wide' ? 1.8 : 1);
    const pts = [[-4, base]];
    let x = -4;
    while (x < W + 6) {
      x += (9 + r() * 15) * (L.mode === 'wide' ? 1.4 : 1);
      pts.push([x, base - rise * (.25 + r() * .75)]);
      x += (5 + r() * 9) * (L.mode === 'wide' ? 1.4 : 1);
      pts.push([x, base - rise * (.08 + r() * .25)]);
    }
    pts.push([W + 6, base]);
    c.fillStyle = '#0A1F25'; poly(c, pts); c.fill();
    for (let i = 1; i < pts.length - 2; i += 2) {
      const a = pts[i], b = pts[i + 1], p = pts[i - 1];
      const face = [a, b, [(a[0] + b[0]) / 2 + 4, base]];
      hatch(c, face, 1.7, 1.25, VELL, .45, r, .62);
      const back = [a, p, [(a[0] + p[0]) / 2, base]];
      hatch(c, back, 2.6, 3.2, VERD, .4, r, .6);
    }
    edge(c, pts, VELL, .6, .8);
    // terraferma: a low ruled strip
    c.strokeStyle = VERD; c.globalAlpha = .7; c.lineWidth = .5; c.beginPath();
    for (let i = 0; i < 3; i++) { c.moveTo(0, base + i * 1.4); c.lineTo(W, base + i * 1.4 + (i ? .2 : 0)); }
    c.stroke(); c.globalAlpha = 1;
  }

  /* A wind head, as de' Barbari cut eight of them. */
  function windHead(c, x, y, s) {
    const col = VELL;
    c.save(); c.translate(x, y); c.scale(s, s);
    // wing
    c.strokeStyle = GOLD; c.lineWidth = .55;
    for (let i = 0; i < 6; i++) { const a = 2.5 + i * .23, l = 19 - i * .9; c.beginPath(); c.moveTo(-6, -1); c.quadraticCurveTo(Math.cos(a) * l * .6 - 4, Math.sin(a) * l * .9 - 5, Math.cos(a) * l - 6, Math.sin(a) * l - 2); c.stroke(); }
    // skull and face
    c.fillStyle = '#0B2329'; c.beginPath(); c.arc(0, 0, 12.5, 0, 7); c.fill();
    c.strokeStyle = col; c.lineWidth = .8; c.beginPath(); c.arc(0, 0, 12.5, -2.4, 2.1); c.stroke();
    // puffed cheek
    c.fillStyle = '#0B2329'; c.beginPath(); c.arc(8.5, 3, 7.4, 0, 7); c.fill();
    c.strokeStyle = col; c.lineWidth = .8; c.beginPath(); c.arc(8.5, 3, 7.4, -1.1, 2.3); c.stroke();
    c.lineWidth = .45; for (let i = 0; i < 6; i++) { c.beginPath(); c.arc(8.5, 3, 6.4 - i * .85, .1, 1.7); c.stroke(); }
    // lips, eye, brow, nose
    c.lineWidth = .9; c.beginPath(); c.moveTo(15.2, .6); c.quadraticCurveTo(19, 2, 15.6, 3.8); c.stroke();
    c.lineWidth = .7; c.beginPath(); c.arc(4.2, -3.6, 2, 3.5, 6.2); c.stroke(); c.beginPath(); c.arc(4.4, -3.2, .7, 0, 7); c.fillStyle = col; c.fill();
    c.beginPath(); c.moveTo(1, -7.4); c.quadraticCurveTo(5, -9.4, 8.4, -6.8); c.stroke();
    c.beginPath(); c.moveTo(9, -5.6); c.quadraticCurveTo(12.4, -2.8, 10.2, -1.6); c.stroke();
    // curls
    c.strokeStyle = GOLD; c.lineWidth = .7;
    [[-7, -9], [-1, -12.2], [-11, -3], [-12, 3.6], [-8.4, 9], [-2, 12], [5.6, -13]].forEach((q, i) => {
      c.beginPath();
      for (let t = 0; t < 12; t++) { const a = t * .62 + i, rr = 4.2 - t * .32; const px = q[0] + Math.cos(a) * rr, py = q[1] + Math.sin(a) * rr; if (t) c.lineTo(px, py); else c.moveTo(px, py); }
      c.stroke();
    });
    c.restore();
  }

  function rose(c, x, y, R) {
    c.save(); c.translate(x, y);
    c.strokeStyle = GOLD; c.lineWidth = .45; c.globalAlpha = .5; c.beginPath();
    for (let i = 0; i < 16; i++) { const a = i / 16 * 6.283; c.moveTo(Math.cos(a) * R * .55, Math.sin(a) * R * .55); c.lineTo(Math.cos(a) * R * 2.2, Math.sin(a) * R * 2.2); }
    c.stroke(); c.globalAlpha = .85;
    c.lineWidth = .6; c.beginPath(); c.arc(0, 0, R * .52, 0, 7); c.stroke(); c.beginPath(); c.arc(0, 0, R * .46, 0, 7); c.stroke();
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * 6.283 - 1.5708, l = (i % 2 ? .3 : .46) * R, w = .08 * R;
      const tip = [Math.cos(a) * l, Math.sin(a) * l], lf = [Math.cos(a + 1.57) * w, Math.sin(a + 1.57) * w], rg = [-lf[0], -lf[1]];
      c.fillStyle = '#0B1F24'; poly(c, [tip, lf, rg]); c.fill();
      c.fillStyle = i % 2 ? VERD : GOLD; poly(c, [tip, lf, [0, 0]]); c.fill();
      edge(c, [tip, lf, [0, 0], rg], GOLD, .5, 1, true);
    }
    c.restore(); c.globalAlpha = 1;
  }

  V.drawCity = function (cv, L, dpr, grid) {
    const c = cv.getContext('2d'), W = L.W, H = L.H;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    const r = V.rng(1500);
    alps(c, r, L);

    // land on its own layer so the canal can be cut from it
    const lc = document.createElement('canvas'); lc.width = cv.width; lc.height = cv.height;
    const l = lc.getContext('2d'); l.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintLand(l, L, true);
    l.globalCompositeOperation = 'source-atop';
    l.strokeStyle = GOLD; l.lineCap = 'round'; l.lineJoin = 'round'; l.globalAlpha = .9;
    streetPath(l, L); l.lineWidth = L.canal + 1.8; l.stroke();
    riiPath(l, L); l.lineWidth = L.canal * .17 + 1.2; l.stroke();
    l.globalAlpha = .42; l.strokeStyle = VERD; l.lineWidth = .45; l.beginPath();
    for (let o = -H; o < W + H; o += 3.1) { l.moveTo(o, 0); l.lineTo(o + H * .72, H); }
    l.stroke();
    l.globalCompositeOperation = 'source-over'; l.globalAlpha = 1;
    c.drawImage(lc, 0, 0, W, H);

    // reserve ground for the stations, then fill the rest of the city back to front
    const S = Object.keys(Stations).map((name) => {
      const p = L.at(L.st[name]), s = L.scale(p.y), gap = L.canal / 2;
      const spec = { name, s, x: p.x, y: p.y - gap - 1 };
      if (name === 'bocca') spec.y = p.y;
      if (name === 'varo') { spec.x = p.x + 2 * s; spec.y = L.south.reduce((m, q) => (Math.abs(q[0] - p.x) < Math.abs(m[0] - p.x) ? q : m), L.south[0])[1] - 1; }
      if (name === 'portolano' && L.porto) { spec.x = L.porto[0]; spec.y = L.porto[1]; }
      else if (name === 'portolano') { const isl = L.island; spec.x = isl.reduce((a, q) => a + q[0], 0) / isl.length + 6 * s; spec.y = isl.reduce((a, q) => a + q[1], 0) / isl.length + 8 * s; }
      return spec;
    });
    const rects = {
      bocca: (q) => [q.x - 14 * q.s, q.y - L.canal - 18 * q.s, 28 * q.s, 2 * L.canal + 36 * q.s],
      disegno: (q) => [q.x - 45 * q.s, q.y - 14 * q.s, 90 * q.s, 16 * q.s],
      cantiere: (q) => [q.x - 60 * q.s, q.y - 18 * q.s, 134 * q.s, 20 * q.s],
      collaudo: (q) => [q.x - 38 * q.s, q.y - 16 * q.s, 72 * q.s, 18 * q.s],
      varo: (q) => [q.x - 46 * q.s, q.y - 26 * q.s, 92 * q.s, 32 * q.s],
      portolano: (q) => [q.x - 26 * q.s, q.y - 14 * q.s, 54 * q.s, 18 * q.s],
    };
    const reserved = S.map((q) => rects[q.name](q));
    const blocked = (x, y, w, h) => reserved.some((b) => x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]);

    const items = [];
    const margin = L.mode === 'wide' ? 5 : 3;
    const onLand = (x, y) => { if (!grid.isLand(x, y)) return false; for (let a = 0; a < 6.28; a += 1.05) if (!grid.isLand(x + Math.cos(a) * margin, y + Math.sin(a) * margin)) return false; return true; };
    const campo = (x, y) => { const q = Math.sin(x * .031 + 2) * Math.sin(y * .047 + 1) + Math.sin(x * .013 + y * .017) * .6; return q > .92; };
    const gScale = L.mode === 'wide' ? .62 : .78;
    for (let y = L.horizon + 8; y < L.usable + 40; y += 7.2 * gScale * L.scale(y)) {
      const s = L.scale(y) * gScale;
      for (let x = -10 + r() * 8; x < W + 8;) {
        const w = (9 + r() * 15) * s, h = (6 + r() * 7) * s, d = (8 + r() * 6) * s, rh = (3 + r() * 3) * s, yy = y + r() * 3;
        const top = yy - h - d * .4 - rh;
        if (onLand(x, yy) && onLand(x + w, yy) && onLand(x, top) && onLand(x + w + d * .56, top) && !blocked(x, yy - 8 * s, w + d * .56, 10 * s) && !campo(x, yy) && r() > .05) {
          const side = x < W * .5 ? 1 : -1, roof = r() < .2 ? GOLD : VERD, lit = .2 + r() * .65, a = .46 + .3 * Math.min(1, yy / L.usable);
          items.push({ y: yy, draw() { block(c, r, { x, y: yy, w, h, d, rh, a, side, roof, lit }); } });
        }
        x += w + (1 + r() * 3.5) * s;
      }
    }
    // bell towers, each a beacon in de' Barbari's sense
    const towers = L.mode === 'wide' ? 22 : 9;
    for (let i = 0, tries = 0; i < towers && tries < 900; tries++) {
      const x = r() * W, y = L.horizon + r() * (L.usable - L.horizon), s = L.scale(y), tw = 6 * s, th = (24 + r() * 16) * s;
      if (!grid.isLand(x, y) || !grid.isLand(x + tw, y) || !grid.isLand(x, y - th * .5) || blocked(x - 2, y - th, tw + 4, th)) continue;
      items.push({ y: y + 1, draw() { tower(c, r, x, y, tw, th, .8, { bn: 1, bh: 4 * s, ch: 8 * s }); } }); i++;
    }
    S.forEach((q) => {
      items.push({ y: q.y + (q.name === 'bocca' ? -L.canal : 0), draw() {
        const res = Stations[q.name](c, r, q.x, q.y, q.s, L);
        if (res && res.after) items.push({ y: q.y + L.canal, draw: res.after });
      } });
    });
    // Sorted once. Bocca's south tower is appended during the walk, so it lands last.
    items.sort((a, b) => a.y - b.y);
    for (let i = 0; i < items.length; i++) items[i].draw();
    L.stationSpecs = S;
    windHead(c, L.wind[0], L.wind[1], (L.mode === 'wide' ? 1.7 : 1.08) * Math.max(.9, L.sx > 1.2 ? 1 : L.sx));
    rose(c, L.rose[0], L.rose[1], L.rose[2]);
  };
})();
