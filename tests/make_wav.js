// Writes a mono 16-bit WAV with short clicks on every beat: node make_wav.js out.wav bpm firstBeatSec seconds
const fs = require('fs');
const [out, bpm = 120, first = 0.5, secs = 30] = process.argv.slice(2);
const sr = 44100, n = Math.floor(sr * secs), buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
const beat = 60 / bpm;
for (let t = +first, k = 0; t < secs; t += beat, k++) {
  const s0 = Math.round(t * sr), amp = k % 4 === 0 ? 30000 : 16000;
  for (let i = 0; i < 1500 && s0 + i < n; i++) buf.writeInt16LE(Math.round(amp * Math.exp(-i / 220) * Math.sin(i * 0.35)), 44 + (s0 + i) * 2);
}
fs.writeFileSync(out, buf);
