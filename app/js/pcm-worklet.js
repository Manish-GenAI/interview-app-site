// AudioWorklet: mono 16 kHz PCM16 (little-endian) in ~100 ms chunks, plus a level reading.
// If the AudioContext already runs at 16 kHz this is a pass-through; otherwise it
// downsamples by averaging (good enough for speech recognition).
const TARGET_RATE = 16000;
const CHUNK = 1600; // 100 ms at 16 kHz

class PCM16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
    this.buf = new Int16Array(CHUNK);
    this.len = 0;
    this.sumSq = 0;
    this.paused = false;
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === 'flush') {
        this.emit(true);
        this.port.postMessage({ flushed: true });
      } else if (cmd === 'pause') {
        this.paused = true;
        this.len = 0; this.sumSq = 0; this.acc = 0; this.n = 0;
      } else if (cmd === 'resume') {
        this.paused = false;
      }
    };
  }

  emit(partial) {
    if (this.len === 0) return;
    const out = partial ? this.buf.slice(0, this.len) : this.buf;
    const rms = Math.sqrt(this.sumSq / this.len);
    const level = Math.min(1, rms * 5);
    this.port.postMessage({ pcm: out.buffer, level }, [out.buffer]);
    this.buf = new Int16Array(CHUNK);
    this.len = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (this.paused || !input || input.length === 0 || !input[0]) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i += 1) {
      let s = 0;
      for (let c = 0; c < channels; c += 1) s += input[c][i];
      s /= channels;
      this.acc += s;
      this.n += 1;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let v = this.acc / this.n;
        this.acc = 0;
        this.n = 0;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        this.sumSq += v * v;
        this.buf[this.len] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.len += 1;
        if (this.len === CHUNK) this.emit(false);
      }
    }
    return true;
  }
}

registerProcessor('pcm-16k', PCM16kProcessor);
