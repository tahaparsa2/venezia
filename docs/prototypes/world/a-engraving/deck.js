/* deck.js: the instrument. Plate engraved once on canvas; keys are DOM. */
window.V = window.V || {};
(function () {
  const { clamp, rng } = V;
  const D = V.deck = { effort: 1, angle: -45 };
  const STOPS = [{ a: -112, n: 'Low' }, { a: -38, n: 'Med' }, { a: 38, n: 'High' }, { a: 112, n: 'Max' }];

  /* The plate is cut the way the world is cut: lines, not gradients, where it matters. */
  D.paintPlate = function () {
    const deck = document.getElementById('deck'), cv = document.getElementById('plate');
    const b = deck.getBoundingClientRect(), W = b.width, H = b.height, dpr = Math.min(2.5, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    const c = cv.getContext('2d'); c.scale(dpr, dpr);
    const r = rng(1498);
    const dr = document.getElementById('dial').getBoundingClientRect();
    const dx = dr.left - b.left + dr.width / 2, dy = dr.top - b.top + dr.height / 2, DR = dr.width / 2;

    const g = c.createLinearGradient(0, 0, W * .6, H);
    g.addColorStop(0, '#D9B662'); g.addColorStop(.4, '#C6A04C'); g.addColorStop(.72, '#BA9342'); g.addColorStop(1, '#AE8838');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    // long brush strokes in the metal
    for (let i = 0; i < 900; i++) {
      c.strokeStyle = r() > .5 ? 'rgba(255,240,190,.05)' : 'rgba(60,38,8,.055)'; c.lineWidth = .5 + r() * .6;
      const y = r() * H, x = r() * W, l = 30 + r() * 180; c.beginPath(); c.moveTo(x, y); c.lineTo(x + l, y + (r() - .5)); c.stroke();
    }
    // verdigris where hands and salt have been
    [[0, H, 150], [W, H, 120], [W, 0, 70], [0, 0, 60]].forEach(([x, y, R]) => {
      const q = c.createRadialGradient(x, y, 0, x, y, R); q.addColorStop(0, 'rgba(62,142,126,.5)'); q.addColorStop(.55, 'rgba(62,142,126,.16)'); q.addColorStop(1, 'rgba(62,142,126,0)');
      c.fillStyle = q; c.fillRect(0, 0, W, H);
    });
    for (let i = 0; i < 260; i++) { c.fillStyle = `rgba(30,70,60,${.05 + r() * .14})`; const edge = r() < .5; c.beginPath(); c.arc(edge ? (r() < .5 ? r() * 40 : W - r() * 40) : r() * W, H - r() * r() * H, r() * 1.4, 0, 7); c.fill(); }

    const cut = (fn, w) => { // a graver's line: a dark cut with a bright lip beneath it
      c.save(); c.translate(0, .6); c.strokeStyle = 'rgba(255,240,195,.5)'; c.lineWidth = w || .7; fn(); c.restore();
      c.strokeStyle = 'rgba(40,24,4,.86)'; c.lineWidth = w || .7; fn();
    };
    // wind lines radiating from the dial, as on a portolan
    c.save(); c.beginPath(); c.rect(8, 8, W - 16, H - 16); c.clip();
    for (let i = 0; i < 32; i++) {
      const a = i / 32 * 6.2832, major = i % 4 === 0;
      c.strokeStyle = major ? 'rgba(40,24,4,.34)' : 'rgba(40,24,4,.16)'; c.lineWidth = .55;
      c.beginPath(); c.moveTo(dx + Math.cos(a) * (DR + 30), dy + Math.sin(a) * (DR + 30)); c.lineTo(dx + Math.cos(a) * 900, dy + Math.sin(a) * 900); c.stroke();
    }
    c.restore();
    // a hatched band under the lamps, the same tone logic as the sheet
    const lamps = document.getElementById('lamps').getBoundingClientRect();
    const ly = lamps.bottom - b.top + 1;
    // border rules
    cut(() => { c.beginPath(); c.rect(5.5, 5.5, W - 11, H - 11); c.stroke(); }, .9);
    cut(() => { c.beginPath(); c.rect(8.5, 8.5, W - 17, H - 17); c.stroke(); }, .5);
    // the graduated circle around the dial
    cut(() => { c.beginPath(); c.arc(dx, dy, DR + 8, 0, 7); c.stroke(); }, .6);
    cut(() => {
      c.beginPath();
      for (let d = -130; d <= 130; d += 5) {
        const a = (d - 90) * Math.PI / 180, l = d % 25 === 0 ? 5 : 2.8;
        c.moveTo(dx + Math.cos(a) * (DR + 8), dy + Math.sin(a) * (DR + 8)); c.lineTo(dx + Math.cos(a) * (DR + 8 + l), dy + Math.sin(a) * (DR + 8 + l));
      }
      c.stroke();
    }, .55);
    // screws, each slot set at its own angle
    [[14, 14], [W - 14, 14], [14, H - 14], [W - 14, H - 14]].forEach(([x, y]) => {
      const sg = c.createRadialGradient(x - 1, y - 1, .5, x, y, 4.2); sg.addColorStop(0, '#F5DF9F'); sg.addColorStop(1, '#7E5F24');
      c.fillStyle = 'rgba(40,24,4,.7)'; c.beginPath(); c.arc(x, y + .4, 4.8, 0, 7); c.fill();
      c.fillStyle = sg; c.beginPath(); c.arc(x, y, 4.2, 0, 7); c.fill();
      const a = r() * 3.14; c.strokeStyle = '#2A1B05'; c.lineWidth = 1.1; c.beginPath(); c.moveTo(x - Math.cos(a) * 3.4, y - Math.sin(a) * 3.4); c.lineTo(x + Math.cos(a) * 3.4, y + Math.sin(a) * 3.4); c.stroke();
    });
    // the bright lip of the paper slot
    c.fillStyle = '#2A1B05'; c.fillRect(10, 1.5, W - 20, 2.4); c.fillStyle = 'rgba(255,240,195,.6)'; c.fillRect(10, 3.9, W - 20, .6);

    // dial scale labels
    const dl = document.getElementById('dlabels'); dl.innerHTML = '';
    const box = dl.parentElement.getBoundingClientRect();
    STOPS.forEach((s) => {
      const a = (s.a - 90) * Math.PI / 180, R = DR + 15, sp = document.createElement('span');
      sp.textContent = s.n;
      // Keep the labels on the plate at narrow widths.
      sp.style.left = (dr.left - box.left + DR + Math.cos(a) * (R + 3)) + 'px'; sp.style.top = (dr.top - box.top + DR + Math.sin(a) * R) + 'px';
      dl.appendChild(sp);
    });
    // the voice rule traces the inner border
    const svg = document.getElementById('voiceRule'), vr = document.getElementById('vr');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); vr.setAttribute('x', 7); vr.setAttribute('y', 7); vr.setAttribute('width', W - 14); vr.setAttribute('height', H - 14);
    vr.setAttribute('pathLength', 490);
  };

  D.setEffort = function (i, silent) {
    i = clamp(i, 0, 3); const was = this.effort; this.effort = i; this.target = STOPS[i].a;
    const el = document.getElementById('dial');
    el.setAttribute('aria-valuenow', i + 1); el.setAttribute('aria-valuetext', ['Low', 'Medium', 'High', 'Max'][i]);
    if (!silent && was !== i) { V.audio.detent(i > was); haptic(6); V.onEffort && V.onEffort(i); }
    this.paintDial(STOPS[i].a);
  };
  D.paintDial = function (a) {
    document.getElementById('knurl').style.transform = `rotate(${a}deg)`;
    document.getElementById('mark').style.transform = `rotate(${a}deg)`;
  };
  function haptic(ms) { try { if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(ms); } catch (e) {} }
  V.haptic = haptic;

  D.initDial = function () {
    const el = document.getElementById('dial');
    let drag = false, base = 0, start = 0, last = 0;
    const ang = (e) => { const r = el.getBoundingClientRect(); return Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2) * 180 / Math.PI + 90; };
    el.addEventListener('pointerdown', (e) => { V.audio.unlock(); drag = true; el.setPointerCapture(e.pointerId); start = ang(e); base = STOPS[this.effort].a; last = start; });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return; let a = ang(e), d = a - last; if (d > 180) d -= 360; if (d < -180) d += 360; last = a; base += d;
      const c = clamp(base, -128, 128); this.paintDial(c);
      let best = 0, bd = 1e9; STOPS.forEach((s, i) => { const q = Math.abs(s.a - c); if (q < bd) { bd = q; best = i; } });
      if (best !== this.effort) { const was = this.effort; this.effort = best; V.audio.detent(best > was); haptic(6); V.onEffort && V.onEffort(best); el.setAttribute('aria-valuenow', best + 1); }
    });
    const end = () => { if (drag) { drag = false; this.setEffort(this.effort, true); } };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { e.preventDefault(); V.audio.unlock(); this.setEffort(this.effort + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
    el.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); this.setEffort(this.effort + 1); } if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); this.setEffort(this.effort - 1); } });
    this.setEffort(1, true);
  };

  /* Any button with .down travel: pointer, touch, keyboard all arrive here. */
  D.travel = function (el, opts) {
    let held = false;
    const dn = (e) => { if (held) return; held = true; V.audio.unlock(); el.classList.add('down'); V.audio.key(true, opts.pitch); haptic(7); opts.down && opts.down(e); };
    const up = (e) => { if (!held) return; held = false; el.classList.remove('down'); V.audio.key(false, opts.pitch); opts.up && opts.up(e); };
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch (x) {} dn(e); });
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('mousedown', (e) => e.preventDefault()); // keep Space for talk after a click
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); dn(e); } });
    el.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); up(e); } });
    return { down: dn, up };
  };

  /* The voice visual: seven engraved lines that swell with your amplitude, like the water. */
  const vox = { hist: new Float32Array(64), i: 0 };
  D.vox = function (level, t, active) {
    const cv = document.getElementById('vox');
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr)) { cv.width = W * dpr; cv.height = H * dpr; }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    vox.hist[vox.i++ % 64] = level;
    const n = 7, sp = H / (n + 1);
    for (let j = 0; j < n; j++) {
      const y0 = sp * (j + 1), off = Math.abs(j - 3) / 3;
      c.fillStyle = active ? (j === 3 ? '#F2CF7A' : '#79C2B0') : 'rgba(217,169,58,.8)';
      c.beginPath();
      const steps = 40, top = [], bot = [];
      for (let i = 0; i <= steps; i++) {
        const k = i / steps, x = k * W, hv = vox.hist[(vox.i - 1 - Math.floor(k * 63) + 640) % 64] * (1 - off * .55);
        const env = Math.sin(k * Math.PI);
        const th = .28 + hv * env * (sp * .46) * (active ? 1 : 0);
        const y = y0 + (active ? Math.sin(k * 11 + t * 6 + j) * hv * 3.2 * env * (j - 3) * .35 : 0);
        top.push([x, y - th]); bot.push([x, y + th]);
      }
      top.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
      bot.reverse().forEach((p) => c.lineTo(p[0], p[1]));
      c.closePath(); c.fill();
    }
  };

  const GLYPH = {
    idle: '<svg viewBox="0 0 14 14" class="glyph"><path d="M3 7h8" stroke="currentColor" stroke-width="1.5"/></svg>',
    work: '<svg viewBox="0 0 14 14" class="glyph"><circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 2.9"/></svg>',
    done: '<svg viewBox="0 0 14 14" class="glyph"><path d="M2.6 7.4 5.8 10.4 11.6 3.6" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    need: '<svg viewBox="0 0 14 14" class="glyph"><path d="M7 1.8v6.4" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="11" r="1.3" fill="currentColor"/></svg>',
    fail: '<svg viewBox="0 0 14 14" class="glyph"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8"/></svg>',
  };
  const WORD = { idle: 'idle', work: 'working', done: 'finished, unread', need: 'needs you', fail: 'failed' };
  const CVAR = { idle: 'var(--lamp-idle)', work: 'var(--lamp-work)', done: 'var(--lamp-done)', need: 'var(--lamp-need)', fail: 'var(--lamp-fail)' };
  D.buildLamps = function (hulls, onSelect) {
    const box = document.getElementById('lamps'); box.innerHTML = ''; this.lampEls = [];
    hulls.forEach((h, i) => {
      const b = document.createElement('button'); b.className = 'lamp';
      b.innerHTML = `<span class="cap2"><i class="glow"></i><span class="gl"></span><span class="nm">${h.name}</span></span>`;
      box.appendChild(b); this.lampEls.push(b);
      this.travel(b, { pitch: 1.1, down: () => onSelect(i) });
    });
  };
  D.lamp = function (i, h, sel) {
    const b = this.lampEls[i];
    if (b.dataset.l !== h.lamp) {
      b.dataset.l = h.lamp; b.querySelector('.gl').innerHTML = GLYPH[h.lamp]; b.style.setProperty('--c', CVAR[h.lamp]);
    }
    b.classList.toggle('sel', sel);
    b.setAttribute('aria-label', `${h.name}: ${WORD[h.lamp]}. Lamp ${i + 1}.`);
    b.setAttribute('aria-pressed', sel ? 'true' : 'false');
  };
  D.lampPulse = function (i, h, t, calm) {
    let l = .92;
    if (!calm) {
      if (h.lamp === 'need') l = .88 + .12 * Math.sin(t * 2.4);
      else if (h.lamp === 'fail') l = (t * 1.1 % 1) < .16 || ((t * 1.1 + .78) % 1) < .16 ? 1 : .6;
      else if (h.lamp === 'work') l = .72 + .2 * Math.sin(t * 5 + i);
      else if (h.lamp === 'idle') l = .25;
      else if (h.lamp === 'done') l = .9;
    } else if (h.lamp === 'idle') l = .25;
    (this.glows || (this.glows = []))[i] = this.glows[i] && this.glows[i].isConnected ? this.glows[i] : this.lampEls[i].querySelector('.glow');
    this.glows[i].style.opacity = l.toFixed(2);
  };
})();
