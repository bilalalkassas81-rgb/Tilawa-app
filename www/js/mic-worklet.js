// Audio thread: hands the microphone's samples to the page in blocks of about 40 ms.
class TilawaMic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n + ch.length > this.buf.length) { this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; }
      this.buf.set(ch, this.n); this.n += ch.length;
    }
    return true;
  }
}
registerProcessor('tilawa-mic', TilawaMic);
