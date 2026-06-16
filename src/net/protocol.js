// Multiplayer wire protocol.
//
// Every message is one JSON array: [type, ...payload]. Numeric type constants
// keep packets small; the hot-path messages (player state, enemy snapshots)
// additionally use positional arrays instead of objects. All gameplay numbers
// that cross the wire are quantized via q()/q2() — sub-0.01px precision is
// noise that costs bytes.
//
// No images/assets ever cross the wire: spawns carry assetKey strings + content
// seeds, and every machine resolves them against its own local asset files.

export const NET_PROTOCOL_VERSION = 2;
export const NET_MAX_PLAYERS = 8;
export const NET_DEFAULT_PORT = 27777;

// Tick rates (Hz)
export const RATE_PLAYER_STATE = 30;   // client → host own-ship state
export const RATE_PLAYER_RELAY = 30;   // host → clients all-player states
export const RATE_ENEMY_SNAP = 15;     // host → clients enemy snapshots
export const RATE_WORLD_STATE = 2;     // host → clients timers/difficulty
export const RATE_EVENT_SYNC = 2;      // host → clients event authoritative sync
export const INTERP_DELAY = 0.1;       // seconds of interpolation buffer on replicas

export const MSG = {
    // ── Lobby / control ────────────────────────────────────────────────────
    HELLO: 1,           // c→h {name, shipId, ver, token, resuming}
    WELCOME: 2,         // h→c {pid, players, worldSeed, inRun}
    REJECT: 3,          // h→c {reason}
    LOBBY: 4,           // h→c {players:[{pid,name,shipId,alive}]}
    START: 5,           // h→c {runSeed, worldSeed, players}
    JOIN_SNAPSHOT: 6,   // h→c {snapshot} (join-in-progress full world; resume:true keeps the live ship; player:blob restores ship/stats)
    CHAT: 7,            // both {pid, text}
    PLAYER_LEFT: 8,     // h→c {pid}
    SHIP_CHANGE: 9,     // c→h {shipId} (lobby only)
    END: 10,            // h→c {reason} session over
    PING: 11,           // c→h {t}
    PONG: 12,           // h→c {t, ht} (echo + host clock)
    PLAYER_DISCONNECTED: 13, // h→c {pid} dropped, held in grace — show "reconnecting", freeze ghost
    PLAYER_RECONNECTED: 14,  // h→c {pid} resumed within grace — unfreeze
    PLAYER_PERSIST: 15,      // c→h {blob} client uploads player.serialize() so the host can restore ship/stats on rejoin

    // ── Player replication ─────────────────────────────────────────────────
    PLAYER_STATE: 20,   // c→h [t, x, y, vx, vy, angle, flags, hpFrac, shieldFrac, level, shots[]]
    PLAYERS_RELAY: 21,  // h→c [hostT, [pid, ...state], ...]
    PLAYER_DIED: 22,    // c→h {} / h→c {pid}
    PLAYER_RESPAWN: 23, // c→h {shipId} / h→c {pid, x, y, shipId}
    DAMAGE_PLAYER: 24,  // h→c {amount, x, y} (host-side world hit a remote player)

    // ── World entity replication (host → clients) ──────────────────────────
    SPAWN_ASTEROID: 30, // {nid,x,y,size,vx,vy,rot,rotSpd,assetKey,seed,t}
    SPAWN_ENEMY: 31,    // {nid,cls,spriteKey,x,y,ds,hp,maxHp,upg,sel,waveTag,boss}
    SPAWN_PICKUP: 32,   // {nid,kind,x,y,vx,vy,value,itemId,tier,assetKey}
    SPAWN_CACHE: 33,    // {nid,x,y,seed,isReward,crash:{tx,ty}}
    SPAWN_ENCOUNTER: 34,// {nid,type,x,y,assetKey,portraitKey}
    ENEMY_SNAP: 35,     // [t, [nid,x,y,angle,hp,aiState], ...]
    ENEMY_PROJ: 36,     // [[x,y,angle,speed,spriteId,damage,ownerNid], ...]
    KILL: 37,           // {kind,nid,killerPid,hitX,hitY}
    HP_UPDATE: 38,      // [[kind,nid,hp], ...]
    DESPAWN: 39,        // {kind,nids:[...]}
    WORLD_STATE: 40,    // {waveTimer,difficulty,waveNum,waveTargetPid,gameTime,playerCount}
    WAVE_START: 41,     // {num,targetPid,bossKey}
    EVENT_SYNC: 42,     // [[idx,state,hp,x,y,revealed,discovered,finished], ...]
    ASTEROID_VEL: 43,   // [[nid,x,y,vx,vy], ...] (velocity changed e.g. crusher tractor)
    MUSIC_CUE: 44,      // {key} boss music etc.
    WAVE_CLEARED: 45,   // h→c {num} (stats/achievements on every machine)
    MUSIC_TRACK: 46,    // h→c {mode:'exploration'|'combat', index, pos} synced song choice + playhead

    // ── Client world actions (client → host) ───────────────────────────────
    DAMAGE: 50,         // {kind,nid,amount,hitX,hitY}
    ENEMY_CONTACT: 51,  // {nid, dmg} player rammed an enemy
    TAKE: 52,           // {nid} collect pickup request
    TOOK: 53,           // h→c {nid, pid}
    MY_SHOTS: 54,       // folded into PLAYER_STATE — reserved
    ASTEROID_RAM: 55,   // {nid} player flew into asteroid (destroy it)
    DROP_ITEM: 56,      // c→h {id,tier,x,y,vx,vy} item dropped into space (host spawns + replicates)

    // ── Interactables ──────────────────────────────────────────────────────
    LOCK_REQ: 60,       // c→h {kind:'shop'|'cache'|'encounter', id}
    LOCK_RES: 61,       // h→c {kind, id, granted, byPid}
    UNLOCK: 62,         // c→h {kind, id}
    SHOP_STATE: 63,     // both {idx, inv, perm} (after a shop session / purchase)
    CACHE_STATE: 64,    // both {nid, items:[{id,tier}], emptied}
    ENCOUNTER_OUTCOME: 65, // c→h {nid, outcome:'depart'|'hostile'|'stay', maxScrap, forced}
    SHOP_SPAWNED: 66,   // h→c {idx, x, y, seed, assetKey, inv} (new shop entered the world)
    SHOP_SPAWN_REQ: 67, // c→h {} (shop map / encounter reward wants a new distant shop)

    // ── Trading ────────────────────────────────────────────────────────────
    TRADE_REQ: 70,      // {fromPid, toPid}
    TRADE_ACCEPT: 71,   // {fromPid, toPid}
    TRADE_OFFER: 72,    // {pid, items:[{id,tier}], scrap}
    TRADE_LOCK: 73,     // {pid, locked}
    TRADE_CANCEL: 74,   // {pid}
    TRADE_COMMIT: 75,   // h→both {aPid, bPid, aGives, bGives}
};

// Replicated entity kinds (used in KILL / HP_UPDATE / DESPAWN / DAMAGE)
export const KIND = {
    ASTEROID: 0,
    ENEMY: 1,
    PICKUP: 2,
    EVENT: 3,   // nid = index into playingState.events
    CACHE: 4,
};

// Pickup kinds for SPAWN_PICKUP
export const PICKUP = { SCRAP: 0, EXP: 1, ITEM: 2 };

// Player state flags bitfield
export const PF = {
    THRUSTING: 1,
    SHIELDING: 2,
    WARPING: 4,
    BOOSTING: 8,
    DEAD: 16,
    CURSED: 32,   // ancient curse trail
};

// Enemy class ids for SPAWN_ENEMY
export const ENEMY_CLS = {
    BASIC: 0,
    KAMIKAZE: 1,
    CTHULHU: 2,
    HOSTILE_ENCOUNTER: 3,
    NANITE: 4,
    NANITE_DRONE: 5,
    SHIELD: 6,
    MISSILE: 7,
    BLINK: 8,
    BERSERK: 9,
    STARCORE: 10,
    CRUSHER: 11,
    HORIZON: 12,
    SCAVENGER: 13,
};

// Projectile sprite ids — keep a stable indexed table so projectile spawn
// messages carry one byte instead of a key string.
export const PROJ_SPRITES = [
    'blue_laser_ball', 'blue_laser_ball_big',
    'red_laser_ball', 'red_laser_ball_big',
    'yellow_laser_ball', 'yellow_laser_ball_big',
];
export function projSpriteId(key) {
    const i = PROJ_SPRITES.indexOf(key);
    return i >= 0 ? i : 0;
}

// Quantizers — 2 decimals for positions/velocities, 3 for angles.
export function q(v) { return Math.round(v * 100) / 100; }
export function q3(v) { return Math.round(v * 1000) / 1000; }

export function encode(type, payload) {
    return JSON.stringify([type, payload]);
}

export function decode(raw) {
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || arr.length < 1) return null;
        return { type: arr[0], payload: arr[1] };
    } catch {
        return null;
    }
}
