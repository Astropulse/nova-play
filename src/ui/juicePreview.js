// JuicePreview — a scripted, captioned tour of every juice effect, staged
// IN CONTEXT inside a real single-player run: real enemies, real projectiles
// through the real collision loop, real scrap/XP pickups, a real boss.
//
// Start it with the dev console command `juice` (optionally `juice <n>` to
// jump to beat n), or launch Electron with NOVA_AUTOTEST=solo
// NOVA_AUTOTEST_JUICE=<ms>. `juice stop` ends it.
//
// While it runs: the pilot is pinned in place and kept topped up (except in
// beats that show damage/healing), wave spawns are held off, and every enemy
// the script didn't create is quietly removed so each beat reads cleanly.
// Dev tool only — never runs in multiplayer.

import { Enemy, ShieldEnemy, MissileEnemy, KamikazeEnemy, CthulhuEnemy, BlinkEnemy, BerserkEnemy, ScavengerEnemy, NaniteEnemy } from '../entities/enemy.js';
import { Seraph } from '../entities/seraph.js';
import { Wheels } from '../entities/wheels.js';
import { Hive } from '../entities/swarm.js';
import { Carcosa } from '../entities/bones.js';
import { YellowOne } from '../entities/yellowOne.js';
import { Dragon } from '../entities/dragon.js';
import { CthulhuEvent } from '../entities/cthulhuEvent.js';
import { KnowledgeEvent } from '../entities/knowledgeEvent.js';
import { CargoShipEvent } from '../entities/cargoShipEvent.js';
import { FracturedStationEvent } from '../entities/fracturedStationEvent.js';
import { Starcore } from '../entities/starcore.js';
import { AsteroidCrusher } from '../entities/asteroidCrusher.js';
import { EventHorizon } from '../entities/eventHorizon.js';
import { UPGRADES, makeItem } from '../data/upgrades.js';
import { ACHIEVEMENTS } from '../data/achievements.js';
import { Projectile } from '../entities/projectile.js';
import { Scrap, ExpOrb, Asteroid } from '../entities/asteroid.js';

const TAU = Math.PI * 2;

export class JuicePreview {
    constructor(game, state, startBeat = 0) {
        this.game = game;
        this.state = state;
        this.beats = this._buildBeats();
        this.i = Math.max(0, Math.min(this.beats.length - 1, startBeat));
        this.t = 0;
        this.done = false;
        this.owned = new Set();   // enemies/objects this script created
        this.pins = [];           // {en, x, y} enemies held in place
        this.timers = [];         // {at, fn} one-shot events within a beat
        this.ax = state.player.worldX;
        this.ay = state.player.worldY;
        this._savedWave = state.waveTimer;
        this._startBeat();
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    get p() { return this.state.player; }

    at(time, fn) { this.timers.push({ at: time, fn }); }

    every(from, to, step, fn) {
        let k = 0;
        for (let t = from; t <= to; t += step) { const kk = k++; this.at(t, () => fn(kk)); }
    }

    enemy(Cls, dx, dy, opts = {}) {
        const s = this.state;
        const en = new Cls(this.game, this.ax + dx, this.ay + dy, s.difficultyScale || 1);
        if (opts.hp != null) { en.maxHealth = opts.maxHp || opts.hp; en.health = opts.hp; }
        this.owned.add(en);
        if (opts.pin !== false) this.pins.push({ en, x: this.ax + dx, y: this.ay + dy, orbit: opts.orbit || 0, ph: Math.atan2(dy, dx), R: Math.hypot(dx, dy) });
        if (s._addEnemies) s._addEnemies([en]); else s.enemies.push(en);
        return en;
    }

    // A real player shot from the pilot toward (tx, ty).
    shoot(tx, ty, dmg = 3, opts = {}) {
        const p = this.p;
        const a = Math.atan2(ty - p.worldY, tx - p.worldX) + (opts.spread ? (Math.random() - 0.5) * opts.spread : 0);
        const proj = new Projectile(this.game, p.worldX, p.worldY, a, opts.speed || 1000, opts.sprite || 'blue_laser_ball', p, dmg, 1.5);
        proj.friendly = true;
        if (opts.rocket) { proj.isRocket = true; proj.target = opts.target || null; }
        this.state.projectiles.push(proj);
        if (!opts.silent) this.game.sounds.play('laser', { volume: 0.18, x: p.worldX, y: p.worldY });
        return proj;
    }

    // A real enemy shot at the pilot (goes through enemy muzzle collection).
    enemyShoot(en) {
        const p = this.p;
        const a = Math.atan2(p.worldY - en.worldY, p.worldX - en.worldX);
        en.angle = a;
        const proj = new Projectile(this.game, en.worldX + Math.cos(a) * 20, en.worldY + Math.sin(a) * 20, a, 520, 'red_laser_ball', en, 1, 2.0);
        en.pendingProjectiles.push(proj);
    }

    // Remove world events a beat added (bosses, their chain spawns, events),
    // and undo the global flags they flipped.
    _clearEvents() {
        const s = this.state;
        if (!this.evSnap) return;
        for (let i = s.events.length - 1; i >= 0; i--) {
            const e = s.events[i];
            if (!this.evSnap.has(e)) { e.alive = false; s.events.splice(i, 1); }
        }
        if (s.dragonEvent !== this._dragonSnap) s.dragonEvent = this._dragonSnap;
        if (this._yoFight) { s.yellowOneFightActive = false; this._yoFight = false; }
        if (this._music) {
            this._music = false;
            try { if (this.game.sounds.restoreMusic) this.game.sounds.restoreMusic(); } catch (e) { /* ignore */ }
        }
        this.evSnap = null;
    }

    _clearOwned() {
        const s = this.state;
        for (const en of this.owned) {
            if (en.alive !== false) en.alive = false;
        }
        this.owned.clear();
        this.pins.length = 0;
        this.timers.length = 0;
        this.p._forceShield = false;
    }

    // ── beats ───────────────────────────────────────────────────────────────

    _buildBeats() {
        return [
            {
                title: 'HITS', sub: 'hit sparks, back-spray + shrapnel through the hull, stacking damage numbers',
                dur: 6, start: () => {
                    const en = this.enemy(Enemy, 300, 0, { hp: 99999 });
                    this.every(0.6, 5.2, 0.1, () => this.shoot(en.worldX, en.worldY + (Math.random() - 0.5) * 20, 3, { silent: true }));
                }
            },
            {
                title: 'BATTLE DAMAGE', sub: 'smoke at 70% > fire at 45% > sparks + arcing lightning at 30%. Burns only on hull pixels, where shots landed',
                dur: 9, start: () => {
                    const hp = [62, 38, 16];
                    const ens = hp.map((h, k) => this.enemy(Enemy, (k - 1) * 230, -170, { hp: h, maxHp: 100, orbit: 0.35 }));
                    ens.forEach((en, k) => this.every(0.2 + k * 0.3, 1.6 + k * 0.3, 0.22, () => this.shoot(en.worldX, en.worldY, 0.01, { silent: true })));
                    this.tick = () => ens.forEach((en, k) => { if (en.alive) en.health = hp[k]; });
                }
            },
            {
                title: 'KILLS', sub: 'directional blasts: fire, smoke, sparks and wreckage carried by the shot; burning chunks',
                dur: 8, start: () => {
                    const ens = [];
                    for (let k = 0; k < 6; k++) {
                        const a = -Math.PI * 0.9 + (k / 5) * Math.PI * 0.8;
                        ens.push(this.enemy(Enemy, Math.cos(a) * 280, Math.sin(a) * 280, { hp: 6, maxHp: 30 }));
                    }
                    ens.forEach((en, k) => this.every(0.6 + k * 1.0, 0.9 + k * 1.0, 0.1, () => en.alive && this.shoot(en.worldX, en.worldY, 3)));
                }
            },
            {
                title: 'ENERGY SHIELDS', sub: 'shots ricochet + lightning crawls the bubble; it shatters, then re-forms with racing arcs',
                dur: 10.5, start: () => {
                    const en = this.enemy(ShieldEnemy, 280, 0, { hp: 99999 });
                    en.shieldMax = en.shieldHP = 99999;
                    this.tick = () => { if (en.alive) en.angle = Math.atan2(this.p.worldY - en.worldY, this.p.worldX - en.worldX); };
                    this.every(0.5, 5.6, 0.16, () => this.shoot(en.worldX, en.worldY + (Math.random() - 0.5) * 30, 3, { silent: true }));
                    this.at(5.0, () => { en.shieldHP = 4; });
                }
            },
            {
                title: 'YOUR SHIELD', sub: 'enemy muzzle pops telegraph each shot; deflections off your bubble',
                dur: 6, start: () => {
                    this.p._forceShield = true;
                    const a = this.enemy(Enemy, 280, -150, { hp: 99999 });
                    const b = this.enemy(Enemy, -280, -150, { hp: 99999 });
                    this.every(0.4, 5.2, 0.3, (k) => this.enemyShoot(k % 2 ? a : b));
                    this.keepShield = true;
                }
            },
            {
                title: 'HULL HITS', sub: 'unshielded: hull sparks and light where the shot lands',
                dur: 4.5, start: () => {
                    const a = this.enemy(Enemy, 300, 120, { hp: 99999 });
                    this.every(0.3, 3.8, 0.45, () => this.enemyShoot(a));
                    this.tick = () => { this.p.invulnTimer = 0; };
                }
            },
            {
                title: 'SCRAP PAYOUT', sub: 'each piece flies into the counter, which rolls up as they land; the pickups climb a scale. Far scrap glints',
                dur: 8, start: () => {
                    const s = this.state;
                    for (let k = 0; k < 10; k++) {
                        const a = Math.random() * TAU, d = 300 + Math.random() * 120;
                        const sc = new Scrap(this.game, this.ax + Math.cos(a) * d, this.ay + Math.sin(a) * d, Math.random() < 0.3 ? 'big' : 'small');
                        s.scrapEntities.push(sc); this.owned.add(sc);
                    }
                    this.every(0.4, 3.4, 0.1, () => {
                        const a = Math.random() * TAU, d = 70 + Math.random() * 70;
                        const sc = new Scrap(this.game, this.ax + Math.cos(a) * d, this.ay + Math.sin(a) * d, Math.random() < 0.25 ? 'big' : 'small');
                        s.scrapEntities.push(sc);
                    });
                }
            },
            {
                title: 'EXPERIENCE', sub: 'XP motes stream into the bar\'s fill edge',
                dur: 5, start: () => {
                    const s = this.state;
                    this.every(0.3, 2.8, 0.1, () => {
                        const a = Math.random() * TAU, d = 70 + Math.random() * 60;
                        s.expOrbs.push(new ExpOrb(this.game, this.ax + Math.cos(a) * d, this.ay + Math.sin(a) * d, 0.05));
                    });
                }
            },
            {
                title: 'LEVEL UP', sub: 'rotating sunburst, rings, a star fountain arcing under gravity, chime',
                dur: 5, start: () => {
                    this.at(0.5, () => { const p = this.p; p.addExp(Math.max(1, p.expNeeded - p.exp + 0.01)); });
                }
            },
            {
                title: 'HEALING', sub: 'green motes rise in proportion to HP gained; a big heal adds a ring and chime',
                dur: 5.5, start: () => {
                    const p = this.p;
                    this.noRefill = true;
                    p.health = p.maxHealth * 0.25; p._fxHp = p.health;
                    this.tick = (t) => {
                        if (t > 0.6 && t < 2.8) p.health = Math.min(p.maxHealth * 0.6, p.health + p.maxHealth * 0.2 * (1 / 60));
                    };
                    this.at(3.4, () => { p.health = p.maxHealth; });
                }
            },
            {
                title: 'ROCKETS & MISSILES', sub: 'smoke trails off every rocket, yours and theirs',
                dur: 7, start: () => {
                    const t1 = this.enemy(Enemy, 380, -60, { hp: 99999 });
                    const t2 = this.enemy(Enemy, -380, -60, { hp: 99999 });
                    const m = this.enemy(MissileEnemy, 0, -320, { hp: 99999 });
                    m.missileTimer = 0.6;
                    this.every(0.4, 5.5, 0.45, (k) => {
                        const tg = k % 2 ? t1 : t2;
                        this.shoot(tg.worldX, tg.worldY, 3, { rocket: true, target: tg, speed: 520, sprite: 'blue_laser_ball_big', spread: 1.2 });
                    });
                }
            },
            {
                title: 'BOMBS & EXPLOSIVES', sub: 'armed bombs blink a beacon; detonations and explosive pops',
                dur: 7, start: () => {
                    const s = this.state, p = this.p;
                    const bombs = [];
                    for (let k = 0; k < 3; k++) {
                        const a = -Math.PI / 2 + (k - 1) * 0.9;
                        const b = new Projectile(this.game, this.ax + Math.cos(a) * 220, this.ay + Math.sin(a) * 220, 0, 0, 'blue_laser_ball_big', p, 5, 8.1);
                        b.isBomb = true; b.bombLife = 8.1; b.friendly = true;
                        s.projectiles.push(b); bombs.push(b);
                    }
                    bombs.forEach((b, k) => this.at(2.2 + k * 0.8, () => { if (b.alive) { s._detonateBomb(b); b.alive = false; } }));
                    for (let k = 0; k < 4; k++) {
                        this.at(4.8 + k * 0.35, () => s._spawnExplosion(this.ax + (k - 1.5) * 110, this.ay + 200, 1));
                    }
                }
            },
            {
                title: 'RAILGUN', sub: 'pierce crackle on each hull + chain lightning arcing between everything one beam hits',
                dur: 6.5, start: () => {
                    for (let k = 0; k < 6; k++) this.enemy(Enemy, 180 + k * 95, (k % 2 ? 1 : -1) * 18, { hp: 20, maxHp: 30 });
                    this.every(0.8, 4.4, 1.2, () => this.state._fireSingleBeam(this.p.worldX, this.p.worldY, 1, 0, 1000, 9, this.p));
                }
            },
            {
                title: 'ASTEROIDS', sub: 'rock dust billows into wisps; chips fly with the shot',
                dur: 6, start: () => {
                    const s = this.state;
                    const rocks = [];
                    for (let k = 0; k < 4; k++) {
                        const a = -Math.PI / 2 + (k - 1.5) * 0.55;
                        const r = new Asteroid(this.game, this.ax + Math.cos(a) * 300, this.ay + Math.sin(a) * 300, k === 1 ? 'big' : 'medium', 0, 0);
                        s.asteroids.push(r); rocks.push(r);
                    }
                    this.every(0.4, 5.2, 0.09, (k) => {
                        const r = rocks.find(x => x.alive);
                        if (r) this.shoot(r.worldX, r.worldY, 6, { silent: true, spread: 0.08 });
                    });
                }
            },
            {
                title: 'WARP-INS', sub: 'arriving ships: streaks pulled in, flash, ring, vwoop',
                dur: 6, start: () => {
                    this.every(0.4, 4.2, 0.55, () => {
                        const a = Math.random() * TAU, d = 260 + Math.random() * 180;
                        this.enemy(Enemy, Math.cos(a) * d, Math.sin(a) * d, { hp: 99999 });
                    });
                }
            },
            {
                title: 'DISTANT SKIRMISHES', sub: 'deep in the starfield: capital ships trade broadsides + missiles, fighters make attack runs',
                dur: 14, start: () => {
                    const fx = this.state.impactFx;
                    fx.skirmishes.length = 0;
                    fx._skirmishT = 0;
                }
            },
            {
                title: 'ITEM PICKUPS', sub: 'a burst + fountain in each rarity\'s colours, bigger the rarer; rare+ adds the jackpot reel',
                dur: 9, start: () => {
                    const order = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
                    order.forEach((r, k) => this.at(0.5 + k * 1.6, () => {
                        const def = UPGRADES.find(u => u.rarity === r);
                        const item = def && makeItem(def.id);
                        if (item) this.state.celebratePickup(item, this.p);
                    }));
                }
            },
            {
                title: 'ACHIEVEMENTS & UNLOCKS', sub: 'confetti off the toast; unlocks get rainbow confetti, twinkles round the card and a chime',
                dur: 10, start: () => {
                    const mgr = this.game.achievements;
                    if (!mgr) return;
                    const plain = ACHIEVEMENTS.find(a => !a.unlock);
                    const unlock = ACHIEVEMENTS.find(a => a.unlock && a.unlock.type === 'ship') || ACHIEVEMENTS.find(a => a.unlock);
                    this.at(0.3, () => { if (plain) mgr.toastQueue.push(plain); });
                    this.at(0.4, () => { if (unlock) mgr.toastQueue.push(unlock); });
                }
            },
            {
                title: 'ENCOUNTERS', sub: 'warps in + hails; outcomes: gains fly INTO you, losses fly OUT to them; ominous deals crackle red; then it turns hostile',
                dur: 11, start: () => {
                    const s = this.state;
                    const before = s.encounters.length;
                    s._spawnEncounter();
                    const enc = s.encounters[s.encounters.length - 1];
                    if (!enc || s.encounters.length === before) return;
                    this.owned.add(enc);
                    enc.worldX = this.ax + 260; enc.worldY = this.ay - 60;
                    s.impactFx.warpIn(enc.worldX, enc.worldY, 34);
                    this.tick = () => { enc.worldX = this.ax + 260; enc.worldY = this.ay - 60; };
                    const fx = s.impactFx, p = this.p;
                    this.at(2.0, () => fx.encounterAction('add_perm_health', p, enc));
                    this.at(2.8, () => fx.encounterAction('add_perm_damage', p, enc));
                    this.at(3.6, () => fx.encounterAction('add_upgrade', p, enc));
                    this.at(4.6, () => fx.encounterAction('remove_scrap', p, enc));
                    this.at(5.6, () => fx.encounterAction('spawn_boss', p, enc));
                    this.at(7.4, () => s._hostileTurnFx(enc));
                }
            },
            {
                title: 'ENCOUNTER LEAVES', sub: 'deal done: engines punch, a flash and an ion spray as it burns away',
                dur: 6, start: () => {
                    const s = this.state;
                    const before = s.encounters.length;
                    s._spawnEncounter();
                    const enc = s.encounters[s.encounters.length - 1];
                    if (!enc || s.encounters.length === before) return;
                    this.owned.add(enc);
                    enc.worldX = this.ax + 240; enc.worldY = this.ay + 40;
                    let pinned = true;
                    this.tick = () => { if (pinned) { enc.worldX = this.ax + 240; enc.worldY = this.ay + 40; enc.vx = 0; enc.vy = 0; } };
                    this.at(1.5, () => { pinned = false; if (enc.depart) enc.depart(); });
                }
            },
            {
                title: 'RAMMERS', sub: 'kamikazes + cthulhu minions: energy gathers in the windup, a burst kicks off each ram',
                dur: 8, start: () => {
                    this.enemy(KamikazeEnemy, 420, -200, { pin: false });
                    this.enemy(KamikazeEnemy, -420, -150, { pin: false });
                    this.enemy(CthulhuEnemy, 0, 380, { pin: false });
                }
            },
            {
                title: 'BLINKERS', sub: 'violet energy implodes at the origin, the destination flickers, then a burst on arrival',
                dur: 8, start: () => {
                    this.enemy(BlinkEnemy, 380, -100, { pin: false });
                    this.enemy(BlinkEnemy, -380, 100, { pin: false });
                }
            },
            {
                title: 'BERSERKER', sub: 'below half health it erupts in red lightning, smoulders with embers, and spins a spiral bloom',
                dur: 9, start: () => {
                    const e = this.enemy(BerserkEnemy, 300, -60, { hp: 100, maxHp: 100 });
                    this.at(1.0, () => { e.health = 40; });
                    this.tick = () => { if (e.alive && e.health < 30) e.health = 40; };
                }
            },
            {
                title: 'SCAVENGER', sub: 'its tractor visibly drags loot in; each grab glints gold',
                dur: 9, start: () => {
                    const e = this.enemy(ScavengerEnemy, 320, 0, { pin: false });
                    const st = this.state;
                    for (let k = 0; k < 12; k++) {
                        const a = Math.random() * TAU, d = 120 + Math.random() * 120;
                        st.scrapEntities.push(new Scrap(this.game, e.worldX + Math.cos(a) * d, e.worldY + Math.sin(a) * d, 'small'));
                    }
                }
            },
            {
                title: 'NANITES', sub: 'the hull bursts into an electric swarm; each drone sparks awake',
                dur: 7, start: () => {
                    const a = this.enemy(NaniteEnemy, 280, -80, { hp: 5, maxHp: 30 });
                    const b = this.enemy(NaniteEnemy, -280, -80, { hp: 5, maxHp: 30 });
                    this.allow = (en) => en.constructor && en.constructor.name === 'NaniteDrone';
                    this.every(0.8, 1.3, 0.1, () => a.alive && this.shoot(a.worldX, a.worldY, 3));
                    this.every(2.6, 3.1, 0.1, () => b.alive && this.shoot(b.worldX, b.worldY, 3));
                }
            },
            {
                title: 'BEAM SHIPS', sub: 'red charge gathers at the nose, then the beam flashes down its line',
                dur: 6, start: () => {
                    const e = this.enemy(Enemy, 320, -120, { hp: 99999 });
                    if (e.applyUpgrade) e.applyUpgrade('beam');
                }
            },
            {
                title: 'CARGO SHIP', sub: 'a derelict blinks a red distress beacon, hull sparking; fly close and it breaches, venting',
                dur: 10, start: () => {
                    const ev = new CargoShipEvent(this.game, this.ax + 1000, this.ay - 60);
                    this.state.events.push(ev);
                    this.at(4.5, () => { ev.worldX = this.ax + 520; });
                }
            },
            {
                title: 'FRACTURED STATION', sub: 'red alert as each ambush launches, the next station lights up, gold when it\'s done',
                dur: 15, start: () => {
                    const ev = new FracturedStationEvent(this.game, [
                        { x: this.ax + 180, y: this.ay - 90 }, { x: this.ax + 230, y: this.ay + 90 }, { x: this.ax - 160, y: this.ay + 120 }]);
                    this.state.events.push(ev);
                    this._music = true;
                }
            },
            {
                title: 'THE LIDLESS EYE', sub: 'dormant, its gaze drifts toward you; near, matter spirals in; struck awake, the void erupts',
                dur: 20, start: () => {
                    const ev = new KnowledgeEvent(this.game, this.ax + 1500, this.ay);
                    this.state.events.push(ev);
                    this._music = true;
                    this.at(3.5, () => { ev.worldX = this.ax + 650; });
                    this.at(7.5, () => { for (let k = 0; k < 40 && ev.state === 1; k++) ev.hit(200); });
                    this.at(17, () => { for (let k = 0; k < 400 && ev.state === 2; k++) ev.hit(200); });
                }
            },
            {
                title: 'SERAPH', sub: 'awakens in fire; hand gathers heat before each charge, the eye opens in gold, beam + nova, rage, death',
                dur: 21, start: () => {
                    const st = this.state, p = this.p;
                    const se = new Seraph(this.game, this.ax + 650, this.ay);
                    se.revealed = true; st.events.push(se);
                    this._music = true;
                    const go = (fn) => () => { try { if (se.state === 'fight') { se.attack = null; fn(); } } catch (e) { console.warn(e); } };
                    this.at(3.0, go(() => se._startAttack1(p)));
                    this.at(6.5, () => { try { if (se.state === 'fight' && !se.formAnim) se._startOpening(); } catch (e) { console.warn(e); } });
                    this.at(9.0, go(() => se._startAttack3(p)));
                    this.at(11.5, go(() => se._startAttack2(p)));
                    this.at(14.0, () => { se.health = se.maxHealth * 0.2; });
                    this.at(17.5, () => { try { se._triggerDeathSequence(); } catch (e) { console.warn(e); } });
                }
            },
            {
                title: 'THE WHEELS', sub: 'gold awakening, charge chains gather and blast, the buzz-saw spin sheds sparks, a runaway death',
                dur: 18, start: () => {
                    const st = this.state, p = this.p;
                    const w = new Wheels(this.game, this.ax + 650, this.ay);
                    w.revealed = true; st.events.push(w);
                    this._music = true;
                    this.at(2.5, () => { try { if (w.state === 'fight') { w.attack = null; w._startCharge(p, 3); } } catch (e) { console.warn(e); } });
                    this.at(8.0, () => { try { if (w.state === 'fight') { w.attack = null; w._startSpin(p); } } catch (e) { console.warn(e); } });
                    this.at(12.5, () => { w.health = w.maxHealth * 0.3; });
                    this.at(14.0, () => { try { w._triggerDeathSequence(); } catch (e) { console.warn(e); } });
                }
            },
            {
                title: 'THE HIVE', sub: 'spore awakening, brood energy streams in before each birth, the Mother charges + volleys, the hive dies',
                dur: 23, start: () => {
                    const st = this.state, p = this.p;
                    const h = new Hive(this.game, this.ax + 800, this.ay);
                    h.revealed = true; st.events.push(h);
                    this._music = true;
                    this.allow = (en) => { const n = en.constructor && en.constructor.name; return n === 'LocustEnemy' || n === 'SwarmMother'; };
                    this.at(4.0, () => { h._birthTelegraph = 0.6; });
                    this.at(7.0, () => { try { if (h.mother) h.mother._startCharge(p); } catch (e) { console.warn(e); } });
                    this.at(10.0, () => { try { if (h.mother) h.mother._startVolley(p); } catch (e) { console.warn(e); } });
                    this.at(12.0, () => { h._birthTelegraph = 0.6; });
                    this.at(14.5, () => { try { h._triggerDeathSequence(); } catch (e) { console.warn(e); } });
                    this.at(19.0, () => {
                        try { if (h.mother && h.mother._startDeath) h.mother._startDeath(); } catch (e) { console.warn(e); }
                        for (const l of (h.locusts || [])) if (l.alive) l.hit(99999);
                    });
                }
            },
            {
                title: 'CTHULHU', sub: 'abyssal bubbles while it sleeps; it wakes in a dark flare, waves pulse lightning; collapses when killed',
                dur: 19, start: () => {
                    const st = this.state;
                    const ev = new CthulhuEvent(this.game, this.ax + 600, this.ay);
                    ev.revealed = true; st.events.push(ev);
                    this._music = true;
                    this.at(3.0, () => { try { ev.triggerEvent(); } catch (e) { console.warn(e); } });
                    this.at(8.5, () => { ev.wave = ev.maxWaves; ev.enemiesToSpawn = 0; if (ev.spawnedEnemies) ev.spawnedEnemies.length = 0; });
                    this.at(16.0, () => { if (ev.state === 4 && st._routeDamage(ev, 99999)) st._onEntityDestroyed(ev); });
                }
            },
            {
                title: 'CARCOSA', sub: 'the bone city wakes in a white shockwave, ships rise in dust, one calcifies, a gold pulse rebuilds it',
                dur: 22, start: () => {
                    const st = this.state;
                    const c = new Carcosa(this.game, this.ax + 600, this.ay);
                    c.revealed = true; st.events.push(c);
                    c._dropTribute = () => {}; // demo: never seed the real Dragon
                    this._music = true;
                    this.allow = (en) => !!en.isBone;
                    this.at(10.0, () => { const b = (c.bones || []).find(b => b.alive && !b.dormant); if (b && b._startCalcify) b._startCalcify(); });
                    this.at(14.0, () => {
                        if (c.husks) c.husks.length = 0; c._waking = 0; if (c._queue) c._queue.length = 0;
                        for (const b of (c.bones || [])) { if (!b.alive) continue; b.reanimating = false; b.calcified = false; b.dormant = false; b.hit(999999); }
                    });
                }
            },
            {
                title: 'THE YELLOW ONE', sub: 'motes as it notices you, phase one flares, the armada warps in yellow, phase two storms',
                dur: 17, start: () => {
                    const st = this.state;
                    const yo = new YellowOne(this.game, this.ax + 500, this.ay - 40);
                    yo.revealed = true; st.events.push(yo);
                    this._yoFight = true; this._music = true;
                    this.allow = (en) => !!en.yellowArmada;
                    this.tick = () => { if (yo.health !== undefined && yo.health < 1) yo.health = 1; };
                    this.at(2.5, () => { yo.musicStartTime = performance.now() / 1000 - 21; });
                    this.at(6.0, () => { yo.summonTimer = 0; });
                    this.at(10.0, () => { yo.health = yo.maxHealth * 0.39; });
                    this.at(12.5, () => { yo.crushTimer = 0; });
                }
            },
            this._headBeat('deception', 'DRAGON: DECEPTION'),
            this._headBeat('accusation', 'DRAGON: ACCUSATION'),
            this._headBeat('murder', 'DRAGON: MURDER'),
            this._headBeat('blasphemy', 'DRAGON: BLASPHEMY'),
            this._headBeat('economic_control', 'DRAGON: ECONOMIC CONTROL'),
            this._headBeat('false_worship', 'DRAGON: FALSE WORSHIP'),
            this._headBeat('persecution', 'DRAGON: PERSECUTION'),
            {
                title: 'CACHE REVEALS', sub: 'each item lands in its rarity colours: rays, a slot flash, a fountain; epic+ rains confetti',
                dur: 9, start: () => {
                    const ui = this.state.uiFx, W = this.game.width, H = this.game.height, ss = 32 * (this.game.uiScale || 3);
                    ['common', 'uncommon', 'rare', 'epic', 'legendary'].forEach((r, k) => this.at(0.4 + k * 1.5, () =>
                        ui.cacheReveal(W * (0.2 + k * 0.15) - ss / 2, H * 0.45 - ss / 2, ss, ss, r)));
                }
            },
            {
                title: 'SHOP', sub: 'buying pours scrap from your counter into the item; selling pays it back; can\'t afford = red sputter',
                dur: 8, start: () => {
                    const ui = this.state.uiFx, W = this.game.width, H = this.game.height, ss = 32 * (this.game.uiScale || 3);
                    const label = [W * 0.5, H * 0.18];
                    this.at(0.4, () => ui.shopBuy(W * 0.35 - ss, H * 0.5 - ss / 2, ss * 2, ss, 'epic', label[0], label[1]));
                    this.at(2.2, () => ui.shopBuy(W * 0.62 - ss / 2, H * 0.55 - ss / 2, ss, ss * 2, 'rare', label[0], label[1]));
                    this.at(4.0, () => ui.shopSell(W * 0.45 - ss / 2, H * 0.6 - ss / 2, ss, ss, label[0], label[1]));
                    this.at(5.6, () => ui.shopFail(W * 0.55 - ss / 2, H * 0.48 - ss / 2, ss, ss));
                    this.at(6.6, () => ui.permBuy(W * 0.5 - ss, H * 0.7, ss * 2, ss * 0.75));
                }
            },
            {
                title: 'LEVEL-UP PICK', sub: 'the chosen card blazes in its bonus colour and its power streams into your ship (cursed: violet)',
                dur: 8, start: () => {
                    const ui = this.state.uiFx, W = this.game.width, H = this.game.height, us = this.game.uiScale || 3;
                    const card = (i) => ({ x: W / 2 - 80 * us, y: H * 0.3 + i * 44 * us, w: 160 * us, h: 40 * us });
                    const ship = () => { const c = this.state.camera, p = this.p; return [p.worldX * c.wtsScale + c.wtsOffX, p.worldY * c.wtsScale + c.wtsOffY]; };
                    this.at(0.4, () => { const [sx, sy] = ship(); ui.levelPick(card(0), '#ffd24a', false, sx, sy); });
                    this.at(2.6, () => { const [sx, sy] = ship(); ui.levelPick(card(1), '#c86bff', false, sx, sy); });
                    this.at(4.8, () => { const [sx, sy] = ship(); ui.levelPick(card(2), '#7a3ab8', true, sx, sy); });
                    this.at(6.6, () => ui.levelSkip({ x: W / 2 - 30 * us, y: H * 0.3 + 3 * 44 * us, w: 60 * us, h: 14 * us }));
                }
            },
            {
                title: 'ENCOUNTER CHOICE', sub: 'the option you pick flashes and sparks as the deal is struck',
                dur: 4, start: () => {
                    const ui = this.state.uiFx, W = this.game.width, H = this.game.height, us = this.game.uiScale || 3;
                    [0, 1, 2].forEach((i) => this.at(0.4 + i * 1.1, () => ui.encounterPick({ x: W * 0.25, y: H * 0.45 + i * 12 * us, w: W * 0.5, h: 10 * us })));
                }
            },
            {
                title: 'SUPPLY DROP', sub: 'a cache burns in on re-entry, slams down in a ring of dust, then pulses a gold beacon',
                dur: 6, start: () => {
                    const s = this.state;
                    if (!s.cacheSpawner) return;
                    const c = s.cacheSpawner.spawnNear(this.ax, this.ay, 220, 260);
                    s.caches.push(c);
                    this.owned.add(c);
                }
            },
            {
                title: 'PLAYER SHIP DESTROYED', sub: 'shown beside you: blast, lightning, rolling sub-explosions',
                dur: 5, start: () => {
                    this.at(0.6, () => this.state.impactFx.playerDeath(this.ax + 220, this.ay, null));
                }
            },
            this._bossBeat('STARCORE', Starcore, 'solar flares crawl its hull, embers shed, fire is sucked into the beam muzzle; dies as a supernova'),
            this._bossBeat('ASTEROID CRUSHER', AsteroidCrusher, 'grinding dust, lightning tether on hauled rocks; dies in a rockslide'),
            this._bossBeat('EVENT HORIZON', EventHorizon, 'matter spirals into it; dies by collapsing inward, then bursting'),
        ];
    }

    // One Dragon head, solo: its windups gather energy in its colours, strikes
    // burst, beams flash, new moves announce themselves, it burns as it
    // weakens and goes out in its own finale.
    _headBeat(key, title) {
        return {
            title, sub: 'windups gather in its colours, strikes burst, beams flash, moves announce themselves; burns, then shatters',
            dur: 13, start: () => {
                const st = this.state;
                const d = Dragon.spawnSolo(this.game, st, key, this.ax + 850, this.ay);
                if (!d || !d.heads[0]) return;
                const h = d.heads[0];
                this._music = true;
                this.at(5.0, () => { h.health = h.maxHealth * 0.4; });
                this.at(8.0, () => { h.health = h.maxHealth * 0.2; });
                this.every(5.0, 10.0, 0.14, () => h.state === 'fight' && this.shoot(h.worldX, h.worldY, 0.01, { silent: true, spread: 0.2 }));
                this.at(10.5, () => { try { h.invulnerable = false; h.health = 1; h.hit(999); } catch (e) { console.warn(e); } });
            }
        };
    }

    _bossBeat(title, Cls, sub) {
        return {
            title, sub, dur: 14, start: () => {
                const s = this.state;
                const boss = new Cls(this.game, this.ax + 420, this.ay - 120, s.difficultyScale || 1);
                this.owned.add(boss);
                if (s._addEnemies) s._addEnemies([boss]); else s.enemies.push(boss);
                this.bossBeat = true;
                if (Cls === AsteroidCrusher) {
                    for (let k = 0; k < 6; k++) {
                        const a = Math.random() * TAU, d = 220 + Math.random() * 160;
                        s.asteroids.push(new Asteroid(this.game, boss.worldX + Math.cos(a) * d, boss.worldY + Math.sin(a) * d, 'medium', 0, 0));
                    }
                }
                if (Cls === Starcore) {
                    this.at(4.0, () => { if (boss.alive && boss._startBeamCharge) boss._startBeamCharge(); });
                }
                this.at(3.0, () => { boss.health = boss.maxHealth * 0.4; });
                this.at(6.5, () => { boss.health = boss.maxHealth * 0.2; });
                this.every(3.0, 9.5, 0.12, () => boss.alive && this.shoot(boss.worldX, boss.worldY, 0.01, { silent: true, spread: 0.15 }));
                this.at(10, () => { if (boss.alive && boss._triggerDeathSequence) boss._triggerDeathSequence(); });
            }
        };
    }

    _startBeat() {
        this._clearOwned();
        this._clearEvents();
        this.allow = null;
        this.evSnap = new Set(this.state.events);
        this._dragonSnap = this.state.dragonEvent;
        this.tick = null;
        this.noRefill = false;
        this.keepShield = false;
        this.bossBeat = false;
        this.t = 0;
        this.ax = this.p.worldX;
        this.ay = this.p.worldY;
        const b = this.beats[this.i];
        console.log(`JUICE PREVIEW ${this.i + 1}/${this.beats.length}: ${b.title}`);
        b.start();
    }

    stop() {
        this._clearOwned();
        this._clearEvents();
        this.state.waveTimer = this._savedWave;
        this.done = true;
    }

    // Called at the end of PlayingState.update.
    update(dt) {
        if (this.done) return;
        const s = this.state, p = this.p;
        this.t += dt;
        s.waveTimer = Math.max(s.waveTimer || 0, 60);

        // Fire due events.
        for (let k = this.timers.length - 1; k >= 0; k--) {
            if (this.t >= this.timers[k].at) { const ev = this.timers[k]; this.timers.splice(k, 1); ev.fn(); }
        }
        if (this.tick) this.tick(this.t, dt);

        // Pin the pilot; keep them topped up unless the beat is about damage.
        p.worldX = this.ax; p.worldY = this.ay; p.vx = 0; p.vy = 0;
        if (!this.noRefill) { p.health = p.maxHealth; p._fxHp = p.health; }
        if (this.keepShield) { p.shieldEnergy = p.maxShieldEnergy; p.shieldBroken = false; }

        // Hold pinned enemies (orbiters circle slowly so smoke trails show).
        for (const pin of this.pins) {
            const en = pin.en;
            if (!en.alive) continue;
            if (pin.orbit) {
                pin.ph += pin.orbit * dt;
                const nx = this.ax + Math.cos(pin.ph) * pin.R, ny = this.ay + Math.sin(pin.ph) * pin.R;
                en.vx = (nx - en.worldX) / Math.max(dt, 1e-3); en.vy = (ny - en.worldY) / Math.max(dt, 1e-3);
                en.worldX = nx; en.worldY = ny;
                en.angle = pin.ph + Math.PI / 2;
            } else {
                en.worldX = pin.x; en.worldY = pin.y; en.vx = 0; en.vy = 0;
            }
        }
        // Quietly remove anything the script didn't stage (wave trickle etc.).
        for (const en of s.enemies) {
            if (en.alive && !this.owned.has(en) && !(this.bossBeat && en.isBoss) && !(this.allow && this.allow(en))) en.alive = false;
        }

        if (this.t >= this.beats[this.i].dur) {
            this.i++;
            if (this.i >= this.beats.length) { console.log('JUICE PREVIEW complete'); this.stop(); return; }
            this._startBeat();
        }
    }

    // Caption card, top-center, flat panel in the HUD's own colours.
    draw(ctx) {
        if (this.done) return;
        const b = this.beats[this.i];
        const hs = (this.state.hud && this.state.hud._hudScale) || 2;
        const W = this.game.width;
        ctx.save();
        ctx.font = `${8 * hs}px Astro4x`;
        const tw = ctx.measureText(b.title).width;
        ctx.font = `${5 * hs}px Astro4x`;
        const sw = ctx.measureText(b.sub).width;
        const pw = Math.max(tw, sw) + 16 * hs, ph = 26 * hs;
        const x = Math.round((W - pw) / 2), y = Math.round(20 * hs);
        ctx.fillStyle = 'rgba(4,8,18,0.92)';
        ctx.fillRect(x, y, pw, ph);
        ctx.strokeStyle = '#233040';
        ctx.lineWidth = hs;
        ctx.strokeRect(x + hs / 2, y + hs / 2, pw - hs, ph - hs);
        // Progress along the bottom edge.
        ctx.fillStyle = '#223344';
        ctx.fillRect(x + hs, y + ph - 2 * hs, (pw - 2 * hs) * Math.min(1, this.t / b.dur), hs);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.font = `${8 * hs}px Astro4x`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(b.title, W / 2, y + 11 * hs);
        ctx.font = `${5 * hs}px Astro4x`;
        ctx.fillStyle = '#9fb4cc';
        ctx.fillText(b.sub, W / 2, y + 20 * hs);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#445566';
        ctx.fillText(`${this.i + 1}/${this.beats.length}`, x + pw - 4 * hs, y + 7 * hs);
        ctx.restore();
    }
}
