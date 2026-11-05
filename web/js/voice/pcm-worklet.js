// Runs on the audio thread. Turns the microphone into 16 kHz Int16 PCM frames for /ws/voice.
// The context runs at whatever rate the device likes, so this averages down by a box filter,
// which is enough to keep speech clean without pulling in a resampler.

const OUTPUT_RATE = 16000;
const FRAME_SAMPLES = 640; // 40 ms

class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / OUTPUT_RATE;
    this.position = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
    this.energy = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.filled === 0) {
      this.port.postMessage({ flushed: true });
      return;
    }
    const pcm = this.frame.slice(0, this.filled);
    this.send(pcm);
    this.filled = 0;
    this.energy = 0;
    this.port.postMessage({ flushed: true });
  }

  send(pcm) {
    const level = Math.sqrt(this.energy / Math.max(1, pcm.length));
    this.port.postMessage({ pcm: pcm.buffer, level }, [pcm.buffer]);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i];
      this.count += 1;
      this.position += 1;
      if (this.position < this.step) continue;
      this.position -= this.step;
      const sample = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.frame[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.energy += sample * sample;
      if (this.filled === FRAME_SAMPLES) {
        this.send(this.frame.slice());
        this.filled = 0;
        this.energy = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-16k', Pcm16kProcessor);
