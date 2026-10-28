// LootFlight — the slot-machine payout layer. Every scrap pickup launches the
// actual scrap piece (its own sprite, native world-layer size, still
// tumbling) out of the pickup point, then whips it into the HUD SCRAP
// counter; the counter only rolls up as pieces LAND, flashes on each arrival,
// and a gold "+N" tally builds beside it while the stream lasts. Arrivals
// ding up a pentatonic ladder (SfxSynth.coin). XP pickups send violet motes
// into the exp bar's fill edge.
//
// Screen space, drawn after the HUD. Single-view only (split-screen panes
// keep the plain HUD). Cosmetic: the real scrap is credited immediately — the
// HUD just displays `scrap - inFlightScrap` until the coins arrive.

const MAX_FLY = 120;
const MAX_SPARK = 160;
const GOLD = ['#7a4a10', '#c98a1c', '#ffd24a', '#fff3b0'];
const VIOLET = ['#3a1d5c', '#6a3fa0', '#915dbf', '#c9a6ec', '#ffffff'];

export class LootFlight {
    constructor(game, state) {
        this.game = game;
        this.state = state;
        this.synth = null;

        this.n = 0;
        this.x0 = new Float32Array(MAX_FLY); this.y0 = new Float32Array(MAX_FLY);
        this.cx = new Float32Array(MAX_FLY); this.cy = new Float32Array(MAX_FLY);
        this.t = new Float32Array(MAX_FLY); this.dur = new Float32Array(MAX_FLY);
        this.val = new Float32Array(MAX_FLY);
        this.kind = new Uint8Array(MAX_FLY);   // 0 = scrap coin, 1 = exp mote
        this.spin = new Float32Array(MAX_FLY);   // rotation (scrap) / phase
        this.spinV = new Float32Array(MAX_FLY);
        this.img = new Array(MAX_FLY).fill(null); // scrap sprite per flight

        this.kN = 0;
        this.kx = new Float32Array(MAX_SPARK); this.ky = new Float32Array(MAX_SPARK);
        this.kvx = new Float32Array(MAX_SPARK); this.kvy = new Float32Array(MAX_SPARK);
        this.kl = new Float32Array(MAX_SPARK); this.km = new Float32Array(MAX_SPARK);
        this.kc = new Uint8Array(MAX_SPARK);   // 0 gold, 1 violet

        // Achievement/unlock toast celebration (screen space, drawn above the
        // toast, self-clocked so it plays even while the sim is paused).
        this.confetti = [];
        this.toastStars = [];
        this._ovLast = 0;

        this.inFlightScrap = 0;
        this.scrapFlash = 0;
        this.tally = 0;
        this.tallyT = 99;
        this._ladder = 0;
        this._ladderT = 99;

    }

    _enabled() {
        const s = this.state;
        return !(s.localPlayers && s.localPlayers.length > 1) && !!s.hud;
    }

    _screen(wx, wy) {
        const cam = this.state.camera;
        return [wx * cam.wtsScale + cam.wtsOffX, wy * cam.wtsScale + cam.wtsOffY];
    }

    _spawn(kind, sx, sy, value, img = null, rot = 0) {
        if (this.n >= MAX_FLY) return false;
        const i = this.n++;
        const hs = this.state.hud._hudScale || 2;
        // Pop out in a random upward-ish direction before the pull takes over.
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
        const pop = (28 + Math.random() * 40) * hs;
        this.x0[i] = sx; this.y0[i] = sy;
        this.cx[i] = sx + Math.cos(a) * pop * 2;
        this.cy[i] = sy + Math.sin(a) * pop * 2;
        this.t[i] = -Math.random() * 0.06;
        this.dur[i] = 0.5 + Math.random() * 0.25;
        this.val[i] = value;
        this.kind[i] = kind;
        this.spin[i] = img ? rot : Math.random() * 10;
        this.spinV[i] = (Math.random() < 0.5 ? -1 : 1) * (9 + Math.random() * 8);
        this.img[i] = img;
        return true;
    }

    // `piece` = the collected Scrap entity (its sprite + current spin).
    spawnScrap(wx, wy, value, piece = null) {
        if (!this._enabled() || !(value > 0)) return;
        const img = piece && piece.img;
        if (!img) return;
        const [sx, sy] = this._screen(wx, wy);
        if (this._spawn(0, sx, sy, value, img, piece.rotation || 0)) this.inFlightScrap += value;
    }

    spawnExp(wx, wy) {
        if (!this._enabled()) return;
        const [sx, sy] = this._screen(wx, wy);
        this._spawn(1, sx, sy, 0);
    }

    _target(kind) {
        const hud = this.state.hud;
        if (kind === 0) return [hud.scrapAnchorX || this.game.width - 40, hud.scrapAnchorY || 20];
        return [hud.expAnchorX || this.game.width / 2, hud.expAnchorY || this.game.height - 20];
    }

    _burst(x, y, c, count) {
        const hs = this.state.hud._hudScale || 2;
        for (let k = 0; k < count && this.kN < MAX_SPARK; k++) {
            const i = this.kN++;
            const a = Math.random() * Math.PI * 2, sp = (40 + Math.random() * 90) * hs;
            this.kx[i] = x; this.ky[i] = y;
            this.kvx[i] = Math.cos(a) * sp; this.kvy[i] = Math.sin(a) * sp;
            this.kl[i] = this.km[i] = 0.18 + Math.random() * 0.2;
            this.kc[i] = c;
        }
    }

    update(dt) {
        this.scrapFlash = Math.max(0, this.scrapFlash - dt * 6);
        this.tallyT += dt;
        if (this.tallyT > 1.1) this.tally = 0;
        this._ladderT += dt;

        for (let i = this.n - 1; i >= 0; i--) {
            this.t[i] += dt;
            // Tumbles fast, spinning down as it lands.
            this.spin[i] += dt * this.spinV[i] * (1 - 0.7 * Math.min(1, Math.max(0, this.t[i]) / this.dur[i]));
            if (this.t[i] < this.dur[i]) continue;
            // Landed.
            const k = this.kind[i];
            const [tx, ty] = this._target(k);
            if (k === 0) {
                this.inFlightScrap = Math.max(0, this.inFlightScrap - this.val[i]);
                this.tally += this.val[i];
                this.tallyT = 0;
                this.scrapFlash = 1;
                if (this._ladderT > 0.35) this._ladder = 0;
                if (this.synth) this.synth.coin(this._ladder);
                this._ladder = Math.min(this._ladder + 1, 10);
                this._ladderT = 0;
                this._burst(tx, ty, 0, 5);
            } else {
                this._burst(tx, ty, 1, 4);
            }
            const j = --this.n;
            if (i !== j) {
                this.x0[i] = this.x0[j]; this.y0[i] = this.y0[j]; this.cx[i] = this.cx[j]; this.cy[i] = this.cy[j];
                this.t[i] = this.t[j]; this.dur[i] = this.dur[j]; this.val[i] = this.val[j];
                this.kind[i] = this.kind[j]; this.spin[i] = this.spin[j];
                this.spinV[i] = this.spinV[j]; this.img[i] = this.img[j];
            }
            this.img[j] = null;
        }
        for (let i = this.kN - 1; i >= 0; i--) {
            this.kl[i] -= dt;
            if (this.kl[i] <= 0) {
                const j = --this.kN;
                if (i !== j) {
                    this.kx[i] = this.kx[j]; this.ky[i] = this.ky[j]; this.kvx[i] = this.kvx[j]; this.kvy[i] = this.kvy[j];
                    this.kl[i] = this.kl[j]; this.km[i] = this.km[j]; this.kc[i] = this.kc[j];
                }
                continue;
            }
            const d = Math.exp(-6 * dt);
            this.kvx[i] *= d; this.kvy[i] *= d;
            this.kx[i] += this.kvx[i] * dt; this.ky[i] += this.kvy[i] * dt;
        }
    }

    // Position along the flight: quadratic bezier start → pop control →
    // target, eased so the coin hangs at the top of its pop, then whips in.
    _pos(i, u, tx, ty) {
        const e = u * u * (1.6 - 0.6 * u);
        const a = (1 - e) * (1 - e), b = 2 * (1 - e) * e, c = e * e;
        return [a * this.x0[i] + b * this.cx[i] + c * tx, a * this.y0[i] + b * this.cy[i] + c * ty];
    }

    // Burst from the achievement toast as it lands. Unlocks (new ship /
    // upgrade / combine) get double confetti in every rarity colour, a ring
    // of twinkles running round the card for its whole stay, and a chime.
    toastBurst(x, y, w, h, isUnlock) {
        const hs = (this.state.hud && this.state.hud._hudScale) || 2;
        const cols = isUnlock
            ? ['#ffd24a', '#ffffff', '#44ddff', '#c9a6ec', '#ff7a3a', '#44ff66']
            : ['#ffd24a', '#fff3b0', '#ffffff'];
        const n = isUnlock ? 70 : 34;
        for (let k = 0; k < n && this.confetti.length < 200; k++) {
            const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
            const sp = (60 + Math.random() * 120) * hs;
            this.confetti.push({
                x: x + Math.random() * w, y: y + Math.random() * h * 0.5,
                vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                life: 0.8 + Math.random() * 0.5, t: 0, c: cols[(Math.random() * cols.length) | 0],
                ph: Math.random() * 6.28, tall: Math.random() < 0.5
            });
        }
        if (isUnlock) {
            for (let k = 0; k < 14; k++) this.toastStars.push({ t: -k * 0.18, dur: 0.35, u: Math.random() });
            if (this.synth) this.synth.chime(0.2);
        }
    }

    drawOverlay(ctx) {
        if (!this.confetti.length && !this.toastStars.length) return;
        const now = performance.now();
        const dt = this._ovLast ? Math.min(0.05, (now - this._ovLast) / 1000) : 0.016;
        this._ovLast = now;
        const hs = Math.max(1, Math.round((this.state.hud && this.state.hud._hudScale) || 2));
        ctx.save();
        for (let i = this.confetti.length - 1; i >= 0; i--) {
            const c = this.confetti[i];
            c.t += dt;
            if (c.t >= c.life) { this.confetti[i] = this.confetti[this.confetti.length - 1]; this.confetti.pop(); continue; }
            // Paper physics: gravity, heavy air drag, side-to-side flutter.
            c.vy += 260 * hs * dt;
            const d = Math.exp(-2.6 * dt);
            c.vx *= d; c.vy *= d;
            c.x += (c.vx + Math.sin(c.t * 9 + c.ph) * 30 * hs) * dt;
            c.y += c.vy * dt;
            ctx.globalAlpha = Math.min(1, (c.life - c.t) / 0.3);
            ctx.fillStyle = c.c;
            // Flip between tall and wide as it tumbles.
            const tall = ((c.t * 7 + c.ph) | 0) % 2 === (c.tall ? 0 : 1);
            ctx.fillRect(Math.round(c.x / hs) * hs, Math.round(c.y / hs) * hs, tall ? hs : hs * 2, tall ? hs * 2 : hs);
        }
        ctx.globalAlpha = 1;
        // Twinkles ride the toast card's LIVE rect (the HUD refreshes it every
        // frame it draws the toast) and vanish the moment the card is gone.
        if (now - (this.toastSeen || 0) > 120) this.toastStars.length = 0;
        const R = this.toastRect;
        for (let i = this.toastStars.length - 1; i >= 0; i--) {
            const s = this.toastStars[i];
            s.t += dt;
            if (s.t >= s.dur) {
                // Re-arm round the card for as long as it's on screen.
                s.t = -Math.random() * 0.2; s.u = Math.random();
                continue;
            }
            if (s.t < 0 || !R) continue;
            // Position along the card's border.
            const per = 2 * (R.w + R.h), d = s.u * per;
            let x, y;
            if (d < R.w) { x = R.x + d; y = R.y; }
            else if (d < R.w + R.h) { x = R.x + R.w; y = R.y + d - R.w; }
            else if (d < 2 * R.w + R.h) { x = R.x + R.w - (d - R.w - R.h); y = R.y + R.h; }
            else { x = R.x; y = R.y + R.h - (d - 2 * R.w - R.h); }
            const u = s.t / s.dur, L = u < 0.5 ? 2 : 1;
            const px = Math.round(x / hs) * hs, py = Math.round(y / hs) * hs;
            ctx.fillStyle = u < 0.4 ? '#ffffff' : '#ffd24a';
            ctx.fillRect(px, py, hs, hs);
            for (let k = 1; k <= L; k++) {
                ctx.fillRect(px + k * hs, py, hs, hs); ctx.fillRect(px - k * hs, py, hs, hs);
                ctx.fillRect(px, py + k * hs, hs, hs); ctx.fillRect(px, py - k * hs, hs, hs);
            }
        }
        ctx.restore();
    }

    draw(ctx) {
        if (!this.n && !this.kN && !(this.tally > 0)) return;
        const hud = this.state.hud;
        const hs = Math.max(1, Math.round(hud._hudScale || 2));
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 1;
        const ws = this.game.worldScale;
        const [stx, sty] = this._target(0);
        const [etx, ety] = this._target(1);
        for (let i = 0; i < this.n; i++) {
            const t = this.t[i];
            if (t < 0) continue;
            const u = Math.min(1, t / this.dur[i]);
            const k = this.kind[i];
            const tx = k === 0 ? stx : etx, ty = k === 0 ? sty : ety;
            const [x, y] = this._pos(i, u, tx, ty);
            if (k === 0) {
                // The scrap piece itself, at its world-layer pixel size.
                const img = this.img[i];
                const w = img.width * ws, h = img.height * ws;
                const r = this.spin[i], c = Math.cos(r), sn = Math.sin(r);
                ctx.setTransform(c, sn, -sn, c, Math.round(x), Math.round(y));
                ctx.drawImage(img.canvas || img, -w / 2, -h / 2, w, h);
                ctx.setTransform(1, 0, 0, 1, 0, 0);
            } else {
                // Violet mote with a two-step trail behind it.
                const [qx, qy] = this._pos(i, Math.max(0, u - 0.07), tx, ty);
                ctx.fillStyle = VIOLET[2];
                ctx.fillRect(Math.round(qx / hs) * hs, Math.round(qy / hs) * hs, hs, hs);
                const px = Math.round(x / hs) * hs, py = Math.round(y / hs) * hs;
                ctx.fillStyle = VIOLET[3];
                ctx.fillRect(px - hs, py, hs * 3, hs);
                ctx.fillRect(px, py - hs, hs, hs * 3);
                ctx.fillStyle = VIOLET[4];
                ctx.fillRect(px, py, hs, hs);
            }
        }
        for (let i = 0; i < this.kN; i++) {
            const u = 1 - this.kl[i] / this.km[i];
            const pal = this.kc[i] ? VIOLET : GOLD;
            ctx.fillStyle = pal[Math.max(0, pal.length - 1 - Math.floor(u * pal.length))];
            ctx.fillRect(Math.round(this.kx[i] / hs) * hs, Math.round(this.ky[i] / hs) * hs, hs, hs);
        }
        // Running "+N" tally to the left of the counter while coins pour in.
        if (this.tally > 0 && hud.scrapAnchorLeft) {
            const fade = this.tallyT < 0.8 ? 1 : Math.max(0, 1 - (this.tallyT - 0.8) / 0.3);
            ctx.globalAlpha = fade;
            ctx.font = `${8 * hud._hudScale}px Astro4x`;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'alphabetic';
            const flash = this.scrapFlash > 0.5;
            ctx.fillStyle = '#000000';
            const tx = hud.scrapAnchorLeft - 6 * hud._hudScale, ty = hud._hudScale * 10;
            const label = `+${Math.round(this.tally)}`;
            ctx.fillText(label, tx + hud._hudScale, ty + hud._hudScale);
            ctx.fillStyle = flash ? '#ffffff' : '#ffd24a';
            ctx.fillText(label, tx, ty);
            ctx.textAlign = 'left';
        }
        ctx.restore();
    }
}
