const K = window.KSMCore;
const UI_FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';

/* ============================================================================
 * Timeline view: geometry + rendering of the MMW-style vertical chart timeline.
 * Time flows upward. Only visible objects are drawn (binary search per lane).
 * ========================================================================== */
const COL_INFO = {
	zoom_top: { label: 'Zoom Top', short: 'ZT', range: 300, color: '#b48cff' },
	zoom_bottom: { label: 'Zoom Bottom', short: 'ZB', range: 300, color: '#8cb4ff' },
	zoom_side: { label: 'Zoom Side', short: 'ZS', range: 300, color: '#8cffc8' },
	tilt: { label: 'Tilt', short: 'TL', range: 1, color: '#ffd28c' },
	rotation_deg: { label: 'Rotation°', short: 'RO', range: 180, color: '#ff8cb4' },
	center_split: { label: 'Split', short: 'CS', range: 300, color: '#c8ff8c' },
	scroll_speed: { label: 'Scroll Spd', short: 'SS', range: 2, color: '#8cf0ff' },
};
const ALL_COLS = ['zoom_top', 'zoom_bottom', 'zoom_side', 'tilt', 'rotation_deg', 'center_split', 'scroll_speed'];

class TimelineView {
	constructor(canvas, ed) {
		this.cv = canvas; this.ctx = canvas.getContext('2d', { alpha: false });
		this.ed = ed;
		this.HEAD = 22;
		this.zoom = 1;          // px per tick = 0.25 * zoom
		this.bottomTick = -120; // tick at the bottom edge (below the header-free area)
		this.w = 0; this.h = 0; this.dpr = 1;
		this.cols = [];
		this.resize();
	}
	get ppt() { return 0.25 * this.zoom; }
	resize() {
		const r = this.cv.getBoundingClientRect();
		this.dpr = window.devicePixelRatio || 1;
		this.w = Math.max(100, Math.floor(r.width)); this.h = Math.max(100, Math.floor(r.height));
		this.cv.width = Math.floor(this.w * this.dpr); this.cv.height = Math.floor(this.h * this.dpr);
		this.layout();
	}
	layout() {
		const S = this.ed.settings;
		const G = 54, W = S.showWave ? 54 : 0;
		this.gutterR = G; this.waveL = G; this.waveR = G + W;
		this.laneW = S.laneW;
		this.trackL = this.waveR + 10;
		this.trackR = this.trackL + this.laneW * 6;
		this.timingL = this.trackR + 10; this.timingR = this.timingL + 104;
		const vis = ALL_COLS.filter(k => S.cols[k]);
		const avail = this.w - this.timingR - 6;
		const cw = vis.length ? Math.max(46, Math.min(84, Math.floor(avail / vis.length))) : 0;
		this.cols = vis.map((k, i) => ({ key: k, l: this.timingR + 6 + i * cw, r: this.timingR + 6 + (i + 1) * cw - 4 }));
		this.rangeCache = null;
	}
	// ---- geometry ----
	yOf(t) { return this.h - (t - this.bottomTick) * this.ppt; }
	tickAt(y) { return this.bottomTick + (this.h - y) / this.ppt; }
	btL(lane) { return this.trackL + this.laneW * (lane + 1); }
	fxL(lane) { return this.trackL + this.laneW * (1 + lane * 2); }
	laserX(v) { return this.trackL + this.laneW * 0.5 + (v / 50) * this.laneW * 5; }
	vAtX(x) { return (x - this.trackL - this.laneW * 0.5) / (this.laneW * 5) * 50; }
	region(x) {
		if (x < this.gutterR) return { kind: 'gutter' };
		if (x < this.waveR) return { kind: 'wave' };
		if (x < this.trackR + 6) return { kind: 'track' };
		if (x < this.timingR + 3) return { kind: 'timing' };
		for (const c of this.cols) if (x >= c.l - 2 && x <= c.r + 2) return { kind: 'cam', key: c.key, col: c };
		return { kind: 'none' };
	}
	colRange(key) {
		const pts = key === 'tilt' ? this.ed.chart.tilt : this.ed.chart.cam[key];
		let mx = COL_INFO[key].range;
		for (const p of pts) { for (const v of [p.v, p.vf]) if (typeof v === 'number') mx = Math.max(mx, Math.abs(v) * 1.1); }
		return mx;
	}
	colX(col, v) { const R = this._ranges[col.key]; const c = (col.l + col.r) / 2; return c + (v / R) * ((col.r - col.l) / 2 - 3); }
	colV(col, x) { const R = this._ranges[col.key]; const c = (col.l + col.r) / 2; return (x - c) / ((col.r - col.l) / 2 - 3) * R; }
	visibleRange() { return [Math.floor(this.tickAt(this.h + 10)), Math.ceil(this.tickAt(this.HEAD - 10))]; }

	// ---- rendering ----
	draw() {
		const ed = this.ed, c = this.ctx, ch = ed.chart, tm = ed.timing;
		c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		c.fillStyle = '#0e0e11'; c.fillRect(0, 0, this.w, this.h);
		this._ranges = {}; for (const col of this.cols) this._ranges[col.key] = this.colRange(col.key);
		const [t0, t1] = this.visibleRange();
		const L = this.laneW, tl = this.trackL, tr = this.trackR;

		// track background
		c.fillStyle = '#131317'; c.fillRect(tl, 0, tr - tl, this.h);
		c.fillStyle = 'rgba(47,184,255,0.07)'; c.fillRect(tl, 0, L, this.h);
		c.fillStyle = 'rgba(255,61,154,0.07)'; c.fillRect(tr - L, 0, L, this.h);
		c.fillStyle = '#16161b'; c.fillRect(this.btL(1), 0, L, this.h); c.fillRect(this.btL(3), 0, L, this.h);
		c.fillStyle = '#101013'; c.fillRect(this.timingL, 0, this.timingR - this.timingL, this.h);
		for (const col of this.cols) { c.fillStyle = '#111115'; c.fillRect(col.l, 0, col.r - col.l, this.h); }

		// waveform
		if (ed.settings.showWave && ed.audio.peaks) this._drawWave(t0, t1);

		// stops (hatched bands)
		for (const s of ch.stops) {
			if (s.t + s.l < t0 || s.t > t1) continue;
			const y0 = this.yOf(s.t), y1 = this.yOf(s.t + s.l);
			c.fillStyle = 'rgba(255,80,80,0.08)'; c.fillRect(tl, y1, tr - tl, y0 - y1);
		}

		this._drawGrid(t0, t1);

		// lane dividers
		c.lineWidth = 1;
		c.strokeStyle = '#2a2a33'; c.beginPath();
		for (let i = 1; i < 6; i++) { if (i === 3) continue; const x = Math.round(tl + L * i) + 0.5; c.moveTo(x, 0); c.lineTo(x, this.h); }
		c.stroke();
		c.strokeStyle = '#3c3c48'; c.beginPath();
		for (const x0 of [tl, tl + L * 3, tr]) { const x = Math.round(x0) + 0.5; c.moveTo(x, 0); c.lineTo(x, this.h); }
		c.stroke();
		for (const col of this.cols) { // zero line
			const x = Math.round(this.colX(col, 0)) + 0.5;
			c.strokeStyle = '#26262e'; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, this.h); c.stroke();
		}

		this._drawNotes(t0, t1);
		this._drawLasers(t0, t1);
		this._drawSpins(t0, t1);
		this._drawTimingCol(t0, t1);
		for (const col of this.cols) this._drawCamCol(col, t0, t1);
		ed.drawOverlay(c, this);   // ghosts, marquee, hover highlights

		// playhead
		const ph = ed.playing ? ed.playTick : ed.cursor;
		const py = Math.round(this.yOf(ph)) + 0.5;
		c.strokeStyle = '#ff4f4f'; c.lineWidth = 2; c.beginPath(); c.moveTo(this.waveL, py); c.lineTo(this.w, py); c.stroke();
		c.fillStyle = '#ff4f4f'; c.beginPath(); c.moveTo(this.gutterR - 10, py - 6); c.lineTo(this.gutterR - 10, py + 6); c.lineTo(this.gutterR - 1, py); c.fill();
		c.lineWidth = 1;

		// header band
		c.fillStyle = '#18181c'; c.fillRect(0, 0, this.w, this.HEAD);
		c.strokeStyle = '#2e2e35'; c.beginPath(); c.moveTo(0, this.HEAD - 0.5); c.lineTo(this.w, this.HEAD - 0.5); c.stroke();
		c.font = '600 10.5px ' + UI_FONT;
		c.textBaseline = 'middle'; c.textAlign = 'center';
		const hy = this.HEAD / 2 + 1;
		c.fillStyle = '#7a7a84'; c.fillText('MEAS', this.gutterR / 2, hy);
		if (ed.settings.showWave) c.fillText('WAVE', (this.waveL + this.waveR) / 2, hy);
		const lab = [['L', '#2fb8ff'], ['A', '#ddd'], ['B', '#ddd'], ['C', '#ddd'], ['D', '#ddd'], ['R', '#ff3d9a']];
		lab.forEach(([s, col], i) => { c.fillStyle = col; c.fillText(s, tl + L * (i + 0.5), hy); });
		c.fillStyle = '#9ad68a'; c.fillText('BPM · BEAT · STOP', (this.timingL + this.timingR) / 2, hy);
		for (const col of this.cols) {
			c.fillStyle = COL_INFO[col.key].color;
			const w = col.r - col.l;
			c.fillText(w > 70 ? COL_INFO[col.key].label : COL_INFO[col.key].short, (col.l + col.r) / 2, hy);
		}
		c.textAlign = 'left';
	}

	_drawWave(t0, t1) {
		const c = this.ctx, ed = this.ed, a = ed.audio;
		const off = ed.offsetSec(), cx = (this.waveL + this.waveR) / 2, hw = (this.waveR - this.waveL) / 2 - 2;
		c.fillStyle = '#0b0b0e'; c.fillRect(this.waveL, 0, this.waveR - this.waveL, this.h);
		c.fillStyle = '#3d7f99';
		const step = 2;
		for (let y = this.HEAD; y < this.h; y += step) {
			const ta = this.tickAt(y + step), tb = this.tickAt(y);
			if (tb < 0 && ta < 0) continue;
			const sa = ed.timing.tickToSec(ta) + off, sb = ed.timing.tickToSec(tb) + off;
			if (sb < 0 || sa > a.duration) continue;
			const p = Math.min(1, a.peakAt(sa, sb) * 1.15);
			const w = p * hw;
			if (w > 0.3) c.fillRect(cx - w, y, w * 2, step);
		}
	}

	_drawGrid(t0, t1) {
		const c = this.ctx, ed = this.ed, tm = ed.timing;
		const div = ed.div;
		const step = 960 / div;
		let ms = tm.measureOf(Math.max(0, t0));
		const font = UI_FONT;
		const xL = this.waveR, xR = this.timingR;
		const divPx = step * this.ppt;
		let guard = 0;
		while (ms.start <= t1 && guard++ < 400) {
			const beatLen = 960 / ms.d;
			// division lines
			if (divPx >= 4) {
				c.strokeStyle = '#1d1d24'; c.beginPath();
				for (let k = 1; k * step < ms.len; k++) {
					const t = ms.start + k * step;
					if (t < t0 || t > t1 || (k * step) % beatLen === 0) continue;
					const y = Math.round(this.yOf(t)) + 0.5;
					c.moveTo(this.trackL, y); c.lineTo(this.trackR, y);
				}
				c.stroke();
			}
			// beat lines
			c.strokeStyle = '#30303a'; c.beginPath();
			for (let k = 1; k * beatLen < ms.len; k++) {
				const y = Math.round(this.yOf(ms.start + k * beatLen)) + 0.5;
				c.moveTo(xL, y); c.lineTo(xR, y);
			}
			c.stroke();
			// measure line + label
			const y = Math.round(this.yOf(ms.start)) + 0.5;
			c.strokeStyle = '#5c5c6c'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(0, y); c.lineTo(this.w, y); c.stroke(); c.lineWidth = 1;
			c.fillStyle = '#b8b8c4'; c.font = '600 12px ' + font; c.textBaseline = 'bottom'; c.textAlign = 'right';
			c.fillText(String(ms.m + 1), this.gutterR - 6, y - 2);
			c.fillStyle = '#5c5c68'; c.font = '10px ' + font; c.textBaseline = 'top';
			c.fillText(fmtTime(tm.tickToSec(ms.start)), this.gutterR - 4, y + 2);
			c.textAlign = 'left';
			const next = ms.start + ms.len;
			ms = tm.measureOf(next);
			if (ms.start < next) break;
		}
	}

	_laneRange(arr, t0, t1) { // indices [i0, i1) of items that may be visible
		let i0 = K.lowerBound(arr, t0);
		while (i0 > 0 && arr[i0 - 1].t + (arr[i0 - 1].l || 0) >= t0) i0--;
		return [i0, K.upperBound(arr, t1)];
	}

	_drawNotes(t0, t1) {
		const c = this.ctx, ed = this.ed, ch = ed.chart, L = this.laneW, sel = ed.sel;
		const font = UI_FONT;
		// FX holds
		for (let lane = 0; lane < 2; lane++) {
			const arr = ch.fx[lane], [i0, i1] = this._laneRange(arr, t0, t1), x = this.fxL(lane);
			for (let i = i0; i < i1; i++) {
				const n = arr[i]; if (n.l <= 0) continue;
				const y0 = this.yOf(n.t), y1 = this.yOf(n.t + n.l);
				c.fillStyle = 'rgba(255,150,30,0.42)'; c.fillRect(x + 3, y1, L * 2 - 6, y0 - y1);
				c.strokeStyle = sel.has(n.id) ? '#7fe4ff' : '#ffae45'; c.lineWidth = sel.has(n.id) ? 2 : 1.2;
				c.strokeRect(x + 3.5, y1 + 0.5, L * 2 - 7, y0 - y1 - 1);
				c.fillStyle = '#ffb24d'; c.fillRect(x + 3, y0 - 3, L * 2 - 6, 3);
				if (n.fx && y0 - y1 > 16) {
					c.fillStyle = '#ffe2b8'; c.font = '10px ' + font; c.textBaseline = 'bottom';
					c.save(); c.beginPath(); c.rect(x + 4, y1, L * 2 - 8, y0 - y1); c.clip();
					c.fillText(n.fx, x + 6, y0 - 5); c.restore();
				}
			}
		}
		c.lineWidth = 1;
		// BT holds
		for (let lane = 0; lane < 4; lane++) {
			const arr = ch.bt[lane], [i0, i1] = this._laneRange(arr, t0, t1), x = this.btL(lane);
			for (let i = i0; i < i1; i++) {
				const n = arr[i]; if (n.l <= 0) continue;
				const y0 = this.yOf(n.t), y1 = this.yOf(n.t + n.l);
				c.fillStyle = 'rgba(235,235,240,0.5)'; c.fillRect(x + 7, y1, L - 14, y0 - y1);
				c.strokeStyle = sel.has(n.id) ? '#7fe4ff' : 'rgba(255,255,255,0.9)'; c.lineWidth = sel.has(n.id) ? 2 : 1.2;
				c.strokeRect(x + 7.5, y1 + 0.5, L - 15, y0 - y1 - 1);
				c.fillStyle = '#fff'; c.fillRect(x + 4, y0 - 3, L - 8, 3);
			}
		}
		c.lineWidth = 1;
		// FX chips
		for (let lane = 0; lane < 2; lane++) {
			const arr = ch.fx[lane], [i0, i1] = this._laneRange(arr, t0, t1), x = this.fxL(lane);
			for (let i = i0; i < i1; i++) {
				const n = arr[i]; if (n.l > 0) continue;
				const y = this.yOf(n.t);
				c.fillStyle = '#ff9a1f'; c.fillRect(x + 3, y - 9, L * 2 - 6, 9);
				c.fillStyle = '#ffd08a'; c.fillRect(x + 3, y - 9, L * 2 - 6, 2);
				if (sel.has(n.id)) { c.strokeStyle = '#7fe4ff'; c.lineWidth = 2; c.strokeRect(x + 2, y - 10, L * 2 - 4, 11); c.lineWidth = 1; }
				if (n.se) { c.fillStyle = '#3b2000'; c.font = '9px ' + font; c.textBaseline = 'bottom'; c.fillText('♪', x + 6, y - 0.5); }
			}
		}
		// BT chips
		for (let lane = 0; lane < 4; lane++) {
			const arr = ch.bt[lane], [i0, i1] = this._laneRange(arr, t0, t1), x = this.btL(lane);
			for (let i = i0; i < i1; i++) {
				const n = arr[i]; if (n.l > 0) continue;
				const y = this.yOf(n.t);
				c.fillStyle = '#f4f4f6'; c.fillRect(x + 3, y - 7, L - 6, 7);
				c.fillStyle = '#9a9aa4'; c.fillRect(x + 3, y - 1.5, L - 6, 1.5);
				if (sel.has(n.id)) { c.strokeStyle = '#7fe4ff'; c.lineWidth = 2; c.strokeRect(x + 2, y - 8, L - 4, 9); c.lineWidth = 1; }
			}
		}
	}

	slamH() { return Math.max(10, Math.min(28, 60 * this.ppt)); } // drawn height of a slam (also its click area)

	laserPath(sec, lane, cb) { // calls cb(kind, ...) for every drawable piece of a section
		const pts = sec.pts;
		for (let i = 0; i < pts.length; i++) {
			const p = pts[i], q = pts[i + 1], t = sec.t + p.ry;
			if (p.v !== p.vf) cb('slam', t, p.v, p.vf, p);
			if (q) cb('seg', t, p.vf, sec.t + q.ry, q.v, p);
		}
	}

	_drawLasers(t0, t1) {
		const c = this.ctx, ed = this.ed, ch = ed.chart, L = this.laneW;
		const hw = L * 0.27;
		const cols = [['rgba(47,184,255,0.55)', '#8fdcff', '#2fb8ff'], ['rgba(255,61,154,0.55)', '#ffa3cc', '#ff3d9a']];
		const showHandles = ed.tool === 'select' || ed.tool === 'laserL' || ed.tool === 'laserR';
		for (let lane = 0; lane < 2; lane++) {
			const arr = ch.laser[lane];
			const [fill, edge, solid] = cols[lane];
			let i0 = K.upperBound(arr, t1);
			for (let i = i0 - 1; i >= 0; i--) {
				const sec = arr[i];
				if (K.sectionEndTick(sec) < t0) { if (sec.t + 960 * 32 < t0) break; continue; }
				const slamH = this.slamH();
				c.fillStyle = fill;
				// body
				this.laserPath(sec, lane, (kind, a, b, cc, d, p) => {
					if (kind === 'slam') {
						const y = this.yOf(a), x0 = this.laserX(b), x1 = this.laserX(cc);
						const sx = Math.min(x0, x1) - hw, sw = Math.abs(x1 - x0) + hw * 2;
						c.fillRect(sx, y - slamH, sw, slamH); c.fillRect(sx, y - slamH, sw, slamH); // double fill: slams read stronger than the trail
						c.fillStyle = edge; c.fillRect(sx, y - slamH, sw, 2); c.fillRect(sx, y - 1, sw, 1); c.fillStyle = fill;
					} else {
						const ya = this.yOf(a), yb = this.yOf(cc);
						if (ya < -50 && yb < -50) return; if (ya > this.h + 50 && yb > this.h + 50) return;
						const xa = this.laserX(b), xb = this.laserX(d);
						c.beginPath();
						if (K.isLinear(p) || b === d) {
							c.moveTo(xa - hw, ya); c.lineTo(xb - hw, yb); c.lineTo(xb + hw, yb); c.lineTo(xa + hw, ya);
						} else {
							const N = 16, xs = [];
							for (let k = 0; k <= N; k++) xs.push(xa + (xb - xa) * K.evalCurve(p.a, p.b, k / N));
							c.moveTo(xs[0] - hw, ya);
							for (let k = 1; k <= N; k++) c.lineTo(xs[k] - hw, ya + (yb - ya) * k / N);
							for (let k = N; k >= 0; k--) c.lineTo(xs[k] + hw, ya + (yb - ya) * k / N);
						}
						c.closePath(); c.fill();
					}
				});
				// centre line
				c.strokeStyle = edge; c.lineWidth = 1.5; c.beginPath();
				this.laserPath(sec, lane, (kind, a, b, cc, d, p) => {
					if (kind !== 'seg') return;
					const ya = this.yOf(a), yb = this.yOf(cc), xa = this.laserX(b), xb = this.laserX(d);
					if (K.isLinear(p) || b === d) { c.moveTo(xa, ya); c.lineTo(xb, yb); }
					else { c.moveTo(xa, ya); for (let k = 1; k <= 16; k++) c.lineTo(xa + (xb - xa) * K.evalCurve(p.a, p.b, k / 16), ya + (yb - ya) * k / 16); }
				});
				c.stroke(); c.lineWidth = 1;
				if (sec.wide) {
					c.fillStyle = solid; c.font = '700 10px sans-serif'; c.textBaseline = 'top';
					c.fillText('2x', this.laserX(sec.pts[0].v) + hw + 2, this.yOf(sec.t) + 1);
				}
				// handles
				for (const p of sec.pts) {
					const isSel = ed.sel.has(p.id), y = this.yOf(sec.t + p.ry);
					if (!showHandles && !isSel) continue;
					const s = isSel ? 5 : 3.5;
					for (const v of p.v === p.vf ? [p.v] : [p.v, p.vf]) {
						const x = this.laserX(v);
						c.fillStyle = isSel ? '#ffffff' : solid; c.fillRect(x - s, y - s, s * 2, s * 2);
						c.strokeStyle = isSel ? '#7fe4ff' : '#000'; c.strokeRect(x - s + 0.5, y - s + 0.5, s * 2 - 1, s * 2 - 1);
					}
				}
			}
		}
	}

	_drawSpins(t0, t1) {
		const c = this.ctx, ed = this.ed;
		const font = UI_FONT;
		this.spinHits = []; // label boxes, clickable with any tool
		for (const s of ed.chart.spins) {
			if (s.t + s.l < t0 || s.t > t1) continue;
			const y0 = this.yOf(s.t), y1 = this.yOf(s.t + s.l);
			const x = this.trackR - 4;
			c.fillStyle = 'rgba(190,120,255,0.35)'; c.fillRect(x, y1, 3, y0 - y1);
			const lab = (s.kind === 'spin' ? '↻ spin' : s.kind === 'half' ? '↺ half' : '≋ swing') + (s.dir < 0 ? ' ←' : ' →');
			c.font = '600 10px ' + font; c.textBaseline = 'middle';
			const w = c.measureText(lab).width + 8;
			c.fillStyle = ed.sel.has(s.id) ? '#7fe4ff' : '#9b5cf0'; c.fillRect(x - w + 3, y0 - 8, w, 14);
			this.spinHits.push({ x0: x - w + 3, x1: x + 3, y0: y0 - 8, y1: y0 + 6, item: s });
			c.fillStyle = '#fff'; c.fillText(lab, x - w + 7, y0 - 1);
		}
	}

	_drawTimingCol(t0, t1) {
		const c = this.ctx, ed = this.ed, ch = ed.chart;
		const font = UI_FONT;
		const x0 = this.timingL, x1 = this.timingR;
		c.save(); c.beginPath(); c.rect(x0, this.HEAD, x1 - x0, this.h); c.clip();
		c.textBaseline = 'bottom';
		this.timingHits = []; // clickable label boxes (editor hit testing / box select uses these)
		const stack = new Map(); // small labels at the same tick stack upwards
		const label = (t, txt, color, row, hit) => {
			if (t < t0 - 200 || t > t1 + 200) return;
			const y = Math.round(this.yOf(t)) + 0.5;
			const on = hit && ed.sel.has(hit.item.id), hov = hit && ed.hover && ed.hover.item === hit.item;
			const col = on ? '#7fe4ff' : color;
			c.strokeStyle = col; c.globalAlpha = row === 3 && !on ? 0.6 : 1; c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); c.globalAlpha = 1;
			c.font = (row === 0 ? '600 11px ' : '10px ') + font;
			let dy = 0;
			if (row === 3) { const n = stack.get(t) || 0; stack.set(t, n + 1); dy = 11 + n * 11; }
			const tx = x0 + 3 + (row === 2 ? 52 : 0), ty = y - 1 - dy, w = c.measureText(txt).width;
			if (on || hov) { c.fillStyle = on ? 'rgba(127,228,255,0.18)' : 'rgba(255,255,255,0.08)'; c.fillRect(tx - 2, ty - 11, Math.min(w + 4, x1 - tx + 2), 12); }
			c.fillStyle = col; c.fillText(txt, tx, ty);
			if (hit) this.timingHits.push({ x0: tx - 2, x1: Math.min(x1, tx + w + 2), y0: ty - 12, y1: ty + 2, t, ...hit });
		};
		for (const s of ch.stops) {
			if (s.t + s.l < t0 || s.t > t1) continue;
			const ya = this.yOf(s.t), yb = this.yOf(s.t + s.l);
			c.fillStyle = ed.sel.has(s.id) ? 'rgba(127,228,255,.35)' : 'rgba(255,90,90,0.25)'; c.fillRect(x1 - 10, yb, 7, ya - yb);
			label(s.t, 'stop ' + fmtLen(s.l), '#ff7a7a', 2, { kind: 'stop', item: s });
		}
		for (const s of ch.sig) label(ed.timing.measureStart(s.m), s.n + '/' + s.d, '#e6c84a', 2, { kind: 'sig', item: s });
		for (const b of ch.bpm) label(b.t, '♩' + K.fmtNum(b.v), '#8fe07a', 0, { kind: 'bpm', item: b });
		const small = (key, pre, color) => { for (const e of ch[key]) label(e.t, pre + e.v, color, 3, { kind: 'ev', key, item: e }); };
		small('filterType', 'filter ', '#c9a2ff'); small('pfilterGain', 'pfgain ', '#a2b8ff'); small('slamVol', 'slamvol ', '#ffb27a'); small('slamSE', 'slam se ', '#ffb27a');
		for (const r of ch.raw) label(r.t, r.k === '//' ? '// ' + r.v : (r.k || '') + (r.k ? '=' : '') + r.v, '#8a8a96', 3, { kind: 'ev', key: 'raw', item: r });
		c.restore();
	}

	_drawCamCol(col, t0, t1) {
		const c = this.ctx, ed = this.ed, key = col.key, info = COL_INFO[key];
		const pts = key === 'tilt' ? ed.chart.tilt : ed.chart.cam[key];
		const font = UI_FONT;
		c.save(); c.beginPath(); c.rect(col.l, this.HEAD, col.r - col.l, this.h); c.clip();
		const def = key === 'scroll_speed' ? 1 : 0;
		const val = (v) => typeof v === 'number' ? v : null;
		// dashed ghost: the tilt the game engine actually applies (auto laser tilt + manual), from the preview's USC model
		if (key === 'tilt' && ed.preview && ed.settings.showTiltGhost !== false) {
			c.save(); c.setLineDash([4, 3]); c.strokeStyle = 'rgba(255,210,140,0.55)'; c.lineWidth = 1.2; c.beginPath();
			let first = true;
			for (let y = this.h; y >= this.HEAD - 4; y -= 3) {
				const t = this.tickAt(y); if (t < -240) continue;
				const x = this.colX(col, ed.preview.tiltAtTick(t));
				if (first) { c.moveTo(x, y); first = false; } else c.lineTo(x, y);
			}
			c.stroke(); c.restore();
		}
		// graph line
		c.strokeStyle = info.color; c.lineWidth = 1.5; c.beginPath();
		const yTop = this.HEAD - 5, yBot = this.h + 5;
		let started = false;
		const i0 = Math.max(0, K.upperBound(pts, t0) - 1), i1 = Math.min(pts.length, K.upperBound(pts, t1) + 1);
		if (!pts.length) { const x = this.colX(col, def); c.moveTo(x, yBot); c.lineTo(x, yTop); }
		else {
			if (i0 === 0) { const v0 = val(pts[0].v); const x = this.colX(col, v0 === null ? 0 : v0); c.moveTo(x, yBot); c.lineTo(x, this.yOf(pts[0].t)); started = true; }
			for (let i = i0; i < i1; i++) {
				const p = pts[i], q = pts[i + 1];
				const pv = val(p.v), pvf = val(p.vf !== undefined ? p.vf : p.v);
				const y = this.yOf(p.t);
				if (pv !== null) { const xa = this.colX(col, pv); if (!started) { c.moveTo(xa, y); started = true; } else c.lineTo(xa, y); }
				if (pvf === null) { started = false; continue; }
				const xf = this.colX(col, pvf);
				if (pv === null) c.moveTo(xf, y); else c.lineTo(xf, y);
				if (!q) { c.lineTo(xf, yTop); break; }
				const qv = val(q.v);
				const yq = this.yOf(q.t);
				if (qv === null) { c.lineTo(xf, yq); started = false; continue; }
				if (K.isLinear(p)) c.lineTo(this.colX(col, qv), yq);
				else for (let k = 1; k <= 16; k++) c.lineTo(this.colX(col, pvf + (qv - pvf) * K.evalCurve(p.a, p.b, k / 16)), y + (yq - y) * k / 16);
			}
		}
		c.stroke(); c.lineWidth = 1;
		// keyframes
		c.font = '10px ' + font; c.textBaseline = 'middle';
		let lastLabelY = Infinity;
		for (let i = i0; i < i1; i++) {
			const p = pts[i], y = this.yOf(p.t), isSel = ed.sel.has(p.id);
			const pv = val(p.v);
			const x = pv !== null ? this.colX(col, pv) : (col.l + col.r) / 2;
			c.fillStyle = isSel ? '#ffffff' : info.color;
			c.beginPath(); c.arc(x, y, isSel ? 5 : 3.5, 0, Math.PI * 2); c.fill();
			if (isSel) { c.strokeStyle = '#7fe4ff'; c.stroke(); }
			if (p.vf !== undefined && p.vf !== p.v && typeof p.vf === 'number') { const xf = this.colX(col, p.vf); c.fillRect(xf - 2.5, y - 2.5, 5, 5); }
			if (lastLabelY - y > 12 || isSel) {
				let txt = typeof p.v === 'number' ? K.fmtNum(p.v) : p.v;
				if (p.vf !== undefined && p.vf !== p.v) txt += '→' + (typeof p.vf === 'number' ? K.fmtNum(p.vf) : p.vf);
				if (!K.isLinear(p)) txt += ' ~';
				c.fillStyle = isSel ? '#fff' : '#a8a8b4';
				const tw = c.measureText(txt).width;
				const tx = x + 6 + tw > col.r ? x - 6 - tw : x + 6;
				c.fillText(txt, tx, y - 7);
				lastLabelY = y;
			}
		}
		c.restore();
	}
}

function fmtTime(sec) {
	const s = Math.max(0, sec), m = Math.floor(s / 60), r = s - m * 60;
	return m + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
}
function fmtTimeMs(sec) {
	const neg = sec < 0, s = Math.abs(sec), m = Math.floor(s / 60), r = s - m * 60;
	return (neg ? '-' : '') + m + ':' + (r < 10 ? '0' : '') + r.toFixed(3);
}
function fmtLen(ticks) { // "1/8", "3/16", "1 1/4" measures (4/4 based)
	const g = (a, b) => b ? g(b, a % b) : a;
	if (ticks <= 0) return '0';
	const d = g(ticks, 960);
	const num = ticks / d, den = 960 / d;
	return den === 1 ? String(num) : num + '/' + den;
}
