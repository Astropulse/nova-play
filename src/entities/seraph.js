import { Scrap, ItemPickup, ExpOrb, ProceduralDebris, Asteroid, getCachedShatter } from './asteroid.js';
import { UPGRADES } from '../data/upgrades.js';
import { ellipseContains } from '../engine/collision.js';
import { Projectile } from './projectile.js';
import { pickFireExplosion, fireExplosionFrame, drawBeamStrip } from '../engine/vfx.js';

export const SERAPH_STATE = {
    IDLE: 'seraph_idle',   // Pre-fight float, invulnerable (never 'dormant' — that
    FIGHT: 'fight',        // string would trip the Cthulhu ram-wake loop)
    DYING: 'dying',
    FINISHED: 'finished'
};

// Attack phases within FIGHT (this.attack.type / .phase)
//   a1: windup (raise tongs, drift back) → pause (held at top) → dash (charge swing)
//   a2: signal (drift to screen edge)    → cast (crush motion, fling world objects)
//   a3: aim (targeting line from eye)    → fire (synced fire-beam burst) [opened only]

// Beam sequence: one pass through the fire_beam_start GIF's 7 frames, fast.
const BEAM_FRAME_MS = 55;
const BEAM_FRAMES = 7;
const BEAM_RANGE = 2600;
// The eye sits ~56 logical px above sprite center on the open sprite.
const EYE_OFF_Y = -56;

// The second boss — found by following the yellow glow after the Yellow One
// falls. An upright winged figure that never rotates. Two forms:
//   closed — tongs swing (a1) + crush/fling (a2)
//   opened — same attacks faster, plus the eye's fire beam (a3) which heals it.
// Opens below 1/3 health; closes again if it heals above 1/2.
export class Seraph {
    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.vx = 0;
        this.vy = 0;
        this.alive = true;
        this.state = SERAPH_STATE.IDLE;
        this.form = 'closed';          // 'closed' | 'opened'
        this.formAnim = null;          // null | 'opening' | 'closing'
        this.radius = 100;

        // Ellipse hitbox: drawn upright, never rotates (see engine/collision.js).
        this.spriteKey = 'seraph_idle_closed';
        this.hitRotAbs = 0;

        this.displayName = 'Burning Seraph';
        this.isBoss = true;            // boss-tier kill: cache drop + music restore
        this.revealed = false;
        this.discovered = false;
        this.isFinished = false;

        // Throwaway pre-fight health; the real pool is set when the fight starts.
        this.health = 50;
        this.maxHealth = 50;
        this.invulnerable = true;
        this.fightStarted = false;

        // Seeded content RNG for loot (AI stays on Math.random, like bosses).
        if (game.rng) {
            const d = game.rng.deriveEntity('enemies');
            this.contentRng = d.rng;
        } else {
            this.contentRng = null;
        }

        // Animation. Attack anims are frame-scheduled from phase progress;
        // idle/open/close free-run on animTimer.
        this.animFrame = 0;
        this.animTimer = 0;

        // Movement
        this.orbitAngle = Math.random() * Math.PI * 2;
        this.orbitDir = Math.random() > 0.5 ? 1 : -1;
        this._orbitFlipTimer = 4 + Math.random() * 4;
        this._bobPhase = Math.random() * Math.PI * 2;
        // Sim-driven animation clock for all cosmetic motion (bob/shiver/
        // pulses). Never use performance.now()/Date.now() in draw — the world
        // still draws under the pause menu and wall-clock motion won't freeze.
        this._animClock = 0;

        // Facing: the art faces LEFT natively; facing = 1 mirrors it right.
        // Turns play a short "blur-flip" (squash through zero + motion blur).
        this.facing = -1;
        this._flipFrom = -1;
        this._flipTimer = 0;
        this._flipBlurCanvas = null;
        this._flipBlurSrc = null;
        this.swoopTimer = 0;           // >0 while swooping
        this.swoopCooldown = 0;
        this.swoopTX = 0;
        this.swoopTY = 0;
        // Reposition jolts: short darting bursts around the player so it
        // prowls the screen instead of hovering. Frequent + wild in rage.
        this._repositionTimer = 1.2;
        this._joltTimer = 0;

        // Attacks
        this.attack = null;            // {type, phase, timer, dur, ...}
        this.attackCooldown = 3.0;
        this.beamCooldown = 0;         // extra gate on a3 (rage free-rolls only)
        this.activeBeam = null;        // {x, y, angle, frame, frameTimer, hitSet}
        this.pendingSpawns = [];

        // The eye is the weak point: sealed = immune. It opens in short
        // windows to beam/nova (the punish moments), and locks open during
        // RAGE — the last quarter of health (leech above 1/3 calms it).
        this.raged = false;
        this.eyeTimer = 3.5;           // until the next eye window (closed only)
        this._eyeLinger = 0;           // post-attack open time before sealing
        this._eyeAttackPending = false;
        this._lastClink = 0;
        this.rageInvulnTimer = 0;      // 2s of immunity when rage ignites (strobed)

        // Death sequence (boss-style staggered explosions)
        this.deathExplosions = null;
        this.deathTimer = 0;
    }

    // ─── SMALL HELPERS ─────────────────────────────────────────────────

    get isActive() {
        // Never freezes world spawning — the fight leans on ambient
        // asteroids/enemies as ammunition for the crush attack.
        return false;
    }

    get isAttackable() {
        return !this.invulnerable && this.state === SERAPH_STATE.FIGHT
            && this._eyeExposed() && this.rageInvulnTimer <= 0;
    }

    // The only time damage lands: any frame where the eye is at all open
    // (opened form or mid open/close animation).
    _eyeExposed() {
        return this.form === 'opened' || this.formAnim !== null;
    }

    // Live local pilots this fight can hurt. Multiplayer: the Seraph is a
    // locally-scripted event (LOCAL_SCRIPTED_EVENTS), so only the local pilot.
    _bodies() {
        const state = this.game.currentState;
        if (!state) return [];
        if (!state.netSync && state.localPlayers && state.localPlayers.length > 1) {
            return state.localPlayers.map(s => s.player).filter(p => p && !p.dead);
        }
        return state.player && !state.player.dead ? [state.player] : [];
    }

    _hurt(body, dmg, x, y) {
        const state = this.game.currentState;
        if (!state) return;
        if (!state.netSync && state.damagePlayerBody) state.damagePlayerBody(body, dmg, x, y);
        else state._damagePlayer(dmg, x, y);
    }

    _diff() {
        return (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
    }

    // Half-viewport extents in world units (the "screen" the Seraph clings to).
    _viewHalf() {
        const ws = this.game.worldScale || 1;
        return { w: (this.game.width / 2) / ws, h: (this.game.height / 2) / ws };
    }

    _gif(key) {
        return this.game.assets.get(key);
    }

    // Facing with a blur-flip: flips are latched (with a dead zone upstream)
    // and animate as a horizontal squash through zero plus a ghost trail.
    _setFacing(f) {
        if (f === this.facing || (f !== 1 && f !== -1)) return;
        this._flipFrom = this.facing;
        this.facing = f;
        this._flipTimer = 0.16;
    }

    // Who to look at this frame. Locked mid-dash (set at launch) and during
    // the beam (the burst angle is locked); everyone else tracks the player.
    _updateFacing(player) {
        if (this.state === SERAPH_STATE.DYING) return;
        const a = this.attack;
        if (a && a.type === 'a1' && a.phase === 'dash') return;
        if (a && a.type === 'a3') {
            this._setFacing(Math.cos(a.angle) >= 0 ? 1 : -1);
            return;
        }
        const dx = player.worldX - this.worldX;
        if (Math.abs(dx) > 60) this._setFacing(dx > 0 ? 1 : -1);
    }

    _idleKey() {
        return this.form === 'opened' ? 'seraph_idle_opened' : 'seraph_idle_closed';
    }

    // ─── UPDATE ────────────────────────────────────────────────────────

    update(dt, player) {
        if (!this.alive) return;
        this._animClock += dt;

        if (this.state === SERAPH_STATE.DYING) {
            this._updateDying(dt);
            return;
        }
        if (this.state === SERAPH_STATE.FINISHED) return;

        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (!this.revealed && dist < 3500) this.revealed = true;

        if (this._flipTimer > 0) this._flipTimer -= dt;
        if (this.rageInvulnTimer > 0) this.rageInvulnTimer -= dt;
        this._updateFacing(player);

        if (this.state === SERAPH_STATE.IDLE) {
            this._updateIdleAnim(dt);
            // Gentle bob in place — tied to its spot in the world.
            this.worldX += Math.cos(this.orbitAngle + this._animClock / 2.4) * 6 * dt;
            this.worldY += Math.sin(this._animClock / 1.9) * 8 * dt;
            if (dist < 1150) this._startFight();
            return;
        }

        // ── FIGHT ──
        this._updateBeam(dt, player);

        if (this.formAnim) {
            this._updateFormAnim(dt);
            this._moveFloat(dt, player, dist, 0.4);
            return;
        }

        // RAGE — the last quarter of health. The eye locks open (permanently
        // damageable) and the assault goes relentless. The beam's leech is the
        // only way back out: healed above 1/3, it calms and seals again.
        if (!this.raged && this.health < this.maxHealth / 4) {
            this.raged = true;
            this._eyeLinger = 0;
            this.rageInvulnTimer = 2.0; // the ignition itself can't be burst down
            if (this.form === 'closed') {
                this._startOpening();
                return;
            }
        } else if (this.raged && this.health > this.maxHealth / 3) {
            this.raged = false;
            if (this.form === 'opened' && !this.attack) {
                this._startClosing();
                return;
            }
        }

        if (this.attack) {
            this._updateAttack(dt, player, dist);
            return;
        }

        this._updateIdleAnim(dt);
        this._moveFloat(dt, player, dist, 1.0);
        this._updateSwoop(dt, player, dist);
        this._updateReposition(dt, player);

        // Eye window (non-rage): the eye opened for exactly one beam/nova.
        // Fire it, linger briefly (the punish window), then seal.
        if (this.form === 'opened' && !this.raged) {
            if (this._eyeAttackPending) {
                this._eyeAttackPending = false;
                if (Math.random() < 0.55) this._startAttack3(player);
                else this._startAttack2(player); // opened form → fireball nova
                return;
            }
            this._eyeLinger -= dt;
            if (this._eyeLinger <= 0) this._startClosing();
            return;
        }

        this.attackCooldown -= dt;
        this.beamCooldown -= dt;

        // Sealed: free-roll charges/crushes, and periodically open the eye —
        // the ONLY moments the Seraph can be hurt.
        if (this.form === 'closed' && !this.raged) {
            this.eyeTimer -= dt;
            if (this.eyeTimer <= 0 && this.swoopTimer <= 0) {
                this._startOpening();
                return;
            }
        }

        if (this.attackCooldown <= 0 && this.swoopTimer <= 0) {
            this._pickAttack(player, dist);
        }
    }

    // ─── MOVEMENT ──────────────────────────────────────────────────────

    // Floaty world-tied drift: a lazy figure-eight sweep around the player
    // without hard homing. Two extra layers keep it feeling present:
    //  - a soft "screen spring" that shoves it back inside the view edges the
    //    further it strays past them (border-mindful following), and
    //  - a speed cap that scales with the player's own speed so a cruising
    //    player doesn't simply peel away between swoops.
    _moveFloat(dt, player, dist, agility) {
        const pSpeed = Math.sqrt((player.vx || 0) ** 2 + (player.vy || 0) ** 2);

        // Orbit progresses faster when the player is on the move, and flips
        // direction now and then so the hover never turns into a metronome.
        this.orbitAngle += this.orbitDir * (0.35 + Math.min(0.5, pSpeed * 0.0005)) * dt;
        this._orbitFlipTimer -= dt;
        if (this._orbitFlipTimer <= 0) {
            this._orbitFlipTimer = 4 + Math.random() * 4;
            if (Math.random() < 0.5) this.orbitDir = -this.orbitDir;
        }

        // Lissajous wander layered on the hover point — alive, not parked.
        const t = this._animClock + this._bobPhase;
        const hoverDist = 380;
        const tx = player.worldX + Math.cos(this.orbitAngle) * hoverDist + Math.cos(t * 1.7) * 30;
        const ty = player.worldY + Math.sin(this.orbitAngle) * hoverDist + Math.sin(t * 2.3) * 40;
        const toX = tx - this.worldX;
        const toY = ty - this.worldY;
        const toDist = Math.sqrt(toX * toX + toY * toY) || 1;

        const far = toDist > 500;
        const pull = (far ? 1400 : Math.min(700, toDist * 1.6)) * agility;
        this.vx += (toX / toDist) * pull * dt;
        this.vy += (toY / toDist) * pull * dt;

        // Screen spring: proportional shove back toward the view the moment it
        // pokes past ~80% of the half-extents (relative to the player).
        const half = this._viewHalf();
        const relX = this.worldX - player.worldX;
        const relY = this.worldY - player.worldY;
        const limX = half.w * 0.82, limY = half.h * 0.78;
        let overshoot = 0;
        if (Math.abs(relX) > limX) {
            const over = Math.abs(relX) - limX;
            overshoot = Math.max(overshoot, over);
            this.vx -= Math.sign(relX) * over * 6.0 * dt;
        }
        if (Math.abs(relY) > limY) {
            const over = Math.abs(relY) - limY;
            overshoot = Math.max(overshoot, over);
            this.vy -= Math.sign(relY) * over * 6.0 * dt;
        }

        if (this._joltTimer > 0) this._joltTimer -= dt;

        let maxV = Math.max(360, pSpeed * 1.15);
        if (overshoot > 0) maxV = Math.max(maxV, 900 + overshoot * 2);
        if (this._joltTimer > 0) maxV = Math.max(maxV, this.raged ? 2700 : 1650);
        if (this.swoopTimer > 0) maxV = 3400;
        const vel = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (vel > maxV) {
            this.vx = (this.vx / vel) * maxV;
            this.vy = (this.vy / vel) * maxV;
        }

        const friction = Math.pow(
            this.swoopTimer > 0 || this._joltTimer > 0 ? 0.97 : (far || overshoot > 0 ? 0.965 : 0.93), dt * 60);
        this.vx *= friction;
        this.vy *= friction;

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
    }

    // Reposition jolts: quick darting bursts to a new spot around the player
    // (à la the Yellow One's dashes) so it prowls instead of hovering.
    // Rage jolts are near-constant and wild.
    _updateReposition(dt, player) {
        this._repositionTimer -= dt;
        if (this._repositionTimer > 0 || this.swoopTimer > 0) return;

        const ang = Math.random() * Math.PI * 2;
        const d = 240 + Math.random() * 260;
        const tx = player.worldX + Math.cos(ang) * d;
        const ty = player.worldY + Math.sin(ang) * d;
        const toX = tx - this.worldX;
        const toY = ty - this.worldY;
        const toDist = Math.sqrt(toX * toX + toY * toY) || 1;
        if (toDist > 120) {
            const speed = this.raged ? 1800 + Math.random() * 800 : 1100 + Math.random() * 500;
            this.vx = (toX / toDist) * speed;
            this.vy = (toY / toDist) * speed;
            this._joltTimer = 0.5;
            this.orbitDir = Math.random() > 0.5 ? 1 : -1;
            this.game.sounds.play('boost', { volume: this.raged ? 0.4 : 0.25, x: this.worldX, y: this.worldY });
        }
        this._repositionTimer = this.raged ? 0.3 + Math.random() * 0.4 : 0.8 + Math.random() * 1.0;
    }

    // Swoop: when the player is about to lose it off-screen, it lunges back
    // into view in one deliberate motion (no teleports, no constant homing).
    _updateSwoop(dt, player, dist) {
        if (this.swoopTimer > 0) {
            this.swoopTimer -= dt;
            const toX = this.swoopTX - this.worldX;
            const toY = this.swoopTY - this.worldY;
            if (toX * toX + toY * toY < 160 * 160) this.swoopTimer = 0;
            return;
        }
        this.swoopCooldown -= dt;
        if (this.swoopCooldown > 0) return;

        // The screen spring (in _moveFloat) handles the borders; the swoop is
        // the hard catch-up for when it's genuinely lost off-screen.
        const half = this._viewHalf();
        const offX = Math.abs(this.worldX - player.worldX) > half.w + this.radius;
        const offY = Math.abs(this.worldY - player.worldY) > half.h + this.radius;
        if (!offX && !offY) return;

        // Lunge to a point just ahead of the player's travel.
        const lead = 0.45;
        const tx = player.worldX + (player.vx || 0) * lead;
        const ty = player.worldY + (player.vy || 0) * lead;
        const ang = Math.atan2(this.worldY - ty, this.worldX - tx);
        this.swoopTX = tx + Math.cos(ang) * 340;
        this.swoopTY = ty + Math.sin(ang) * 340;

        const toX = this.swoopTX - this.worldX;
        const toY = this.swoopTY - this.worldY;
        const toDist = Math.sqrt(toX * toX + toY * toY) || 1;
        const speed = Math.max(1400, Math.min(3200, 1100 + toDist * 0.55));
        this.vx = (toX / toDist) * speed;
        this.vy = (toY / toDist) * speed;
        this.swoopTimer = 0.85;
        this.swoopCooldown = 0.7;
        this.game.sounds.play('boost', { volume: 0.45, x: this.worldX, y: this.worldY });
    }

    // ─── FIGHT FLOW ────────────────────────────────────────────────────

    _startFight() {
        this.state = SERAPH_STATE.FIGHT;
        this.invulnerable = false;
        this.fightStarted = true;
        this.attackCooldown = 0.5;
        this.beamCooldown = 3.0;
        this.eyeTimer = 2.5; // first eye window comes early — teach the mechanic
        this.raged = false;

        // Post-Yellow One tuning: by now the player is likely maxed out (damage
        // stacks, fire-rate, autos), so the pool is big and — unlike the base
        // bosses' softened diff^0.6 curve — scales LINEARLY with difficulty.
        const diff = this._diff();
        this.health = 4200 + 1000 * diff;
        this.maxHealth = this.health;

        this.game.sounds.playSpecificMusic('Burning Seraph');
        this.game.sounds.play('shield_break', { volume: 0.7, x: this.worldX, y: this.worldY });
        this.game.camera.shake(2.0);

        // Arrival fanfare — the duel has begun.
        const state = this.game.currentState;
        if (state) {
            if (state.triggerFlash) state.triggerFlash('#ff8800', 1.0, 0.35);
            if (state.cinematics) {
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ff8800', maxR: 260, dur: 0.7, width: 5 });
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ffd050', maxR: 170, dur: 0.5, width: 3 });
            }
            if (state._spawnSparks) {
                state._spawnSparks(this.worldX, this.worldY, 18, { color: '#ff9a33', speedMin: 180, speedMax: 520 });
            }
        }
    }

    _pickAttack(player, dist) {
        const roll = Math.random();
        if (this.raged) {
            // Everything, constantly: beams, charges, novas.
            if (this.beamCooldown <= 0 && roll < 0.4) this._startAttack3(player);
            else if (roll < 0.72) this._startAttack1(player);
            else this._startAttack2(player); // opened form → nova
            return;
        }
        // Sealed free-roll: charges + world-crush only (beam/nova belong to
        // the eye windows).
        if (roll < 0.65) this._startAttack1(player);
        else this._startAttack2(player);
    }

    _endAttack() {
        this.attack = null;
        if (this.raged) {
            // Rage barely breathes — erratic, sometimes back-to-back.
            this.attackCooldown = 0.18 + Math.random() * 0.3;
        } else if (this.form === 'opened') {
            // Eye-window attack just finished — a blink of punish time, then
            // update() seals the eye.
            this._eyeLinger = 0.35;
        } else {
            // Erratic, near-constant pressure: sometimes instant follow-ups,
            // never a long breather.
            this.attackCooldown = 0.35 + Math.random() * 0.9;
        }
        this.animFrame = 0;
        this.animTimer = 0;
    }

    // ─── ATTACK 1: tongs swing + charge ────────────────────────────────

    _startAttack1(player) {
        const opened = this.form === 'opened';
        // The telegraph compresses as difficulty climbs — late-run players get
        // far less warning before the swing comes down. Rage compresses it more.
        const tele = Math.max(0.5, 1 - (this._diff() - 1) * 0.1) * (this.raged ? 0.6 : 1);
        this.attack = {
            type: 'a1',
            phase: 'windup',
            timer: 0,
            // Opened swings come up faster and barely pause at the top.
            windupDur: (opened ? 0.5 : 0.85) * tele,
            pauseDur: (opened ? 0.15 : 0.4) * tele,
            dashDur: opened ? 0.7 : 0.8,
            // Rage charges are absurdly fast — the strobing blur is the warning.
            dashSpeed: (opened ? 3600 : 3000) * (this.raged ? 1.15 : 1),
            hitSet: new Set(),
            sparkAccum: 0,
            pauseCued: false
        };
        // Reset immediately — the stale idle frame index would otherwise show
        // one flash of the raised pose before the raise plays.
        this.animFrame = 0;
        this.animTimer = 0;
        this.game.sounds.play('railgun_target', { volume: 0.4, x: this.worldX, y: this.worldY });
    }

    _updateAttack1(dt, player, dist) {
        const a = this.attack;
        a.timer += dt;
        const gifLen = 8; // both attack_1 gifs

        if (a.phase === 'windup') {
            // Up-portion of the swing: frames 0..3 across the windup, held on
            // the top frame through the pause.
            const p = Math.min(1, a.timer / a.windupDur);
            this.animFrame = Math.min(3, Math.floor(p * 4));

            const ang = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
            if (a.timer < a.windupDur) {
                // The coil: a real recoil away from the player (strongest at the
                // start, easing off) with a slight upward lift as the tongs rise.
                const recoil = 380 * (1 - p * 0.6);
                this.vx += -Math.cos(ang) * recoil * dt;
                this.vy += -Math.sin(ang) * recoil * dt - 30 * dt;
                const friction = Math.pow(0.92, dt * 60);
                this.vx *= friction;
                this.vy *= friction;

                // Embers shake off the coal while it winds up — the tell.
                const state = this.game.currentState;
                a.sparkAccum += dt;
                if (state && state._spawnSparks && a.sparkAccum > 0.09) {
                    a.sparkAccum = 0;
                    // The coal hand mirrors with the facing flip.
                    state._spawnSparks(this.worldX + 58 * this.facing, this.worldY + 30, 1 + Math.floor(Math.random() * 2), {
                        dir: -Math.PI / 2, spread: 2.2,
                        color: Math.random() < 0.5 ? '#ffd050' : '#ff7a2a',
                        speedMin: 40, speedMax: 140
                    });
                }
            } else {
                // The pause at the top: hard brake to a dead stop — the held
                // breath before the swing (the shiver is drawn in draw()).
                if (!a.pauseCued) {
                    a.pauseCued = true;
                    this.game.sounds.play('railgun_target', { volume: 0.6, x: this.worldX, y: this.worldY });
                }
                const brake = Math.pow(0.76, dt * 60);
                this.vx *= brake;
                this.vy *= brake;
            }
            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;

            if (a.timer >= a.windupDur + a.pauseDur) {
                a.phase = 'dash';
                a.timer = 0;
                // Launch: charge through the player's position (overshoot past
                // them). Starts explosive; _updateAttack1 bleeds it off like a
                // heavy swing rather than a bullet.
                const ddx = player.worldX - this.worldX;
                const ddy = player.worldY - this.worldY;
                const dl = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
                this.vx = (ddx / dl) * a.dashSpeed;
                this.vy = (ddy / dl) * a.dashSpeed;
                this._setFacing(this.vx >= 0 ? 1 : -1); // locked for the dash
                this.game.sounds.play('boost', { volume: 0.9, x: this.worldX, y: this.worldY });
                this.game.camera.shake(1.0);
                const state = this.game.currentState;
                if (state && state._spawnSparks) {
                    state._spawnSparks(this.worldX, this.worldY, 10, {
                        dir: Math.atan2(this.vy, this.vx), spread: 0.9,
                        color: '#ff9a33', speedMin: 200, speedMax: 520
                    });
                }
                if (state && state.cinematics) {
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ff9a33', maxR: 130, dur: 0.35, width: 4 });
                }
            }
            return;
        }

        // Dash: down-portion of the swing, frames 4..7, spraying fire sparks.
        const p = Math.min(1, a.timer / a.dashDur);
        this.animFrame = Math.min(gifLen - 1, 4 + Math.floor(p * 4));

        // Weight: the launch speed bleeds off across the whole dash (gently —
        // the swing carries far).
        const swingDrag = Math.pow(0.975, dt * 60);
        this.vx *= swingDrag;
        this.vy *= swingDrag;
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Fire trail off the WHOLE silhouette (effect only — the charge is the
        // damage): each tick, embers shed from random points across the body,
        // biased toward the trailing edge, so the dash drags a full flame wake.
        const state = this.game.currentState;
        a.sparkAccum += dt;
        if (state && state._spawnSparks && a.sparkAccum > 0.03) {
            a.sparkAccum = 0;
            const va = Math.atan2(this.vy, this.vx);
            const bursts = 3 + Math.floor(Math.random() * 3);
            for (let i = 0; i < bursts; i++) {
                // Random point inside the body (tall sprite: ±45 x, ±95 y),
                // pushed back along the travel direction.
                const bx = (Math.random() - 0.5) * 90;
                const by = (Math.random() - 0.5) * 190;
                const trail = 20 + Math.random() * 40;
                state._spawnSparks(
                    this.worldX + bx - Math.cos(va) * trail,
                    this.worldY + by - Math.sin(va) * trail,
                    1 + Math.floor(Math.random() * 2), {
                        dir: va + Math.PI, spread: 0.9,
                        color: Math.random() < 0.5 ? '#ffd050' : '#ff7a2a',
                        speedMin: 100, speedMax: 360
                    });
            }
        }

        // Charge contact — one hit per pilot per dash.
        const dmg = Math.min(70, 38 + 5 * this._diff());
        for (const body of this._bodies()) {
            if (a.hitSet.has(body)) continue;
            if (ellipseContains(this, body.worldX, body.worldY, body.radius)) {
                a.hitSet.add(body);
                this._hurt(body, dmg, this.worldX, this.worldY);
                if (state && state._applyKnockback) {
                    const kdx = body.worldX - this.worldX;
                    const kdy = body.worldY - this.worldY;
                    state._applyKnockback(kdx, kdy, Math.sqrt(kdx * kdx + kdy * kdy), 350, body);
                }
                this.game.camera.shake(1.2);
            }
        }

        // Slight drag near the end so the dash reads as a swing, not a bullet.
        if (p > 0.7) {
            const drag = Math.pow(0.94, dt * 60);
            this.vx *= drag;
            this.vy *= drag;
        }

        if (a.timer >= a.dashDur) this._endAttack();
    }

    // ─── ATTACK 2: crush — fling the world at the player ───────────────

    _startAttack2(player) {
        const opened = this.form === 'opened';
        if (opened) {
            // Opened form: no crush — the clench detonates a radial storm of
            // homing fireballs. Short in-place gather instead of the edge drift.
            this.attack = {
                type: 'a2',
                phase: 'signal',
                timer: 0,
                signalDur: 0.35,
                frameMs: 60,
                nova: true,
                flung: false
            };
            this.game.sounds.play('railgun_target', { volume: 0.6, x: this.worldX, y: this.worldY });
            return;
        }
        // Closed form: signal by drifting toward the screen edge, slightly
        // away from the player, then crush-fling the world at them.
        const half = this._viewHalf();
        const edgeDist = Math.min(half.w, half.h) - 130;
        const ang = Math.atan2(this.worldY - player.worldY, this.worldX - player.worldX);
        this.attack = {
            type: 'a2',
            phase: 'signal',
            timer: 0,
            signalDur: 0.9,
            frameMs: 90,
            nova: false,
            edgeX: player.worldX + Math.cos(ang) * edgeDist,
            edgeY: player.worldY + Math.sin(ang) * edgeDist,
            flung: false
        };
    }

    _updateAttack2(dt, player, dist) {
        const a = this.attack;
        a.timer += dt;

        if (a.phase === 'signal') {
            this._updateIdleAnim(dt);

            if (a.nova) {
                // Gather: hold nearly still while embers converge on the body.
                const brake = Math.pow(0.85, dt * 60);
                this.vx *= brake;
                this.vy *= brake;
                this.worldX += this.vx * dt;
                this.worldY += this.vy * dt;
                const state = this.game.currentState;
                if (state && state._spawnSparks && Math.random() < 0.5) {
                    const ga = Math.random() * Math.PI * 2;
                    state._spawnSparks(this.worldX + Math.cos(ga) * 150, this.worldY + Math.sin(ga) * 150, 2,
                        { dir: ga + Math.PI, spread: 0.2, color: '#ff9a33', speedMin: 300, speedMax: 480 });
                }
            } else {
                // Ease out to the edge point (recomputed against the moving
                // player so it stays at the screen edge, not a stale spot).
                const ang = Math.atan2(this.worldY - player.worldY, this.worldX - player.worldX);
                const half = this._viewHalf();
                const edgeDist = Math.min(half.w, half.h) - 130;
                a.edgeX = player.worldX + Math.cos(ang) * edgeDist;
                a.edgeY = player.worldY + Math.sin(ang) * edgeDist;

                const toX = a.edgeX - this.worldX;
                const toY = a.edgeY - this.worldY;
                const toDist = Math.sqrt(toX * toX + toY * toY) || 1;
                const speed = Math.min(650, toDist * 2.2);
                this.vx = (toX / toDist) * speed;
                this.vy = (toY / toDist) * speed;
                this.worldX += this.vx * dt;
                this.worldY += this.vy * dt;
                if (toDist < 60) a.timer = Math.max(a.timer, a.signalDur);
            }

            if (a.timer >= a.signalDur) {
                a.phase = 'cast';
                a.timer = 0;
                this.animFrame = 0;
                this.game.sounds.play('railgun_target', { volume: 0.5, x: this.worldX, y: this.worldY });
            }
            return;
        }

        // Cast: hand up, clench. The payload fires on the clench frame.
        const gif = this._gif(this.form === 'opened' ? 'seraph_attack_2_opened' : 'seraph_attack_2_closed');
        const len = (gif && gif.length) || 8;
        this.animFrame = Math.min(len - 1, Math.floor((a.timer * 1000) / a.frameMs));

        // Drift to a stop while casting.
        const drag = Math.pow(0.9, dt * 60);
        this.vx *= drag;
        this.vy *= drag;
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        if (!a.flung && this.animFrame >= 5) {
            a.flung = true;
            if (a.nova) this._fireballNova(player);
            else this._crushFling(player);
        }

        if (a.timer >= (len * a.frameMs) / 1000) this._endAttack();
    }

    // Opened-form nova: a ring of fireballs with slight homing, so the wave
    // bends toward the player and simply strafing a straight line won't clear it.
    _fireballNova(player) {
        const state = this.game.currentState;
        if (!state || !state.projectiles) return;

        const diff = this._diff();
        const count = Math.min(26, 16 + Math.floor(diff * 2));
        const dmg = 14 + 3 * diff;
        const bodies = this._bodies();
        for (let i = 0; i < count; i++) {
            const ang = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
            const speed = 380 + Math.random() * 240;
            const proj = new Projectile(this.game, this.worldX, this.worldY, ang, speed, 'fireball', this, dmg, 3.5);
            proj.spriteRotOffset = 0; // fireball art faces right
            proj.target = bodies.length ? bodies[i % bodies.length] : player;
            proj.turnRate = 0.5 + Math.random() * 0.4; // slight homing
            state.projectiles.push(proj);
        }

        this.game.sounds.play('railgun_shoot', { volume: 0.8, x: this.worldX, y: this.worldY });
        this.game.sounds.play('laser', { volume: 0.5, x: this.worldX, y: this.worldY });
        this.game.camera.shake(1.3);
        if (state.cinematics) {
            state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ff7a2a', maxR: 240, dur: 0.5, width: 5 });
        }
    }

    _crushFling(player) {
        const state = this.game.currentState;
        if (!state) return;

        let flungAny = false;
        const rangeSq = 1700 * 1700;

        // Nearby asteroids get hurled at the player, each at its own pace.
        let count = 0;
        for (const ast of state.asteroids) {
            if (!ast.alive || count >= 6) continue;
            const dx = ast.worldX - this.worldX;
            const dy = ast.worldY - this.worldY;
            if (dx * dx + dy * dy > rangeSq) continue;
            const ang = Math.atan2(player.worldY - ast.worldY, player.worldX - ast.worldX);
            const speed = 420 + Math.random() * 330; // varied, not crazy fast
            ast.vx = Math.cos(ang) * speed;
            ast.vy = Math.sin(ang) * speed;
            ast.highlightRed = true;
            count++;
            flungAny = true;
        }

        // Empty field is no mercy: conjure rocks out of the dark and hurl
        // those instead, so the crush ALWAYS sends a volley.
        if (state.asteroids && count < 4) {
            const conjure = 4 - count;
            for (let i = 0; i < conjure; i++) {
                const ang = Math.random() * Math.PI * 2;
                const d = 350 + Math.random() * 350;
                const ax = this.worldX + Math.cos(ang) * d;
                const ay = this.worldY + Math.sin(ang) * d;
                const size = Math.random() < 0.35 ? 'medium' : 'small';
                const ast = new Asteroid(this.game, ax, ay, size, 0, 0);
                const toPlayer = Math.atan2(player.worldY - ay, player.worldX - ax);
                const speed = 420 + Math.random() * 330;
                ast.vx = Math.cos(toPlayer) * speed;
                ast.vy = Math.sin(toPlayer) * speed;
                ast.highlightRed = true;
                ast._nearPlayer = true; // mid-tick spawn: don't skip broad-phase this frame
                state.asteroids.push(ast);
                flungAny = true;
            }
        }

        // Enemy ships too — shoved via external velocity so their AI tumbles.
        count = 0;
        for (const en of state.enemies) {
            if (!en.alive || en.isBoss || count >= 4) continue;
            const dx = en.worldX - this.worldX;
            const dy = en.worldY - this.worldY;
            if (dx * dx + dy * dy > rangeSq) continue;
            const ang = Math.atan2(player.worldY - en.worldY, player.worldX - en.worldX);
            const speed = 500 + Math.random() * 350;
            en.externalVx = Math.cos(ang) * speed;
            en.externalVy = Math.sin(ang) * speed;
            en.isHurled = true;
            count++;
            flungAny = true;
        }

        this.game.sounds.play('railgun_shoot', { volume: 0.6, x: this.worldX, y: this.worldY });
        if (state.cinematics) {
            state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ff8800', maxR: 200, dur: 0.45, width: 4 });
        }
        if (flungAny) {
            this.game.sounds.play('boost', { volume: 0.6, x: this.worldX, y: this.worldY });
            this.game.camera.shake(1.1);
        }
    }

    // ─── ATTACK 3: the eye's fire beam (opened only) ───────────────────

    _startAttack3(player) {
        this.attack = {
            type: 'a3',
            phase: 'aim',
            timer: 0,
            aimDur: 0.5,
            angle: Math.atan2(player.worldY - (this.worldY + EYE_OFF_Y), player.worldX - this.worldX)
        };
        this.animFrame = 0; // no stale-frame flash on the first draw
        this.animTimer = 0;
        this.beamCooldown = 1.8;
        this.game.sounds.play('railgun_target', { volume: 0.8, x: this.worldX, y: this.worldY });
    }

    _updateAttack3(dt, player, dist) {
        const a = this.attack;
        a.timer += dt;

        // Hold nearly still while the eye burns.
        const drag = Math.pow(0.88, dt * 60);
        this.vx *= drag;
        this.vy *= drag;
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        if (a.phase === 'aim') {
            this.animFrame = Math.min(3, Math.floor((a.timer / a.aimDur) * 4));
            // Track the player hard during the aim; the angle locks at fire time.
            const target = Math.atan2(player.worldY - (this.worldY + EYE_OFF_Y), player.worldX - this.worldX);
            let diff = target - a.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            a.angle += diff * Math.min(1, 7.0 * dt);

            if (a.timer >= a.aimDur) {
                a.phase = 'fire';
                a.timer = 0;
                // Lock with a short predictive lead — flying a straight line
                // through the telegraph no longer guarantees a whiff.
                const lead = 0.12;
                a.angle = Math.atan2(
                    player.worldY + (player.vy || 0) * lead - (this.worldY + EYE_OFF_Y),
                    player.worldX + (player.vx || 0) * lead - this.worldX);
                this.activeBeam = {
                    angle: a.angle,
                    frame: 0,
                    frameTimer: 0,
                    hitSet: new Set()
                };
                this.game.sounds.play('railgun_shoot', { volume: 0.9, x: this.worldX, y: this.worldY });
                this.game.sounds.play('laser', { volume: 0.5, x: this.worldX, y: this.worldY });
                this.game.camera.shake(1.5);
                const state = this.game.currentState;
                const eyeY = this.worldY + EYE_OFF_Y;
                if (state && state.cinematics) {
                    state.cinematics.spawnRing(this.worldX, eyeY, { color: '#ff7a2a', maxR: 90, dur: 0.3, width: 4 });
                }
                if (state && state._spawnSparks) {
                    state._spawnSparks(this.worldX, eyeY, 12, {
                        dir: a.angle, spread: 0.7, color: '#ffd050', speedMin: 260, speedMax: 640
                    });
                }
            }
            return;
        }

        // Fire: the attack anim's back half rides the beam's 7-frame burst.
        if (this.activeBeam) {
            this.animFrame = Math.min(7, 4 + Math.floor((this.activeBeam.frame / BEAM_FRAMES) * 4));
        } else {
            this._endAttack();
        }
    }

    // Beam lifetime/damage. Runs even outside a3 so an interrupted attack
    // state can never strand a live beam.
    _updateBeam(dt, player) {
        const b = this.activeBeam;
        if (!b) return;

        b.frameTimer += dt * 1000;
        while (b.frameTimer >= BEAM_FRAME_MS) {
            b.frameTimer -= BEAM_FRAME_MS;
            b.frame++;
        }
        if (b.frame >= BEAM_FRAMES) {
            // One full pass through the sequence — gone.
            this.activeBeam = null;
            if (this.attack && this.attack.type === 'a3') this._endAttack();
            return;
        }

        // Hitscan along the beam, one hit per pilot per burst. Leeches health.
        const ex = this.worldX;
        const ey = this.worldY + EYE_OFF_Y;
        const dirX = Math.cos(b.angle);
        const dirY = Math.sin(b.angle);
        const dmg = 38 + 5 * this._diff();

        for (const body of this._bodies()) {
            if (b.hitSet.has(body)) continue;
            const dx = body.worldX - ex;
            const dy = body.worldY - ey;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d <= 0 || d > BEAM_RANGE) continue;
            const dot = (dx * dirX + dy * dirY) / d;
            if (dot < 0) continue;
            const cross = Math.abs(dx * dirY - dy * dirX);
            if (cross < body.radius + 24) {
                b.hitSet.add(body);
                this._hurt(body, dmg, ex, ey);
                this._leech(dmg * 3, body.worldX, body.worldY);
            }
        }
    }

    _leech(amount, atX, atY) {
        if (this.health <= 0 || this.state !== SERAPH_STATE.FIGHT) return;
        const healed = Math.min(this.maxHealth - this.health, amount);
        if (healed <= 0) return;
        this.health += healed;
        const state = this.game.currentState;
        if (state && state.spawnFloatingText) {
            state.spawnFloatingText(this.worldX, this.worldY, `+${Math.ceil(healed)}`, '#66ff66');
            // The Seraph is usually OFF-screen when its beam lands (range 2600)
            // — echo the steal at the impact point so the player always sees
            // the health being taken.
            if (atX !== undefined) {
                state.spawnFloatingText(atX, atY - 30, `+${Math.ceil(healed)}`, '#66ff66');
            }
        }
        // Un-raging (heal past 1/3) is checked in update().
    }

    // ─── FORM TRANSITIONS ──────────────────────────────────────────────

    _startOpening() {
        this.formAnim = 'opening';
        this.attack = null;
        this.animFrame = 0;
        this.animTimer = 0;
        this.game.sounds.play('shield_break', { volume: 0.8, x: this.worldX, y: this.worldY });
        this.game.sounds.play('railgun_target', { volume: 0.5, x: this.worldX, y: this.worldY });
        this.game.camera.shake(this.raged ? 2.5 : 1.2);
        // The eye opens. Windows get rings + embers; the full screen-flash
        // fanfare is reserved for the RAGE lock-open (it fires every ~6s
        // otherwise, which would wear the flash out).
        const state = this.game.currentState;
        if (state) {
            if (this.raged && state.triggerFlash) state.triggerFlash('#ff8800', 0.9, 0.4);
            if (state.cinematics) {
                state.cinematics.spawnRing(this.worldX, this.worldY + EYE_OFF_Y, { color: '#ff7a2a', maxR: 240, dur: 0.6, width: 5 });
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ffd050', maxR: 320, dur: 0.8, width: 3 });
            }
            if (state._spawnSparks) {
                state._spawnSparks(this.worldX, this.worldY + EYE_OFF_Y, 24, { color: '#ff9a33', speedMin: 200, speedMax: 620 });
            }
        }
    }

    _startClosing() {
        this.formAnim = 'closing';
        this.attack = null;
        this.activeBeam = null;
        this.animFrame = 0;
        this.animTimer = 0;
        this.game.sounds.play('shield', { volume: 0.7, x: this.worldX, y: this.worldY });
        this.game.camera.shake(1.5);
        const state = this.game.currentState;
        if (state && state.cinematics) {
            state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ffffcc', maxR: 200, dur: 0.6, width: 3 });
        }
    }

    _updateFormAnim(dt) {
        const gif = this._gif(this.formAnim === 'opening' ? 'seraph_open' : 'seraph_close');
        if (!gif || !gif.length) {
            this._finishFormAnim();
            return;
        }
        this.animTimer += dt * 1000;
        if (this.animTimer >= 60) { // snappy — eye windows should feel like a blink
            this.animTimer = 0;
            this.animFrame++;
            if (this.animFrame >= gif.length) this._finishFormAnim();
        }
    }

    _finishFormAnim() {
        this.form = this.formAnim === 'opening' ? 'opened' : 'closed';
        this.formAnim = null;
        this.animFrame = 0;
        this.animTimer = 0;
        this.spriteKey = this._idleKey(); // keep the fitted hitbox in step
        if (this.form === 'opened') {
            if (this.raged) {
                this.attackCooldown = 0.15;
                this.beamCooldown = 0.4;
            } else {
                // Window: fire the eye attack immediately (update() picks it).
                this._eyeAttackPending = true;
            }
        } else {
            this.attackCooldown = 0.5;
            this.eyeTimer = 4.5 + Math.random() * 2.0; // frequent but brief windows
        }
    }

    _updateIdleAnim(dt) {
        const gif = this._gif(this._idleKey());
        if (!gif || !gif.length) return;
        this.animTimer += dt * 1000;
        const frame = gif[Math.min(this.animFrame, gif.length - 1)];
        if (frame && this.animTimer >= (frame.delay || 100)) {
            this.animTimer = 0;
            this.animFrame = (this.animFrame + 1) % gif.length;
        }
    }

    _updateAttack(dt, player, dist) {
        switch (this.attack.type) {
            case 'a1': this._updateAttack1(dt, player, dist); break;
            case 'a2': this._updateAttack2(dt, player, dist); break;
            case 'a3': this._updateAttack3(dt, player, dist); break;
        }
    }

    // ─── DAMAGE / DEATH ────────────────────────────────────────────────

    hit(damage) {
        if (this.invulnerable || this.state !== SERAPH_STATE.FIGHT) return false;

        // Immune: sealed eye, or the 2s rage-ignition grace. Shots ping off —
        // grey ZERO numbers say it out loud (rate-limited vs rapid fire).
        if (!this._eyeExposed() || this.rageInvulnTimer > 0) {
            this._immuneFeedback();
            return false;
        }

        this.health -= damage;

        const state = this.game.currentState;
        if (state && state.spawnFloatingText) {
            state.spawnFloatingText(this.worldX, this.worldY, `-${Math.ceil(damage)}`, '#ff8844');
        }
        this.game.sounds.play('hit', { volume: 0.45, x: this.worldX, y: this.worldY });
        // Embers shake loose from the armor where it's struck.
        if (state && state._spawnSparks) {
            state._spawnSparks(
                this.worldX + (Math.random() - 0.5) * 120,
                this.worldY + (Math.random() - 0.5) * 180,
                3 + Math.floor(Math.random() * 3),
                { color: Math.random() < 0.5 ? '#ffd050' : '#ff9a5a', speedMin: 120, speedMax: 340 });
        }

        if (this.health <= 0) {
            this._triggerDeathSequence();
        }
        return false; // death plays out first; _updateDying reports the kill
    }

    freeze(duration) {
        // Bosses shrug off freeze effects.
    }

    _immuneFeedback() {
        if (this._animClock - this._lastClink <= 0.09) return;
        this._lastClink = this._animClock;
        this.game.sounds.play('hit', { volume: 0.15, x: this.worldX, y: this.worldY });
        const st = this.game.currentState;
        if (st && st.spawnFloatingText) {
            st.spawnFloatingText(
                this.worldX + (Math.random() - 0.5) * 100,
                this.worldY + (Math.random() - 0.5) * 140, '0', '#9aa4ae');
        }
        if (st && st._spawnSparks) {
            st._spawnSparks(
                this.worldX + (Math.random() - 0.5) * 120,
                this.worldY + (Math.random() - 0.5) * 180,
                2, { color: '#c8d2dc', speedMin: 80, speedMax: 220 });
        }
    }

    _triggerDeathSequence() {
        this.state = SERAPH_STATE.DYING;
        this.health = 0;
        this.attack = null;
        this.activeBeam = null;
        this.formAnim = null;
        this.vx = 0;
        this.vy = 0;

        const staggers = [0, 0.35, 0.6, 0.75, 1.0, 1.15, 1.3, 1.45];
        this.deathExplosions = [];
        for (let i = 0; i < staggers.length; i++) {
            const ang = Math.random() * Math.PI * 2;
            const r = Math.random() * 90;
            const { key, totalDuration } = pickFireExplosion(this.game.assets);
            this.deathExplosions.push({
                lx: Math.cos(ang) * r,
                ly: Math.sin(ang) * r * 1.3, // the sprite is tall
                delay: staggers[i],
                fired: false,
                finished: false,
                animTimer: 0,
                fireKey: key,
                totalDuration,
                scale: 0.9 + Math.random() * 0.8
            });
        }
        this.deathTimer = staggers[staggers.length - 1] + 0.7;
    }

    _updateDying(dt) {
        this.deathTimer -= dt;
        for (const ex of this.deathExplosions) {
            if (!ex.fired) {
                ex.delay -= dt;
                if (ex.delay <= 0) {
                    ex.fired = true;
                    this.game.sounds.play('ship_explode', { volume: 0.6, x: this.worldX, y: this.worldY });
                    this.game.camera.shake(2.5);
                }
            } else if (!ex.finished) {
                ex.animTimer += dt * 1000;
                if (ex.animTimer >= ex.totalDuration) ex.finished = true;
            }
        }

        if (this.deathTimer <= 0) {
            this.game.camera.shake(6.0);
            this.alive = false;
            this.isFinished = true;
            this.state = SERAPH_STATE.FINISHED;

            const state = this.game.currentState;
            if (state) {
                // Final flash + shockwave as the body lets go.
                if (state.triggerFlash) state.triggerFlash('#ffffff', 1.2, 0.45);
                if (state.cinematics) {
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ffd050', maxR: 420, dur: 1.0, width: 6 });
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ff7a2a', maxR: 280, dur: 0.7, width: 4 });
                }
                // The yellow glow's job is done — point it home again.
                for (const body of state.getPlayerBodies ? state.getPlayerBodies() : [state.player]) {
                    if (body && body.hasYellowGlow) body.yellowGlowTarget = { x: 0, y: 0 };
                }
                if (state._onEntityDestroyed) state._onEntityDestroyed(this);
            }
            if (this.game.achievements) {
                this.game.achievements.notify('boss_defeated', { bossId: 'Seraph' });
            }
        }
    }

    getSpawnOnDeath() {
        const spawns = [];
        const rand = () => this.contentRng ? this.contentRng.next() : Math.random();

        // Shatter the open base sprite along fracture lines (it died burning).
        const asset = this.game.assets.get('seraph_base_open') || this.game.assets.get('seraph_base_closed');
        if (asset) {
            const fragments = getCachedShatter(asset, 'seraph_base_open', 100);
            for (const frag of fragments) {
                const wx = this.worldX + frag.lx;
                const wy = this.worldY + frag.ly;
                const outAngle = Math.atan2(frag.ly, frag.lx);
                const spread = 40 + Math.random() * 130;
                spawns.push(new ProceduralDebris(
                    this.game, wx, wy, frag,
                    Math.cos(outAngle) * spread, Math.sin(outAngle) * spread,
                    0, (Math.random() - 0.5) * 3,
                    4.0 + Math.random() * 2.0
                ));
                if (Math.random() < 0.5) {
                    spawns.push(new Scrap(this.game, wx, wy, Math.random() < 0.35 ? 'big' : 'small'));
                }
            }
        }

        const diff = this._diff();
        const state = this.game.currentState;
        const scrapMult = (state && state.netScrapMult) || 1.0;

        const expAmount = Math.floor(22 + 4 * diff);
        for (let i = 0; i < expAmount; i++) spawns.push(new ExpOrb(this.game, this.worldX, this.worldY, 1));

        const bigScrap = Math.round((5 + rand() * 3) * scrapMult);
        for (let i = 0; i < bigScrap; i++) {
            const ang = Math.random() * Math.PI * 2;
            const d = Math.random() * 110;
            spawns.push(new Scrap(this.game, this.worldX + Math.cos(ang) * d, this.worldY + Math.sin(ang) * d, 'big'));
        }
        const smallScrap = Math.round((7 + rand() * 5) * scrapMult);
        for (let i = 0; i < smallScrap; i++) {
            const ang = Math.random() * Math.PI * 2;
            const d = Math.random() * 90;
            spawns.push(new Scrap(this.game, this.worldX + Math.cos(ang) * d, this.worldY + Math.sin(ang) * d, 'small'));
        }

        // Boss-tier extras: batteries + a decent upgrade roll.
        const batteryData = UPGRADES.find(u => u.id === 'small_battery');
        if (batteryData) {
            const batteryCount = 1 + (rand() < 0.6 ? 1 : 0);
            for (let i = 0; i < batteryCount; i++) {
                const ang = Math.random() * Math.PI * 2;
                const d = 30 + Math.random() * 50;
                spawns.push(new ItemPickup(this.game, this.worldX + Math.cos(ang) * d, this.worldY + Math.sin(ang) * d, batteryData));
            }
        }
        if (rand() < 0.5) {
            const pool = UPGRADES.filter(u => (u.rarity === 'rare' || u.rarity === 'uncommon') && !u.consumable);
            if (pool.length > 0) {
                const pick = pool[Math.floor(rand() * pool.length)];
                const ang = Math.random() * Math.PI * 2;
                const d = 40 + Math.random() * 30;
                spawns.push(new ItemPickup(this.game, this.worldX + Math.cos(ang) * d, this.worldY + Math.sin(ang) * d, pick));
            }
        }

        return spawns;
    }

    popSpawns() {
        const spawns = [...this.pendingSpawns];
        this.pendingSpawns = [];
        return spawns;
    }

    // ─── DRAWING ───────────────────────────────────────────────────────

    _currentGifKey() {
        if (this.state === SERAPH_STATE.DYING) return this._idleKey();
        if (this.formAnim === 'opening') return 'seraph_open';
        if (this.formAnim === 'closing') return 'seraph_close';
        if (this.attack) {
            const opened = this.form === 'opened';
            switch (this.attack.type) {
                case 'a1': return opened ? 'seraph_attack_1_opened' : 'seraph_attack_1_closed';
                case 'a2': return this.attack.phase === 'cast'
                    ? (opened ? 'seraph_attack_2_opened' : 'seraph_attack_2_closed')
                    : this._idleKey();
                case 'a3': return 'seraph_attack_3_opened';
            }
        }
        return this._idleKey();
    }

    _currentFrame() {
        const gif = this._gif(this._currentGifKey());
        if (!gif || !gif.length) return null;
        return gif[Math.min(this.animFrame, gif.length - 1)];
    }

    // A genuinely blurred horizontal smear of the current frame, built once
    // per source image (at logical resolution, so it's cheap) and reused for
    // the whole flip. Seven weighted taps ≈ a horizontal box blur.
    _getFlipBlur(img, logicalW, logicalH) {
        if (this._flipBlurSrc === img) return this._flipBlurCanvas;
        const pad = 18;
        let c = this._flipBlurCanvas;
        if (!c || c.width !== logicalW + pad * 2 || c.height !== logicalH) {
            c = document.createElement('canvas');
            c.width = logicalW + pad * 2;
            c.height = logicalH;
        }
        const g = c.getContext('2d');
        g.clearRect(0, 0, c.width, c.height);
        // Center-heavy weights that overlap to a near-OPAQUE core — the smear
        // must read as a solid blurred body, not a translucent ghost.
        const taps = [[0, 0.9], [4, 0.55], [-4, 0.55], [9, 0.3], [-9, 0.3], [15, 0.14], [-15, 0.14]];
        for (const [off, a] of taps) {
            g.globalAlpha = a;
            g.drawImage(img, pad + off, 0, logicalW, logicalH);
        }
        g.globalAlpha = 1;
        this._flipBlurCanvas = c;
        this._flipBlurSrc = img;
        return c;
    }

    draw(ctx, camera) {
        if (!this.alive) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const cullPad = 600 * this.game.worldScale;
        const beamLive = this.activeBeam || (this.attack && this.attack.type === 'a3');
        if (!beamLive &&
            (screen.x < -cullPad || screen.x > this.game.width + cullPad ||
             screen.y < -cullPad || screen.y > this.game.height + cullPad)) return;

        // Aim telegraph — a faint targeting line from the eye (railgun-style).
        if (this.attack && this.attack.type === 'a3' && this.attack.phase === 'aim') {
            const targetImg = this.game.assets.get('red_laser_beam_targeting');
            if (targetImg) {
                const eye = camera.worldToScreen(this.worldX, this.worldY + EYE_OFF_Y, this.game.width, this.game.height);
                const alpha = 0.35 + 0.3 * (Math.sin(this._animClock * 25) * 0.5 + 0.5);
                this._drawTiledBeam(ctx, eye.x, eye.y, this.attack.angle, targetImg, alpha, BEAM_RANGE);
            }
        }

        const frame = this._currentFrame();
        if (frame) {
            const img = frame.canvas || frame;
            const w = (frame.width || img.width) * this.game.worldScale;
            const h = (frame.height || img.height) * this.game.worldScale;

            const t = this._animClock;
            // Constant wing-beat bob — it hovers, it never just sits.
            let drawY = screen.y + Math.sin(t * 2.1 + this._bobPhase) * 4 * this.game.worldScale;
            let drawX = screen.x;
            // Tension shiver while the swing hangs at the top of the windup.
            const a = this.attack;
            if (a && a.type === 'a1' && a.phase === 'windup' && a.timer >= a.windupDur) {
                drawX += Math.sin(t * 55) * 1.6 * this.game.worldScale;
            }

            // Blur-flip: the art faces left; facing right mirrors it. The turn
            // squashes through zero, but the mirror hides inside an actual
            // motion blur: a pre-blurred smear of the frame (_getFlipBlur) is
            // drawn in BOTH orientations, cross-fading through the turn, while
            // the crisp sprite all but vanishes at the crossover. Reads as one
            // fast spin — no readable 2D mirror, no crisp ghosts.
            const FLIP_DUR = 0.18;
            let sx = this.facing === 1 ? -1 : 1;
            let flip = null;
            if (this._flipTimer > 0) {
                const p = 1 - this._flipTimer / FLIP_DUR;
                const ease = 0.5 - 0.5 * Math.cos(Math.PI * p);
                const from = this._flipFrom === 1 ? -1 : 1;
                flip = { from, to: sx, ease, blur: Math.sin(Math.PI * ease) };
                sx = from + (sx - from) * ease;
            }
            const clampSx = (v) => Math.abs(v) < 0.06 ? (v < 0 ? -0.06 : 0.06) : v;

            ctx.save();
            ctx.translate(drawX, drawY);
            // Always upright — the Seraph never rotates (it only mirrors).
            if (flip && flip.blur > 0.05) {
                const b = flip.blur;
                const blurC = this._getFlipBlur(img, frame.width || img.width, frame.height || img.height);
                const bw = blurC.width * this.game.worldScale;
                const bh = blurC.height * this.game.worldScale;
                // SOLID through the turn: normal (source-over) passes whose
                // alphas overshoot so their union stays ~1 at the crossover —
                // the body never fades, it just blurs while it whips around.
                const squish = 0.86 + 0.14 * (1 - b);
                const clamp01 = (v) => Math.max(0, Math.min(1, v));
                const passes = [
                    { sgn: flip.from, alpha: clamp01(1.6 * (1 - flip.ease)) * b },
                    { sgn: flip.to, alpha: clamp01(1.6 * flip.ease) * b }
                ];
                for (const ps of passes) {
                    if (ps.alpha <= 0.02) continue;
                    ctx.save();
                    ctx.globalAlpha = ps.alpha;
                    ctx.scale(ps.sgn * squish, 1);
                    ctx.drawImage(blurC, -bw / 2, -bh / 2, bw, bh);
                    ctx.restore();
                }
            }
            ctx.save();
            let bodyAlpha = flip ? 1 - 0.35 * flip.blur : 1;
            // Rage-ignition invulnerability strobes the body — the classic
            // "can't touch this right now" phasing flicker.
            if (this.rageInvulnTimer > 0 && Math.floor(this._animClock * 12) % 2 === 0) {
                bodyAlpha *= 0.35;
            }
            ctx.globalAlpha = bodyAlpha;
            ctx.scale(clampSx(sx), 1);
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
            ctx.restore();

            if (this.state === SERAPH_STATE.DYING && this.deathExplosions) {
                for (const ex of this.deathExplosions) {
                    if (!ex.fired || ex.finished) continue;
                    const frameImg = fireExplosionFrame(this.game.assets.get(ex.fireKey), ex.animTimer);
                    if (!frameImg) continue;
                    const ew = (frameImg.width || frameImg.canvas.width / 4) * this.game.worldScale * ex.scale;
                    const eh = (frameImg.height || frameImg.canvas.height / 4) * this.game.worldScale * ex.scale;
                    ctx.drawImage(frameImg.canvas || frameImg,
                        ex.lx * this.game.worldScale - ew / 2,
                        ex.ly * this.game.worldScale - eh / 2, ew, eh);
                }
            }
            ctx.restore();
        }

        // The fire beam draws OVER the body — it erupts from the eye, it
        // doesn't peek out from behind the wings.
        if (this.activeBeam) this._drawFireBeam(ctx, camera, this.activeBeam);
    }

    // Start cap at the eye + tiled segments, all frame-synced to the burst.
    _drawFireBeam(ctx, camera, beam) {
        const startGif = this._gif('fire_beam_start');
        const segGif = this._gif('fire_beam');
        if (!startGif || !startGif.length) return;

        const f = Math.min(beam.frame, startGif.length - 1);
        const startFrame = startGif[f];
        const segFrame = segGif && segGif.length ? segGif[Math.min(f, segGif.length - 1)] : null;

        const eye = camera.worldToScreen(this.worldX, this.worldY + EYE_OFF_Y, this.game.width, this.game.height);
        const ws = this.game.worldScale;

        ctx.save();
        ctx.translate(eye.x, eye.y);
        ctx.rotate(beam.angle);

        // Segments first so the start cap overlaps their seam.
        if (segFrame) {
            const tw = (segFrame.width || segFrame.canvas.width) * ws;
            const th = (segFrame.height || segFrame.canvas.height) * ws;
            const startX = ((startFrame.width || 59) * 0.7) * ws;
            ctx.save();
            ctx.translate(startX, 0);
            drawBeamStrip(ctx, segFrame, tw, th, BEAM_RANGE * ws - startX);
            ctx.restore();
        }

        const startImg = startFrame.canvas || startFrame;
        const sw = (startFrame.width || startImg.width) * ws;
        const sh = (startFrame.height || startImg.height) * ws;
        ctx.drawImage(startImg, -sw * 0.2, -sh / 2, sw, sh);

        ctx.restore();
    }

    _drawTiledBeam(ctx, x, y, angle, img, alpha, range) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);
        ctx.rotate(angle);
        const canvas = img.canvas || img;
        const tileW = (img.width || canvas.width) * this.game.worldScale;
        const tileH = (img.height || canvas.height) * this.game.worldScale;
        drawBeamStrip(ctx, img, tileW, tileH, range * this.game.worldScale);
        ctx.restore();
    }
}
