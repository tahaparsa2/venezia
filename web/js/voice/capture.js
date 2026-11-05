// The microphone, through an AudioWorklet, to /ws/voice. Frames are 16 kHz Int16 PCM. Text
// frames back are {t:'status'|'partial'|'final'|'done'|'intent'|'unavailable'|'error'}, and the
// server closes the socket when it has said everything. `mode=transcribe` means the server
// reports what it read and runs nothing, so the person always has the last word.
//
// Frames wait in a queue until the socket opens, so the first word of a press is not lost.

const FINISH_TIMEOUT_MS = 10_000;
const QUEUE_LIMIT = 150; // six seconds at 40 ms a frame

export class VoiceUnavailable extends Error {
  constructor(plain, { denied = false } = {}) {
    super(plain);
    this.plain = plain;
    this.denied = denied;
  }
}

export const canCapture = () => Boolean(window.isSecureContext !== false
  && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);

const socketUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/voice?mode=transcribe`;

/**
 * @param {object} hooks
 * @param {(level: number) => void} hooks.onLevel 0..1, about 25 times a second
 * @param {(text: string) => void} hooks.onPartial
 * @param {(plain: string) => void} hooks.onNote a passing status line
 * @param {(plain: string) => void} hooks.onFail voice cannot go on, fall back
 */
export async function startCapture({ onLevel, onPartial, onNote, onFail }) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    throw new VoiceUnavailable(denied ? 'The microphone is blocked here.' : 'No microphone was found.', { denied });
  }

  const context = new AudioContext({ latencyHint: 'interactive' });
  let socket = null;
  let closed = false;
  let flushed = null;
  let finishing = null;
  const queue = [];
  let text = '';
  let intent = null;

  function release() {
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
    finishing?.({ text, intent });
    finishing = null;
  }

  try {
    await context.resume();
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
    onLevel(Math.min(1, data.level * 5));
    if (socket?.readyState === 1) socket.send(data.pcm);
    else if (queue.length < QUEUE_LIMIT) queue.push(data.pcm);
  };

  socket = new WebSocket(socketUrl());
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    for (const frame of queue.splice(0)) socket.send(frame);
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
        if (message.plain) onNote(message.plain);
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
  socket.onclose = () => {
    if (closed || finishing) {
      shut();
      settle();
      return;
    }
    onFail('The voice link closed.');
    shut();
  };

  return {
    /** Send what is left, tell the server that is all, wait for its last word. */
    async finish() {
      if (closed) return { text, intent };
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
      else if (socket.readyState !== 0) {
        shut();
        settle();
      }
      const timer = setTimeout(() => {
        shut();
        settle();
      }, FINISH_TIMEOUT_MS);
      const result = await answer;
      clearTimeout(timer);
      return result;
    },
    cancel: shut,
  };
}
