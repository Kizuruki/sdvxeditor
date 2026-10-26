/* ============================================================================
 * Preview: perspective SDVX highway with camera effects applied.
 * This is an approximation of KSM's renderer for editing purposes:
 * zoom_top (pitch around judgment line), zoom_bottom (camera distance),
 * zoom_side (shift), center_split, rotation_deg, tilt (auto/manual), spins/swings,
 * scroll_speed and stops.
 * ========================================================================== */
class Preview3D {
	constructor(canvas, ed) {
		this.cv = canvas; this.ctx = canvas.getContext('2d', { alpha: false });
		this.ed = ed; this.ver = -1; this.sm = null;
		this.tiltCur = 0; this.lastFrame = 0;
		this.resize();
	}
	resize() {
		const r = this.cv.getBoundingClientRect();
		this.dpr = window.devicePixelRatio || 1;
		this.w = Math.max(50, Math.floor(r.width)); this.h = Math.max(50, Math.floor(r.height));
		this.cv.width = Math.floor(this.w * this.dpr); this.cv.height = Math.floor(this.h * this.dpr);
	}
	_camera(p) {
		// Camera fitted to a 9:16 (portrait, like SDVX) view anchored at the bottom of the pane:
		// judgment line spans 95% of the width at 86% height, horizon sits above the screen,
		// and the lane narrows to ~35% of its width at the base length (LEN_BASE).
		const W = this.w, H = this.h;
		const vw = Math.min(W, H * 9 / 16), vh = vw * 16 / 9, top = H - vh;
		const phi = 0.5, cph = Math.cos(phi), sph = Math.sin(phi);
		const camH0 = 11.6 * cph;                       // gives horizon at -17% of the view
		const dz = K.clamp(p.zb / 100, -3, 3) * 0.5;    // zoom_bottom: move camera forward
		const camH = camH0 - dz * sph, camD = -dz * cph;
		const tp = p.zt / 2400 * Math.PI * 2;            // zoom_top: rotate lane around the judgment line
		const ctp = Math.cos(tp), stp = Math.sin(tp);
		const zcN0 = camH0 * sph, ycN0 = -camH0 * cph;   // un-zoomed near point
		const F = vw * 0.95 * zcN0 / 6;
		const cy = top + vh * 0.86 + F * ycN0 / zcN0;
		const cx = W / 2 + p.side * F / zcN0;
		const proj = (x, z) => {
			const Y = z * stp - camH, Z = z * ctp + camD;
			const yc = Y * cph + Z * sph, zc = -Y * sph + Z * cph;
			if (zc < 0.15) return null;
			return [cx + F * x / zc, cy - F * yc / zc, F / zc];
		};
		const base = 1.86 * zcN0 / cph;                  // depth where the lane is 35% wide
		let len = base;
		for (; len < base * 3; len += 0.5) { const q = proj(0, len); if (!q || q[1] < H * 0.07) break; }
		return { proj, len, base };
	}
	draw(nowTick) {
		const ed = this.ed, ch = ed.chart, c = this.ctx, W = this.w, H = this.h;
		const now = performance.now(), dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0.016;
		this.lastFrame = now;
		if (this.ver !== ed.version) { this.sm = new K.ScrollMap(ch); this.ver = ed.version; }
		const sm = this.sm;
		const vNow = sm.at(nowTick);
		const beats = ed.settings.previewBeats;

		// camera parameters at the current tick
		const g = (k) => K.graphValueAt(ch.cam[k], nowTick, 0);
		const cam = { zt: g('zoom_top'), zb: g('zoom_bottom'), side: g('zoom_side') * 0.015, split: g('center_split') / 100, rot: g('rotation_deg') };
		const { proj, len, base } = this._camera(cam);
		const zOf = (t) => (sm.at(t) - vNow) / beats * base;

		// roll: rotation_deg + tilt + spins
		let roll = cam.rot, sway = 0, spin = 0;
		roll += this._tilt(nowTick, dt);
		for (const s of ch.spins) {
			if (nowTick < s.t || nowTick > s.t + s.l || s.l <= 0) continue;
			const p = (nowTick - s.t) / s.l;
			if (s.kind === 'spin') spin += s.dir * 360 * (1 - Math.pow(1 - p, 2.2));
			else if (s.kind === 'half') spin += s.dir * 120 * Math.sin(Math.PI * p) * (1 - p * 0.5);
			else {
				const decay = s.dec === 0 ? 1 : s.dec === 1 ? 1 - p : (1 - p) * (1 - p);
				const osc = Math.sin(Math.PI * s.rep * p) * decay;
				roll += s.dir * (s.amp / 250) * 10 * osc; sway += s.dir * (s.amp / 250) * 0.6 * osc;
			}
		}

		c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		const bg = c.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#07070c'); bg.addColorStop(1, '#141024');
		c.fillStyle = bg; c.fillRect(0, 0, W, H);
		const pv = proj(0, 0);
		if (!pv) return;
		c.save();
		if (spin) { // spins turn the whole lane around its middle
			const mid = proj(0, base * 0.3) || pv;
			c.translate(mid[0], mid[1]); c.rotate(spin * Math.PI / 180); c.translate(-mid[0], -mid[1]);
		}
		c.translate(pv[0], pv[1]); c.rotate(roll * Math.PI / 180); c.translate(-pv[0], -pv[1]);
		const sp = cam.split / 2;
		const X = (x) => x + sway + (x < -1e-6 ? -sp : x > 1e-6 ? sp : 0);
		const quad = (xa, xb, za, zb2, fill) => {
			za = Math.max(za, -0.4); zb2 = Math.min(zb2, len);
			if (zb2 <= za) return;
			const p1 = proj(X(xa), za), p2 = proj(X(xb), za), p3 = proj(X(xb), zb2), p4 = proj(X(xa), zb2);
			if (!p1 || !p2 || !p3 || !p4) return;
			c.fillStyle = fill; c.beginPath(); c.moveTo(p1[0], p1[1]); c.lineTo(p2[0], p2[1]); c.lineTo(p3[0], p3[1]); c.lineTo(p4[0], p4[1]); c.closePath(); c.fill();
		};
		// track
		quad(-3, -2, -0.4, len, '#0d1a2a'); quad(2, 3, -0.4, len, '#2a0d1c');
		quad(-2, 2, -0.4, len, '#17171e');
		c.strokeStyle = '#34343f'; c.lineWidth = 1; c.beginPath();
		for (const x of [-3, -2, -1, 0, 1, 2, 3]) { const a = proj(X(x), -0.4), b = proj(X(x), len); if (a && b) { c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); } }
		c.stroke();
		// visible tick range
		let tEnd = nowTick;
		for (let k = 0; k < 256; k++) { tEnd += 240; if (zOf(tEnd) > len) break; }
		const tStart = nowTick - 480;
		// bar lines
		let ms = ed.timing.measureOf(Math.max(0, tStart));
		c.strokeStyle = 'rgba(255,255,255,0.18)'; c.beginPath();
		for (let k = 0; k < 64 && ms.start <= tEnd; k++) {
			const z = zOf(ms.start);
			if (z >= 0 && z <= len) { const a = proj(X(-2), z), b = proj(X(2), z); if (a && b) { c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); } }
			ms = ed.timing.measureOf(ms.start + ms.len);
		}
		c.stroke();
		const range = (arr) => { let i0 = K.lowerBound(arr, tStart); while (i0 > 0 && arr[i0 - 1].t + (arr[i0 - 1].l || 0) > tStart) i0--; return [i0, K.upperBound(arr, tEnd)]; };
		// holds
		for (let lane = 0; lane < 2; lane++) { const a = ch.fx[lane], [i0, i1] = range(a); for (let i = i0; i < i1; i++) { const n = a[i]; if (n.l > 0) quad(-2 + lane * 2 + 0.06, lane * 2 - 0.06, zOf(n.t), zOf(n.t + n.l), nowTick >= n.t && nowTick <= n.t + n.l && ed.playing ? 'rgba(255,190,90,0.75)' : 'rgba(255,140,20,0.55)'); } }
		for (let lane = 0; lane < 4; lane++) { const a = ch.bt[lane], [i0, i1] = range(a); for (let i = i0; i < i1; i++) { const n = a[i]; if (n.l > 0) quad(-2 + lane + 0.12, -1 + lane - 0.12, zOf(n.t), zOf(n.t + n.l), nowTick >= n.t && nowTick <= n.t + n.l && ed.playing ? 'rgba(255,255,255,0.85)' : 'rgba(230,230,235,0.6)'); } }
		// chips (fixed thickness in beats)
		const chipZ = 0.14;
		for (let lane = 0; lane < 2; lane++) { const a = ch.fx[lane], [i0, i1] = range(a); for (let i = i0; i < i1; i++) { const n = a[i]; if (n.l === 0 && n.t >= nowTick - 10) { const z = zOf(n.t); quad(-2 + lane * 2 + 0.04, lane * 2 - 0.04, z, z + chipZ * 1.2, '#ff9a1f'); } } }
		for (let lane = 0; lane < 4; lane++) { const a = ch.bt[lane], [i0, i1] = range(a); for (let i = i0; i < i1; i++) { const n = a[i]; if (n.l === 0 && n.t >= nowTick - 10) { const z = zOf(n.t); quad(-2 + lane + 0.06, -1 + lane - 0.06, z, z + chipZ, '#f6f6f8'); } } }
		// lasers
		const lcol = [['rgba(47,184,255,0.62)', '#9fe3ff'], ['rgba(255,61,154,0.62)', '#ffb0d4']];
		const cursors = [];
		for (let lane = 0; lane < 2; lane++) {
			const arr = ch.laser[lane];
			for (let i = K.upperBound(arr, tEnd) - 1; i >= 0; i--) {
				const s = arr[i]; const end = K.sectionEndTick(s);
				if (end < tStart) { if (s.t + 960 * 32 < tStart) break; continue; }
				const xOf = (v) => (K.laserPos(v, s.wide) - 0.5) * 5;
				const pts = s.pts;
				for (let k = 0; k < pts.length; k++) {
					const p = pts[k], q = pts[k + 1], t = s.t + p.ry;
					if (p.v !== p.vf) { const z = zOf(t), x0 = xOf(p.v), x1 = xOf(p.vf); quad(Math.min(x0, x1) - 0.5, Math.max(x0, x1) + 0.5, z, z + 0.22, lcol[lane][0]); }
					if (!q) continue;
					const tq = s.t + q.ry;
					if (tq < tStart || t > tEnd) continue;
					const N = K.isLinear(p) ? Math.max(1, Math.ceil((tq - t) / 120)) : 12;
					for (let j = 0; j < N; j++) {
						const ta = t + (tq - t) * j / N, tb = t + (tq - t) * (j + 1) / N;
						const va = p.vf + (q.v - p.vf) * K.evalCurve(p.a, p.b, j / N), vb = p.vf + (q.v - p.vf) * K.evalCurve(p.a, p.b, (j + 1) / N);
						const za = Math.max(-0.4, zOf(ta)), zb2 = Math.min(len, zOf(tb));
						if (zb2 <= za) continue;
						const xa = xOf(va), xb = xOf(vb);
						const p1 = proj(X(xa - 0.5), za), p2 = proj(X(xa + 0.5), za), p3 = proj(X(xb + 0.5), zb2), p4 = proj(X(xb - 0.5), zb2);
						if (!p1 || !p2 || !p3 || !p4) continue;
						c.fillStyle = lcol[lane][0]; c.beginPath(); c.moveTo(p1[0], p1[1]); c.lineTo(p2[0], p2[1]); c.lineTo(p3[0], p3[1]); c.lineTo(p4[0], p4[1]); c.closePath(); c.fill();
					}
				}
				if (nowTick >= s.t && nowTick <= end) { const v = K.laserValueAt(s, Math.round(nowTick)); if (v !== null) cursors.push([lane, xOf(v)]); }
			}
		}
		// judgment line + laser cursors
		const j1 = proj(X(-3), 0), j2 = proj(X(3), 0);
		if (j1 && j2) { c.strokeStyle = '#ffffff'; c.lineWidth = 3; c.beginPath(); c.moveTo(j1[0], j1[1]); c.lineTo(j2[0], j2[1]); c.stroke(); c.lineWidth = 1; }
		for (const [lane, x] of cursors) {
			const p = proj(X(x), 0); if (!p) continue;
			c.fillStyle = lane ? '#ff3d9a' : '#2fb8ff';
			c.beginPath(); c.moveTo(p[0], p[1] - 4); c.lineTo(p[0] - 9, p[1] + 12); c.lineTo(p[0] + 9, p[1] + 12); c.closePath(); c.fill();
		}
		c.restore();
		// far fade
		const fade = c.createLinearGradient(0, 0, 0, H * 0.35); fade.addColorStop(0, 'rgba(7,7,12,1)'); fade.addColorStop(1, 'rgba(7,7,12,0)');
		c.fillStyle = fade; c.fillRect(0, 0, W, H * 0.35);
		// HUD
		c.font = '11px ' + UI_FONT; c.fillStyle = '#8a8a96'; c.textBaseline = 'top';
		const hud = [];
		if (cam.zt) hud.push('top ' + Math.round(cam.zt)); if (cam.zb) hud.push('bottom ' + Math.round(cam.zb)); if (cam.side) hud.push('side ' + Math.round(cam.side / 0.015));
		if (cam.rot) hud.push('rot ' + Math.round(cam.rot) + '°'); if (cam.split) hud.push('split ' + Math.round(cam.split * 100));
		c.fillText(hud.join('  '), 6, 6);
		c.fillText('BPM ' + K.fmtNum(ed.timing.bpmAt(nowTick)), 6, H - 18);
	}
	_tilt(t, dt) {
		const ch = this.ed.chart;
		const tp = K.lastAtOrBefore(ch.tilt, t);
		let target = 0;
		const ver = parseInt(ch.meta.ver_compat || ch.meta.ver || '171', 10) || 0;
		const unit = ver < 170 && ch.tilt.some(p => typeof p.v === 'number' && Math.abs(p.v) >= 10) ? 14 : 10;
		const manual = tp && (typeof (tp.vf !== undefined ? tp.vf : tp.v) === 'number' || (typeof tp.v === 'number' && t > tp.t && tp.vf === undefined));
		if (manual) target = -K.graphValueAt(ch.tilt, t, 0) * unit;
		else {
			const type = tp ? (typeof tp.vf === 'string' ? tp.vf : tp.v) : 'normal';
			const scale = { normal: 1, bigger: 1.75, biggest: 2.5, keep_normal: 1, keep_bigger: 1.75, keep_biggest: 2.5, zero: 0 }[type] ?? 1;
			let l = null, r = null;
			for (let lane = 0; lane < 2; lane++) {
				const arr = ch.laser[lane], i = K.upperBound(arr, t) - 1;
				if (i < 0) continue;
				const s = arr[i]; if (t > K.sectionEndTick(s)) continue;
				const v = K.laserValueAt(s, Math.round(t)); if (v === null) continue;
				const pos = K.laserPos(v, s.wide);
				if (lane === 0) l = pos; else r = pos;
			}
			let input = 0;
			if (l !== null) input += l; if (r !== null) input += r - 1;
			target = -Math.max(-1, Math.min(1, input)) * 10 * scale;
		}
		const k = 1 - Math.exp(-dt * 12);
		this.tiltCur += (target - this.tiltCur) * k;
		return this.tiltCur;
	}
}
