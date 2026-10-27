/* ============================================================================
 * Preview: SDVX-style highway. The camera is a direct port of USC's portrait
 * camera (Main/src/Camera.cpp, Track.cpp, Game.cpp, Scoring.cpp; MIT licence),
 * so zoom_top / zoom_bottom / zoom_side / center_split, the engine's automatic
 * laser tilt (normal / bigger / biggest / zero / keep_*), manual tilt, slam
 * roll + slam shake, spins / half spins / swings and hi-speed behave like they
 * do in USC (which itself mimics SDVX).
 *
 * World units: the track is 1 wide (6 lanes of 1/6) and 12 long, judgment
 * line at y = 0. Visible range = 8 / hi-speed beats.
 * ========================================================================== */
const M4 = { // column-major 4x4, same conventions as USC's Transform
	id() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
	mul(a, b) {
		const r = new Array(16);
		for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
			r[x * 4 + y] = a[y] * b[x * 4] + a[4 + y] * b[x * 4 + 1] + a[8 + y] * b[x * 4 + 2] + a[12 + y] * b[x * 4 + 3];
		}
		return r;
	},
	tr(x, y, z) { const m = M4.id(); m[12] = x; m[13] = y; m[14] = z; return m; },
	rot(ex, ey, ez) { // Transform::Rotation(euler degrees)
		const d = Math.PI / 180, p = -ex * d, yw = -ey * d, r = -ez * d;
		const a = Math.cos(p), b = Math.sin(p), c = Math.cos(yw), dd = Math.sin(yw), e = Math.cos(r), f = Math.sin(r);
		const ad = a * dd, bd = b * dd;
		return [c * e, -c * f, dd, 0, bd * e + a * f, -bd * f + a * e, -b * c, 0, -ad * e + b * f, ad * f + b * e, a * c, 0, 0, 0, 0, 1];
	},
	pos(m) { return [m[12], m[13], m[14]]; },
};
const PV = {
	MAX_ROLL: 10 / 360,   // turns
	TRACK_LEN: 12,        // portrait
	BTN_W: 1 / 6,
	FOV: 90, PITCH_OFFSET: 0.25,
	ROLL_IGNORE: 0.1, SLAM_DUR: 0.1, SLAM_SEC: 0.04,
};

function uscPitchScale(input) { // PitchScaleFunc (portrait constants)
	const kLower = -4, kUpper = 5.59, uLower = -2.8195, uUpper = 4.675;
	let rot = 0; const dir = input < 0 ? -1 : 1;
	if (dir === -1) { while (input < -12) { input += 24; rot++; } }
	else { while (input > 12) { input -= 24; rot++; } }
	let s;
	if (input < kLower) s = -(-(input - kLower) / (12 + kLower)) * (12 + uLower) + uLower;
	else if (input < 0) s = (input / kLower) * uLower;
	else if (input < kUpper) s = (input / kUpper) * uUpper;
	else s = ((input - kUpper) / (12 - kUpper)) * (12 - uUpper) + uUpper;
	return rot * dir * 24 + s;
}
function uscOrigin(pitch, offs, roll) { // GetOriginTransform (portrait)
	const origin = M4.rot(1, 0, roll);
	const anchor = M4.mul(M4.tr(offs, -0.8, 0), M4.rot(1.5, 0, 0));
	const contnr = M4.mul(M4.tr(0, 0, -0.9), M4.rot(-90 + pitch, 0, 0));
	return M4.mul(M4.mul(origin, anchor), contnr);
}
function uscZoomed(t, zoom) {
	const p = M4.pos(t), dist = Math.hypot(p[0], p[1], p[2]);
	const amt = zoom <= 0 ? Math.pow(1.65, -zoom) - 1 : dist * (Math.pow(1.65, -Math.pow(zoom, 1.35)) - 1);
	const k = amt / dist;
	return M4.mul(M4.tr(p[0] * k, p[1] * k, p[2] * k), t);
}
const dampedSin = (t, amp, freq, decay) => amp * Math.exp(-decay * t) * Math.sin(freq * 2 * t * Math.PI);
const uscSwing = (t) => dampedSin(t, 120 / 360, 1, 3.5);
const sgn = (v) => v > 0 ? 1 : v < 0 ? -1 : 0;

class Preview3D {
	constructor(canvas, ed) {
		this.cv = canvas; this.ctx = canvas.getContext('2d', { alpha: false });
		this.ed = ed; this.ver = -1; this.sim = null;
		this.resize();
	}
	resize() {
		const r = this.cv.getBoundingClientRect();
		this.dpr = window.devicePixelRatio || 1;
		this.w = Math.max(50, Math.floor(r.width)); this.h = Math.max(50, Math.floor(r.height));
		this.cv.width = Math.floor(this.w * this.dpr); this.cv.height = Math.floor(this.h * this.dpr);
	}
	secAt(t) { return this.ed.timing.tickToSec(t); }
	tickAtSec(s) { return this.ed.timing.secToTick(s); }

	// ------------------------------------------------------------ chart -> engine events
	_prep() {
		const ed = this.ed, ch = ed.chart;
		if (this.ver === ed.version && this.timingRef === ed.timing) return;
		this.ver = ed.version; this.timingRef = ed.timing;
		this.sm = new K.ScrollMap(ch);
		const ev = [];
		ch.tilt.forEach(p => ev.push({ sec: this.secAt(p.t), o: 0, kind: 'tilt', p }));
		ch.laser.forEach((lane, li) => lane.forEach(s => {
			const last = s.pts.length - 1;
			s.pts.forEach((p, i) => {
				if (p.v === p.vf) return;
				// positions as USC stores them (wide lasers in the extended -0.5..1.5 range)
				const a = K.laserPos(p.v, s.wide), b = K.laserPos(p.vf, s.wide);
				ev.push({ sec: this.secAt(s.t + p.ry), o: 1, kind: 'slam', lane: li, size: b - a, tail: b, end: i === last });
			});
			const lp = s.pts[last];
			if (lp.v === lp.vf && last > 0) ev.push({ sec: this.secAt(s.t + lp.ry), o: 2, kind: 'exit', lane: li });
		}));
		ev.sort((a, b) => a.sec - b.sec || a.o - b.o);
		this.ev = ev;
		this.spinsSec = ch.spins.map(s => ({ ...s, sec: this.secAt(s.t), beat: 60 / ed.timing.bpmAt(s.t) })).sort((a, b) => a.sec - b.sec);
		// BPM covering most of the chart: the base for mod speed
		const end = Math.max(ed.chartEndTick ? ed.chartEndTick() : 0, 960);
		const dur = new Map();
		ch.bpm.forEach((b, i) => {
			const t0 = i ? b.t : 0, t1 = i + 1 < ch.bpm.length ? ch.bpm[i + 1].t : Math.max(end, t0);
			const d = Math.max(0, this.secAt(Math.min(t1, end)) - this.secAt(Math.min(t0, end)));
			dur.set(b.v, (dur.get(b.v) || 0) + d);
		});
		let best = ch.bpm.length ? ch.bpm[0].v : 120, bd = -1;
		for (const [v, d] of dur) if (d > bd) { bd = d; best = v; }
		this.baseBpm = best;
		this.sim = null;
	}
	// Scoring::GetLaserRollOutput: current laser position, or an upcoming laser within 2 beats
	_laserOut(lane, tick) {
		const arr = this.ed.chart.laser[lane];
		const i = K.upperBound(arr, tick) - 1;
		const out = (raw) => lane === 0 ? -raw : 1 - raw;
		if (i >= 0) {
			const s = arr[i], lp = s.pts[s.pts.length - 1];
			if (tick < s.t + lp.ry) { const v = K.laserValueAt(s, Math.floor(tick)); if (v !== null) return out(K.laserPos(v, s.wide)); }
		}
		const nx = arr[i + 1];
		if (nx && nx.t - tick <= 480) return out(K.laserPos(nx.pts[0].v, nx.wide));
		return 0;
	}
	_freshSim(sec) {
		const st = { sec, crit: 0, roll: 0, intensity: PV.MAX_ROLL, oldIntensity: PV.MAX_ROLL, manual: false, toggled: false, keep: false, keepTarget: 0,
			ignore: [0, 0], slamRoll: [0, 0], shake: 0, shakeAdd: 0, guard: 0, ei: 0 };
		const ch = this.ed.chart, tick = this.tickAtSec(sec);
		const tp = K.lastAtOrBefore(ch.tilt, tick);
		if (tp) { this._applyTilt(st, tp); st.oldIntensity = st.intensity; st.toggled = false; }
		const ev = this.ev; let lo = 0, hi = ev.length;
		while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].sec <= sec) lo = m + 1; else hi = m; }
		st.ei = lo;
		return st;
	}
	_applyTilt(st, p) { // Game::OnEventChanged(TrackRollBehaviour)
		const v = p.vf !== undefined ? p.vf : p.v;
		let manual = false, lvl = 1, keep = false;
		if (typeof v === 'number') manual = true;
		else { keep = v.startsWith('keep_'); const b = keep ? v.slice(5) : v; lvl = { zero: 0, normal: 1, bigger: 2, biggest: 3 }[b] ?? 1; }
		st.keep = keep && !manual;
		if (manual !== st.manual) st.toggled = true;
		st.manual = manual;
		const inten = manual ? st.intensity : lvl === 0 ? 0 : PV.MAX_ROLL * (1 + 0.75 * (lvl - 1));
		st.oldIntensity = st.intensity; st.intensity = inten;
	}
	// One frame of Game::Tick (camera part) + Camera::Tick
	_step(st, sec, dt) {
		const ev = this.ev;
		while (st.ei < ev.length && ev[st.ei].sec <= sec) {
			const e = ev[st.ei++];
			if (e.kind === 'tilt') this._applyTilt(st, e.p);
			else if (e.kind === 'slam') {
				if (st.guard <= 0) st.shakeAdd = -e.size;
				if (e.end) { st.slamRoll[e.lane] = e.lane === 0 ? -e.tail : 1 - e.tail; st.ignore[e.lane] = PV.ROLL_IGNORE + PV.SLAM_DUR; }
			} else st.ignore[e.lane] = PV.ROLL_IGNORE;
		}
		const tick = this.tickAtSec(sec), MR = PV.MAX_ROLL;
		const live = [0, 1].map(l => st.ignore[l] <= 0 ? this._laserOut(l, tick) : null);
		const rL1 = live[0] ?? st.slamRoll[0], rR1 = live[1] ?? st.slamRoll[1];
		const slowTilt = (rL1 === -1 && rR1 === 1) || (rL1 === 0 && rR1 === 0);
		const target = (live[0] ?? 0) + (live[1] ?? 0);
		// SetTargetRoll
		const critTarget = K.clamp(target + st.slamRoll[0] + st.slamRoll[1], -1, 1) * MR;
		const keepT = K.clamp(target, -1, 1);
		if (!st.keep || st.keepTarget === 0 || (sgn(st.keepTarget) === sgn(keepT) && Math.abs(st.keepTarget) < Math.abs(keepT))) st.keepTarget = keepT;
		// Camera::Tick
		const lerpTo = (v, tg, speed) => { const c = dt * speed; return tg < v ? Math.max(v - c, tg) : Math.min(v + c, tg); };
		let speed = MR * 4;
		if (slowTilt) speed /= Math.abs(st.crit) > MR * 0.1 ? 4 : 8;
		st.crit = lerpTo(st.crit, critTarget, speed);
		let actual = 0, instant = false;
		if (st.manual) {
			const ch = this.ed.chart;
			actual = -K.graphValueAt(ch.tilt, tick, 0) * MR;
			const lp = K.lastAtOrBefore(ch.tilt, tick);
			instant = !!(lp && lp.vf !== undefined && typeof lp.vf === 'number');
		} else if (st.keep) actual = st.keepTarget * st.intensity;
		else actual = (st.crit / MR) * st.intensity;
		if (instant) st.roll = actual;
		else {
			speed = MR * 4 * Math.max(st.intensity, st.oldIntensity) / MR;
			if (speed === 0 || st.manual || st.toggled) speed = MR * 4 * 2.5;
			if (st.manual || st.toggled) { const d = Math.abs(st.roll - actual) - MR; if (d > 0) speed *= 1 + d * 360 / 2.5; }
			st.roll = lerpTo(st.roll, actual, speed);
		}
		if (st.toggled) st.toggled = st.roll !== actual;
		for (let i = 0; i < 2; i++) { st.ignore[i] -= dt; if (st.ignore[i] <= PV.ROLL_IGNORE) st.slamRoll[i] = 0; }
		if (st.shakeAdd !== 0) { st.shake += st.shakeAdd; st.shakeAdd = 0; st.guard = 1 / 60; }
		else if (st.shake !== 0) st.shake = Math.max(Math.abs(st.shake) - 0.2 * dt * 60, 0) * sgn(st.shake);
		st.guard -= dt;
		st.sec = sec;
	}
	_simTo(sec, continuous) {
		this._prep();
		let st = this.sim;
		if (!continuous || !st || sec < st.sec - 1e-9 || sec - st.sec > 1) st = this._freshSim(sec - 2.5);
		const h = 1 / 240;
		while (st.sec + h < sec) this._step(st, st.sec + h, h);
		if (sec > st.sec) this._step(st, sec, sec - st.sec);
		this.sim = st;
		return st;
	}
	// camera parameters at a tick
	cameraAt(nowTick, continuous) {
		this._prep();
		const ch = this.ed.chart, sec = this.secAt(nowTick);
		const g = (k) => K.graphValueAt(ch.cam[k], nowTick, 0);
		const ver = parseInt(ch.meta.ver, 10) || 0;
		const st = this._simTo(sec, continuous);
		const cam = {
			zoom: g('zoom_bottom') / 100, pitchIn: g('zoom_top') / 100, offset: g('zoom_side') / 100, split: g('center_split') / 100,
			rot: g('rotation_deg'), pitchUnit: ver >= 168 ? 15 : 7, roll: st.roll, shake: st.shake, spinRoll: 0, bounce: 0,
		};
		// the latest spin of any kind wins (one spin state in USC)
		const sp = this.spinsSec; let lo = 0, hi = sp.length;
		while (lo < hi) { const m = (lo + hi) >> 1; if (sp[m].sec <= sec) lo = m + 1; else hi = m; }
		const s = sp[lo - 1];
		if (s) {
			const isSwing = s.kind === 'swing';
			const dur = (isSwing ? 0.5 : 1) * (s.l / 5 / 192) * s.beat * 4;
			const prog = (sec - s.sec) / dur;
			if (prog < 2) {
				if (s.kind === 'spin') {
					const t = prog / 2, TS = 0.375, TR = 0.375;
					if (t <= TS) cam.spinRoll = -s.dir * (TS - t) / TS;
					else if (t < TS + TR) cam.spinRoll = uscSwing((t - TS) / TR) * 0.25 * s.dir;
				} else if (s.kind === 'half') cam.spinRoll = uscSwing(prog / 2) * s.dir;
				else cam.bounce = dampedSin(prog / 2, (s.amp || 0) / 250, (s.rep || 0) / 2, 3.0) * s.dir;
			}
		}
		return cam;
	}
	hiSpeed() {
		const S = this.ed.settings;
		if (S.speedMode === 'hs') return Math.max(0.1, S.hiSpeed || 1);
		return Math.max(0.1, (S.modSpeed || 700) / (this.baseBpm || 120));
	}

	// ------------------------------------------------------------ drawing
	draw(nowTick, continuous) {
		const ed = this.ed, ch = ed.chart, c = this.ctx, S = ed.settings;
		const cam = this.cameraAt(nowTick, continuous);
		const W = this.w, H = this.h, BW = PV.BTN_W, TL = PV.TRACK_LEN;
		// USC's camera is tuned for a 9:16 portrait screen: fit that box to the pane, and let the
		// picture continue past it when the pane is taller or wider (no letterboxing).
		// In a narrow pane the box may overhang the sides a little (the track itself spans ~81% of it).
		const vw = Math.min(H * 9 / 16, W / 0.86), vh = vw * 16 / 9;
		const vx = (W - vw) / 2, vy = (H - vh) / 2;

		// ---- USC camera
		const lanePitch = uscPitchScale(cam.pitchIn) * cam.pitchUnit;
		const totalOffset = (cam.offset * (5 * 100) / (6 * 116)) / 2 + cam.bounce;
		const worldNormal = uscOrigin(lanePitch, totalOffset, (cam.spinRoll + cam.roll) * 360 - cam.rot); // rotation_deg has the same sign as tilt (KSM v2: rotation_deg 10 == tilt 1)
		const worldNoRoll = uscOrigin(lanePitch, 0, 0);
		const trackOrigin = uscZoomed(worldNormal, cam.zoom);
		const critOrigin = uscZoomed(uscOrigin(lanePitch, totalOffset, cam.roll * 360 + Math.sin(cam.spinRoll * Math.PI * 2) * 20 - cam.rot), cam.zoom);
		const cp = M4.pos(worldNoRoll), cl = Math.hypot(cp[0], cp[1], cp[2]);
		const rotToCrit = -Math.atan2(cp[1] / cl, -cp[2] / cl) * 180 / Math.PI;
		const camPitch = rotToCrit - (PV.FOV / 2 - PV.FOV * PV.PITCH_OFFSET);
		const view = M4.rot(camPitch, cam.shake, 0);
		const fy = 1 / Math.tan(PV.FOV / 2 * Math.PI / 180), fx = fy / (vw / vh);
		const mT = M4.mul(view, trackOrigin), mC = M4.mul(view, critOrigin);
		const NEAR = 0.05;
		const V = (m, x, y) => [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13], m[2] * x + m[6] * y + m[14]];
		const S2 = (v) => [vx + (v[0] * fx / -v[2] * 0.5 + 0.5) * vw, vy + (0.5 - v[1] * fy / -v[2] * 0.5) * vh];
		const P = (m, x, y) => { const v = V(m, x, y); return v[2] > -NEAR ? null : S2(v); }; // track plane point -> screen
		const clipNear = (vs) => { // Sutherland-Hodgman against z = -NEAR (keeps z <= -NEAR)
			const out = [];
			for (let i = 0; i < vs.length; i++) {
				const a = vs[i], b = vs[(i + 1) % vs.length], ia = a[2] <= -NEAR, ib = b[2] <= -NEAR;
				if (ia) out.push(a);
				if (ia !== ib) { const t = (-NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, -NEAR]); }
			}
			return out;
		};

		c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		const far = P(mT, 0, TL * 1.2) || [vx + vw / 2, vy + vh * 0.3];
		const bg = c.createRadialGradient(far[0], far[1], 2, far[0], far[1], Math.max(W, H) * 0.8);
		bg.addColorStop(0, '#3b2260'); bg.addColorStop(0.25, '#1a1030'); bg.addColorStop(0.6, '#08060f'); bg.addColorStop(1, '#020205');
		c.fillStyle = bg; c.fillRect(0, 0, W, H);

		// ---- timing
		this._prep();
		const sm = this.sm;
		const drawSec = this.secAt(nowTick) - (S.drawOffsetMs || 0) / 1000;
		const drawTick = this.tickAtSec(drawSec);
		const bpm = ed.timing.bpmAt(Math.max(0, nowTick));
		const hs = this.hiSpeed();
		const viewRange = 8 / hs;
		const vNow = sm.at(drawTick);
		const yOf = (t) => (sm.at(t) - vNow) / viewRange * TL;
		const split = cam.split * 0.5 * BW;
		const sideX = (x) => x < -1e-6 ? x - split : x > 1e-6 ? x + split : x;

		// filled polygon given in track-plane coordinates [[x, y], ...]
		const poly = (m, pts, fill) => {
			const vs = clipNear(pts.map(p => V(m, p[0], p[1])));
			if (vs.length < 3) return;
			c.fillStyle = fill; c.beginPath();
			vs.forEach((v, i) => { const q = S2(v); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); });
			c.closePath(); c.fill();
		};
		const quad = (m, x0, x1, y0, y1, fill) => {
			y0 = Math.max(y0, -1); y1 = Math.min(y1, TL);
			if (y1 <= y0) return;
			poly(m, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], fill);
		};
		const line = (m, x0, y0, x1, y1, col, w) => {
			let a = V(m, x0, y0), b = V(m, x1, y1);
			const ia = a[2] <= -NEAR, ib = b[2] <= -NEAR;
			if (!ia && !ib) return;
			if (ia !== ib) { const t = (-NEAR - a[2]) / (b[2] - a[2]), q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, -NEAR]; if (ia) b = q; else a = q; }
			const p = S2(a), q = S2(b);
			c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke();
		};
		c.save();

		// ---- track (EG look: near-black translucent deck, white lane lines, neon edge rails)
		for (const side of [-1, 1]) {
			const dx = side * split;
			const x0 = side < 0 ? -0.5 : 0, x1 = side < 0 ? 0 : 0.5;
			quad(mT, x0 + dx, x1 + dx, -1, TL, 'rgba(3,3,8,0.84)');
			quad(mT, (side < 0 ? -0.5 : 0.5 - BW) + dx, (side < 0 ? -0.5 + BW : 0.5) + dx, -1, TL, side < 0 ? 'rgba(20,110,200,0.22)' : 'rgba(200,20,120,0.22)');
		}
		for (let i = 1; i <= 5; i++) { const x = sideX(-0.5 + i * BW); line(mT, x, -1, x, TL, i === 1 || i === 5 ? 'rgba(225,235,255,0.62)' : 'rgba(200,210,235,0.42)', i === 3 ? 1.3 : 1.1); }
		for (const [x, col, glow] of [[-0.5 - split, '#7fdcff', 'rgba(40,180,255,0.30)'], [0.5 + split, '#ff8fcf', 'rgba(255,40,160,0.30)']]) {
			line(mT, x, -1, x, TL, glow, 8);
			line(mT, x, -1, x, TL, col, 2.2);
		}

		// ---- bar lines
		let tEnd = drawTick;
		for (let k = 0; k < 2000 && yOf(tEnd) < TL; k++) tEnd += 60;
		const tStart = drawTick - 480;
		let ms = ed.timing.measureOf(Math.max(0, tStart));
		for (let k = 0; k < 256 && ms.start <= tEnd; k++) {
			const y = yOf(ms.start);
			if (y >= 0 && y <= TL) { line(mT, sideX(-0.5 + BW), y, -split, y, 'rgba(255,255,255,0.28)', 1); line(mT, split, y, sideX(0.5 - BW), y, 'rgba(255,255,255,0.28)', 1); }
			ms = ed.timing.measureOf(ms.start + ms.len);
		}
		const range = (arr) => { let i0 = K.lowerBound(arr, tStart); while (i0 > 0 && arr[i0 - 1].t + (arr[i0 - 1].l || 0) > tStart) i0--; return [i0, K.upperBound(arr, tEnd)]; };
		const playing = ed.playing;
		const chipLen = (y) => 0.125 * (1 + K.clamp(y / TL, 0, 1)); // USC: 48/64 texture ratio x 1/6, distantButtonScale = 2
		const fxX = (lane) => -2 * BW + lane * 2 * BW + (lane ? split : -split);
		const btX = (lane) => -2 * BW + lane * BW + (lane < 2 ? -split : split);

		// ---- holds (FX under BT)
		for (let lane = 0; lane < 2; lane++) {
			const a = ch.fx[lane], [i0, i1] = range(a), x0 = fxX(lane);
			for (let i = i0; i < i1; i++) {
				const n = a[i]; if (n.l <= 0) continue;
				const on = playing && nowTick >= n.t && nowTick <= n.t + n.l;
				quad(mT, x0 + 0.01, x0 + 2 * BW - 0.01, Math.max(0, yOf(n.t)), yOf(n.t + n.l), on ? 'rgba(255,205,110,0.92)' : 'rgba(255,150,30,0.78)');
			}
		}
		for (let lane = 0; lane < 4; lane++) {
			const a = ch.bt[lane], [i0, i1] = range(a), x0 = btX(lane);
			for (let i = i0; i < i1; i++) {
				const n = a[i]; if (n.l <= 0) continue;
				const on = playing && nowTick >= n.t && nowTick <= n.t + n.l;
				quad(mT, x0 + 0.022, x0 + BW - 0.022, Math.max(0, yOf(n.t)), yOf(n.t + n.l), on ? 'rgba(255,255,255,0.95)' : 'rgba(215,228,255,0.72)');
			}
		}
		// ---- chips
		for (let lane = 0; lane < 2; lane++) {
			const a = ch.fx[lane], [i0, i1] = range(a), x0 = fxX(lane);
			for (let i = i0; i < i1; i++) {
				const n = a[i]; if (n.l !== 0 || n.t < drawTick - 2) continue;
				const y = yOf(n.t), L = chipLen(y);
				quad(mT, x0 + 0.006, x0 + 2 * BW - 0.006, y, y + L, '#ff8c10');
				quad(mT, x0 + 0.03, x0 + 2 * BW - 0.03, y + L * 0.25, y + L * 0.75, '#ffc060');
			}
		}
		for (let lane = 0; lane < 4; lane++) {
			const a = ch.bt[lane], [i0, i1] = range(a), x0 = btX(lane);
			for (let i = i0; i < i1; i++) {
				const n = a[i]; if (n.l !== 0 || n.t < drawTick - 2) continue;
				const y = yOf(n.t), L = chipLen(y);
				quad(mT, x0 + 0.008, x0 + BW - 0.008, y, y + L, '#ffffff');
				quad(mT, x0 + 0.03, x0 + BW - 0.03, y + L * 0.25, y + L * 0.75, '#d4e2ff');
			}
		}

		// ---- lasers (USC: x = (pos - 0.5) * (trackWidth - laserWidth), width = 1/6)
		// USC/SDVX: a slam bar is as long as the lane scrolls in 50 ms, so it gets thicker with speed
		const LW = BW, lx = (pos) => (pos - 0.5) * (1 - LW);
		const slamLen = (t) => Math.max(LW * 0.5, yOf(this.tickAtSec(this.secAt(t) + PV.SLAM_SEC)) - yOf(t));
		const lcol = ['rgba(40,170,255,0.62)', 'rgba(255,50,160,0.62)'], lslam = ['rgba(50,180,255,0.75)', 'rgba(255,60,170,0.75)'];
		const cursors = [];
		c.globalCompositeOperation = 'lighter';
		for (let lane = 0; lane < 2; lane++) {
			const arr = ch.laser[lane];
			for (let i = K.upperBound(arr, tEnd) - 1; i >= 0; i--) {
				const s = arr[i], end = K.sectionEndTick(s);
				if (end < drawTick - 60) { if (s.t + 960 * 64 < tStart) break; continue; }
				const pts = s.pts;
				for (let k = 0; k < pts.length; k++) {
					const p = pts[k], q = pts[k + 1], t = s.t + p.ry, slam = p.v !== p.vf;
					const SLAM_H = slam ? slamLen(t) : 0;
					if (slam && yOf(t) + SLAM_H > 0) { // slam: horizontal bar
						const y = yOf(t), xa = lx(K.laserPos(p.v, s.wide)), xb = lx(K.laserPos(p.vf, s.wide));
						quad(mT, Math.min(xa, xb) - LW / 2, Math.max(xa, xb) + LW / 2, Math.max(0, y), y + SLAM_H, lslam[lane]);
					}
					if (!q) { // short tail after a final slam
						if (slam) { const y = yOf(t) + SLAM_H, x = lx(K.laserPos(p.vf, s.wide)); quad(mT, x - LW / 2, x + LW / 2, Math.max(0, y), y + SLAM_H * 0.6, lcol[lane]); }
						continue;
					}
					const tq = s.t + q.ry;
					if (tq < drawTick || t > tEnd) continue;
					const N = K.isLinear(p) ? 1 : 24;
					for (let j = 0; j < N; j++) {
						const fa = j / N, fb = (j + 1) / N;
						const ta = t + (tq - t) * fa, tb = t + (tq - t) * fb;
						if (tb < drawTick) continue;
						const va = p.vf + (q.v - p.vf) * K.evalCurve(p.a, p.b, fa), vb = p.vf + (q.v - p.vf) * K.evalCurve(p.a, p.b, fb);
						let ya = yOf(ta) + (j === 0 && slam ? SLAM_H : 0), yb = yOf(tb);
						let xa = lx(K.laserPos(va, s.wide)), xb = lx(K.laserPos(vb, s.wide));
						if (yb <= ya) continue;
						if (ya < 0) { const f = -ya / (yb - ya); xa += (xb - xa) * f; ya = 0; }
						if (yb > TL) { const f = (TL - ya) / (yb - ya); xb = xa + (xb - xa) * f; yb = TL; }
						if (yb <= ya) continue;
						poly(mT, [[xa - LW / 2, ya], [xa + LW / 2, ya], [xb + LW / 2, yb], [xb - LW / 2, yb]], lcol[lane]);
					}
				}
				if (nowTick >= s.t && nowTick <= end) { const v = K.laserValueAt(s, Math.floor(nowTick)); if (v !== null) cursors.push([lane, lx(K.laserPos(v, s.wide))]); }
			}
		}
		c.globalCompositeOperation = 'source-over';
		// far fade
		const fa = P(mT, 0, TL * 0.72), fb = P(mT, 0, TL);
		if (fa && fb) {
			const gr = c.createLinearGradient(fa[0], fa[1], fb[0], fb[1]);
			gr.addColorStop(0, 'rgba(20,12,36,0)'); gr.addColorStop(1, 'rgba(28,18,50,0.85)');
			poly(mT, [[-0.5 - split - 0.02, TL * 0.72], [0.5 + split + 0.02, TL * 0.72], [0.5 + split + 0.02, TL], [-0.5 - split - 0.02, TL]], gr);
		}

		// ---- judgment line + laser cursors (crit transform)
		line(mC, -0.52, 0, 0.52, 0, 'rgba(90,190,255,0.45)', 10);
		line(mC, -0.52, 0, 0.52, 0, '#ffffff', 3);
		for (const [lane, x] of cursors) {
			poly(mC, [[x, 0.01], [x - 0.055, -0.11], [x + 0.055, -0.11]], lane ? '#ff4aa0' : '#3ab4ff');
			c.strokeStyle = '#fff'; c.lineWidth = 1; c.stroke();
		}
		c.restore();

		// ---- HUD
		const hx = Math.max(vx, 0) + 6, hy = Math.max(vy, 0) + 6;
		c.font = '11px ' + UI_FONT; c.textBaseline = 'top'; c.fillStyle = 'rgba(220,220,235,0.85)';
		c.fillText('BPM ' + K.fmtNum(bpm) + '   LANE-SPEED ' + (hs * bpm / 100).toFixed(2) + '   HS ' + hs.toFixed(2), hx, hy);
		const hud = [];
		if (cam.pitchIn) hud.push('top ' + Math.round(cam.pitchIn * 100));
		if (cam.zoom) hud.push('btm ' + Math.round(cam.zoom * 100));
		if (cam.offset) hud.push('side ' + Math.round(cam.offset * 100));
		if (cam.rot) hud.push('rot ' + Math.round(cam.rot) + '°');
		if (cam.split) hud.push('split ' + Math.round(cam.split * 100));
		hud.push('tilt ' + (-cam.roll * 360).toFixed(1) + '°');
		c.fillStyle = 'rgba(170,170,190,0.75)';
		c.fillText(hud.join('  '), hx, hy + 14);
		if (S.drawOffsetMs) c.fillText('DRAW ' + (S.drawOffsetMs > 0 ? '+' : '') + S.drawOffsetMs + ' ms', hx, hy + 28);
	}

	// Engine tilt over the whole chart in KSH units (1 = 10 deg), sampled at 120 Hz of song time; cached per edit.
	tiltTrack() {
		this._prep();
		if (this._tt && this._tt.ver === this.ver) return this._tt;
		const RATE = 120, ed = this.ed;
		const endT = Math.max(960, (ed.chartEndTick ? ed.chartEndTick() : 0) + 960);
		const s0 = this.secAt(0) - 1, s1 = this.secAt(endT);
		const n = Math.max(2, Math.ceil((s1 - s0) * RATE) + 1), v = new Float32Array(n);
		const st = this._freshSim(s0 - 1.5);
		const h = 1 / RATE;
		while (st.sec + h <= s0) this._step(st, st.sec + h, h);
		for (let k = 0; k < n; k++) { const target = s0 + k * h; if (target > st.sec) this._step(st, target, target - st.sec); v[k] = -st.roll / PV.MAX_ROLL; }
		this._tt = { ver: this.ver, s0, rate: RATE, v };
		return this._tt;
	}
	tiltAtTick(t) {
		const tt = this.tiltTrack(), x = (this.secAt(t) - tt.s0) * tt.rate, k = Math.floor(x);
		if (k < 0) return tt.v[0]; if (k + 1 >= tt.v.length) return tt.v[tt.v.length - 1];
		return tt.v[k] + (tt.v[k + 1] - tt.v[k]) * (x - k);
	}

	// Engine tilt in KSH units (1 = 10°, + = clockwise like KSH tilt) sampled from t0 to t1 every `step`
	// ticks; used for the dashed "auto" ghost in the Tilt column.
	tiltCurve(t0, t1, step) {
		this._prep();
		const out = [];
		const s0 = this.secAt(Math.max(0, t0));
		const st = this._freshSim(s0 - 2.5);
		const h = 1 / 120;
		for (let t = t0; t <= t1; t += step) {
			const target = this.secAt(t);
			while (st.sec + h < target) this._step(st, st.sec + h, h);
			if (target > st.sec) this._step(st, target, target - st.sec);
			out.push([t, -st.roll / PV.MAX_ROLL]);
		}
		return out;
	}
}
