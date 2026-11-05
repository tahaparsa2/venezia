/* ships.js: hulls in side elevation, cut as sprites and drawn over the city. */
window.V = window.V || {};
(function () {
  const { clamp, lerp, rng } = V;
  const GOLD = '#D9A93A', VELL = '#EFE4CB', VERD = '#3E8E7E', VERL = '#6FB8A6', RED = '#C8391F', INK = '#0B1F24', PALE = '#F2DFAE';
  const LAMP = { idle: '#EFE4CB', work: '#5EA8E0', done: '#57C58A', need: '#E9A23B', fail: '#E5482A' };

  function hullShape(c) {
    c.beginPath(); c.moveTo(-52, -17);
    c.quadraticCurveTo(-34, -8, 0, -7.5); c.quadraticCurveTo(26, -7, 44, -10);
    c.lineTo(66, -13.5); c.lineTo(47, -5.5); c.quadraticCurveTo(38, 0, 22, 0); c.lineTo(-32, 0);
    c.quadraticCurveTo(-46, -3, -52, -17); c.closePath();
  }
  function sheer(c, o) { c.beginPath(); c.moveTo(-50 + o * .3, -15 + o); c.quadraticCurveTo(-34, -8 + o * .9, 0, -7.5 + o * .86); c.quadraticCurveTo(26, -7 + o * .84, 45, -9.6 + o * .9); c.stroke(); }

  /* stage: 0 ribs, .3 planked in part, .55 mast, .75 yard and rigging, .9 oars, 1 sail */
  function drawGalley(c, h) {
    const p = h.progress, gilt = h.mode === 'gilt', leak = h.mode === 'leak';
    const line = gilt ? '#2A1C05' : PALE;
    const r = rng(h.seed || 7);
    c.lineJoin = 'round'; c.lineCap = 'round';
    // masts and sail stand behind the hull
    const metal = gilt ? GOLD : PALE;
    const lateen = (mx, base, top, tackX, tackY, peakX, peakY, clewX, clewY, set) => {
      c.strokeStyle = metal; c.lineWidth = 1.5; c.beginPath(); c.moveTo(mx, base); c.lineTo(mx, top); c.stroke();
      if (p < .7) return;
      if (set) {
        const sail = () => { c.beginPath(); c.moveTo(tackX, tackY); c.lineTo(peakX, peakY); c.quadraticCurveTo(clewX - 6, (peakY + clewY) / 2 + 2, clewX, clewY); c.quadraticCurveTo((tackX + clewX) / 2, clewY + 4, tackX, tackY); c.closePath(); };
        sail(); c.fillStyle = gilt ? '#E7BC54' : '#123038'; c.fill();
        c.save(); sail(); c.clip();
        c.strokeStyle = gilt ? '#6B480E' : VELL; c.lineWidth = .5; c.beginPath();
        for (let i = -16; i < 92; i += 1.9) { const t = i / 76; c.moveTo(lerp(peakX, tackX, t), lerp(peakY, tackY, t)); c.lineTo(lerp(peakX, tackX, t) + (clewX - peakX) * .75, lerp(peakY, tackY, t) + 62); }
        c.stroke(); c.restore();
        sail(); c.strokeStyle = gilt ? '#FFF1C4' : PALE; c.lineWidth = .7; c.stroke();
      }
      c.strokeStyle = metal; c.lineWidth = 1.5; c.beginPath(); c.moveTo(tackX + 3, tackY + 1.6); c.lineTo(peakX - 3, peakY - 1.6); c.stroke();
    };
    if (p >= .5) {
      lateen(4, -8, -52, 42, -13, -36, -66, -30, -13, p >= 1);
      if (p >= .85) lateen(33, -9, -33, 56, -13, 12, -44, 14, -13, p >= 1);
    }
    if (p >= .7) {
      c.strokeStyle = metal; c.lineWidth = .5; c.beginPath(); c.moveTo(4, -50); c.lineTo(-44, -14); c.moveTo(4, -50); c.lineTo(46, -11); c.moveTo(4, -38); c.lineTo(-26, -9); c.stroke();
    }
    // the hull itself
    c.save();
    hullShape(c); c.fillStyle = gilt ? GOLD : '#0E2A31'; c.fill();
    if (gilt) {
      const g = c.createLinearGradient(-50, 0, 60, 0); g.addColorStop(0, '#8E6A1E'); g.addColorStop(.32, '#F6D777'); g.addColorStop(.5, '#FFF0B8'); g.addColorStop(.7, '#D9A93A'); g.addColorStop(1, '#8E6A1E');
      c.fillStyle = g; c.fill();
    }
    hullShape(c); c.clip();
    const planked = clamp(p / .85, 0, 1);       // planks close from stern to bow
    const xEnd = lerp(-52, 70, planked);
    c.strokeStyle = line; c.lineWidth = .6;
    c.save(); c.beginPath(); c.rect(-60, -30, xEnd + 60, 40); c.clip();
    for (let o = 1.6; o < 9; o += 1.6) sheer(c, o);
    c.lineWidth = .5; c.beginPath();
    for (let x = -50; x < 60; x += gilt ? 2 : 2.6) { const j = r() * 2; c.moveTo(x, -9 + j); c.lineTo(x - 1.4, -1); }
    c.stroke();
    c.restore();
    if (planked < 1) {
      c.fillStyle = '#071518'; c.fillRect(xEnd, -30, 90, 40);
      c.strokeStyle = GOLD; c.lineWidth = .9; c.beginPath();
      for (let x = xEnd + 2; x < 62; x += 4) { c.moveTo(x, 0); c.quadraticCurveTo(x - 2, -6, x - .5, -12); }
      c.stroke();
    }
    c.restore();
    hullShape(c); c.strokeStyle = gilt ? '#FFF1C4' : PALE; c.lineWidth = 1; c.stroke();
    // stern cabin
    if (p >= .3) {
      c.fillStyle = gilt ? '#7A5414' : '#0E2A31'; c.beginPath(); c.moveTo(-46, -14); c.quadraticCurveTo(-36, -26, -22, -11); c.closePath(); c.fill();
      c.strokeStyle = gilt ? '#FFF1C4' : PALE; c.lineWidth = .7; c.stroke();
      c.lineWidth = .4; c.beginPath(); for (let a = -42; a < -22; a += 2.4) { c.moveTo(a, -22 + Math.abs(a + 34) * .35); c.lineTo(a + 1, -11); } c.stroke();
      c.lineWidth = .8; c.beginPath(); c.moveTo(-49, -16); c.lineTo(-49, -29); c.stroke();
    }
    if (leak) {
      // an open seam, hatched in vermilion below the waterline strake
      c.strokeStyle = RED; c.lineWidth = 1.3; c.beginPath(); c.moveTo(-8, -6); c.lineTo(-3, -2); c.lineTo(-9, -1); c.lineTo(-1, 1); c.stroke();
      c.lineWidth = .7; c.beginPath(); for (let x = -22; x < 12; x += 2.2) { c.moveTo(x, -1.5); c.lineTo(x + 2.4, 1); } c.stroke();
    }
  }

  /* Fog is hatching too: a bank of fine level lines under scalloped crests. */
  function makeFog(seed) {
    const cv = document.createElement('canvas'), W = 210, H = 110, S = 2.4;
    cv.width = W * S; cv.height = H * S;
    const c = cv.getContext('2d'); c.scale(S, S);
    const r = rng(seed), puffs = [];
    for (let i = 0; i < 17; i++) {
      const t = i / 16, x = 16 + t * 178 + (r() - .5) * 10, spread = Math.sin(t * 3.14);
      puffs.push({ x, y: 72 - r() * 34 * spread, r: 7 + r() * 11 * (.35 + spread * .65) });
    }
    puffs.sort((a, b) => a.y - b.y);
    puffs.forEach((p) => { c.fillStyle = 'rgba(14,38,44,.8)'; c.beginPath(); c.arc(p.x, p.y, p.r, 0, 7); c.fill(); });
    c.fillRect(14, 72, 182, 16);
    c.globalCompositeOperation = 'source-atop';
    c.strokeStyle = VELL; c.lineWidth = .55; c.beginPath();
    for (let y = 18; y < 92; y += 1.9) { let x = 0; while (x < W) { const l = 8 + r() * 40; c.moveTo(x, y + r() * .5); c.lineTo(x + l, y + r() * .5); x += l + 1 + r() * 7; } }
    c.globalAlpha = .62; c.stroke(); c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    puffs.forEach((p) => {
      c.save(); c.beginPath(); c.arc(p.x, p.y, p.r, 0, 7); c.clip();
      c.strokeStyle = VELL; c.lineWidth = .6;
      for (let k = 1; k < 4; k++) { c.globalAlpha = .75 - k * .15; c.beginPath(); c.arc(p.x + p.r * .2, p.y + p.r * .25, p.r * (1 - k * .16), 3.2, 5.2); c.stroke(); }
      c.restore(); c.globalAlpha = 1;
      c.strokeStyle = '#F7EFDC'; c.lineWidth = 1; c.beginPath(); c.arc(p.x, p.y, p.r, 3.15, 6.05); c.stroke();
    });
    const fade = c.createLinearGradient(0, 66, 0, 96); fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    c.globalCompositeOperation = 'destination-in'; c.fillStyle = fade; c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';
    return cv;
  }

  function makeGlory() {
    const cv = document.createElement('canvas'), R = 96, S = 2.2; cv.width = cv.height = R * 2 * S;
    const c = cv.getContext('2d'); c.scale(S, S); c.translate(R, R);
    const n = 88;
    for (let i = 0; i < n; i++) {
      const a = i / n * 6.283, long = i % 2 === 0;
      const r0 = 26, r1 = long ? 74 + (i % 4 === 0 ? 18 : 0) : 46;
      c.strokeStyle = GOLD; c.lineWidth = long ? .8 : .55; c.globalAlpha = long ? .95 : .8;
      c.beginPath();
      if (i % 6 === 3) { for (let t = 0; t <= 8; t++) { const rr = lerp(r0, r1 + 12, t / 8), w = Math.sin(t * 1.5) * .05; const x = Math.cos(a + w) * rr, y = Math.sin(a + w) * rr * .62; if (t) c.lineTo(x, y); else c.moveTo(x, y); } }
      else { c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 * .62); c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1 * .62); }
      c.stroke();
    }
    return cv;
  }

  /* The Bucintoro, shown only at release. */
  function makeBucintoro() {
    const cv = document.createElement('canvas'), W = 280, H = 120, S = 2.4; cv.width = W * S; cv.height = H * S;
    const c = cv.getContext('2d'); c.scale(S, S); c.translate(138, 96);
    const hull = () => { c.beginPath(); c.moveTo(-122, -26); c.quadraticCurveTo(-92, -10, -30, -12); c.quadraticCurveTo(50, -13, 96, -18); c.quadraticCurveTo(116, -26, 130, -44); c.quadraticCurveTo(122, -6, 90, 0); c.lineTo(-84, 0); c.quadraticCurveTo(-112, -4, -122, -26); c.closePath(); };
    // the long gilded deck-house with its vermilion canopy
    c.fillStyle = '#7A1E10'; c.beginPath(); c.moveTo(-98, -26); c.quadraticCurveTo(-10, -60, 84, -24); c.lineTo(84, -18); c.lineTo(-98, -18); c.closePath(); c.fill();
    c.save(); c.clip(); c.strokeStyle = '#E8603F'; c.lineWidth = .6; c.beginPath(); for (let x = -110; x < 100; x += 2.2) { c.moveTo(x, -66); c.lineTo(x + 8, -14); } c.stroke();
    c.strokeStyle = GOLD; c.lineWidth = .7; c.beginPath(); for (let x = -100; x < 100; x += 12) { c.moveTo(x, -62); c.quadraticCurveTo(x + 6, -40, x, -16); } c.stroke(); c.restore();
    c.strokeStyle = GOLD; c.lineWidth = 1.1; c.beginPath(); c.moveTo(-98, -26); c.quadraticCurveTo(-10, -60, 84, -24); c.stroke();
    hull(); const g = c.createLinearGradient(-122, 0, 130, 0); g.addColorStop(0, '#8E6A1E'); g.addColorStop(.3, '#F6D777'); g.addColorStop(.55, '#D9A93A'); g.addColorStop(.8, '#FFF0B8'); g.addColorStop(1, '#8E6A1E'); c.fillStyle = g; c.fill();
    c.save(); hull(); c.clip(); c.strokeStyle = '#4A3008'; c.lineWidth = .55; c.beginPath();
    for (let o = 2; o < 14; o += 2.4) { c.moveTo(-122, -24 + o); c.quadraticCurveTo(-30, -12 + o * .9, 124, -24 + o); }
    for (let x = -120; x < 130; x += 7) { c.moveTo(x, -18); c.quadraticCurveTo(x + 4, -9, x, 0); } c.stroke();
    c.restore(); hull(); c.strokeStyle = '#FFF1C4'; c.lineWidth = 1; c.stroke();
    // prow figure and banner
    c.strokeStyle = '#FFF1C4'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(130, -44); c.lineTo(134, -56); c.stroke();
    c.lineWidth = 1; c.strokeStyle = GOLD; c.beginPath(); c.moveTo(-10, -44); c.lineTo(-10, -92); c.stroke();
    c.fillStyle = RED; c.beginPath(); c.moveTo(-10, -92); c.lineTo(26, -86); c.lineTo(14, -82); c.lineTo(26, -76); c.lineTo(-10, -74); c.closePath(); c.fill();
    c.strokeStyle = GOLD; c.lineWidth = .6; c.stroke();
    return cv;
  }

  const S = V.ships = { sprites: {}, fog: [], ringFall: null, buc: null, parcels: [] };

  S.init = function (cv, L, dpr) {
    this.cv = cv; this.c = cv.getContext('2d'); this.L = L; this.dpr = dpr;
    cv.width = Math.round(L.W * dpr); cv.height = Math.round(L.H * dpr);
    this.sprites = {};
    if (!this.fog.length) this.fog = [makeFog(3), makeFog(11)];
    if (!this.glory) this.glory = makeGlory();
    if (!this.bucSprite) this.bucSprite = makeBucintoro();
  };
  S.sprite = function (h) {
    const key = h.id + ':' + h.mode + ':' + h.progress.toFixed(3);
    if (this.sprites[key]) return this.sprites[key];
    const scale = 2 * this.L.k, W = 150, Ht = 100, cv = document.createElement('canvas');
    cv.width = W * scale; cv.height = Ht * scale;
    const c = cv.getContext('2d'); c.scale(scale, scale); c.translate(62, 78);
    drawGalley(c, h);
    return (this.sprites[key] = { cv, W, Ht, ox: 62, oy: 78 });
  };

  function smoke(c, x, y, s, t) {
    c.strokeStyle = '#D9CDB4'; c.lineCap = 'round';
    for (let j = 0; j < 3; j++) {
      const ph = t * .7 + j * 2.1;
      c.lineWidth = 1 - j * .15; c.globalAlpha = .85 - j * .12;
      c.beginPath();
      for (let i = 0; i < 16; i++) {
        const k = i / 15, yy = y - k * 62 * s, xx = x + j * 4 * s - 4 * s + Math.sin(k * 7 + ph) * (2 + k * 9) * s + k * 12 * s;
        if (i) c.lineTo(xx, yy); else c.moveTo(xx, yy);
      }
      c.stroke();
      // a curl at the top of each plume
      const ex = x + j * 4 * s - 4 * s + Math.sin(7 + ph) * 11 * s + 12 * s, ey = y - 62 * s;
      c.beginPath(); for (let i = 0; i < 12; i++) { const a = i * .7 + ph, rr = (4.6 - i * .36) * s; const px = ex + Math.cos(a) * rr, py = ey + Math.sin(a) * rr; if (i) c.lineTo(px, py); else c.moveTo(px, py); } c.stroke();
    }
    c.globalAlpha = 1;
  }

  S.frame = function (st) {
    const c = this.c, L = this.L, t = st.t, d = this.dpr;
    c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, L.W, L.H);
    // the wind head's breath: as many strokes as the weather is strong
    const wx = L.wind[0] + 26 * (L.mode === 'wide' ? 1.5 : 1), wy = L.wind[1] + (L.mode === 'wide' ? 8 : 11);
    const nb = 2 + Math.round(st.wind * 3 + st.storm * 3);
    c.strokeStyle = VELL; c.lineCap = 'round';
    for (let i = 0; i < nb; i++) {
      const sp = (i - (nb - 1) / 2) * 4.5, len = (L.mode === 'wide' ? 150 : 86) * (.6 + st.wind * .5 + st.storm * .4) * (1 - Math.abs(i - (nb - 1) / 2) * .12);
      c.globalAlpha = .8; c.lineWidth = .7; c.beginPath();
      for (let k = 0; k <= 14; k++) {
        const q = k / 14, xx = wx + q * len, yy = wy + sp * (.4 + q * .9) + Math.sin(q * 5 - t * (2 + st.wind * 3) + i) * 2.2 * q;
        if (k) c.lineTo(xx, yy); else c.moveTo(xx, yy);
      }
      c.stroke();
    }
    c.globalAlpha = 1;

    // gate booms: gold when open, vermilion when shut. A hull cannot pass a closed window.
    (st.gates || []).forEach((g) => {
      const p = L.at(g.u), n = p.a + Math.PI / 2, hw = L.canal / 2 + 1, cx = Math.cos(n) * hw, cy = Math.sin(n) * hw;
      c.lineWidth = g.open ? .8 : 1.6; c.strokeStyle = g.open ? GOLD : RED; c.setLineDash(g.open ? [] : [3, 2.4]);
      c.beginPath();
      if (g.open) { c.moveTo(p.x - cx, p.y - cy); c.lineTo(p.x - cx * .72, p.y - cy * .72); c.moveTo(p.x + cx, p.y + cy); c.lineTo(p.x + cx * .72, p.y + cy * .72); }
      else { c.moveTo(p.x - cx, p.y - cy); c.quadraticCurveTo(p.x + 2, p.y + 3, p.x + cx, p.y + cy); }
      c.stroke(); c.setLineDash([]);
      [[-1], [1]].forEach(([q]) => { c.fillStyle = g.open ? GOLD : RED; c.beginPath(); c.arc(p.x + cx * q, p.y + cy * q, 1.9, 0, 7); c.fill(); });
    });

    const order = st.hulls.slice().sort((a, b) => a.y - b.y);
    order.forEach((h) => {
      const sc = h.s, f = h.flip ? -1 : 1;
      // selection: an engraved ellipse on the water
      if (h === st.sel) {
        c.strokeStyle = VELL; c.lineWidth = .8; c.setLineDash([2, 3]); c.lineDashOffset = -t * 6;
        c.beginPath(); c.ellipse(h.x, h.y + 2, 62 * sc, 13 * sc, 0, 0, 7); c.stroke(); c.setLineDash([]);
      }
      if (h.mode === 'gilt' && h.gild > 0) {
        const pulse = 1 + Math.sin(t * .9) * .025, R = 96 * sc * 1.25 * pulse;
        c.globalAlpha = h.gild; c.drawImage(this.glory, h.x - R, h.y - 12 * sc - R * .98, R * 2, R * 2); c.globalAlpha = 1;
      }
      const sp = this.sprite(h);
      c.save(); c.translate(h.x, h.y + h.bob); c.rotate(h.tilt); c.scale(f * sc, sc);
      if (h.mode === 'fog') c.globalAlpha = .8;
      // oars row with the dial; a hull held at a closed window ships them
      if (h.progress >= .85) {
        const rate = h.moving ? 2.2 + st.effort * 1.5 : .28;
        c.strokeStyle = h.mode === 'gilt' ? GOLD : PALE; c.lineWidth = .8; c.beginPath();
        const ph = t * rate;
        for (let i = 0; i < 9; i++) {
          const x = -24 + i * 6, sw = Math.sin(ph) * 5;
          c.moveTo(x, -7); c.lineTo(x - 5 + sw, 11);
        }
        c.stroke();
      }
      c.drawImage(sp.cv, -sp.ox, -sp.oy, sp.W, sp.Ht);
      c.restore(); c.globalAlpha = 1;
      // the pennon flies the lamp's colour, so the world and the deck agree
      if (h.progress >= .5) {
        const mx = h.x + f * 6 * sc, my = h.y - 50 * sc + h.bob, fl = 13 * sc;
        c.fillStyle = LAMP[h.lamp]; c.beginPath(); c.moveTo(mx, my);
        for (let i = 1; i <= 6; i++) c.lineTo(mx + f * fl * i / 6, my + 1.6 + Math.sin(i - t * 5) * .9);
        for (let i = 6; i >= 0; i--) c.lineTo(mx + f * fl * i / 6, my + 4.6 - i * .4 + Math.sin(i - t * 5) * .9);
        c.closePath(); c.fill();
      }
      if (h.mode === 'leak') {
        smoke(c, h.x + f * 2 * sc, h.y - 8 * sc, sc * 1.05, t);
        // the Calafato's boat alongside
        const bx = h.x - f * 48 * sc, by = h.y + 11 * sc;
        c.strokeStyle = PALE; c.lineWidth = .9; c.beginPath(); c.moveTo(bx - 11 * sc, by - 3 * sc); c.quadraticCurveTo(bx, by + 2 * sc, bx + 11 * sc, by - 3 * sc); c.stroke();
        c.lineWidth = 1.1; c.beginPath(); c.moveTo(bx, by - 1 * sc); c.lineTo(bx, by - 7 * sc); c.stroke(); c.fillStyle = PALE; c.beginPath(); c.arc(bx, by - 8 * sc, 1.3 * sc, 0, 7); c.fill();
      }
      if (h.towing) {
        const ah = h.flip ? -1 : 1, q = L.at(h.u + .5 * (h.towDir || 1)), bx = h.x + ah * 66 * sc + (q.x - h.x) * 0, by = h.y - 2 * sc + Math.sin(t * 2) * .6;
        const tx = bx + ah * 22 * sc;
        c.strokeStyle = VELL; c.lineWidth = .5; c.beginPath(); c.moveTo(bx, by - 9 * sc); c.lineTo(tx, by); c.stroke();
        c.strokeStyle = PALE; c.lineWidth = 1.1; c.beginPath(); c.moveTo(tx - 7 * sc, by - 2 * sc); c.quadraticCurveTo(tx, by + 2.5 * sc, tx + 8 * sc, by - 2.5 * sc); c.stroke();
        c.lineWidth = .7; c.beginPath(); c.moveTo(tx - 2, by - 1); c.lineTo(tx - 2 - 4 * Math.sin(t * 3) * sc, by + 4 * sc); c.stroke();
      }
      if (h.mode === 'fog' || h.fogFade > 0) {
        const a = h.mode === 'fog' ? 1 : h.fogFade;
        c.globalAlpha = a;
        const w = 138 * sc * 1.0, ht = w * 110 / 210;
        c.drawImage(this.fog[0], h.x - w * .58 + Math.sin(t * .22) * 6, h.y - ht * .82, w, ht);
        c.drawImage(this.fog[1], h.x - w * .44 + Math.sin(t * .17 + 2) * 7, h.y - ht * .5, w * .86, ht * .86);
        c.globalAlpha = 1;
      }
    });

    this.parcels = this.parcels.filter((p) => {
      p.k += st.dt / p.dur; if (p.k >= 1) { p.done && p.done(); return false; }
      const k = p.k, x = lerp(p.x0, p.x1(), k), y = lerp(p.y0, p.y1(), k) - Math.sin(k * 3.14) * 22;
      c.fillStyle = GOLD; c.fillRect(x - 2, y - 2, 4, 4); c.strokeStyle = VELL; c.lineWidth = .5; c.strokeRect(x - 2, y - 2, 4, 4);
      return true;
    });

    if (this.buc) {
      const b = this.buc, w = 280 * b.s, ht = 120 * b.s;
      c.save(); c.globalAlpha = b.a;
      const reveal = clamp(b.reveal, .02, 1);
      c.drawImage(this.bucSprite, 0, 0, this.bucSprite.width * reveal, this.bucSprite.height, b.x - w / 2, b.y - ht * .8, w * reveal, ht);
      // forty-two oars is too many to cut at this size. Fourteen, kept in time.
      c.strokeStyle = GOLD; c.lineWidth = 1; c.beginPath();
      const n = 14;
      for (let i = 0; i < n * reveal; i++) { const x = b.x - w * .34 + i * w * .046, sw = Math.sin(t * 2.1) * 7 * b.s; c.moveTo(x, b.y - 8 * b.s); c.lineTo(x - 6 * b.s + sw, b.y + 16 * b.s); }
      c.stroke();
      c.restore();
    }

    if (this.ringFall) {
      const R = this.ringFall, k = clamp(R.k, 0, 1), e = k * k;
      const x = lerp(R.x0, R.x1, k), y = lerp(R.y0, R.y1, e) - Math.sin(k * 3.14) * 18, rad = lerp(R.r0, 7, e);
      const tilt = Math.abs(Math.cos(k * 7.5)) * .86 + .14;
      c.strokeStyle = '#F6D777'; c.lineWidth = lerp(5, 2.2, e); c.beginPath(); c.ellipse(x, y, rad, rad * tilt, k * 3, 0, 7); c.stroke();
      c.strokeStyle = '#6E4C10'; c.lineWidth = .7; c.stroke();
    }
  };
})();
