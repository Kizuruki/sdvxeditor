// Node tests for the effect engine in src/fx.js: runs the AudioWorklet processor offline on synthetic audio.
// Usage: node tests/fx.test.js
'use strict';
const assert = require('assert');
global.K = require('../src/core.js');
const KSMFX = require('../src/fx.js');

// minimal AudioWorklet globals
let Proc = null;
globalThis.sampleRate = 48000; globalThis.currentFrame = 0; // read as globals by the worklet
new Function('AudioWorkletProcessor', 'registerProcessor', KSMFX.WORKLET_SRC)(class { constructor() { this.port = { postMessage() { } }; } }, (name, cls) => { Proc = cls; });

const SR = 48000;
function editorFor(chart) {
	const timing = new K.Timing(chart);
	const off = (parseInt(chart.meta.o, 10) || 0) / 1000;
	return { chart, timing, songTimeOf: (t) => timing.tickToSec(t) + off, tickOfSong: (s) => timing.secToTick(s - off) };
}
// render `sec` seconds of `fn(t)` (mono test signal, both channels) through the processor
function render(chart, mode, sec, fn = () => 0.5, fx = true) {
	const n = Math.round(sec * 44100), l = new Float32Array(n), r = new Float32Array(n);
	for (let i = 0; i < n; i++) { l[i] = r[i] = fn(i / 44100); }
	const sched = KSMFX.buildSchedule(editorFor(chart));
	const p = new Proc({ processorOptions: { pcm: { l, r, n, sr: 44100 }, sched, play: { frame: 0, song: 0, rate: 1 }, mode } });
	p.fxOn = fx;
	const N = Math.floor(sec * SR / 128) * 128, oL = new Float32Array(N), oR = new Float32Array(N);
	for (let f = 0; f < N; f += 128) {
		globalThis.currentFrame = f; // the worklet reads the global
		const out = [[new Float32Array(128), new Float32Array(128)]];
		p.process([], out);
		oL.set(out[0][0], f); oR.set(out[0][1], f);
	}
	return { L: oL, R: oR };
}
globalThis.sampleRate = SR;
const P = (o) => ({ id: K.nid(), a: 0, b: 0, ...o });
const at = (out, s) => out.L[Math.round(s * SR)];
const rms = (out, s0, s1) => { let a = 0, c = 0; for (let i = Math.round(s0 * SR); i < Math.round(s1 * SR); i++) { a += out.L[i] ** 2; c++; } return Math.sqrt(a / c); };

let failures = 0, checks = 0;
function check(name, fn) {
	try { fn(); checks++; console.log('  ok  ' + name); }
	catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + String(e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}
const chart120 = () => { const c = K.newChart(); c.bpm = [P({ t: 0, v: 120 })]; return c; };

console.log('SOUND VOLTEX parameters');
check('KSH effects map to the .vox rows the exporter writes', () => {
	assert.strictEqual(KSMFX.svLine(KSMFX.sdvxParams(KSMFX.parseEffect('Retrigger;16'))), '1,\t8,\t95.00,\t2.00,\t1.00,\t0.85,\t0.15');
	assert.strictEqual(KSMFX.svLine(KSMFX.sdvxParams(KSMFX.parseEffect('Gate;8'))), '2,\t100.00,\t4,\t1.00');
	assert.strictEqual(KSMFX.svLine(KSMFX.sdvxParams(KSMFX.parseEffect('SideChain'))), '5,\t90.00,\t1.00,\t45,\t50,\t60');
	assert.strictEqual(KSMFX.svLine(KSMFX.TAB_STD[4], true), '3,\t100.00,\t30');
});
check('an imported definition keeps its exact SOUND VOLTEX row (sdvx=...)', () => {
	const defs = KSMFX.parseDefines(['#define_fx SV_Flanger type=Flanger;sdvx=3,75.00,2.00,0.50,90,2.00', '#define_filter SV_LPF_Q5 type=LowPassFilter;sdvx=1,90.00,600.00,15000.00,5.00']);
	assert.deepStrictEqual(KSMFX.sdvxParams(KSMFX.parseEffect('SV_Flanger', defs)), [3, 75, 2, 0.5, 90, 2]);
	const k = KSMFX.filterKind('SV_LPF_Q5', defs);
	assert.strictEqual(KSMFX.kindBase(k), 'lpf1');
	assert.strictEqual(KSMFX.tabCode(k), 2);
	assert.strictEqual(KSMFX.tabCode('hpf1'), 3);
});

console.log('SOUND VOLTEX playback');
check('Gate alternates +0.26 dB / -17.8 dB steps', () => {
	const c = chart120(); c.fx[0] = [P({ t: 960, l: 960, fx: 'Gate;8' })]; // 2 s .. 4 s; 4 steps per beat (0.125 s)
	const o = render(c, 'sdvx', 4.5);
	assert.ok(Math.abs(at(o, 1.5) - 0.5) < 1e-4, 'dry before the note');
	assert.ok(Math.abs(at(o, 2.06) - 0.5 * 1.0304) < 2e-3, 'step 0 loud: ' + at(o, 2.06));
	assert.ok(Math.abs(at(o, 2.19) - 0.5 * 0.1288) < 2e-3, 'step 1 quiet: ' + at(o, 2.19));
	assert.ok(Math.abs(at(o, 4.2) - 0.5) < 1e-3, 'dry after the note');
});
check('Retrigger replays the slice at the start of each cycle, locked to the grid', () => {
	const c = chart120(); c.fx[0] = [P({ t: 960 + 240, l: 960, fx: 'Retrigger;8' })]; // starts one beat into measure 2; 4 slices of 0.25 s in a 1 s (2-beat) cycle
	const o = render(c, 'sdvx', 5, (t) => t / 10); // a ramp shows which moment is being replayed
	// the note joins the 2-beat cycle that began at 2.0 s, one beat (two slices) in: at 2.6 s it replays 2.0 + 0.1 s
	const replay = (at(o, 2.6) - 0.05 * 0.26) / 0.95; // mix 95 %: out = 0.05 dry + 0.95 replay
	assert.ok(Math.abs(replay - 0.21) < 2e-3, 'replays 2.1 s, got ' + (replay * 10).toFixed(3) + ' s');
});
check('FX-L and FX-R overlapping: the later note is heard, not both stacked', () => {
	const c = chart120();
	c.fx[0] = [P({ t: 0, l: 1920, fx: 'Gate;8' })];
	c.fx[1] = [P({ t: 960, l: 480, fx: 'BitCrusher;10' })];
	const o = render(c, 'sdvx', 3.5);
	// during the overlap (2.0..3.0 s) the bitcrusher works on the dry signal: a constant stays at 0.5 (no gate)
	assert.ok(Math.abs(at(o, 2.19) - 0.5) < 1e-3, 'later note wins: ' + at(o, 2.19));
	assert.ok(Math.abs(at(o, 1.19) - 0.5 * 0.1288) < 2e-3, 'gate before the overlap: ' + at(o, 1.19));
});
check('peak filter: lasers boost a band and duck the music; tab LPF disables it', () => {
	const c = chart120();
	c.laser[0] = [P({ t: 960, wide: false, pts: [P({ ry: 0, v: 25, vf: 25 }), P({ ry: 1920, v: 25, vf: 25 })] })]; // 2..6 s at the middle
	const tone = (t) => 0.2 * Math.sin(2 * Math.PI * 1872 * t); // knob 0.5 -> table[63] = 1822 Hz
	const dry = rms(render(c, 'sdvx', 6.5, tone, false), 4, 5.5), wet = rms(render(c, 'sdvx', 6.5, tone), 4, 5.5);
	const gainDb = 20 * Math.log10(wet / dry);
	assert.ok(gainDb > 5, 'boost near the centre frequency: ' + gainDb.toFixed(1) + ' dB');
	const low = (t) => 0.2 * Math.sin(2 * Math.PI * 60 * t), duck = rms(render(c, 'sdvx', 6.5, low), 4, 5.5) / rms(render(c, 'sdvx', 6.5, low, false), 4, 5.5);
	assert.ok(Math.abs(duck - (0.8 - 59 * 0.0025274728)) < 0.03, 'music ducked to ~0.65: ' + duck.toFixed(3));
	c.filterType = [P({ t: 0, v: 'lpf1' })];
	const lp = rms(render(c, 'sdvx', 6.5, tone), 4, 5.5);
	assert.ok(lp < dry, 'tab LPF instead of the peak filter: ' + (20 * Math.log10(lp / dry)).toFixed(1) + ' dB');
});
check('a straight laser at its start edge (knob 0) does nothing in either mode', () => {
	const c = chart120();
	c.laser[0] = [P({ t: 960, wide: false, pts: [P({ ry: 0, v: 0, vf: 0 }), P({ ry: 1920, v: 0, vf: 0 })] })];
	c.meta.pfiltergain = '100';
	const tone = (t) => 0.2 * Math.sin(2 * Math.PI * 500 * t);
	const dry = rms(render(c, 'sdvx', 6, tone, false), 3, 5);
	for (const mode of ['sdvx', 'usc']) assert.ok(Math.abs(rms(render(c, mode, 6, tone), 3, 5) / dry - 1) < 0.01, mode);
});
check('every SDVX effect id renders finite audio', () => {
	for (const fx of ['Retrigger;8', 'Echo;4;60', 'Gate;16', 'Flanger', 'TapeStop;25', 'SideChain', 'Wobble;12', 'BitCrusher;10', 'PitchShift;12']) {
		const c = chart120(); c.fx[0] = [P({ t: 480, l: 960, fx })];
		const o = render(c, 'sdvx', 3, (t) => 0.3 * Math.sin(2 * Math.PI * 220 * t));
		assert.ok(o.L.every(Number.isFinite) && o.R.every(Number.isFinite), fx + ' finite');
		assert.ok(rms(o, 1.2, 2.8) > 0 || fx.startsWith('TapeStop'), fx + ' not silent');
	}
});

console.log(failures ? failures + ' of ' + (checks + failures) + ' checks FAILED' : 'all ' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
