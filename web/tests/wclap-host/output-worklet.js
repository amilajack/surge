// SPDX-License-Identifier: GPL-3.0-or-later
// Plays blocks the DSP worker renders on request, a few quanta ahead.
class WclapOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.requested = 0;
    this.dsp = null;
    this.port.onmessage = ({data}) => {
      this.dsp = data.port;
      this.dsp.onmessage = ({data}) => { this.queue.push(data); this.requested--; };
    };
  }
  process(_, outputs) {
    const [left, right] = outputs[0];
    let at = 0;
    while (at < left.length && this.queue.length) {
      const block = this.queue[0];
      const n = Math.min(left.length - at, block.left.length - this.offset);
      left.set(block.left.subarray(this.offset, this.offset + n), at);
      right?.set(block.right.subarray(this.offset, this.offset + n), at);
      at += n;
      this.offset += n;
      if (this.offset === block.left.length) { this.queue.shift(); this.offset = 0; }
    }
    // Underruns play silence; keep about four quanta in flight.
    while (this.dsp && this.queue.length + this.requested < 4) {
      this.dsp.postMessage({frames: 128});
      this.requested++;
    }
    return true;
  }
}
registerProcessor('wclap-output', WclapOutput);
