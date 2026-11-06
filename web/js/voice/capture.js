// The microphone, through an AudioWorklet, to /ws/voice. Frames are 16 kHz Int16 PCM. Text
// frames back are {t:'status'|'partial'|'final'|'done'|'intent'|'unavailable'|'error'}, and the
// server closes the socket when it has said everything. `mode=transcribe` means the server
// reports what it read and runs nothing, so the person always has the last word.
//
// Frames wait in a queue until the socket opens, so the first word of a press is not lost.

const FINISH_TIMEOUT_MS = 10_000;
const BUILD_WAIT_MS = 200_000; // the helper's first compile, on the server, can take this long
const QUEUE_LIMIT = 150; // six seconds at 40 ms a frame
const RESUME_WAIT_MS = 1500;
const ASKING_AFTER_MS = 1200; // no way to read the permission, and the mic is taking this long
const CHECK_AFTER_MS = 3000; // this far in with no sound, say so while they can still fix it
const SHORT_FRAMES = 15; // 0.6 s
const SILENT_PEAK = 0.0015; // nothing but digital silence or a muted input
const QUIET_PEAK = 0.03; // speech this faint rarely comes back as words
const FLOOR_DB = -60;
const CEILING_DB = -12;

export const ALLOW_MIC = 'Allow the microphone in your browser, then hold Talk again.';

export class VoiceUnavailable extends Error {
  /** `allowed` means the question was answered yes, so a person only has to press again. */
  constructor(plain, { denied = false, allowed = false } = {}) {
    super(plain);
    this.plain = plain;
    this.denied = denied;
    this.allowed = allowed;
  }
}

export const canCapture = () => Boolean(window.isSecureContext !== false
  && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);

const socketUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/voice?mode=transcribe`;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const AGENT = () => navigator.userAgent;
const onIos = () => /iPhone|iPad/.test(AGENT());
const onSafari = () => /Safari/.test(AGENT()) && !/Chrome|Chromium|Edg|OPR/.test(AGENT());
const onFirefox = () => /Firefox/.test(AGENT());

function appName() {
  if (onSafari()) return 'Safari';
  if (onFirefox()) return 'Firefox';
  return /Edg/.test(AGENT()) ? 'Microsoft Edge' : 'Google Chrome';
}

const SYSTEM_PATH = () => `Open System Settings, then Privacy & Security, then Microphone, and turn on ${appName()}. Then quit ${appName()} and open it again.`;

/** The exact place to go, for this browser, once the microphone has been refused. */
function blockedAdvice() {
  if (onIos()) return 'The microphone is blocked. Open the Settings app, find Safari, then Microphone, and choose Allow. Then reload this page.';
  if (onSafari()) return `The microphone is blocked. In the menu bar choose Safari, then Settings for This Website, and set Microphone to Allow. Then reload this page. If it is still blocked: ${SYSTEM_PATH()}`;
  if (onFirefox()) return 'The microphone is blocked. Click the microphone icon in the address bar, clear the block, then reload this page.';
  return 'The microphone is blocked for this page. Click the icon to the left of the web address, set Microphone to Allow, then reload this page.';
}

/** What getUserMedia's refusal means, in words a person can act on. */
function micTrouble(error) {
  const { name, message = '' } = error ?? {};
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    if (/system/i.test(message)) return new VoiceUnavailable(`Your Mac is stopping ${appName()} from using the microphone. ${SYSTEM_PATH()}`, { denied: true });
    if (/dismissed/i.test(message)) return new VoiceUnavailable(ALLOW_MIC, { denied: true });
    return new VoiceUnavailable(blockedAdvice(), { denied: true });
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new VoiceUnavailable(`The microphone would not start. Close any other app using it and try again. If that does not help: ${SYSTEM_PATH()}`, { denied: true });
  }
  return new VoiceUnavailable('No microphone was found. Plug one in, or pick one in System Settings, then Sound, then Input, and try again.');
}

async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    return null; // Firefox has no such name to ask about.
  }
}

/**
 * Why a press ended with no words, from what actually reached the page.
 * @param {{frames: number, peak: number, paused?: boolean, timedOut?: boolean}} heard
 */
export function whyNoWords({ frames, peak, paused = false, timedOut = false }) {
  if (timedOut) return 'Venezia did not answer in time. Check it is still running, then try again.';
  if (paused) return 'The browser kept the microphone paused, so nothing was recorded. Tap Talk once more and speak.';
  if (frames === 0) return 'No sound reached Venezia. Check the microphone is plugged in and picked in System Settings, then Sound, then Input, then try again.';
  if (peak < SILENT_PEAK) return 'The microphone is on, but it is sending silence. Check it is not muted, and that the right one is picked in System Settings, then Sound, then Input.';
  if (frames < SHORT_FRAMES) return 'That was too short to catch any words. Hold Talk while you speak, or tap once to start and once to stop.';
  if (peak < QUIET_PEAK) return 'Your voice is very faint here. Move closer, or turn up Input volume in System Settings, then Sound, then Input, and try again.';
  return 'Venezia heard sound but could not make out any words. Speak up a little, or move closer to the microphone, and try again.';
}

/** Speech sits far below full scale, so the meter reads decibels. A murmur still moves it. */
const toMeter = (rms) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));

/**
 * Call this inside the press itself. The AudioContext is made here, before anything is awaited,
 * because a browser only lets it run from a gesture, and the question about the microphone
 * would use that gesture up.
 *
 * @param {object} hooks
 * @param {(level: number) => void} hooks.onLevel 0..1, about 25 times a second
 * @param {(text: string) => void} hooks.onPartial
 * @param {(plain: string|null, options?: {stay?: boolean}) => void} hooks.onNote a passing status
 *   line. `stay` keeps it up until the next note, and null takes it down.
 * @param {(plain: string) => void} hooks.onFail voice cannot go on, fall back
 * @param {() => void} [hooks.onAsking] the browser is asking the person about the microphone
 */
export async function startCapture({ onLevel, onPartial, onNote, onFail, onAsking = () => {} }) {
  const context = new AudioContext({ latencyHint: 'interactive' });
  const running = context.resume().catch(() => {});

  // Both in the gesture. Waiting on the first would lose the second its user activation.
  const permission = micPermission();
  const opening = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let asked = false;
  const ask = () => {
    if (asked) return;
    asked = true;
    onNote(ALLOW_MIC, { stay: true });
    onAsking();
  };
  const slow = setTimeout(async () => {
    if ((await permission) === null) ask();
  }, ASKING_AFTER_MS);
  permission.then((state) => {
    if (state === 'prompt') ask();
  });

  let stream;
  try {
    stream = await opening;
  } catch (error) {
    context.close().catch(() => {});
    throw micTrouble(error);
  } finally {
    clearTimeout(slow);
  }

  // Answering the question took the press with it, so this one has done its job.
  if (asked) {
    for (const track of stream.getTracks()) track.stop();
    context.close().catch(() => {});
    throw new VoiceUnavailable('The microphone is allowed now. Hold Talk again and speak.', { allowed: true });
  }

  let socket = null;
  let closed = false;
  let flushed = null;
  let finishing = null;
  let building = false;
  let finishTimer = 0;
  let timedOut = false;
  let endPending = false;
  let frames = 0;
  let peak = 0;
  const queue = [];
  let text = '';
  let intent = null;
  const heard = () => ({ frames, peak, paused: context.state === 'suspended', timedOut });

  /** A press on a phone is only a gesture once the finger lifts. Try again when it does. */
  const wake = () => context.resume().catch(() => {});
  const gestures = ['pointerup', 'touchend', 'keyup'];
  for (const name of gestures) window.addEventListener(name, wake, true);

  const check = setTimeout(() => {
    if (closed || finishing) return;
    if (frames === 0 || peak < SILENT_PEAK) onNote('No sound is reaching Venezia yet. Check the microphone is not muted.', { stay: true });
  }, CHECK_AFTER_MS);

  function release() {
    clearTimeout(check);
    for (const name of gestures) window.removeEventListener(name, wake, true);
    for (const track of stream.getTracks()) track.stop();
    context.close().catch(() => {});
  }
  function shut() {
    if (closed) return;
    closed = true;
    release();
    if (socket && socket.readyState < 2) socket.close();
  }
  function settle() {
    clearTimeout(finishTimer);
    finishing?.({ text, intent, heard: heard() });
    finishing = null;
  }
  function armFinish() {
    clearTimeout(finishTimer);
    finishTimer = setTimeout(() => {
      timedOut = true;
      shut();
      settle();
    }, building ? BUILD_WAIT_MS : FINISH_TIMEOUT_MS);
  }

  try {
    await Promise.race([running, wait(RESUME_WAIT_MS)]);
    await context.audioWorklet.addModule('/js/voice/pcm-worklet.js');
  } catch {
    release();
    throw new VoiceUnavailable('Live capture does not work in this browser.');
  }

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'pcm-16k', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const quiet = context.createGain();
  quiet.gain.value = 0;
  source.connect(node);
  node.connect(quiet); // Silent, but a node with no path to the output may not be run.
  quiet.connect(context.destination);

  node.port.onmessage = ({ data }) => {
    if (data.flushed) {
      flushed?.();
      return;
    }
    frames += 1;
    peak = Math.max(peak, data.peak);
    onLevel(toMeter(data.level));
    if (socket?.readyState === 1) socket.send(data.pcm);
    else if (queue.length < QUEUE_LIMIT) queue.push(data.pcm);
  };

  socket = new WebSocket(socketUrl());
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    for (const frame of queue.splice(0)) socket.send(frame);
    if (endPending) socket.send(JSON.stringify({ t: 'end' }));
  };
  socket.onmessage = ({ data }) => {
    if (typeof data !== 'string') return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    switch (message.t) {
      case 'partial':
        text = message.text ?? text;
        onPartial(text);
        break;
      case 'final':
      case 'done':
        if (message.text) text = message.text;
        onPartial(text);
        break;
      case 'intent':
        intent = message;
        break;
      case 'status':
        building = message.state === 'building';
        if (building) onNote(message.plain, { stay: true });
        else if (message.state === 'listening') onNote(null);
        if (finishing) armFinish();
        break;
      case 'unavailable':
        onFail(message.plain ?? 'Speech recognition is not available.');
        shut();
        break;
      case 'error':
        if (message.text) text = message.text;
        if (message.code !== 'intent_failed') onFail(message.plain ?? 'Speech recognition stopped.');
        break;
      default:
        break;
    }
  };
  socket.onerror = () => {};
  for (const track of stream.getAudioTracks()) {
    track.onended = () => {
      if (!closed && !finishing) onFail('The microphone stopped. Check it is still connected.');
    };
  }
  socket.onclose = () => {
    if (closed || finishing) {
      shut();
      settle();
      return;
    }
    onFail('Venezia could not reach its voice service.');
    shut();
  };

  return {
    /** Send what is left, tell the server that is all, wait for its last word. */
    async finish() {
      if (closed) return { text, intent, heard: heard() };
      const answer = new Promise((resolve) => {
        finishing = resolve;
      });
      await new Promise((resolve) => {
        flushed = resolve;
        node.port.postMessage('flush');
        setTimeout(resolve, 120);
      });
      for (const track of stream.getTracks()) track.stop();
      if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'end' }));
      else if (socket.readyState === 0) endPending = true; // a short press can beat the socket
      else {
        shut();
        settle();
      }
      armFinish();
      return answer;
    },
    cancel: shut,
  };
}
