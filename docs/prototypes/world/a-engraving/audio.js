/* audio.js: every sound is synthesised. No samples. */
window.V = window.V || {};
(function () {
  const A = V.audio = { on: true, ctx: null };
  function ir(ctx, sec, decay) {
    const n = ctx.sampleRate * sec, b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
    return b;
  }
  A.unlock = function () {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.on ? .8 : 0; this.master.connect(ctx.destination);
    this.verb = ctx.createConvolver(); this.verb.buffer = ir(ctx, 3.2, 3.2);
    const wet = ctx.createGain(); wet.gain.value = .32; this.verb.connect(wet); wet.connect(this.master);
    this.dry = ctx.createGain(); this.dry.connect(this.master); this.dry.connect(this.verb);
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = nb;
    // the lagoon, always there and always low
    let last = 0; const br = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), bd = br.getChannelData(0);
    for (let i = 0; i < bd.length; i++) { last = (last + .02 * (Math.random() * 2 - 1)) / 1.02; bd[i] = last * 3.5; }
    const s = ctx.createBufferSource(); s.buffer = br; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = .6;
    const g = ctx.createGain(); g.gain.value = .05;
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = .13; lg.gain.value = .022; lfo.connect(lg); lg.connect(g.gain); lfo.start();
    s.connect(f); f.connect(g); g.connect(this.master); s.start();
  };
  A.toggle = function () { this.on = !this.on; if (this.master) this.master.gain.setTargetAtTime(this.on ? .8 : 0, this.ctx.currentTime, .02); return this.on; };
  function burst(ctx, dest, when, freq, q, dur, gain) {
    const s = ctx.createBufferSource(); s.buffer = A.noise; s.loop = true; s.loopStart = Math.random();
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, when); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
    s.connect(f); f.connect(g); g.connect(dest); s.start(when); s.stop(when + dur + .02);
  }
  function tone(ctx, dest, when, freq, dur, gain, type) {
    const o = ctx.createOscillator(); o.type = type || 'sine'; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, when); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
    o.connect(g); g.connect(dest); o.start(when); o.stop(when + dur + .02);
  }
  /* A switch: a stem tick, a housing thock, then the lift. */
  A.key = function (down, pitch) {
    const c = this.ctx; if (!c) return; const t = c.currentTime, p = pitch || 1;
    if (down) { burst(c, this.dry, t, 3100 * p, 3, .018, .34); burst(c, this.dry, t + .004, 1200 * p, 1.5, .03, .24); tone(c, this.dry, t, 190 * p, .05, .2); }
    else { burst(c, this.dry, t, 4200 * p, 4, .012, .14); tone(c, this.dry, t, 320 * p, .02, .05); }
  };
  A.detent = function (hi) { const c = this.ctx; if (!c) return; const t = c.currentTime; burst(c, this.dry, t, hi ? 5200 : 4300, 6, .014, .24); tone(c, this.dry, t, 700, .012, .05, 'square'); };
  const PARTIALS = [[.56, 1], [.92, .68], [1.19, .44], [1.71, .3], [2, .32], [2.74, .14], [3, .12], [3.76, .08], [4.07, .05]];
  A.bell = function (f, gain, dur) {
    const c = this.ctx; if (!c) return; const t = c.currentTime;
    PARTIALS.forEach(([r, a], i) => tone(c, this.dry, t, f * r, dur * (1 - i * .07), a * gain * .34));
    burst(c, this.dry, t, f * 3, 2, .03, gain * .4);
  };
  A.pregadi = function () { this.bell(660, .34, 2.2); setTimeout(() => this.bell(660, .26, 1.8), 340); };
  A.marangona = function () { this.bell(146, 1, 7); };
  A.tessera = function (n) { const c = this.ctx; if (!c) return; const t = c.currentTime; [2093, 2637, 3136].slice(0, n || 3).forEach((f, i) => { tone(c, this.dry, t + i * .07, f, .5, .1); tone(c, this.dry, t + i * .07, f * 2.76, .14, .03); }); };
  A.splash = function () { const c = this.ctx; if (!c) return; const t = c.currentTime; burst(c, this.dry, t, 700, .7, .9, .9); burst(c, this.dry, t + .05, 1900, 1, .4, .3); tone(c, this.dry, t, 72, .8, .5); };
  A.lock = function () { const c = this.ctx; if (!c) return; const t = c.currentTime; burst(c, this.dry, t, 2600, 4, .05, .5); tone(c, this.dry, t, 1320, .6, .16); tone(c, this.dry, t, 1980, .4, .08); };
  A.holdStart = function () {
    const c = this.ctx; if (!c || this.h) return; const t = c.currentTime;
    const g = c.createGain(); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.2, t + .4);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(240, t); f.frequency.exponentialRampToValueAtTime(2800, t + 2); f.Q.value = 5;
    const os = [110, 110.7, 165.4, 220.9].map((fr) => { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(fr, t); o.frequency.exponentialRampToValueAtTime(fr * 1.5, t + 2); o.connect(f); o.start(t); return o; });
    f.connect(g); g.connect(this.dry); this.h = { g, os };
  };
  A.holdStop = function () {
    const c = this.ctx; if (!c || !this.h) return; const t = c.currentTime, h = this.h; this.h = null;
    h.g.gain.cancelScheduledValues(t); h.g.gain.setTargetAtTime(.0001, t, .06); h.os.forEach((o) => o.stop(t + .4));
  };
  /* Voice in. A real microphone if the browser lets us, otherwise a plausible envelope. */
  A.mic = { stream: null, an: null, buf: null, denied: false };
  A.micStart = async function () {
    if (this.mic.an || this.mic.denied) return;
    try {
      if (!navigator.mediaDevices) throw 0;
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const src = this.ctx.createMediaStreamSource(s), an = this.ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
      this.mic = { stream: s, an, buf: new Uint8Array(an.fftSize), denied: false };
    } catch (e) { this.mic.denied = true; }
  };
  A.micLevel = function () {
    const m = this.mic; if (!m.an) return -1;
    m.an.getByteTimeDomainData(m.buf); let s = 0; for (let i = 0; i < m.buf.length; i++) { const v = (m.buf[i] - 128) / 128; s += v * v; }
    return Math.min(1, Math.sqrt(s / m.buf.length) * 5);
  };
})();
