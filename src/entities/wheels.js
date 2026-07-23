import { Scrap, ItemPickup, ExpOrb, ProceduralDebris, getCachedShatter } from './asteroid.js';
import { UPGRADES } from '../data/upgrades.js';
import { ellipseContains } from '../engine/collision.js';
import { Projectile } from './projectile.js';
import { pickFireExplosion, fireExplosionFrame } from '../engine/vfx.js';

export const WHEELS_STATE = {
    IDLE: 'wheels_idle',   // Pre-fight tick-over, invulnerable (never 'dormant' —
    FIGHT: 'fight',        // that string would trip the Cthulhu ram-wake loop)
    DYING: 'dying',
    FINISHED: 'finished'
};

// Attack phases within FIGHT (this.attack.type / .phase)
//   charge: windup (recoil + brake + shiver) → dash (explosive launch, chains)
//   spin:   gather (anim + rotation ramp up) → spin (angular blur, fireball spray)

// The fire kernel is caged by the rings: its lag offset can never exceed this
// (logical px). The rings are 144×144, so ~26 keeps it visibly inside.
const CAGE_R = 26;

// The third boss — found by following the yellow glow after the Burning Seraph
// falls. The classic wheel-within-a-wheel: two rings of eyes (back + front
// layers, animated and moving in unison) caging a fire that trails behind the
// motion. A lull after the Seraph: no immunity windows, no gates — just an
// extremely fast, heavy-hitting clockwork that charges constantly and
// occasionally spins itself into a fireball storm. Its rotation is pure
// mechanism ("ticks" around like an escapement) and is fully independent of
// its direction of travel.
export class Wheels {
    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.vx = 0;
        this.vy = 0;
        this.alive = true;
        this.state = WHEELS_STATE.IDLE;
        this.radius = 66;

        // Near-circular ellipse hitbox fitted from the composite still. The
        // rings rotate but the silhouette is round — a fixed rotation is exact.
        this.spriteKey = 'wheels_base';
        this.hitRotAbs = 0;

        this.displayName = 'Wheels Within Wheels';
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

        // Animation: back + front rings run the SAME frame index (they animate
        // in unison); the fire kernel free-runs its own loop. animSpeed scales
        // the gif delays (spin-up = the whole mechanism racing).
        this.animFrame = 0;
        this.animTimer = 0;
        this.fireFrame = 0;
        this.fireTimer = 0;
        this.animSpeed = 1;

        // Rotation is a mechanism, not steering. Between attacks an escapement
        // "tick" kicks _rotVel in _tickDir and the impulse decays to a stop;
        // attacks override _rotVel directly (fast continuous spin).
        this.rot = Math.random() * Math.PI * 2;
        this._rotVel = 0;
        this._tickTimer = 1.0;
        this._tickDir = Math.random() < 0.5 ? -1 : 1;

        // The fire kernel: lag offset behind the rings (world units, capped to
        // the cage) + a decaying world-space trail of flame.
        this.fireOffX = 0;
        this.fireOffY = 0;
        this._prevX = worldX;
        this._prevY = worldY;
        this.trail = [];               // {x, y, age}
        this._trailAccum = 0;

        // Movement
        this.orbitAngle = Math.random() * Math.PI * 2;
        this.orbitDir = Math.random() > 0.5 ? 1 : -1;
        this._orbitFlipTimer = 4 + Math.random() * 4;
        this._bobPhase = Math.random() * Math.PI * 2;
        // Sim-driven animation clock for all cosmetic motion. Never use
        // performance.now()/Date.now() in draw — the world still draws under
        // the pause menu and wall-clock motion won't freeze.
        this._animClock = 0;
        this.swoopTimer = 0;
        this.swoopCooldown = 0;
        this.swoopTX = 0;
        this.swoopTY = 0;
        this._repositionTimer = 1.0;
        this._joltTimer = 0;

        // Attacks
        this.attack = null;            // {type, phase, timer, ...}
        this.attackCooldown = 3.0;
        this._contactHits = new Map(); // body → last _animClock a touch hurt them

        // Death sequence (boss-style staggered explosions)
        this.deathExplosions = null;
        this.deathTimer = 0;
    }

    // ─── SMALL HELPERS ─────────────────────────────────────────────────

    get isActive() {
        // Never freezes world spawning.
        return false;
    }

    get isAttackable() {
        // The whole point of this fight: no gates, no immunity windows. If you
        // can land a shot on something this fast, it counts.
        return !this.invulnerable && this.state === WHEELS_STATE.FIGHT;
    }

    // Live local pilots this fight can hurt. Multiplayer: the Wheels is a
    // locally-scripted event (LOCAL_SCRIPTED_EVENTS), so only the local pilot.
    // ALLY MODE (the dragon fight): the wheels turn FOR the player — the same
    // AI, rams and fireball storms, aimed at the dragon head they're dueling.
    _bodies() {
        if (this.allyMode) {
            const t = this.allyTarget;
            return t && t.alive && t.state === 'fight' ? [t] : [];
        }
        const state = this.game.currentState;
        if (!state) return [];
        if (!state.netSync && state.localPlayers && state.localPlayers.length > 1) {
            return state.localPlayers.map(s => s.player).filter(p => p && !p.dead);
        }
        return state.player && !state.player.dead ? [state.player] : [];
    }

    _hurt(body, dmg, x, y) {
        if (this.allyMode) {
            // Dueling a head, the Wheels grind at double weight — the angels
            // are executioners, not decoration.
            if (body && body.hit) body.hit(dmg * 2);
            return;
        }
        const state = this.game.currentState;
        if (!state) return;
        if (!state.netSync && state.damagePlayerBody) state.damagePlayerBody(body, dmg, x, y);
        else state._damagePlayer(dmg, x, y);
    }

    _diff() {
        return (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
    }

    // Half-viewport extents in world units.
    _viewHalf() {
        const ws = this.game.worldScale || 1;
        return { w: (this.game.width / 2) / ws, h: (this.game.height / 2) / ws };
    }

    _gif(key) {
        return this.game.assets.get(key);
    }

    _fireX() { return this.worldX + this.fireOffX; }
    _fireY() { return this.worldY + this.fireOffY; }

    // ─── UPDATE ────────────────────────────────────────────────────────

    update(dt, player) {
        if (!this.alive) return;
        this._animClock += dt;

        if (this.state === WHEELS_STATE.DYING) {
            this._updateRings(dt);
            this._updateFire(dt, true);
            this._updateDying(dt);
            return;
        }
        if (this.state === WHEELS_STATE.FINISHED) return;

        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (!this.revealed && dist < 3500) this.revealed = true;

        if (this.state === WHEELS_STATE.IDLE) {
            this.animSpeed = 1;
            this._updateRings(dt);
            this._updateFire(dt, false);
            // Tick over in place — a clock nobody has wound in a long time.
            this.worldX += Math.cos(this.orbitAngle + this._animClock / 2.6) * 5 * dt;
            this.worldY += Math.sin(this._animClock / 2.1) * 7 * dt;
            if (dist < 1150) this._startFight();
            return;
        }

        // ── FIGHT ──
        if (this.attack) {
            this._updateAttack(dt, player, dist);
        } else {
            this.animSpeed = 1;
            this._moveFloat(dt, player, dist, 1.0);
            this._updateSwoop(dt, player, dist);
            this._updateReposition(dt, player);
            this.attackCooldown -= dt;
            if (this.attackCooldown <= 0 && this.swoopTimer <= 0) {
                this._pickAttack(player, dist);
            }
        }

        this._updateRings(dt);
        this._updateFire(dt, true);
        this._updateContact(player);
    }

    // Rotation mechanism + ring animation. Attacks write _rotVel directly;
    // otherwise the escapement ticks it around and the impulse bleeds off.
    _updateRings(dt) {
        const spinning = this.attack && (
            (this.attack.type === 'spin') ||
            (this.attack.type === 'charge' && this.attack.phase === 'dash'));

        if (!spinning && this.state !== WHEELS_STATE.DYING) {
            // Escapement: sharp impulse, fast decay — tick... tick... tick.
            this._tickTimer -= dt;
            if (this._tickTimer <= 0) {
                this._tickTimer = 0.45 + Math.random() * 0.35;
                if (Math.random() < 0.12) this._tickDir = -this._tickDir;
                this._rotVel += this._tickDir * 3.4;
                this.game.sounds.play('click', { volume: 0.3, x: this.worldX, y: this.worldY });
            }
            this._rotVel *= Math.pow(0.86, dt * 60);
        }
        this.rot += this._rotVel * dt;

        // Back + front advance together — one mechanism, one clock.
        const gif = this._gif('wheels_back');
        if (gif && gif.length) {
            this.animTimer += dt * 1000 * this.animSpeed;
            const frame = gif[Math.min(this.animFrame, gif.length - 1)];
            if (frame && this.animTimer >= (frame.delay || 100)) {
                this.animTimer = 0;
                this.animFrame = (this.animFrame + 1) % gif.length;
            }
        }
        const fireGif = this._gif('wheels_fire');
        if (fireGif && fireGif.length) {
            this.fireTimer += dt * 1000 * Math.max(1, this.animSpeed * 0.8);
            const frame = fireGif[Math.min(this.fireFrame, fireGif.length - 1)];
            if (frame && this.fireTimer >= (frame.delay || 100)) {
                this.fireTimer = 0;
                this.fireFrame = (this.fireFrame + 1) % fireGif.length;
            }
        }
    }

    // The fire kernel drags behind the rings' motion (capped to the cage) and
    // sheds a world-anchored trail. During the spin it's flung to the cage wall
    // and whipped around — the trail draws a circle of fire.
    _updateFire(dt, trailOn) {
        const mvX = this.worldX - this._prevX;
        const mvY = this.worldY - this._prevY;
        this._prevX = this.worldX;
        this._prevY = this.worldY;

        const spinAtk = this.attack && this.attack.type === 'spin' && this.attack.phase === 'spin';
        if (spinAtk) {
            // Centrifuge: pinned to the cage wall, riding the spin.
            const a = this.rot * 1.35;
            const decay = Math.min(1, 6 * dt);
            this.fireOffX += (Math.cos(a) * CAGE_R * 0.85 - this.fireOffX) * decay;
            this.fireOffY += (Math.sin(a) * CAGE_R * 0.85 - this.fireOffY) * decay;
        } else {
            // Lag: world movement drags it toward the trailing edge, then it
            // springs home. Clamped so it always stays inside the rings.
            this.fireOffX -= mvX * 0.55;
            this.fireOffY -= mvY * 0.55;
            const spring = Math.pow(0.94, dt * 60);
            this.fireOffX *= spring;
            this.fireOffY *= spring;
            const m = Math.sqrt(this.fireOffX * this.fireOffX + this.fireOffY * this.fireOffY);
            if (m > CAGE_R) {
                this.fireOffX *= CAGE_R / m;
                this.fireOffY *= CAGE_R / m;
            }
        }

        // Trail: fixed world points that age out — fire hangs where it flew.
        const TRAIL_LIFE = 0.45;
        for (let i = this.trail.length - 1; i >= 0; i--) {
            this.trail[i].age += dt;
            if (this.trail[i].age >= TRAIL_LIFE) this.trail.splice(i, 1);
        }
        if (!trailOn) return;
        const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (speed > 260 || spinAtk) {
            this._trailAccum += dt;
            if (this._trailAccum > 0.028) {
                this._trailAccum = 0;
                this.trail.push({ x: this._fireX(), y: this._fireY(), age: 0 });
                if (this.trail.length > 48) this.trail.shift();
            }
        }
    }

    // A wheel of this mass at these speeds is a weapon all by itself: touching
    // it hurts, and getting run over by a charge hurts a LOT. Per-body touch
    // i-frames keep it from grinding a pinned player to paste in one second.
    _updateContact(player) {
        const dashing = this.attack && this.attack.type === 'charge' && this.attack.phase === 'dash';
        const full = Math.min(80, 42 + 6 * this._diff());
        const dmg = dashing ? full : Math.round(full * 0.55);
        const state = this.game.currentState;
        for (const body of this._bodies()) {
            const last = this._contactHits.get(body) || -10;
            if (this._animClock - last < 0.9) continue;
            if (!ellipseContains(this, body.worldX, body.worldY, body.radius)) continue;
            this._contactHits.set(body, this._animClock);
            this._hurt(body, dmg, this.worldX, this.worldY);
            if (state && state._applyKnockback) {
                const kdx = body.worldX - this.worldX;
                const kdy = body.worldY - this.worldY;
                state._applyKnockback(kdx, kdy, Math.sqrt(kdx * kdx + kdy * kdy), dashing ? 420 : 260, body);
            }
            this.game.camera.shake(dashing ? 1.4 : 0.8);
            this.game.sounds.play('hit', { volume: 0.7, x: this.worldX, y: this.worldY });
        }
    }

    // ─── MOVEMENT ──────────────────────────────────────────────────────

    // Same bones as the Seraph's float (orbit + lissajous + screen spring) but
    // tuned hot: it hovers closer, pulls harder, and its baseline speed floor
    // is high — even "resting" it whips around the screen.
    _moveFloat(dt, player, dist, agility) {
        const pSpeed = Math.sqrt((player.vx || 0) ** 2 + (player.vy || 0) ** 2);

        this.orbitAngle += this.orbitDir * (0.45 + Math.min(0.6, pSpeed * 0.0006)) * dt;
        this._orbitFlipTimer -= dt;
        if (this._orbitFlipTimer <= 0) {
            this._orbitFlipTimer = 3 + Math.random() * 3;
            if (Math.random() < 0.5) this.orbitDir = -this.orbitDir;
        }

        const t = this._animClock + this._bobPhase;
        const hoverDist = 340;
        const tx = player.worldX + Math.cos(this.orbitAngle) * hoverDist + Math.cos(t * 1.9) * 40;
        const ty = player.worldY + Math.sin(this.orbitAngle) * hoverDist + Math.sin(t * 2.6) * 46;
        const toX = tx - this.worldX;
        const toY = ty - this.worldY;
        const toDist = Math.sqrt(toX * toX + toY * toY) || 1;

        const far = toDist > 450;
        const pull = (far ? 1900 : Math.min(950, toDist * 2.2)) * agility;
        this.vx += (toX / toDist) * pull * dt;
        this.vy += (toY / toDist) * pull * dt;

        // Screen spring: shove back toward the view past ~80% of half-extents.
        const half = this._viewHalf();
        const relX = this.worldX - player.worldX;
        const relY = this.worldY - player.worldY;
        const limX = half.w * 0.82, limY = half.h * 0.78;
        let overshoot = 0;
        if (Math.abs(relX) > limX) {
            const over = Math.abs(relX) - limX;
            overshoot = Math.max(overshoot, over);
            this.vx -= Math.sign(relX) * over * 7.0 * dt;
        }
        if (Math.abs(relY) > limY) {
            const over = Math.abs(relY) - limY;
            overshoot = Math.max(overshoot, over);
            this.vy -= Math.sign(relY) * over * 7.0 * dt;
        }

        if (this._joltTimer > 0) this._joltTimer -= dt;

        let maxV = Math.max(520, pSpeed * 1.3);
        if (overshoot > 0) maxV = Math.max(maxV, 1100 + overshoot * 2);
        if (this._joltTimer > 0) maxV = Math.max(maxV, 2100);
        if (this.swoopTimer > 0) maxV = 3600;
        const vel = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (vel > maxV) {
            this.vx = (this.vx / vel) * maxV;
            this.vy = (this.vy / vel) * maxV;
        }

        const friction = Math.pow(
            this.swoopTimer > 0 || this._joltTimer > 0 ? 0.975 : (far || overshoot > 0 ? 0.968 : 0.94), dt * 60);
        this.vx *= friction;
        this.vy *= friction;

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
    }

    // Near-constant darting jolts — it prowls at speeds nothing else flies at.
    _updateReposition(dt, player) {
        this._repositionTimer -= dt;
        if (this._repositionTimer > 0 || this.swoopTimer > 0) return;

        const ang = Math.random() * Math.PI * 2;
        const d = 220 + Math.random() * 280;
        const tx = player.worldX + Math.cos(ang) * d;
        const ty = player.worldY + Math.sin(ang) * d;
        const toX = tx - this.worldX;
        const toY = ty - this.worldY;
        const toDist = Math.sqrt(toX * toX + toY * toY) || 1;
        if (toDist > 120) {
            const speed = 1500 + Math.random() * 700;
            this.vx = (toX / toDist) * speed;
            this.vy = (toY / toDist) * speed;
            this._joltTimer = 0.45;
            this.orbitDir = Math.random() > 0.5 ? 1 : -1;
            this.game.sounds.play('boost', { volume: 0.3, x: this.worldX, y: this.worldY });
        }
        this._repositionTimer = 0.55 + Math.random() * 0.75;
    }

    // Hard catch-up lunge for when it's genuinely lost off-screen.
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

        const half = this._viewHalf();
        const offX = Math.abs(this.worldX - player.worldX) > half.w + this.radius;
        const offY = Math.abs(this.worldY - player.worldY) > half.h + this.radius;
        if (!offX && !offY) return;

        const lead = 0.45;
        const tx = player.worldX + (player.vx || 0) * lead;
        const ty = player.worldY + (player.vy || 0) * lead;
        const ang = Math.atan2(this.worldY - ty, this.worldX - tx);
        this.swoopTX = tx + Math.cos(ang) * 320;
        this.swoopTY = ty + Math.sin(ang) * 320;

        const toX = this.swoopTX - this.worldX;
        const toY = this.swoopTY - this.worldY;
        const toDist = Math.sqrt(toX * toX + toY * toY) || 1;
        const speed = Math.max(1600, Math.min(3400, 1200 + toDist * 0.6));
        this.vx = (toX / toDist) * speed;
        this.vy = (toY / toDist) * speed;
        this.swoopTimer = 0.8;
        this.swoopCooldown = 0.6;
        this.game.sounds.play('boost', { volume: 0.45, x: this.worldX, y: this.worldY });
    }

    // ─── FIGHT FLOW ────────────────────────────────────────────────────

    _startFight() {
        this.state = WHEELS_STATE.FIGHT;
        this.invulnerable = false;
        this.fightStarted = true;
        this.attackCooldown = 0.8;

        // Post-Yellow One tuning: same pool as the Seraph, scaling LINEARLY
        // with difficulty — but no gates. Pure damage race against pure speed.
        const diff = this._diff();
        this.health = 4200 + 1000 * diff;
        this.maxHealth = this.health;

        // Ally mode (dragon fight): the dragon's own song is already playing.
        if (!this.allyMode) this.game.sounds.playSpecificMusic('Wheels Within Wheels');
        this.game.sounds.play('shield_break', { volume: 0.7, x: this.worldX, y: this.worldY });
        this.game.camera.shake(2.0);

        const state = this.game.currentState;
        if (state) {
            if (state.triggerFlash) state.triggerFlash('#ffcc44', 1.0, 0.35);
            if (state.cinematics) {
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ffcc44', maxR: 260, dur: 0.7, width: 5 });
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ff7a2a', maxR: 170, dur: 0.5, width: 3 });
            }
            if (state._spawnSparks) {
                state._spawnSparks(this.worldX, this.worldY, 18, { color: '#ffb347', speedMin: 180, speedMax: 520 });
            }
        }
    }

    _pickAttack(player, dist) {
        // It charges a TON. The spin is the palate cleanser, not the main dish.
        if (Math.random() < 0.7) this._startCharge(player, 1 + Math.floor(Math.random() * 3));
        else this._startSpin(player);
    }

    _endAttack() {
        this.attack = null;
        this.animSpeed = 1;
        // Barely breathes — the lull boss is a lull in MECHANICS, not in tempo.
        this.attackCooldown = 0.4 + Math.random() * 0.7;
        this._repositionTimer = Math.min(this._repositionTimer, 0.3);
    }

    // ─── ATTACK: charge (chains) ───────────────────────────────────────

    _startCharge(player, chain, compressed) {
        // Telegraph compresses with difficulty; chained follow-up charges get
        // a shorter (but still weighted) coil — you've already been warned once.
        const tele = Math.max(0.5, 1 - (this._diff() - 1) * 0.1) * (compressed ? 0.55 : 1);
        this.attack = {
            type: 'charge',
            phase: 'windup',
            timer: 0,
            windupDur: 0.55 * tele,
            pauseDur: 0.28 * tele,
            dashDur: 0.75,
            dashSpeed: 2900 + Math.random() * 500,
            chain: chain,              // dashes left INCLUDING this one
            sparkAccum: 0,
            pauseCued: false
        };
        this.game.sounds.play('railgun_target', { volume: 0.45, x: this.worldX, y: this.worldY });
    }

    _updateCharge(dt, player, dist) {
        const a = this.attack;
        a.timer += dt;
        const state = this.game.currentState;

        if (a.phase === 'windup') {
            const p = Math.min(1, a.timer / a.windupDur);
            // The mechanism audibly winds: anim + rotation accelerate through
            // the coil — a spring being cranked past its stop.
            this.animSpeed = 1 + p * 1.2;
            this._rotVel += this._tickDir * 2.2 * dt / Math.max(0.2, a.windupDur);

            const ang = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
            if (a.timer < a.windupDur) {
                // The coil: recoil away from the player, easing off.
                const recoil = 420 * (1 - p * 0.6);
                this.vx += -Math.cos(ang) * recoil * dt;
                this.vy += -Math.sin(ang) * recoil * dt;
                const friction = Math.pow(0.92, dt * 60);
                this.vx *= friction;
                this.vy *= friction;

                // Embers spill from the cage while it winds — the tell.
                a.sparkAccum += dt;
                if (state && state._spawnSparks && a.sparkAccum > 0.08) {
                    a.sparkAccum = 0;
                    state._spawnSparks(this._fireX(), this._fireY(), 1 + Math.floor(Math.random() * 2), {
                        dir: -Math.PI / 2, spread: 2.6,
                        color: Math.random() < 0.5 ? '#ffd050' : '#ff7a2a',
                        speedMin: 40, speedMax: 150
                    });
                }
            } else {
                // Hard brake — the held breath before the wheel drops.
                if (!a.pauseCued) {
                    a.pauseCued = true;
                    this.game.sounds.play('railgun_target', { volume: 0.6, x: this.worldX, y: this.worldY });
                }
                const brake = Math.pow(0.74, dt * 60);
                this.vx *= brake;
                this.vy *= brake;
            }
            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;

            if (a.timer >= a.windupDur + a.pauseDur) {
                a.phase = 'dash';
                a.timer = 0;
                // Launch through a slightly-led player position — overshoot far
                // past them, explosive start, gentle bleed.
                const lead = 0.1;
                const ddx = player.worldX + (player.vx || 0) * lead - this.worldX;
                const ddy = player.worldY + (player.vy || 0) * lead - this.worldY;
                const dl = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
                this.vx = (ddx / dl) * a.dashSpeed;
                this.vy = (ddy / dl) * a.dashSpeed;
                // The wheel ROLLS through the charge — flat-out spin, direction
                // picked from the launch side, angular blur does the talking.
                this._tickDir = ddx >= 0 ? 1 : -1;
                this._rotVel = this._tickDir * 13;
                this.animSpeed = 2.4;
                this.game.sounds.play('boost', { volume: 0.9, x: this.worldX, y: this.worldY });
                this.game.camera.shake(1.1);
                if (state && state._spawnSparks) {
                    state._spawnSparks(this.worldX, this.worldY, 10, {
                        dir: Math.atan2(this.vy, this.vx), spread: 0.9,
                        color: '#ffb347', speedMin: 200, speedMax: 520
                    });
                }
                if (state && state.cinematics) {
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ffcc44', maxR: 130, dur: 0.35, width: 4 });
                }
            }
            return;
        }

        // Dash: the launch speed bleeds off gently — it carries FAR.
        const swingDrag = Math.pow(0.978, dt * 60);
        this.vx *= swingDrag;
        this.vy *= swingDrag;
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Embers shed from the whole silhouette, biased to the trailing edge.
        a.sparkAccum += dt;
        if (state && state._spawnSparks && a.sparkAccum > 0.035) {
            a.sparkAccum = 0;
            const va = Math.atan2(this.vy, this.vx);
            const bursts = 2 + Math.floor(Math.random() * 3);
            for (let i = 0; i < bursts; i++) {
                const ba = Math.random() * Math.PI * 2;
                const br = Math.random() * 62;
                const back = 15 + Math.random() * 35;
                state._spawnSparks(
                    this.worldX + Math.cos(ba) * br - Math.cos(va) * back,
                    this.worldY + Math.sin(ba) * br - Math.sin(va) * back,
                    1 + Math.floor(Math.random() * 2), {
                        dir: va + Math.PI, spread: 0.9,
                        color: Math.random() < 0.5 ? '#ffd050' : '#ff7a2a',
                        speedMin: 100, speedMax: 360
                    });
            }
        }

        if (a.timer >= a.dashDur) {
            this._rotVel = this._tickDir * 4; // spin winds down into ticks
            if (a.chain > 1) {
                // Chain: wheel barely settles before coiling again.
                this._startCharge(player, a.chain - 1, true);
            } else {
                this._endAttack();
            }
        }
    }

    // ─── ATTACK: spin (fireball storm) ─────────────────────────────────

    _startSpin(player) {
        const tele = Math.max(0.5, 1 - (this._diff() - 1) * 0.1);
        this.attack = {
            type: 'spin',
            phase: 'gather',
            timer: 0,
            gatherDur: 0.45 * tele,
            spinDur: 2.2 + Math.random() * 0.8,
            emitAngle: Math.random() * Math.PI * 2,
            emitAccum: 0,
            thrown: 0
        };
        this.game.sounds.play('railgun_target', { volume: 0.6, x: this.worldX, y: this.worldY });
    }

    _updateSpin(dt, player, dist) {
        const a = this.attack;
        a.timer += dt;
        const state = this.game.currentState;
        const diff = this._diff();

        if (a.phase === 'gather') {
            // Wind up on the spot: rotation + animation race upward while it
            // brakes — everything about the machine says "get away from me".
            const p = Math.min(1, a.timer / a.gatherDur);
            this.animSpeed = 1 + p * 1.8;
            this._rotVel += (this._tickDir * 11 - this._rotVel) * Math.min(1, 5 * dt);
            const brake = Math.pow(0.88, dt * 60);
            this.vx *= brake;
            this.vy *= brake;
            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;

            if (state && state._spawnSparks && Math.random() < 0.45) {
                const ga = Math.random() * Math.PI * 2;
                state._spawnSparks(this.worldX + Math.cos(ga) * 120, this.worldY + Math.sin(ga) * 120, 2,
                    { dir: ga + Math.PI, spread: 0.2, color: '#ffb347', speedMin: 260, speedMax: 420 });
            }

            if (a.timer >= a.gatherDur) {
                a.phase = 'spin';
                a.timer = 0;
                this.game.camera.shake(1.2);
                this.game.sounds.play('railgun_shoot', { volume: 0.7, x: this.worldX, y: this.worldY });
                if (state && state.cinematics) {
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ff7a2a', maxR: 220, dur: 0.5, width: 5 });
                }
            }
            return;
        }

        // Full spin: angular-blur speed, the whole animation racing, fire
        // whipping around the cage, fireballs slung off the rim in a spiral.
        this.animSpeed = 2.8;
        this._rotVel += (this._tickDir * 15 - this._rotVel) * Math.min(1, 6 * dt);

        // It doesn't park while it spins — it grinds toward the player like a
        // sawblade walking across a table.
        const ang = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
        this.vx += Math.cos(ang) * 520 * dt;
        this.vy += Math.sin(ang) * 520 * dt;
        const maxV = 300;
        const vel = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (vel > maxV) {
            this.vx = (this.vx / vel) * maxV;
            this.vy = (this.vy / vel) * maxV;
        }
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Spiral fireball sling: a rotating emitter, tight cadence, every
        // fourth ball gets a whiff of homing so orbiting the storm isn't free.
        a.emitAccum += dt;
        const cadence = Math.max(0.07, 0.13 - diff * 0.006);
        while (a.emitAccum >= cadence) {
            a.emitAccum -= cadence;
            a.emitAngle += 2.4; // big golden-angle-ish step — spiral, not a fan
            if (state && state.projectiles) {
                const jitter = (Math.random() - 0.5) * 0.18;
                const speed = 430 + Math.random() * 220;
                const dmg = 14 + 3 * diff;
                const proj = new Projectile(this.game, this._fireX(), this._fireY(),
                    a.emitAngle + jitter, speed, 'fireball', this, dmg, 3.2);
                proj.spriteRotOffset = 0; // fireball art faces right
                if (a.thrown % 4 === 3) {
                    const bodies = this._bodies();
                    proj.target = bodies.length ? bodies[a.thrown % bodies.length] : player;
                    proj.turnRate = 0.5 + Math.random() * 0.3;
                }
                state.projectiles.push(proj);
            }
            a.thrown++;
            if (a.thrown % 3 === 0) {
                this.game.sounds.play('laser', { volume: 0.3, x: this.worldX, y: this.worldY });
            }
        }

        if (a.timer >= a.spinDur) {
            this._rotVel = this._tickDir * 4;
            this._endAttack();
        }
    }

    _updateAttack(dt, player, dist) {
        switch (this.attack.type) {
            case 'charge': this._updateCharge(dt, player, dist); break;
            case 'spin': this._updateSpin(dt, player, dist); break;
        }
    }

    // ─── DAMAGE / DEATH ────────────────────────────────────────────────

    hit(damage) {
        if (this.invulnerable || this.state !== WHEELS_STATE.FIGHT) return false;

        this.health -= damage;

        const state = this.game.currentState;
        if (state && state.spawnFloatingText) {
            state.spawnFloatingText(this.worldX, this.worldY, `-${Math.ceil(damage)}`, '#ff8844');
        }
        this.game.sounds.play('hit', { volume: 0.45, x: this.worldX, y: this.worldY });
        if (state && state._spawnSparks) {
            state._spawnSparks(
                this.worldX + (Math.random() - 0.5) * 120,
                this.worldY + (Math.random() - 0.5) * 120,
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

    _triggerDeathSequence() {
        this.state = WHEELS_STATE.DYING;
        this.health = 0;
        this.attack = null;
        this.vx = 0;
        this.vy = 0;
        this.animSpeed = 3.2;
        // The governor is gone: the mechanism overspins itself to pieces
        // (_updateDying keeps accelerating the rotation until the end).
        this._rotVel = this._tickDir * 6;

        const staggers = [0, 0.3, 0.55, 0.7, 0.95, 1.1, 1.25, 1.4];
        this.deathExplosions = [];
        for (let i = 0; i < staggers.length; i++) {
            const ang = Math.random() * Math.PI * 2;
            const r = Math.random() * 60;
            const { key, totalDuration } = pickFireExplosion(this.game.assets);
            this.deathExplosions.push({
                lx: Math.cos(ang) * r,
                ly: Math.sin(ang) * r,
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
        // Runaway flywheel — spin keeps climbing until the final blast.
        this._rotVel *= Math.pow(1.9, dt);
        this._rotVel = Math.max(-26, Math.min(26, this._rotVel));

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
            this.state = WHEELS_STATE.FINISHED;

            const state = this.game.currentState;
            if (state) {
                if (state.triggerFlash) state.triggerFlash('#ffffff', 1.2, 0.45);
                if (state.cinematics) {
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ffd050', maxR: 420, dur: 1.0, width: 6 });
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ff7a2a', maxR: 280, dur: 0.7, width: 4 });
                    // A herald announces the fall of one of heaven's own.
                    if (state.cinematics.trumpetFanfare) {
                        state.cinematics.trumpetFanfare(this.worldX, this.worldY);
                    }
                }
                // The chain goes on: somewhere out in the dark, something is
                // building a nest. The glow swings onto the Hive. (Post-dragon
                // ECHO Wheels are relics, not chain links — their deaths touch
                // neither the chain nor the glow.)
                if (!this.isEcho) {
                    if (state._spawnHiveAfterWheels) {
                        state._spawnHiveAfterWheels();
                    } else {
                        for (const body of state.getPlayerBodies ? state.getPlayerBodies() : [state.player]) {
                            if (body && body.hasYellowGlow) body.yellowGlowTarget = { x: 0, y: 0 };
                        }
                    }
                }
                if (state._onEntityDestroyed) state._onEntityDestroyed(this);
            }
            if (this.game.achievements) {
                this.game.achievements.notify('boss_defeated', { bossId: 'Wheels' });
            }
        }
    }

    getSpawnOnDeath() {
        const spawns = [];
        const rand = () => this.contentRng ? this.contentRng.next() : Math.random();

        // Shatter the composite still along fracture lines.
        const asset = this.game.assets.get('wheels_base');
        if (asset) {
            const fragments = getCachedShatter(asset, 'wheels_base', 90);
            for (const frag of fragments) {
                const wx = this.worldX + frag.lx;
                const wy = this.worldY + frag.ly;
                const outAngle = Math.atan2(frag.ly, frag.lx);
                const spread = 40 + Math.random() * 130;
                spawns.push(new ProceduralDebris(
                    this.game, wx, wy, frag,
                    Math.cos(outAngle) * spread, Math.sin(outAngle) * spread,
                    0, (Math.random() - 0.5) * 4,
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

    // ─── DRAWING ───────────────────────────────────────────────────────

    _frameOf(key, idx) {
        const gif = this._gif(key);
        if (!gif || !gif.length) return null;
        return gif[Math.min(idx, gif.length - 1)];
    }

    // One ring layer, rotated by the mechanism. Above ~5 rad/s the eyes smear:
    // ghost copies at trailing angular offsets under a solid body — the blur
    // stays inside the silhouette and the body never goes translucent.
    _drawRing(ctx, frame, x, y) {
        const img = frame.canvas || frame;
        const w = (frame.width || img.width) * this.game.worldScale;
        const h = (frame.height || img.height) * this.game.worldScale;
        const spin = this._rotVel;
        ctx.save();
        ctx.translate(x, y);
        if (Math.abs(spin) > 5) {
            const step = Math.min(0.16, Math.abs(spin) * 0.011) * Math.sign(spin);
            const ghosts = [[2, 0.16], [1, 0.3]];
            for (const [n, alpha] of ghosts) {
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.rotate(this.rot - step * n);
                ctx.drawImage(img, -w / 2, -h / 2, w, h);
                ctx.restore();
            }
        }
        ctx.rotate(this.rot);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
    }

    draw(ctx, camera) {
        if (!this.alive) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const cullPad = 600 * this.game.worldScale;
        const hasTrail = this.trail.length > 0;
        if (!hasTrail &&
            (screen.x < -cullPad || screen.x > this.game.width + cullPad ||
             screen.y < -cullPad || screen.y > this.game.height + cullPad)) return;

        const ws = this.game.worldScale;
        const backFrame = this._frameOf('wheels_back', this.animFrame);
        const frontFrame = this._frameOf('wheels_front', this.animFrame);
        const fireFrame = this._frameOf('wheels_fire', this.fireFrame);

        // Fire trail first — it hangs in the world UNDER the body.
        if (hasTrail && fireFrame) {
            const fimg = fireFrame.canvas || fireFrame;
            const TRAIL_LIFE = 0.45;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            for (const p of this.trail) {
                const life = 1 - p.age / TRAIL_LIFE;
                if (life <= 0) continue;
                const s = camera.worldToScreen(p.x, p.y, this.game.width, this.game.height);
                const sc = (0.45 + 0.55 * life) * ws;
                const fw = (fireFrame.width || fimg.width) * sc;
                const fh = (fireFrame.height || fimg.height) * sc;
                ctx.globalAlpha = 0.42 * life;
                ctx.drawImage(fimg, s.x - fw / 2, s.y - fh / 2, fw, fh);
            }
            ctx.restore();
        }

        // Windup shiver: tension while the charge hangs at the top of the coil.
        let drawX = screen.x, drawY = screen.y;
        const a = this.attack;
        if (a && a.type === 'charge' && a.phase === 'windup' && a.timer >= a.windupDur) {
            drawX += Math.sin(this._animClock * 55) * 1.6 * ws;
            drawY += Math.cos(this._animClock * 47) * 1.2 * ws;
        }

        // Back ring → fire kernel → front ring: the fire lives inside the cage.
        if (backFrame) this._drawRing(ctx, backFrame, drawX, drawY);
        if (fireFrame) {
            const fimg = fireFrame.canvas || fireFrame;
            const fw = (fireFrame.width || fimg.width) * ws;
            const fh = (fireFrame.height || fimg.height) * ws;
            ctx.drawImage(fimg,
                drawX + this.fireOffX * ws - fw / 2,
                drawY + this.fireOffY * ws - fh / 2, fw, fh);
        }
        if (frontFrame) this._drawRing(ctx, frontFrame, drawX, drawY);

        if (this.state === WHEELS_STATE.DYING && this.deathExplosions) {
            ctx.save();
            ctx.translate(drawX, drawY);
            for (const ex of this.deathExplosions) {
                if (!ex.fired || ex.finished) continue;
                const frameImg = fireExplosionFrame(this.game.assets.get(ex.fireKey), ex.animTimer);
                if (!frameImg) continue;
                const ew = (frameImg.width || frameImg.canvas.width / 4) * ws * ex.scale;
                const eh = (frameImg.height || frameImg.canvas.height / 4) * ws * ex.scale;
                ctx.drawImage(frameImg.canvas || frameImg,
                    ex.lx * ws - ew / 2,
                    ex.ly * ws - eh / 2, ew, eh);
            }
            ctx.restore();
        }
    }

    popSpawns() {
        return [];
    }
}
