// World replication — the heart of multiplayer.
//
// Model: the HOST is ground truth for the shared world (enemies, waves, world
// spawns, drops, kill/loot arbitration, interactable locks). Each CLIENT is
// authoritative over its own ship — movement, aiming and firing run locally
// with zero latency, so the host has no feel advantage. Everything a client
// renders for the shared world is either:
//
//   • deterministic from a spawn event (asteroids fly straight: pos+vel+time
//     integrates identically everywhere, so they cost nothing after spawn),
//   • interpolated from snapshots (enemies, encounters, other players — drawn
//     INTERP_DELAY behind the host clock so motion is always smooth), or
//   • purely cosmetic and generated locally (debris, sparks, rubble, text).
//
// Damage flows shooter → host → everyone: the shooter detects its own hits
// locally (instant feedback), the host applies them to the real entity, and
// the resulting HP/kill messages are what other players see. Loot is rolled by
// the host and broadcast as data-driven spawn events (asset keys + seeds, never
// pixels) — every machine resolves them against its own asset files.

import {
    MSG, KIND, PICKUP, PF, ENEMY_CLS, PROJ_SPRITES, projSpriteId,
    RATE_PLAYER_STATE, RATE_ENEMY_SNAP, RATE_WORLD_STATE, RATE_EVENT_SYNC,
    INTERP_DELAY, q, q3, encode,
} from './protocol.js';
import { RemotePlayer } from './remotePlayer.js';
import { RNG } from '../engine/rng.js';
import { Projectile } from '../entities/projectile.js';
import { Asteroid, Scrap, ItemPickup, ExpOrb, Rubble } from '../entities/asteroid.js';
import { Enemy, KamikazeEnemy, CthulhuEnemy, HostileEncounter, NaniteEnemy, NaniteDrone, ShieldEnemy, MissileEnemy, BlinkEnemy, BerserkEnemy, ScavengerEnemy } from '../entities/enemy.js';
import { Starcore } from '../entities/starcore.js';
import { AsteroidCrusher } from '../entities/asteroidCrusher.js';
import { EventHorizon } from '../entities/eventHorizon.js';
import { Boss, BOSS_STATE, BossWreck } from '../entities/boss.js';
import { EncounterShip } from '../entities/encounter.js';
import { SpaceCache, CACHE_STATE } from '../entities/spaceCache.js';
import { Shop } from '../entities/shop.js';
import { UPGRADES, makeItem } from '../data/upgrades.js';

// Multiplayer difficulty scaling — simple multiplication curves on player
// count, per design: more pilots = more enemies with more health.
export function mpQuantityMult(playerCount) {
    return 1 + (playerCount - 1) * 0.7;
}
export function mpHealthMult(playerCount) {
    return 1 + (playerCount - 1) * 0.5;
}
// Enemy scrap-drop multiplier — more pilots split the same loot pool, so
// drops grow with the lobby to keep per-player scrap income healthy.
export function mpScrapMult(playerCount) {
    return 1 + (playerCount - 1) * 0.25;
}

// Enemy snapshot state bitfield
const ST = { WINDUP: 1, RAM: 2, TARGETING: 4, DYING: 8, PHASE2: 16, INTRO: 32 };

// Events whose fights are scripted per-pilot — the host only syncs their
// health/finished flags; their states/positions stay locally simulated so the
// cutscenes/sequences play correctly for whoever is actually there.
const LOCAL_SCRIPTED_EVENTS = new Set(['YellowOne', 'KnowledgeEvent', 'Seraph']);

// Some events expose worldX/worldY as getter-only computed properties
// (FracturedStationEvent derives them from its station list). Position sync
// must never throw on those — first failed write flags the entity as locked.
function trySetEventPos(ev, x, y) {
    if (ev._netPosLocked) return false;
    try {
        ev.worldX = x;
        ev.worldY = y;
        return true;
    } catch {
        ev._netPosLocked = true;
        ev._netTargetX = undefined;
        ev._netTargetY = undefined;
        return false;
    }
}

function classifyEnemy(en) {
    if (en instanceof Starcore) return ENEMY_CLS.STARCORE;
    if (en instanceof AsteroidCrusher) return ENEMY_CLS.CRUSHER;
    if (en instanceof EventHorizon) return ENEMY_CLS.HORIZON;
    if (en instanceof HostileEncounter) return ENEMY_CLS.HOSTILE_ENCOUNTER;
    if (en instanceof CthulhuEnemy) return ENEMY_CLS.CTHULHU;
    if (en instanceof KamikazeEnemy) return ENEMY_CLS.KAMIKAZE;
    if (en instanceof NaniteDrone) return ENEMY_CLS.NANITE_DRONE;
    if (en instanceof NaniteEnemy) return ENEMY_CLS.NANITE;
    if (en instanceof ShieldEnemy) return ENEMY_CLS.SHIELD;
    if (en instanceof MissileEnemy) return ENEMY_CLS.MISSILE;
    if (en instanceof BlinkEnemy) return ENEMY_CLS.BLINK;
    if (en instanceof BerserkEnemy) return ENEMY_CLS.BERSERK;
    if (en instanceof ScavengerEnemy) return ENEMY_CLS.SCAVENGER;
    return ENEMY_CLS.BASIC;
}

// ─────────────────────────────────────────────────────────────────────────────
class BaseWorldSync {
    constructor(session, state) {
        this.session = session;
        this.game = state.game;
        this.state = state;             // PlayingState
        this.remotePlayers = new Map(); // pid -> RemotePlayer
        this.byNid = new Map();         // nid -> entity (asteroids/enemies/pickups/caches/encounters)
        this.locks = new Map();         // "kind:id" -> pid holding it
        this._sendTimer = 0;
        this._shotQueue = [];           // local shots since last state send
        this.waveTargetPid = 0;
        this.destroyed = false;
    }

    get myPid() { return this.session.pid; }

    // All player "bodies" — local Player first, then live remote ships. Used
    // for enemy targeting, magnet targets, wave centering, spawn-region checks.
    playerBodies() {
        const out = [];
        if (this.state.player && !this.state.isDead) out.push(this.state.player);
        for (const rp of this.remotePlayers.values()) {
            if (rp._hasState && !rp.isDead && !rp.disconnected) out.push(rp);
        }
        return out;
    }

    nearestBodyTo(x, y) {
        let best = null, bestD = Infinity;
        for (const b of this.playerBodies()) {
            const dx = b.worldX - x, dy = b.worldY - y;
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = b; }
        }
        return best;
    }

    // Route damage to whichever player body a host-side check hit.
    damagePlayerBody(body, amount, x, y) {
        if (body === this.state.player) {
            this.state._damagePlayer(amount, x ?? body.worldX, y ?? body.worldY);
        } else if (body && body.isRemotePlayer && this.session.isHost) {
            this.session.sendTo(body.pid, MSG.DAMAGE_PLAYER, { amount: q(amount), x: q(x ?? body.worldX), y: q(y ?? body.worldY) });
        }
    }

    ensureRemotePlayer(pid) {
        if (pid === this.myPid) return null;
        let rp = this.remotePlayers.get(pid);
        if (!rp) {
            const info = this.session.players.get(pid);
            rp = new RemotePlayer(this.game, pid, info ? info.name : `P${pid}`, info ? info.shipId : 'fighter');
            this.remotePlayers.set(pid, rp);
        }
        return rp;
    }

    onPlayerLeft(pid) {
        this.remotePlayers.delete(pid);
        // Release any locks they held
        for (const [key, holder] of this.locks) {
            if (holder === pid) this.locks.delete(key);
        }
        if (this.state.tradeUI && this.state.tradeUI.partnerPid === pid) {
            this.state.tradeUI.forceClose('Partner disconnected.');
        }
    }

    // Dropped but held in the reconnect grace window — freeze their ghost (kept
    // in the world, excluded from targeting via playerBodies()).
    onPlayerDisconnected(pid) {
        const rp = this.remotePlayers.get(pid);
        if (rp) rp.disconnected = true;
        if (this.state.tradeUI && this.state.tradeUI.partnerPid === pid) {
            this.state.tradeUI.forceClose('Partner disconnected.');
        }
    }

    onPlayerReconnected(pid) {
        const rp = this.remotePlayers.get(pid);
        if (rp) rp.disconnected = false;
    }

    // After our own socket dropped and recovered, the interpolation buffers and
    // clock estimate are stale — clear them so fresh snapshots re-seed cleanly
    // instead of teleporting remote ships.
    resetRemoteInterp() {
        for (const rp of this.remotePlayers.values()) {
            rp._buffer = [];
            rp._lastSnapT = -1;
            rp._hasState = false;
        }
    }

    // Spawn local visual projectiles for another player's shots.
    _spawnRemoteShots(rp, shots) {
        if (!shots || !shots.length) return;
        // One sound per packet per weapon kind — a single volley (multishot /
        // energy blaster) arrives as several entries but is one trigger pull.
        let laserAt = null, beamAt = null;
        for (const s of shots) {
            const [kind, x, y, angle, speed, spriteId] = s;
            if (kind === 1) {
                // Beam flash (railgun / energy blaster visual)
                if (!this.state.activeBeams) this.state.activeBeams = [];
                this.state.activeBeams.push({ x, y, angle, timer: 0.15 });
                beamAt = { x, y };
            } else {
                const proj = new Projectile(this.game, x, y, angle, speed, PROJ_SPRITES[spriteId] || 'blue_laser_ball', rp, 0);
                proj.friendly = true;
                proj.netVisual = true;
                this.state.projectiles.push(proj);
                laserAt = { x, y };
            }
        }
        // Positional: the sound engine attenuates by distance to the listener,
        // so a teammate firing across the map is quiet/silent, nearby is loud.
        if (laserAt) this.game.sounds.play('laser', { volume: 0.3, x: laserAt.x, y: laserAt.y });
        if (beamAt) this.game.sounds.play('railgun_shoot', { volume: 0.7, x: beamAt.x, y: beamAt.y });
    }

    // Record one of the LOCAL player's shots for the next state packet so
    // everyone else sees our lasers. Visual only — damage is reported separately.
    queueLocalShot(kind, x, y, angle, speed, spriteKey) {
        if (this._shotQueue.length < 40) {
            this._shotQueue.push([kind, q(x), q(y), q3(angle), Math.round(speed), projSpriteId(spriteKey)]);
        }
    }

    _packLocalState() {
        const p = this.state.player;
        let flags = 0;
        if (p.thrusting) flags |= PF.THRUSTING;
        if (p.shielding) flags |= PF.SHIELDING;
        if (p.isWarping) flags |= PF.WARPING;
        if (p.isBoosting) flags |= PF.BOOSTING;
        if (this.state.isDead) flags |= PF.DEAD;
        if (p.hasAncientCurse) flags |= PF.CURSED;
        const shots = this._shotQueue;
        this._shotQueue = [];
        return [
            q(p.worldX), q(p.worldY), q(p.vx), q(p.vy), q3(p.angle), flags,
            q3(Math.max(0, p.health / Math.max(1, p.maxHealth))),
            q3(Math.max(0, p.shieldEnergy / Math.max(1, p.maxShieldEnergy))),
            p.level,
            q(p.asteroidSpawnMult || 1),
            q(p.asteroidDrillMult || 1),
            shots,
            // Roster scrap for the multiplayer HUD list (not used for gameplay).
            Math.max(0, Math.round(p.scrap || 0)),
        ];
    }

    _applyRemoteState(rp, t, arr) {
        // arr layout mirrors _packLocalState
        rp.pushState(t, arr[0], arr[1], arr[2], arr[3], arr[4], arr[5], arr[6], arr[7], arr[8]);
        rp.asteroidSpawnMult = arr[9] || 1;
        rp.asteroidDrillMult = arr[10] || 1;
        this._spawnRemoteShots(rp, arr[11]);
        rp.scrap = arr[12] || 0;
    }

    // Advance remote player interpolation. Called from the PlayingState world tick.
    updateRemotePlayers(dt) {
        const renderT = this.session.hostNow() - INTERP_DELAY;
        for (const rp of this.remotePlayers.values()) {
            rp.update(dt, renderT);
        }
    }

    drawRemotePlayers(ctx, camera) {
        for (const rp of this.remotePlayers.values()) {
            rp.draw(ctx, camera);
        }
    }

    // ── Generic helpers shared by both sides ───────────────────────────────
    lockKey(kind, id) { return `${kind}:${id}`; }

    findShopByNetId(id) {
        return this.state.shops.find(s => s.netId === id) || null;
    }
    findEventByNetId(id) {
        return this.state.events.find(e => e.netId === id) || null;
    }

    // Cosmetic-only death for a replicated entity (debris, rubble, sound, shake).
    // Loot is NOT spawned here — it arrives as explicit spawn messages.
    cosmeticDeath(entity) {
        const state = this.state;
        state._triggerShakeAt(entity.worldX, entity.worldY, entity instanceof Asteroid ? 1.5 : 1.8);
        // White silhouette death pop for ship kills (replicas mirror the
        // shooter's local effect).
        if (!(entity instanceof Asteroid) && !entity.isBoss && state.cinematics) {
            state.cinematics.deathPop(entity);
        }
        this.game.sounds.play(entity instanceof Asteroid ? 'asteroid_break' : 'ship_explode',
            { volume: 0.4, x: entity.worldX, y: entity.worldY });
        if (entity._generateProceduralDebris) {
            const debris = entity._generateProceduralDebris();
            for (const d of debris) { if (state.rubble.length < 250) state.rubble.push(d); }
        }
        const rubbleCount = entity.rubbleCount || 4;
        for (let i = 0; i < rubbleCount; i++) {
            if (state.rubble.length < 250) state.rubble.push(new Rubble(this.game, entity.worldX, entity.worldY));
        }
    }

    destroy() {
        this.destroyed = true;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HOST
// ─────────────────────────────────────────────────────────────────────────────
export class HostWorldSync extends BaseWorldSync {
    constructor(session, state) {
        super(session, state);
        this.isHost = true;
        this._nextNid = 1;
        this._enemySnapTimer = 0;
        this._worldTimer = 0;
        this._eventTimer = 0;
        this._hpDirty = new Map();   // "kind:nid" -> [kind, nid, entity]
        this._hpTimer = 0;
        this._astVelTimer = 0;
        this._projQueue = [];        // enemy projectile spawn entries this frame
        this._remoteSpawners = new Map(); // pid -> AsteroidSpawner (created in playingState)
        this._registerHandlers();
    }

    bind() {
        // Stable ids for everything that already exists (fresh synchronized
        // start: all machines built the identical initial world from the seed,
        // in the same order — so counting up in array order matches).
        for (const ast of this.state.asteroids) this._assignNid(ast);
        this.state.shops.forEach((s, i) => { s.netId = i; });
        this.state.events.forEach((e, i) => { e.netId = i; });
        this._nextShopId = this.state.shops.length;
        this.waveTargetPid = 0;
    }

    _assignNid(ent) {
        ent.netId = this._nextNid++;
        this.byNid.set(ent.netId, ent);
        return ent.netId;
    }

    _registerHandlers() {
        const s = this.session;

        s.on(MSG.PLAYER_STATE, (arr, fromPid) => {
            const rp = this.ensureRemotePlayer(fromPid);
            if (!rp) return;
            const t = s.hostNow();
            this._applyRemoteState(rp, t, arr);
            rp._lastStateArr = arr;
            rp._lastStateT = t;
            const info = s.players.get(fromPid);
            if (info) info.alive = !rp.isDead;
        });

        s.on(MSG.DAMAGE, (m, fromPid) => {
            this._applyDamageFrom(fromPid, m.kind, m.nid, m.amount, m.hitX, m.hitY);
        });

        s.on(MSG.ASTEROID_RAM, (m, fromPid) => {
            const ast = this.byNid.get(m.nid);
            if (ast && ast.alive && ast instanceof Asteroid) {
                ast._lastDamageBy = fromPid;
                ast.alive = false;
                this.state._onEntityDestroyed(ast, fromPid);
            }
        });

        s.on(MSG.ENEMY_CONTACT, (m, fromPid) => {
            const en = this.byNid.get(m.nid);
            if (!en || !en.alive) return;
            const rp = this.remotePlayers.get(fromPid);
            if (m.freeze > 0) {
                // Mechanical-claw stun from a client.
                en.freeze(Math.min(5, m.freeze));
                if (!m.dmg) return;
            }
            en._lastDamageBy = fromPid;
            if (en.isBoss) {
                en.hit(1.0);
            } else if (en.onCollision && rp) {
                // Mirror Enemy.onCollision but with the client-computed damage
                // (it knows its own shield-capacitor build).
                if (en.state !== 'ram') {
                    if (en.hit(m.dmg || 20) ) {
                        this.state._onEntityDestroyed(en, fromPid);
                        return;
                    }
                    en.state = 'recovery';
                    const currentSpeed = en.baseSpeed * en.speedMult;
                    const invuln = Math.max(0.1, 0.6 - Math.max(0, (currentSpeed - 400) * 0.001));
                    en.stateTimer = Math.max(0.4, invuln);
                    en.invulnTimer = invuln;
                    en.targetAngleOverride = Math.atan2(en.worldY - rp.worldY, en.worldX - rp.worldX) + (Math.random() - 0.5) * 0.5;
                }
            }
            this.markHpDirty(KIND.ENEMY, en);
        });

        s.on(MSG.TAKE, (m, fromPid) => {
            this._handleTake(m.nid, fromPid);
        });

        s.on(MSG.PLAYER_DIED, (m, fromPid) => {
            const info = s.players.get(fromPid);
            if (info) info.alive = false;
            const rp = this.remotePlayers.get(fromPid);
            if (rp) rp.isDead = true;
            s.broadcast(MSG.PLAYER_DIED, { pid: fromPid });
            s.pushChat(0, `${s.playerName(fromPid)} was destroyed.`);
            s.broadcast(MSG.CHAT, { pid: 0, text: `${s.playerName(fromPid)} was destroyed.` });
        });

        s.on(MSG.PLAYER_RESPAWN, (m, fromPid) => {
            const info = s.players.get(fromPid);
            if (info) { info.alive = true; info.shipId = m.shipId || info.shipId; }
            const rp = this.remotePlayers.get(fromPid);
            if (rp) { rp.isDead = false; rp.setShip(m.shipId || rp.shipId); }
            s.broadcast(MSG.PLAYER_RESPAWN, { pid: fromPid, shipId: m.shipId }, fromPid);
        });

        s.on(MSG.LOCK_REQ, (m, fromPid) => {
            const granted = this.tryLock(m.kind, m.id, fromPid);
            s.sendTo(fromPid, MSG.LOCK_RES, { kind: m.kind, id: m.id, granted, byPid: this.locks.get(this.lockKey(m.kind, m.id)) });
        });

        s.on(MSG.UNLOCK, (m, fromPid) => {
            const key = this.lockKey(m.kind, m.id);
            if (this.locks.get(key) === fromPid) this.locks.delete(key);
        });

        s.on(MSG.SHOP_STATE, (m, fromPid) => {
            this.applyShopState(m);
            s.broadcast(MSG.SHOP_STATE, m, fromPid);
        });

        s.on(MSG.CACHE_STATE, (m, fromPid) => {
            this.applyCacheState(m);
            s.broadcast(MSG.CACHE_STATE, m, fromPid);
        });

        s.on(MSG.ENCOUNTER_OUTCOME, (m, fromPid) => {
            this._handleEncounterOutcome(m, fromPid);
        });

        s.on(MSG.SHOP_SPAWN_REQ, (m, fromPid) => {
            // A client used a shop map / earned a shop reveal — spawn it near them.
            const rp = this.remotePlayers.get(fromPid);
            this.state.spawnDistantShop(rp || null);
        });

        s.on(MSG.DROP_ITEM, (m) => {
            // A client dropped an item out of a UI — make it a real, shared
            // world pickup so every pilot can see and grab it.
            const item = makeItem(m.id, m.tier || 0);
            if (!item) return;
            const it = new ItemPickup(this.game, m.x, m.y, item);
            if (m.vx != null) { it.vx = m.vx; it.vy = m.vy; }
            this.state.itemPickups.push(it);
            this.broadcastSpawns([it]);
        });

        // Trading — every trade message carries {toPid}; the host either
        // consumes it (it's a participant) or forwards it to the recipient.
        const relayTrade = (type) => (m, fromPid) => {
            m.pid = fromPid;
            if (m.toPid === this.myPid) {
                if (this.state.onTradeMessage) this.state.onTradeMessage(type, m, fromPid);
            } else if (m.toPid !== undefined) {
                this.session.sendTo(m.toPid, type, m);
            }
        };
        s.on(MSG.TRADE_REQ, relayTrade(MSG.TRADE_REQ));
        s.on(MSG.TRADE_ACCEPT, relayTrade(MSG.TRADE_ACCEPT));
        s.on(MSG.TRADE_OFFER, relayTrade(MSG.TRADE_OFFER));
        s.on(MSG.TRADE_LOCK, relayTrade(MSG.TRADE_LOCK));
        s.on(MSG.TRADE_CANCEL, relayTrade(MSG.TRADE_CANCEL));
        s.on(MSG.TRADE_COMMIT, relayTrade(MSG.TRADE_COMMIT));
    }

    // Send a trade message as the host participant.
    sendTradeMsg(type, m) {
        m.pid = this.myPid;
        this.session.sendTo(m.toPid, type, m);
    }

    tryLock(kind, id, pid) {
        const key = this.lockKey(kind, id);
        const holder = this.locks.get(key);
        if (holder === undefined || holder === pid) {
            this.locks.set(key, pid);
            return true;
        }
        return false;
    }

    releaseLock(kind, id, pid) {
        const key = this.lockKey(kind, id);
        if (this.locks.get(key) === pid) this.locks.delete(key);
    }

    // ── Damage / kills ──────────────────────────────────────────────────────
    _applyDamageFrom(fromPid, kind, nid, amount, hitX, hitY) {
        amount = Math.max(0, Math.min(10000, Number(amount) || 0));
        if (kind === KIND.EVENT) {
            const ev = this.findEventByNetId(nid);
            if (!ev || !ev.alive) return;
            ev._lastDamageBy = fromPid;
            if (ev.hit(amount)) {
                this.state._onEntityDestroyed(ev, fromPid);
                this.session.broadcast(MSG.KILL, { kind, nid, killerPid: fromPid, hitX: q(ev.worldX), hitY: q(ev.worldY) });
            }
            this.markEventsDirty();
            return;
        }
        const ent = this.byNid.get(nid);
        if (!ent || !ent.alive) return;
        ent._lastDamageBy = fromPid;
        if (ent instanceof Asteroid) {
            if (ent.hit(amount)) {
                this.state._onEntityDestroyed(ent, fromPid);
            } else {
                this.markHpDirty(KIND.ASTEROID, ent);
            }
        } else { // enemy / boss
            const died = ent.hit(amount);
            if (died) {
                this.state._onEntityDestroyed(ent, fromPid);
            } else {
                this.markHpDirty(KIND.ENEMY, ent);
            }
        }
    }

    // PlayingState's collision/beam code routes ALL local damage through this
    // (in single player it falls back to the legacy path).
    damageEntity(ent, amount, hitX, hitY) {
        ent._lastDamageBy = this.myPid;
        const isEvent = this.state.events.includes(ent);
        const died = ent.hit(amount);
        if (!died) {
            if (isEvent) this.markEventsDirty();
            else if (ent instanceof Asteroid) this.markHpDirty(KIND.ASTEROID, ent);
            else if (ent.netId !== undefined) this.markHpDirty(KIND.ENEMY, ent);
        }
        return died;
    }

    markHpDirty(kind, ent) {
        if (ent.netId === undefined) return;
        this._hpDirty.set(`${kind}:${ent.netId}`, [kind, ent.netId, ent]);
    }
    markEventsDirty() { this._eventTimer = 0; }

    // Called by PlayingState._onEntityDestroyed AFTER local processing so the
    // kill + loot get replicated.
    onEntityKilled(entity, killerPid, gameplaySpawns) {
        if (this.destroyed) return;
        let kind, nid;
        if (entity instanceof Asteroid) { kind = KIND.ASTEROID; nid = entity.netId; }
        else if (entity.netId !== undefined && this.state.events.includes(entity)) { kind = KIND.EVENT; nid = entity.netId; }
        else if (entity.netId !== undefined) { kind = KIND.ENEMY; nid = entity.netId; }
        else return; // not replicated (e.g. died before registration)

        if (kind !== KIND.EVENT) this.byNid.delete(nid);
        this.session.broadcast(MSG.KILL, {
            kind, nid, killerPid: killerPid ?? this.myPid,
            hitX: q(entity.worldX), hitY: q(entity.worldY),
        });
        if (gameplaySpawns && gameplaySpawns.length) {
            this.broadcastSpawns(gameplaySpawns);
        }
    }

    // Split death/event spawns: gameplay entities get nids + broadcast; the
    // cosmetic ones (Rubble / ProceduralDebris) stay local everywhere.
    broadcastSpawns(spawns) {
        const pickups = [];
        const asteroids = [];
        for (const sp of spawns) {
            if (sp instanceof Asteroid) {
                this._assignNid(sp);
                asteroids.push(this._asteroidDescriptor(sp));
            } else if (sp instanceof Scrap) {
                this._assignNid(sp);
                pickups.push([sp.netId, PICKUP.SCRAP, q(sp.worldX), q(sp.worldY), q(sp.vx), q(sp.vy), sp.value, sp.assetKey, sp.type]);
            } else if (sp instanceof ExpOrb) {
                this._assignNid(sp);
                pickups.push([sp.netId, PICKUP.EXP, q(sp.worldX), q(sp.worldY), q(sp.vx), q(sp.vy), sp.amount, null, null, sp.ownerPid ?? null]);
            } else if (sp instanceof ItemPickup) {
                this._assignNid(sp);
                pickups.push([sp.netId, PICKUP.ITEM, q(sp.worldX), q(sp.worldY), q(sp.vx), q(sp.vy), 0, sp.item.id, sp.item.tier || 0]);
            }
        }
        if (asteroids.length) this.session.broadcast(MSG.SPAWN_ASTEROID, asteroids);
        if (pickups.length) this.session.broadcast(MSG.SPAWN_PICKUP, pickups);
    }

    _asteroidDescriptor(ast) {
        return {
            nid: ast.netId, x: q(ast.worldX), y: q(ast.worldY), size: ast.size,
            vx: q(ast.vx), vy: q(ast.vy), rot: q3(ast.rotation), rotSpd: q3(ast.rotSpeed),
            assetKey: ast.assetKey, seed: ast.contentSeed, hp: Math.round(ast.hp),
        };
    }

    registerAsteroid(ast) {
        this._assignNid(ast);
        this.session.broadcast(MSG.SPAWN_ASTEROID, [this._asteroidDescriptor(ast)]);
    }

    registerEnemy(en) {
        this._assignNid(en);
        this.session.broadcast(MSG.SPAWN_ENEMY, this._enemyDescriptor(en));
    }

    _enemyDescriptor(en) {
        return {
            nid: en.netId,
            cls: classifyEnemy(en),
            spriteKey: en.spriteKey,
            x: q(en.worldX), y: q(en.worldY),
            ds: q(en.difficultyScale || 1),
            hp: Math.round(en.health), maxHp: Math.round(en.maxHealth || en.health),
            upg: en.isUpgraded ? (en.upgradeType || 'stats') : null,
            yellow: !!en.yellowArmada,
            waveTag: en.waveTag || 0,
            boss: !!en.isBoss,
        };
    }

    registerEncounter(enc) {
        this._assignNid(enc);
        this.session.broadcast(MSG.SPAWN_ENCOUNTER, {
            nid: enc.netId, type: enc.encounterType,
            x: q(enc.worldX), y: q(enc.worldY),
            assetKey: enc.assetKey, portraitKey: enc.portraitKey,
            targetPid: enc.netTargetPid ?? 0,
        });
    }

    registerCache(cache, crashInfo = null) {
        this._assignNid(cache);
        this.session.broadcast(MSG.SPAWN_CACHE, {
            nid: cache.netId, x: q(cache.worldX), y: q(cache.worldY),
            seed: cache.contentSeed, isReward: !!cache.isReward,
            crash: crashInfo,
        });
    }

    registerShop(shop) {
        shop.netId = this._nextShopId++;
        this.session.broadcast(MSG.SHOP_SPAWNED, {
            idx: shop.netId, x: q(shop.worldX), y: q(shop.worldY),
            seed: shop.contentSeed, assetKey: shop.assetKey,
            inv: shop.inventory.serialize(),
        });
    }

    // Enemy/boss projectiles + beams — queued per frame, flushed in tick().
    queueEnemyProjectile(proj, owner) {
        const speed = Math.hypot(proj.vx, proj.vy);
        let targetPid = -1;
        if (proj.isRocket && proj.target) {
            if (proj.target === this.state.player) targetPid = this.myPid;
            else if (proj.target.isRemotePlayer) targetPid = proj.target.pid;
        }
        this._projQueue.push([
            q(proj.worldX), q(proj.worldY), q3(proj.angle), Math.round(speed),
            projSpriteId(proj.spriteKey || 'red_laser_ball'), q(proj.damage),
            owner ? owner.netId ?? -1 : -1, targetPid, q(proj.lifetime),
        ]);
    }

    broadcastEnemyBeam(owner, x, y, angle) {
        this.session.broadcast(MSG.ENEMY_PROJ, [[q(x), q(y), q3(angle), 0, 0, 0, owner.netId ?? -1, -1, 0, 1]]);
    }

    broadcastMusicCue(key) {
        this.session.broadcast(MSG.MUSIC_CUE, { key });
    }

    // Host chose a new exploration/combat song — tell everyone which one (and,
    // for late joiners, where the playhead is) so all clients stay in lockstep.
    broadcastMusicTrack(mode, index, pos = 0) {
        this.session.broadcast(MSG.MUSIC_TRACK, { mode, index, pos: q(pos) });
    }

    // Current exploration/combat/boss song for the join-in-progress snapshot, so
    // a player joining mid-run drops straight into the music everyone else hears.
    _musicSnapshot() {
        const sm = this.game.sounds;
        const cur = sm.currentMusic;
        if (!cur) return null;
        if (sm.explorationTracks.includes(cur))
            return { mode: 'exploration', index: sm.explorationTracks.indexOf(cur), pos: q(cur.currentTime || 0) };
        if (sm.combatTracks.includes(cur))
            return { mode: 'combat', index: sm.combatTracks.indexOf(cur), pos: q(cur.currentTime || 0) };
        for (const key in sm.bossTracks) {
            if (sm.bossTracks[key] === cur) return { mode: 'boss', key };
        }
        return null;
    }

    broadcastDespawn(kind, ents) {
        const nids = [];
        for (const e of ents) {
            // Only entities still registered — KILL/TOOK paths already
            // broadcast their own removal and cleared the registry.
            if (e.netId !== undefined && this.byNid.has(e.netId)) {
                nids.push(e.netId);
                this.byNid.delete(e.netId);
            }
        }
        if (nids.length) this.session.broadcast(MSG.DESPAWN, { kind, nids });
    }

    // ── Wave targeting ──────────────────────────────────────────────────────
    chooseWaveTarget() {
        const candidates = [];
        if (!this.state.isDead) candidates.push(this.myPid);
        for (const [pid, info] of this.session.players) {
            if (pid !== this.myPid && info.alive !== false && info.inRun) candidates.push(pid);
        }
        if (candidates.length === 0) candidates.push(this.myPid);
        // Seeded pick so the same run seed gives the same wave routing.
        const r = this.game.rng ? this.game.rng.enemies.next() : Math.random();
        this.waveTargetPid = candidates[Math.floor(r * candidates.length)] ?? this.myPid;
        return this.waveTargetPid;
    }

    waveTargetBody() {
        if (this.waveTargetPid === this.myPid) return this.state.player;
        return this.remotePlayers.get(this.waveTargetPid) || this.state.player;
    }

    announceWave(num, bossKey) {
        this.session.broadcast(MSG.WAVE_START, { num, targetPid: this.waveTargetPid, bossKey: bossKey || null });
    }

    // ── Pickups ─────────────────────────────────────────────────────────────
    _handleTake(nid, pid) {
        const ent = this.byNid.get(nid);
        if (!ent || !ent.alive) return;
        // Owned EXP can only be taken by its killer.
        if (ent instanceof ExpOrb && ent.ownerPid != null && ent.ownerPid !== pid) return;
        ent.alive = false;
        this.byNid.delete(nid);
        this.session.broadcast(MSG.TOOK, { nid, pid });
    }

    // Host's own collection — apply locally then broadcast removal.
    localTake(ent) {
        if (ent.netId === undefined) return true;
        if (!this.byNid.has(ent.netId)) return false; // already taken
        this.byNid.delete(ent.netId);
        this.session.broadcast(MSG.TOOK, { nid: ent.netId, pid: this.myPid });
        return true;
    }

    // ── Encounter outcomes (interactor → host) ──────────────────────────────
    _handleEncounterOutcome(m, fromPid) {
        const enc = this.byNid.get(m.nid);
        this.releaseLock('encounter', m.nid, fromPid);
        if (!enc || !enc.alive) return;
        if (m.outcome === 'hostile') {
            // Build the hostile version exactly like _convertEncounterToEnemy,
            // using the interactor-reported wealth scaling.
            this.state._convertEncounterToEnemyNet(enc, m.maxScrap || 0, !!m.forced);
        } else if (m.outcome === 'depart') {
            enc.depart();
            this.session.broadcast(MSG.ENCOUNTER_OUTCOME, { nid: m.nid, outcome: 'depart' });
        }
        // 'stay' → nothing; ship keeps orbiting.
    }

    // ── Join-in-progress snapshot ───────────────────────────────────────────
    // opts.resume    → seamless in-grace reconnect: the client kept its live
    //                  ship, so don't move it (just resync the shared world).
    // opts.resumeBlob → grace-expired rejoin: fold the pilot's retained
    //                  ship/stats into the snapshot so they're restored exactly.
    sendJoinSnapshot(pid, opts = {}) {
        const st = this.state;
        const body = this.state.player;
        // Free spot near the host player (only used for a fresh spawn).
        const angle = Math.random() * Math.PI * 2;
        const spawnX = body.worldX + Math.cos(angle) * 260;
        const spawnY = body.worldY + Math.sin(angle) * 260;

        const snapshot = {
            resume: !!opts.resume,
            player: opts.resumeBlob || null,
            runSeed: st.runSeed,
            rng: st.rng.serialize(),
            totalGameTime: st.totalGameTime,
            difficultyScale: st.difficultyScale,
            waveTimer: st.waveTimer,
            waveNumber: st.enemySpawner.waveNumber,
            waveTargetPid: this.waveTargetPid,
            spawnX: q(spawnX), spawnY: q(spawnY),
            music: this._musicSnapshot(),
            players: this.session.lobbySnapshot(),
            events: st.events.map(ev => ({
                netId: ev.netId,
                type: ev.constructor.name,
                worldX: q(ev.worldX), worldY: q(ev.worldY),
                state: ev.state,
                wave: ev.wave,
                spawnedInitialScrap: ev.spawnedInitialScrap,
                positions: ev.positions,
                angles: ev.angles,
                health: ev.health, maxHealth: ev.maxHealth,
                isFinished: ev.isFinished,
                invulnerable: ev.invulnerable,
                phase1Triggered: ev.phase1Triggered,
            })),
            shops: st.shops.map(s => ({ netId: s.netId, ...s.serialize() })),
            asteroids: st.asteroids.filter(a => a.alive).map(a => this._asteroidDescriptor(a)),
            enemies: st.enemies.filter(e => e.alive).map(e => this._enemyDescriptor(e)),
            encounters: st.encounters.filter(e => e.alive).map(e => ({
                nid: e.netId, type: e.encounterType, x: q(e.worldX), y: q(e.worldY),
                assetKey: e.assetKey, portraitKey: e.portraitKey, targetPid: e.netTargetPid ?? 0,
            })),
            caches: st.caches.filter(c => c.alive).map(c => ({
                nid: c.netId, x: q(c.worldX), y: q(c.worldY), seed: c.contentSeed,
                isReward: !!c.isReward, state: c.state, items: c.netItems || null,
            })),
            pickups: this._pickupSnapshot(),
        };
        this.session.sendTo(pid, MSG.JOIN_SNAPSHOT, snapshot);
        // A seamless resume keeps the existing ghost where it froze; only a
        // fresh/late spawn repositions it near the host.
        if (!opts.resume) {
            const rp = this.ensureRemotePlayer(pid);
            if (rp) { rp.worldX = spawnX; rp.worldY = spawnY; }
        }
    }

    _pickupSnapshot() {
        const out = [];
        const push = (e, kind, value, itemId, tier, owner = null) => {
            if (e.netId === undefined || !e.alive) return;
            out.push([e.netId, kind, q(e.worldX), q(e.worldY), q(e.vx), q(e.vy), value, itemId, tier, owner]);
        };
        for (const sc of this.state.scrapEntities) push(sc, PICKUP.SCRAP, sc.value, sc.assetKey, sc.type);
        for (const orb of this.state.expOrbs) push(orb, PICKUP.EXP, orb.amount, null, null, orb.ownerPid ?? null);
        for (const it of this.state.itemPickups) push(it, PICKUP.ITEM, 0, it.item.id, it.item.tier || 0);
        return out;
    }

    // ── Per-frame ───────────────────────────────────────────────────────────
    tick(dt) {
        if (this.destroyed) return;
        const s = this.session;

        // Flush queued enemy projectiles
        if (this._projQueue.length) {
            s.broadcast(MSG.ENEMY_PROJ, this._projQueue);
            this._projQueue = [];
        }

        // Player relay @30Hz — host's own state + every client's latest.
        this._sendTimer -= dt;
        if (this._sendTimer <= 0) {
            this._sendTimer = 1 / RATE_PLAYER_STATE;
            const now = s.hostNow();
            const entries = [[this.myPid, now, ...this._packLocalState()]];
            for (const [pid, rp] of this.remotePlayers) {
                if (rp._lastStateArr) {
                    entries.push([pid, rp._lastStateT, ...rp._lastStateArr]);
                    rp._lastStateArr = null; // only relay fresh data
                }
            }
            if (entries.length) s.broadcast(MSG.PLAYERS_RELAY, entries);
        }

        // Enemy + encounter snapshot @15Hz
        this._enemySnapTimer -= dt;
        if (this._enemySnapTimer <= 0) {
            this._enemySnapTimer = 1 / RATE_ENEMY_SNAP;
            const entries = [];
            for (const en of this.state.enemies) {
                if (!en.alive || en.netId === undefined) continue;
                let st = 0;
                if (en.state === 'windup') st |= ST.WINDUP;
                if (en.state === 'ram') st |= ST.RAM;
                if (en.isTargeting || en.isChargingBeam) st |= ST.TARGETING;
                if (en.state === BOSS_STATE.DYING) st |= ST.DYING;
                if (en.phase === 'attack2') st |= ST.PHASE2;
                if (en.phase === 'intro') st |= ST.INTRO;
                const beamAngle = (en.activeBeams && en.activeBeams.length) ? q3(en.activeBeams[en.activeBeams.length - 1].angle) : null;
                entries.push([en.netId, q(en.worldX), q(en.worldY), q3(en.angle), Math.round(en.health), st, beamAngle]);
            }
            for (const enc of this.state.encounters) {
                if (!enc.alive || enc.netId === undefined) continue;
                entries.push([enc.netId, q(enc.worldX), q(enc.worldY), q3(enc.angle), 0, 0, null]);
            }
            if (entries.length) s.broadcast(MSG.ENEMY_SNAP, [s.hostNow(), entries]);
        }

        // HP updates @10Hz
        this._hpTimer -= dt;
        if (this._hpTimer <= 0) {
            this._hpTimer = 0.1;
            if (this._hpDirty.size) {
                const entries = [];
                for (const [, [kind, nid, ent]] of this._hpDirty) {
                    if (ent.alive) entries.push([kind, nid, Math.round(ent.hp !== undefined ? ent.hp : ent.health)]);
                }
                this._hpDirty.clear();
                if (entries.length) s.broadcast(MSG.HP_UPDATE, entries);
            }
        }

        // Asteroid velocity corrections @10Hz — only for rocks whose velocity
        // changed since the last broadcast (tractor beams, launches).
        this._astVelTimer -= dt;
        if (this._astVelTimer <= 0) {
            this._astVelTimer = 0.1;
            const entries = [];
            for (const ast of this.state.asteroids) {
                if (!ast.alive || ast.netId === undefined) continue;
                const lastVx = ast._netVx !== undefined ? ast._netVx : ast.vx;
                const lastVy = ast._netVy !== undefined ? ast._netVy : ast.vy;
                if (ast._netVx === undefined || Math.abs(ast.vx - lastVx) > 0.5 || Math.abs(ast.vy - lastVy) > 0.5) {
                    if (ast._netVx !== undefined) {
                        entries.push([ast.netId, q(ast.worldX), q(ast.worldY), q(ast.vx), q(ast.vy)]);
                    }
                    ast._netVx = ast.vx;
                    ast._netVy = ast.vy;
                }
                if (entries.length >= 60) break;
            }
            if (entries.length) s.broadcast(MSG.ASTEROID_VEL, entries);
        }

        // World state @2Hz
        this._worldTimer -= dt;
        if (this._worldTimer <= 0) {
            this._worldTimer = 1 / RATE_WORLD_STATE;
            s.broadcast(MSG.WORLD_STATE, {
                waveTimer: q(this.state.waveTimer),
                difficulty: q(this.state.difficultyScale),
                waveNum: this.state.enemySpawner.waveNumber,
                waveTargetPid: this.waveTargetPid,
                gameTime: q(this.state.totalGameTime),
            });
        }

        // Event sync @2Hz (or immediately after markEventsDirty)
        this._eventTimer -= dt;
        if (this._eventTimer <= 0) {
            this._eventTimer = 1 / RATE_EVENT_SYNC;
            const entries = [];
            for (const ev of this.state.events) {
                if (ev.netId === undefined) continue;
                entries.push([
                    ev.netId, ev.state ?? null,
                    ev.health !== undefined ? Math.round(ev.health) : null,
                    q(ev.worldX), q(ev.worldY),
                    !!ev.isFinished, !!ev.alive, ev.wave ?? null,
                ]);
            }
            if (entries.length) s.broadcast(MSG.EVENT_SYNC, entries);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT
// ─────────────────────────────────────────────────────────────────────────────
export class ClientWorldSync extends BaseWorldSync {
    constructor(session, state) {
        super(session, state);
        this.isHost = false;
        this._snapBuffers = new Map();  // nid -> [{t,x,y,angle}] interpolation buffers
        this.waveTargetPid = 0;
        this._persistTimer = 5;         // first upload shortly after the run starts
        this._registerHandlers();
    }

    // Send our current ship/stats to the host so it can hand them back on a
    // rejoin (host owns the player record). Fired on a low-frequency keepalive
    // and on discrete changes (purchases, item moves) via PlayingState.
    uploadPersist() {
        if (!this.state.player) return;
        this.session.send(MSG.PLAYER_PERSIST, {
            shipId: this.state.shipData ? this.state.shipData.id : undefined,
            blob: this.state.player.serialize(),
        });
    }

    bind() {
        // Mirror the host's deterministic initial-world numbering.
        let nid = 1;
        for (const ast of this.state.asteroids) {
            ast.netId = nid++;
            ast.netRemote = true;
            this.byNid.set(ast.netId, ast);
        }
        this.state.shops.forEach((s, i) => { s.netId = i; });
        this.state.events.forEach((e, i) => { e.netId = i; });
    }

    _registerHandlers() {
        const s = this.session;

        s.on(MSG.PLAYERS_RELAY, (entries) => {
            for (const e of entries) {
                const pid = e[0];
                if (pid === this.myPid) continue;
                const rp = this.ensureRemotePlayer(pid);
                if (rp) this._applyRemoteState(rp, e[1], e.slice(2));
            }
        });

        s.on(MSG.SPAWN_ASTEROID, (list) => {
            for (const d of list) this._spawnAsteroid(d);
        });

        s.on(MSG.SPAWN_ENEMY, (d) => this._spawnEnemy(d));
        s.on(MSG.SPAWN_PICKUP, (list) => {
            for (const d of list) this._spawnPickup(d);
        });
        s.on(MSG.SPAWN_CACHE, (d) => this._spawnCache(d));
        s.on(MSG.SPAWN_ENCOUNTER, (d) => this._spawnEncounter(d));

        s.on(MSG.ENEMY_SNAP, ([t, entries]) => {
            for (const e of entries) {
                const ent = this.byNid.get(e[0]);
                if (!ent || !ent.alive) continue;
                let buf = ent._netBuf;
                if (!buf) { buf = ent._netBuf = []; }
                buf.push({ t, x: e[1], y: e[2], angle: e[3] });
                while (buf.length > 2 && buf[0].t < t - 1.2) buf.shift();
                if (e[4] > 0 && ent.health !== undefined) ent.health = e[4];
                this._applyEnemyStateBits(ent, e[5], e[6]);
            }
        });

        s.on(MSG.ENEMY_PROJ, (list) => {
            for (const e of list) this._spawnEnemyProjectile(e);
        });

        s.on(MSG.HP_UPDATE, (entries) => {
            for (const [kind, nid, hp] of entries) {
                if (kind === KIND.EVENT) {
                    const ev = this.findEventByNetId(nid);
                    if (ev && ev.health !== undefined) ev.health = hp;
                } else {
                    const ent = this.byNid.get(nid);
                    if (!ent) continue;
                    if (ent.hp !== undefined) ent.hp = hp;
                    else if (ent.health !== undefined) ent.health = hp;
                }
            }
        });

        s.on(MSG.KILL, (m) => this._handleKill(m));
        s.on(MSG.DESPAWN, (m) => {
            for (const nid of m.nids) {
                const ent = this.byNid.get(nid);
                if (ent) { ent.alive = false; this.byNid.delete(nid); }
            }
        });

        s.on(MSG.TOOK, (m) => this._handleTook(m));

        s.on(MSG.ASTEROID_VEL, (entries) => {
            for (const [nid, x, y, vx, vy] of entries) {
                const ast = this.byNid.get(nid);
                if (ast && ast.alive) {
                    // Snap-correct; rocks are big and slow enough that a hard set
                    // at correction time is invisible.
                    ast.worldX = x; ast.worldY = y;
                    ast.vx = vx; ast.vy = vy;
                }
            }
        });

        s.on(MSG.WORLD_STATE, (m) => {
            this.state.waveTimer = m.waveTimer;
            this.state.difficultyScale = m.difficulty;
            this.state.totalGameTime = m.gameTime;
            this.state.enemySpawner.waveNumber = m.waveNum;
            this.waveTargetPid = m.waveTargetPid;
        });

        s.on(MSG.WAVE_START, (m) => {
            this.waveTargetPid = m.targetPid;
            if (m.bossKey) {
                this.state.triggerFlash('#ffffff', 1.2, 0.5);
            } else {
                this.state.triggerFlash('#ff0000', 0.8, 0.35);
                this.game.sounds.play('ship_explode', 0.6);
            }
        });

        s.on(MSG.MUSIC_CUE, (m) => {
            this.game.sounds.playSpecificMusic(m.key);
        });

        s.on(MSG.MUSIC_TRACK, (m) => {
            this.game.sounds.playSyncedTrack(m.mode, m.index, m.pos || 0);
        });

        s.on(MSG.WAVE_CLEARED, () => {
            this.state.stats.wavesCleared++;
            if (this.game.achievements) this.game.achievements.notify('wave_cleared');
        });

        s.on(MSG.EVENT_SYNC, (entries) => {
            for (const e of entries) {
                const [netId, evState, hp, x, y, isFinished, alive, wave] = e;
                const ev = this.findEventByNetId(netId);
                if (!ev) continue;
                const scripted = LOCAL_SCRIPTED_EVENTS.has(ev.constructor.name);
                if (!scripted && evState !== null && evState !== undefined) ev.state = evState;
                if (hp !== null && ev.health !== undefined) ev.health = hp;
                if (wave !== null && ev.wave !== undefined) ev.wave = wave;
                if (isFinished) ev.isFinished = true;
                if (!alive) ev.alive = false;
                if (!scripted && !ev._netPosLocked) {
                    // Position: blend hard if far off, gently otherwise.
                    const dx = x - ev.worldX, dy = y - ev.worldY;
                    if (dx * dx + dy * dy > 400 * 400) {
                        trySetEventPos(ev, x, y);
                    } else {
                        ev._netTargetX = x;
                        ev._netTargetY = y;
                    }
                }
            }
        });

        s.on(MSG.DAMAGE_PLAYER, (m) => {
            this.state._damagePlayer(m.amount, m.x, m.y);
        });

        s.on(MSG.PLAYER_DIED, (m) => {
            const rp = this.remotePlayers.get(m.pid);
            if (rp) rp.isDead = true;
            const info = s.players.get(m.pid);
            if (info) info.alive = false;
        });

        s.on(MSG.PLAYER_RESPAWN, (m) => {
            const rp = this.remotePlayers.get(m.pid);
            if (rp) { rp.isDead = false; rp.setShip(m.shipId || rp.shipId); }
            const info = s.players.get(m.pid);
            if (info) info.alive = true;
        });

        s.on(MSG.LOCK_RES, (m) => {
            if (this.state.onLockResult) this.state.onLockResult(m);
        });

        s.on(MSG.SHOP_STATE, (m) => this.applyShopState(m));
        s.on(MSG.CACHE_STATE, (m) => this.applyCacheState(m));
        s.on(MSG.SHOP_SPAWNED, (m) => this._spawnShop(m));
        s.on(MSG.ENCOUNTER_OUTCOME, (m) => {
            const enc = this.byNid.get(m.nid);
            if (enc && m.outcome === 'depart') enc.state = 3; // ENC_STATE.DEPARTING (visual; host snaps position)
        });

        const tradeTypes = [MSG.TRADE_REQ, MSG.TRADE_ACCEPT, MSG.TRADE_OFFER, MSG.TRADE_LOCK, MSG.TRADE_CANCEL, MSG.TRADE_COMMIT];
        for (const t of tradeTypes) {
            s.on(t, (m) => {
                if (this.state.onTradeMessage) this.state.onTradeMessage(t, m, m.pid);
            });
        }
    }

    _applyEnemyStateBits(ent, st, beamAngle) {
        if (st === undefined || st === null) return;
        if (!ent.isBoss) {
            if (st & ST.WINDUP) ent.state = 'windup';
            else if (st & ST.RAM) ent.state = 'ram';
            else if (ent.state === 'windup' || ent.state === 'ram') ent.state = 'pursuit';
            ent.isTargeting = !!(st & ST.TARGETING);
        } else {
            ent.isChargingBeam = !!(st & ST.TARGETING);
            if (st & ST.INTRO) ent.phase = 'intro';
            else ent.phase = (st & ST.PHASE2) ? 'attack2' : 'attack1';
            if ((st & ST.DYING) && ent.state !== BOSS_STATE.DYING) {
                ent._triggerDeathSequence();
            }
        }
        if (beamAngle !== null && beamAngle !== undefined && ent.activeBeams) {
            for (const b of ent.activeBeams) b.angle = beamAngle;
        }
    }

    // ── Spawn handlers ──────────────────────────────────────────────────────
    _spawnAsteroid(d) {
        if (this.byNid.has(d.nid)) return;
        const ast = new Asteroid(this.game, d.x, d.y, d.size, d.vx, d.vy);
        ast.netId = d.nid;
        ast.netRemote = true;
        ast.rotation = d.rot;
        ast.rotSpeed = d.rotSpd;
        if (d.assetKey) {
            ast.assetKey = d.assetKey;
            ast.img = this.game.assets.get(d.assetKey) || ast.img;
        }
        if (d.seed != null) {
            ast.contentSeed = d.seed;
            ast.contentRng = new RNG(d.seed);
        }
        if (d.hp) ast.hp = d.hp;
        ast._nearPlayer = true;
        this.byNid.set(d.nid, ast);
        this.state.asteroids.push(ast);
    }

    _spawnEnemy(d) {
        if (this.byNid.has(d.nid)) return;
        let en;
        switch (d.cls) {
            case ENEMY_CLS.STARCORE: en = new Starcore(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.CRUSHER: en = new AsteroidCrusher(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.HORIZON: en = new EventHorizon(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.HOSTILE_ENCOUNTER: {
                en = new HostileEncounter(this.game, d.x, d.y, d.ds, null);
                const img = this.game.assets.get(d.spriteKey);
                if (img) en.initEncounterData(img, d.spriteKey);
                break;
            }
            case ENEMY_CLS.CTHULHU: en = new CthulhuEnemy(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.KAMIKAZE: en = new KamikazeEnemy(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.NANITE: en = new NaniteEnemy(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.NANITE_DRONE: en = new NaniteDrone(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.SHIELD: en = new ShieldEnemy(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.MISSILE: en = new MissileEnemy(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.BLINK: en = new BlinkEnemy(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.BERSERK: en = new BerserkEnemy(this.game, d.x, d.y, d.ds); break;
            case ENEMY_CLS.SCAVENGER: en = new ScavengerEnemy(this.game, d.x, d.y, d.ds); break;
            default: en = new Enemy(this.game, d.x, d.y, d.ds);
        }
        if (d.spriteKey && d.cls !== ENEMY_CLS.HOSTILE_ENCOUNTER && !(en instanceof Boss)) {
            en.spriteKey = d.spriteKey;
            en.img = this.game.assets.get(d.spriteKey) || en.img;
        }
        en.netId = d.nid;
        en.netRemote = true;
        en.health = d.hp;
        en.maxHealth = d.maxHp;
        en.waveTag = d.waveTag;
        en.yellowArmada = !!d.yellow;
        if (d.upg) {
            en.isUpgraded = true;
            en.upgradeType = d.upg;
        }
        en._nearPlayer = true;
        this.byNid.set(d.nid, en);
        this.state.enemies.push(en);
    }

    _spawnPickup(d) {
        const [nid, kind, x, y, vx, vy, value, itemIdOrKey, tierOrType, ownerPid] = d;
        if (this.byNid.has(nid)) return;
        let ent = null;
        if (kind === PICKUP.SCRAP) {
            ent = new Scrap(this.game, x, y, tierOrType || 'small');
            if (itemIdOrKey) {
                ent.assetKey = itemIdOrKey;
                ent.img = this.game.assets.get(itemIdOrKey) || ent.img;
            }
            ent.value = value;
            if (this.state.scrapEntities.length < 400) this.state.scrapEntities.push(ent);
        } else if (kind === PICKUP.EXP) {
            ent = new ExpOrb(this.game, x, y, value);
            if (ownerPid != null) ent.ownerPid = ownerPid; // killer's XP
            if (this.state.expOrbs.length < 300) this.state.expOrbs.push(ent);
        } else if (kind === PICKUP.ITEM) {
            const item = makeItem(itemIdOrKey, tierOrType || 0);
            if (!item) return;
            ent = new ItemPickup(this.game, x, y, item);
            this.state.itemPickups.push(ent);
            if (this.state._onItemDropped) this.state._onItemDropped(ent);
        }
        if (!ent) return;
        ent.vx = vx; ent.vy = vy;
        ent.netId = nid;
        ent.netRemote = true;
        this.byNid.set(nid, ent);
    }

    _spawnCache(d) {
        if (this.byNid.has(d.nid)) return;
        const cache = new SpaceCache(this.game, d.x, d.y);
        cache.netId = d.nid;
        cache.netRemote = true;
        if (d.seed != null) {
            cache.contentSeed = d.seed;
            cache.contentRng = new RNG(d.seed);
        }
        cache.isReward = !!d.isReward;
        if (d.items) cache.netItems = d.items;
        if (d.state && d.state !== CACHE_STATE.INCOMING && d.state !== CACHE_STATE.SETTLING) {
            cache.state = d.state;
        }
        if (d.crash) {
            cache.startCrashLanding(d.crash.px, d.crash.py, { angle: d.crash.angle, tx: d.crash.tx, ty: d.crash.ty });
        }
        this.byNid.set(d.nid, cache);
        this.state.caches.push(cache);
    }

    _spawnEncounter(d) {
        if (this.byNid.has(d.nid)) return;
        const enc = new EncounterShip(this.game, d.x, d.y, d.type);
        enc.netId = d.nid;
        enc.netRemote = true;
        enc.netTargetPid = d.targetPid;
        if (d.assetKey) {
            enc.assetKey = d.assetKey;
            enc.img = this.game.assets.get(d.assetKey) || enc.img;
        }
        if (d.portraitKey) {
            enc.portraitKey = d.portraitKey;
            enc.portraitImg = this.game.assets.get(d.portraitKey) || enc.portraitImg;
        }
        this.byNid.set(d.nid, enc);
        this.state.encounters.push(enc);
    }

    _spawnShop(m) {
        const shop = new Shop(this.game, m.x, m.y);
        shop.netId = m.idx;
        if (m.assetKey) {
            shop.assetKey = m.assetKey;
            shop.img = this.game.assets.get(m.assetKey) || shop.img;
        }
        if (m.inv) shop.inventory.deserialize(m.inv);
        this.state.shops.push(shop);
        this.state._revealShop(shop);
        this.state.stats.shopsUnlocked++;
    }

    _spawnEnemyProjectile(e) {
        const [x, y, angle, speed, spriteId, damage, ownerNid, targetPid, lifetime, isBeam] = e;
        const owner = ownerNid >= 0 ? this.byNid.get(ownerNid) : null;
        if (isBeam) {
            if (owner && owner.activeBeams) {
                owner.activeBeams.push({ x, y, angle, timer: owner.isBoss ? 1.0 : 0.2 });
                owner.isTargeting = false;
            }
            return;
        }
        const proj = new Projectile(
            this.game, x, y, angle, speed,
            PROJ_SPRITES[spriteId] || 'red_laser_ball',
            owner || { alive: true, isNetGhost: true },
            damage, lifetime || 2.0
        );
        if (targetPid >= 0) {
            proj.isRocket = true;
            proj.turnRate = 2.0;
            proj.target = targetPid === this.myPid
                ? this.state.player
                : this.remotePlayers.get(targetPid) || null;
        }
        this.state.projectiles.push(proj);
        this.game.sounds.play('laser', { volume: 0.25, x, y });
    }

    // ── Kill / loot handling ────────────────────────────────────────────────
    _handleKill(m) {
        if (m.kind === KIND.EVENT) {
            const ev = this.findEventByNetId(m.nid);
            if (ev) {
                ev.alive = false;
                this.state._triggerShakeAt(ev.worldX, ev.worldY, 1.8);
                this.game.sounds.play('ship_explode', { volume: 0.6, x: ev.worldX, y: ev.worldY });
            }
            return;
        }
        const ent = this.byNid.get(m.nid);
        if (!ent) return;
        this.byNid.delete(m.nid);
        if (!ent.alive) return;
        ent.alive = false;

        this.cosmeticDeath(ent);

        // Boss wreck marker + music restore mirrors host behavior.
        if (ent.isBoss) {
            this.state.bossWrecks.push(new BossWreck(ent.worldX, ent.worldY));
            const otherBosses = this.state.enemies.some(e => e.isBoss && e.alive && e !== ent);
            if (!otherBosses) this.game.sounds.restoreMusic();
        }

        // Personal stats/achievements only for OUR kills.
        if (m.killerPid === this.myPid) {
            if (ent instanceof Asteroid) {
                this.state.stats.asteroidsDestroyed++;
                if (this.game.achievements) {
                    this.game.achievements.notify('asteroid_destroyed', {
                        entity: ent,
                        playerShieldBroken: this.state.player.shieldBroken && !this.state.player.shielding,
                    });
                }
            } else {
                this.state.stats.enemiesDefeated++;
                if (this.state.killStreak) this.state.killStreak.onKill(ent);
                if (this.game.achievements) this.game.achievements.notify('enemy_killed', { entity: ent });
            }
        }
    }

    _handleTook(m) {
        const ent = this.byNid.get(m.nid);
        this.byNid.delete(m.nid);
        if (!ent) return;
        const mine = m.pid === this.myPid;
        if (ent.alive || ent._pendingTake) {
            ent.alive = false;
            if (mine) this._applyPickupGain(ent);
            else if (ent._pendingTake && ent._optimisticItem) {
                // We optimistically added the item but someone else won the race.
                this._revertOptimisticItem(ent._optimisticItem);
            }
        }
    }

    _applyPickupGain(ent) {
        const state = this.state;
        const p = state.player;
        if (ent instanceof Scrap) {
            p.scrap += ent.value;
            state.stats.scrapCollected += ent.value;
            if (this.game.achievements) this.game.achievements.notify('scrap_collected', { amount: ent.value });
            this.game.sounds.play('scrap', { volume: 0.4, x: ent.worldX, y: ent.worldY });
            state.spawnFloatingText(ent.worldX, ent.worldY, `+${ent.value}`, '#ffff00');
        } else if (ent instanceof ExpOrb) {
            const finalExp = Math.ceil(ent.amount * (p.experienceCondenserMult || 1.0));
            p.addExp(finalExp);
            this.game.sounds.play('exp', { volume: 0.15, x: ent.worldX, y: ent.worldY });
            state.spawnFloatingText(ent.worldX + (Math.random() - 0.5) * 20, ent.worldY + (Math.random() - 0.5) * 20, `+${finalExp} XP`, '#915dbf');
        } else if (ent instanceof ItemPickup) {
            // Item was already optimistically added at request time.
            if (!ent._optimisticItem) {
                if (p.inventory.autoAdd(ent.item)) {
                    this.game.sounds.play('select', 0.5);
                    if (this.game.achievements) this.game.achievements.notify('upgrade_collected', { item: ent.item });
                    state._onInventoryChanged();
                    state.celebratePickup(ent.item);
                }
            } else {
                // Optimistic add confirmed — the prize is officially ours.
                state.celebratePickup(ent.item);
            }
        }
    }

    _revertOptimisticItem(item) {
        const inv = this.state.player.inventory;
        const entry = inv.items.find(e => e.item === item);
        if (entry) {
            inv.removeItemAt(entry.x, entry.y);
            this.state._onInventoryChanged();
        }
    }

    // ── Local-side actions ──────────────────────────────────────────────────
    // Local projectile/beam damage against a replicated entity.
    damageEntity(ent, amount, hitX, hitY) {
        if (ent._pendingDeath) return false;
        let kind, nid;
        if (ent instanceof Asteroid) { kind = KIND.ASTEROID; nid = ent.netId; }
        else if (this.state.events.includes(ent)) { kind = KIND.EVENT; nid = ent.netId; }
        else { kind = KIND.ENEMY; nid = ent.netId; }
        if (nid === undefined) {
            // Events spawned locally mid-run (the post-Yellow One Seraph) have
            // no host authority — resolve the hit on the local sim.
            if (kind === KIND.EVENT) return ent.hit(amount);
            return false;
        }

        // Local prediction: tick HP down but never kill — the host's KILL is
        // the only thing that destroys a replicated entity.
        if (kind !== KIND.EVENT) {
            if (ent.hp !== undefined) ent.hp = Math.max(0.5, ent.hp - amount);
            else if (ent.health !== undefined && !ent.isBoss) ent.health = Math.max(0.5, ent.health - amount);
            this.state.spawnFloatingText(ent.worldX, ent.worldY, `-${Math.ceil(amount)}`, '#ff4444');
        }
        this.session.send(MSG.DAMAGE, { kind, nid, amount: q(amount), hitX: q(hitX ?? ent.worldX), hitY: q(hitY ?? ent.worldY) });
        return false; // never "died" locally
    }

    requestTake(ent) {
        // Local-only pickups (items the pilot dropped out of a UI) need no
        // arbitration — apply directly.
        if (ent.netId === undefined) {
            if (ent instanceof ItemPickup) {
                if (this.state.player.inventory.autoAdd(ent.item)) {
                    ent.alive = false;
                    this.game.sounds.play('select', 0.5);
                    if (this.game.achievements) this.game.achievements.notify('upgrade_collected', { item: ent.item });
                    this.state._onInventoryChanged();
                } else {
                    ent.markEncountered(this.state.player.worldX, this.state.player.worldY);
                }
            } else {
                ent.alive = false;
                this._applyPickupGain(ent);
            }
            return;
        }
        if (ent._pendingTake) return;
        ent._pendingTake = true;
        ent.alive = false; // hide immediately; TOOK confirms or it stays gone

        // Optimistic apply for items so the inventory feels instant; scrap/exp
        // apply on confirm (sub-100ms — imperceptible, and floating text plays now).
        if (ent instanceof ItemPickup) {
            if (this.state.player.inventory.autoAdd(ent.item)) {
                ent._optimisticItem = ent.item;
                this.game.sounds.play('select', 0.5);
                if (this.game.achievements) this.game.achievements.notify('upgrade_collected', { item: ent.item });
                this.state._onInventoryChanged();
            } else {
                ent.alive = true;
                ent._pendingTake = false;
                return;
            }
        }
        this.session.send(MSG.TAKE, { nid: ent.netId });
    }

    reportEnemyContact(en, dmg, freeze = 0) {
        if (en.netId === undefined) return;
        this.session.send(MSG.ENEMY_CONTACT, { nid: en.netId, dmg: q(dmg), freeze });
    }

    reportAsteroidRam(ast) {
        if (ast.netId === undefined) return;
        ast.alive = false;
        this.byNid.delete(ast.netId);
        this.cosmeticDeath(ast);
        this.session.send(MSG.ASTEROID_RAM, { nid: ast.netId });
    }

    // ── Replica advancement (called from PlayingState world tick) ───────────
    updateReplicas(dt) {
        const renderT = this.session.hostNow() - INTERP_DELAY;

        // Enemies + encounters interpolate from snapshots.
        const interp = (ent) => {
            const buf = ent._netBuf;
            if (!buf || !buf.length) return;
            let a = null, b = null;
            for (let i = buf.length - 1; i >= 0; i--) {
                if (buf[i].t <= renderT) { a = buf[i]; b = buf[i + 1] || null; break; }
            }
            let tx, ty, tangle;
            if (a && b) {
                const span = b.t - a.t;
                const f = span > 0.0001 ? Math.min(1, (renderT - a.t) / span) : 1;
                tx = a.x + (b.x - a.x) * f;
                ty = a.y + (b.y - a.y) * f;
                let d = b.angle - a.angle;
                while (d > Math.PI) d -= Math.PI * 2;
                while (d < -Math.PI) d += Math.PI * 2;
                tangle = a.angle + d * f;
            } else {
                const latest = buf[buf.length - 1];
                tx = latest.x; ty = latest.y; tangle = latest.angle;
            }
            // Smooth convergence (same trick as remote players).
            const k = 1 - Math.exp(-dt * 30);
            const ex = tx - ent.worldX, ey = ty - ent.worldY;
            if (ex * ex + ey * ey > 800 * 800) { ent.worldX = tx; ent.worldY = ty; }
            else { ent.worldX += ex * k; ent.worldY += ey * k; }
            let da = tangle - ent.angle;
            while (da > Math.PI) da -= Math.PI * 2;
            while (da < -Math.PI) da += Math.PI * 2;
            ent.angle += da * k;
            // Estimated velocity for projectile dodge prediction visuals
            ent.vx = ex / Math.max(dt, 0.001) * k;
            ent.vy = ey / Math.max(dt, 0.001) * k;
        };

        for (const en of this.state.enemies) {
            if (!en.alive) continue;
            interp(en);
            // Tick cosmetic timers replicas need for drawing.
            if (en.activeBeams && en.activeBeams.length) {
                for (let i = en.activeBeams.length - 1; i >= 0; i--) {
                    en.activeBeams[i].timer -= dt;
                    if (en.activeBeams[i].timer <= 0) en.activeBeams.splice(i, 1);
                }
            }
            if (en.isBoss && en.state === BOSS_STATE.DYING && en.deathExplosions) {
                this._tickBossDying(en, dt);
            }
        }
        for (const enc of this.state.encounters) {
            if (enc.alive) interp(enc);
        }

        // Events blend toward authoritative positions (skipping events whose
        // position is computed/read-only).
        for (const ev of this.state.events) {
            if (ev._netTargetX !== undefined && !ev._netPosLocked) {
                const k = 1 - Math.exp(-dt * 2.5);
                trySetEventPos(
                    ev,
                    ev.worldX + (ev._netTargetX - ev.worldX) * k,
                    ev.worldY + (ev._netTargetY - ev.worldY) * k
                );
            }
        }

        this.updateRemotePlayers(dt);
    }

    // Cosmetic boss death sequence on replicas (mirrors Boss._updateDying
    // minus the authoritative kill — the host's KILL message finishes it).
    _tickBossDying(boss, dt) {
        for (const ex of boss.deathExplosions) {
            if (!ex.fired) {
                ex.delay -= dt;
                if (ex.delay <= 0) {
                    ex.fired = true;
                    this.game.sounds.play('ship_explode', { volume: 0.6, x: boss.worldX, y: boss.worldY });
                    this.game.camera.shake(3.0);
                }
            } else if (!ex.finished) {
                ex.animTimer += dt * 1000;
                if (ex.animTimer >= ex.totalDuration) ex.finished = true;
            }
        }
    }

    sendTradeMsg(type, m) {
        m.pid = this.myPid;
        this.session.send(type, m);
    }

    tick(dt) {
        if (this.destroyed) return;
        this.session.update(dt);
        this._sendTimer -= dt;
        if (this._sendTimer <= 0) {
            this._sendTimer = 1 / RATE_PLAYER_STATE;
            this.session.send(MSG.PLAYER_STATE, this._packLocalState());
        }
        // Low-frequency ship/stats keepalive (discrete changes also push via
        // PlayingState._onInventoryChanged).
        this._persistTimer -= dt;
        if (this._persistTimer <= 0) {
            this._persistTimer = 10;
            this.uploadPersist();
        }
    }
}

// ── Shared interactable-state appliers (mixed into both classes) ─────────────
const sharedAppliers = {
    applyShopState(m) {
        const shop = this.findShopByNetId(m.idx);
        if (!shop) return;
        if (m.inv) shop.inventory.deserialize(m.inv);
        if (m.perm) shop.permUpgrades = { ...m.perm };
    },

    applyCacheState(m) {
        const cache = this.byNid.get(m.nid);
        if (!cache || !(cache instanceof SpaceCache)) return;
        if (m.action === 'open') {
            if (cache.state === CACHE_STATE.CLOSED || cache.state === CACHE_STATE.FOUND) cache.open();
            return;
        }
        if (m.items) cache.netItems = m.items;
        if (m.emptied) cache.markEmptied();
    },
};
Object.assign(HostWorldSync.prototype, sharedAppliers);
Object.assign(ClientWorldSync.prototype, sharedAppliers);
