import { Projectile } from './projectile.js';
import { Enemy } from './enemy.js';
import { Scrap, ItemPickup, ExpOrb, VoronoiSlicer, ProceduralDebris } from './asteroid.js';
import { UPGRADES } from '../data/upgrades.js';
import { MUSIC_STATE } from '../engine/soundManager.js';

export const YO_STATE = {
    IDLE: 'idle',
    FOLLOWING: 'following',
    PHASE1: 'phase1',
    PHASE2: 'phase2',
    ENRAGED: 'enraged',
    SCRIPTED: 'scripted',
    FINISHED: 'finished'
};

export class YellowOne {
    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.vx = 0;
        this.vy = 0;
        this.alive = true;
        this.state = YO_STATE.IDLE;
        this.radius = 80;

        // GIF animations
        this.idleGif = game.assets.get('yellow_one_idle');
        this.crushGif = game.assets.get('yellow_one_crush');
        this.deadGif = game.assets.get('yellow_one_dead');
        this.summonGif = game.assets.get('yellow_one_summon');
        this.currentGif = this.idleGif;
        this.gifFrame = 0;
        this.gifTimer = 0;

        // Discovery
        this.revealed = false;
        this.discovered = false;
        this.isFinished = false;
        this.displayName = 'Strange Figure';

        // Health — invulnerable until phase 1, real health set when fight begins
        this.health = 50; // Throwaway pre-fight health (like Knowledge)
        this.maxHealth = 50;
        this.invulnerable = true; // Can't take damage until phase 1

        // Music timing
        this.musicStartTime = 0;
        this.musicPlaying = false;
        this.phase1Triggered = false;

        // Movement
        this.followDistance = 180;
        this.followSpeed = 500;
        this.dashTimer = 0;
        this.dashCooldown = 2.0;
        this.dashTarget = null;
        this.orbitAngle = Math.random() * Math.PI * 2;
        this.orbitDir = Math.random() > 0.5 ? 1 : -1;

        // Attack timers
        this.summonTimer = 0;
        this.crushTimer = 0;
        this.crushPattern = 0;

        // Summoned ships
        this.summonedShips = [];
        this.maxSummonedShips = 8;

        // Animation state for attacks
        this.attackAnimTimer = 0;
        this.attackAnimGif = null;

        // Phase 2
        this.teleportTimer = 0;
        this.teleportCooldown = 2.0;
        this.glowColor = '#ffdd44';
        this.glowIntensity = 0;

        // Enraged state
        this.enragedTimer = 0;
        this.enragedAttackSpeed = 1.0;
        this.playerSnapshot = null;

        // Scripted sequence
        this.scriptTimer = 0;
        this.scriptPhase = 0;
        this.christusX = 0;
        this.christusY = 0;
        this.deedVisible = false;
        this.deedShattered = false;
        this.deedPieces = [];
        this.yellowOneDeathPlaying = false;
        this.deathGifFrame = 0;
        this.deathGifTimer = 0;
        this.christusGlowing = false;
        this.christusAlpha = 1.0;
        this.constellationVisible = false;
        this.playerControlRestored = false;
        this.fadeToWhite = 0;
        this.fadeFromWhite = 0;
        this.whiteBackground = false;
        this.scriptStarted = false;
        this.preScriptWait = 0;

        // Beam tracking (for crush beam attacks)
        this.activeBeams = [];
        this.targetingBeams = [];

        // Pending spawns for playingState to pick up
        this.pendingSpawns = [];
        this.pendingEnemies = [];

        // Christus victor GIF
        this.christusGif = game.assets.get('christus_victor_gif');
        this.christusFrame = 0;
        this.christusTimer = 0;
    }

    update(dt, player) {
        if (!this.alive && this.state !== YO_STATE.SCRIPTED && this.state !== YO_STATE.FINISHED) return;

        // Update GIF animation
        this._updateGif(dt);

        // Update active beams
        for (let i = this.activeBeams.length - 1; i >= 0; i--) {
            this.activeBeams[i].timer -= dt;
            if (this.activeBeams[i].timer <= 0) this.activeBeams.splice(i, 1);
        }

        // Update targeting beams
        for (let i = this.targetingBeams.length - 1; i >= 0; i--) {
            const tb = this.targetingBeams[i];
            tb.timer -= dt;
            if (tb.timer <= 0) {
                // Fire the actual beam
                this._fireBeam(tb);
                this.targetingBeams.splice(i, 1);
            }
        }

        // Clean dead summoned ships
        for (let i = this.summonedShips.length - 1; i >= 0; i--) {
            if (!this.summonedShips[i].alive) this.summonedShips.splice(i, 1);
        }

        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Discovery
        if (!this.revealed && dist < 3500) {
            this.revealed = true;
        }

        // State machine
        switch (this.state) {
            case YO_STATE.IDLE:
                this._updateIdle(dt, player, dist);
                break;
            case YO_STATE.FOLLOWING:
                this._updateFollowing(dt, player, dist);
                break;
            case YO_STATE.PHASE1:
                this._updatePhase1(dt, player, dist);
                break;
            case YO_STATE.PHASE2:
                this._updatePhase2(dt, player, dist);
                break;
            case YO_STATE.ENRAGED:
                this._updateEnraged(dt, player, dist);
                break;
            case YO_STATE.SCRIPTED:
                this._updateScripted(dt, player);
                break;
        }
    }

    // ─── STATES ────────────────────────────────────────────────────────

    _updateIdle(dt, player, dist) {
        // Float in space with idle animation
        this.currentGif = this.idleGif;

        if (dist < 1200 && !this.musicPlaying) {
            this.musicPlaying = true;
            this.musicStartTime = performance.now() / 1000;
            this.game.sounds.playSpecificMusic('The Yellow One');
            this.state = YO_STATE.FOLLOWING;

            // Freeze enemy spawning and wave timer
            if (this.game.currentState) {
                this.game.currentState.yellowOneFightActive = true;
            }
        }
    }

    _updateFollowing(dt, player, dist) {
        this.currentGif = this.idleGif;
        this.invulnerable = true;

        // Follow player — gentle floating orbit, faster when far away
        const distBoost = 1.0 + Math.max(0, dist - this.followDistance) * 0.003;
        this._moveTowardPlayer(dt, player, dist, this.followDistance, 600 * distBoost);

        // Check for 21-second mark to enter Phase 1
        const elapsed = (performance.now() / 1000) - this.musicStartTime;
        if (elapsed >= 21 && !this.phase1Triggered) {
            this.phase1Triggered = true;
            this.state = YO_STATE.PHASE1;
            this.invulnerable = false;
            this.summonTimer = 2.0;
            this.crushTimer = 5.0;
            this.dashTimer = 1.0;
            this.game.camera.shake(2.0);

            // Set real health now — difficultyScale is guaranteed valid during gameplay
            const diff = this.game.currentState.difficultyScale;
            this.health = 1200 + 220 * diff;
            this.maxHealth = this.health;
        }
    }

    _updatePhase1(dt, player, dist) {
        // Orbit and sweep around the player, faster when far
        const distBoost = 1.0 + Math.max(0, dist - 350) * 0.003;
        this._moveCombat(dt, player, dist, 350, 500 * distBoost);
        this._updateDashing(dt, player, dist);

        // Summon attack
        this.summonTimer -= dt;
        if (this.summonTimer <= 0) {
            this._summonAttack(player);
            this.summonTimer = 4.0 + Math.random() * 2.0;
        }

        // Crush attack
        this.crushTimer -= dt;
        if (this.crushTimer <= 0) {
            this._crushAttack(player);
            this.crushTimer = 3.5 + Math.random() * 2.0;
        }

        // Phase transition at 40% health
        if (this.health <= this.maxHealth * 0.4) {
            this.state = YO_STATE.PHASE2;
            this.glowIntensity = 1.0;
            this.glowColor = '#ffdd44';
            this.teleportTimer = 1.0;
            this.game.sounds.play('ship_explode', { volume: 1.0, x: this.worldX, y: this.worldY });
            this.game.camera.shake(3.0);
        }
    }

    _updatePhase2(dt, player, dist) {
        // Faster orbits, tighter distance, faster when far
        const distBoost = 1.0 + Math.max(0, dist - 280) * 0.004;
        this._moveCombat(dt, player, dist, 280, 650 * distBoost);
        this._updateDashing(dt, player, dist);

        // Teleporting
        this.teleportTimer -= dt;
        if (this.teleportTimer <= 0) {
            this._teleportNearPlayer(player);
            this.teleportTimer = this.teleportCooldown * (0.6 + Math.random() * 0.4);
        }

        // Faster attacks
        this.summonTimer -= dt;
        if (this.summonTimer <= 0) {
            this._summonAttack(player);
            this.summonTimer = 3.0 + Math.random() * 1.5;
        }

        this.crushTimer -= dt;
        if (this.crushTimer <= 0) {
            // Can also hurl asteroids and ships in phase 2
            const roll = Math.random();
            if (roll < 0.4) {
                this._crushAttack(player);
            } else if (roll < 0.7) {
                this._hurlAsteroids(player);
            } else {
                this._hurlShip(player);
            }
            this.crushTimer = 2.5 + Math.random() * 1.5;
        }

        // Check for "death" - transition to enraged
        if (this.health <= 0) {
            this._startEnraged(player);
        }
    }

    _startEnraged(player) {
        this.state = YO_STATE.ENRAGED;
        this.health = 1; // Keep alive
        this.glowColor = '#ff8800';
        this.enragedTimer = 0;
        this.enragedAttackSpeed = 1.0;

        // Flag so sacrifice and normal death are bypassed
        if (this.game.currentState) {
            this.game.currentState.yellowOneEnraged = true;
        }

        // Dramatic transition sound
        this.game.sounds.play('ship_explode', { volume: 1.0, x: this.worldX, y: this.worldY });
        this.game.sounds.play('shield_break', { volume: 0.8, x: this.worldX, y: this.worldY });
        this.game.camera.shake(4.0);

        // Snapshot player state BEFORE rapid attacks
        this.playerSnapshot = this._snapshotPlayer(player);
    }

    _updateEnraged(dt, player, dist) {
        this.enragedTimer += dt;

        // Get progressively faster
        this.enragedAttackSpeed = Math.min(8.0, 1.0 + this.enragedTimer * 0.5);

        // Aggressive sweeping, closing in, faster when far
        const distBoost = 1.0 + Math.max(0, dist - 220) * 0.005;
        this._moveCombat(dt, player, dist, 220, 800 * distBoost);

        // Rapid teleports
        this.teleportTimer -= dt;
        if (this.teleportTimer <= 0) {
            this._teleportNearPlayer(player);
            this.teleportTimer = Math.max(0.3, 1.5 / this.enragedAttackSpeed);
        }

        // Rapid crush attacks — skip animation, fire directly
        this.crushTimer -= dt;
        if (this.crushTimer <= 0) {
            this._enragedCrush(player);
            this.crushTimer = Math.max(0.4, 1.5 / this.enragedAttackSpeed);
        }

        // Rapid summons — skip animation, spawn directly
        this.summonTimer -= dt;
        if (this.summonTimer <= 0) {
            const p = this.game.currentState && this.game.currentState.player;
            if (p) this._finishSummon(p);
            this.summonTimer = Math.max(0.8, 2.5 / this.enragedAttackSpeed);
        }

        // After 5s of enraged, force kill the player (bypass regen and sacrifice)
        if (this.enragedTimer >= 5.0 && player.health > 0) {
            player.hasSacrifice = false;
            player.health = 0;
        }

        // Check if player is "dead" - trigger scripted sequence
        if (player.health <= 0 && this.game.currentState) {
            this._startScriptedSequence(player);
        }
    }

    _startScriptedSequence(player) {
        this.state = YO_STATE.SCRIPTED;
        this.scriptTimer = 0;
        this.scriptPhase = 0; // 0: death screen wait, 1: fade to white, 2: king's victory playing
        this.scriptStarted = false;

        // Stop all attacks
        this.targetingBeams = [];
        this.activeBeams = [];
        this._summonAnimPlaying = false;

        // Despawn all yellow armada ships
        for (const ship of this.summonedShips) {
            if (ship.alive) ship.alive = false;
        }
        this.summonedShips = [];

        const state = this.game.currentState;
        if (state) {
            // Remove ALL projectiles — player, enemy, everything
            for (const proj of state.projectiles) {
                proj.alive = false;
            }
            state.yellowOneEnraged = false;
            // Trigger the real death visuals (debris, death screen, stats)
            // but mark that buttons should be blocked
            state.yellowOneScriptActive = true;
            state.yellowOneDeathScreen = true;

            // Zero camera velocity
            this.game.camera.vx = 0;
            this.game.camera.vy = 0;
            this.game.camera.shakeIntensity = 0;

            // Let the normal death trigger run (shows debris + death screen)
            player.health = 0;
            player.alive = false;
            state.isDead = true;
            state.deathTimer = 0;
            state.showDeathScreen = false;
            state.game.sounds.play('ship_explode', 0.8);
            state.shipDebris = state._generateShipDebris();
            // Don't stop music - "The Yellow One" keeps playing
        }
    }

    _updateScripted(dt, player) {
        this.scriptTimer += dt;

        // Phase 0: Death screen showing, then 5-second fade to white once stats are visible
        if (this.scriptPhase === 0) {
            this.currentGif = this.idleGif;
            this.vx = 0;
            this.vy = 0;

            // Wait for death screen to appear (3s debris, then stats show)
            const state = this.game.currentState;
            const deathScreenVisible = state && state.showDeathScreen;

            if (deathScreenVisible) {
                // Track time since death screen appeared
                if (!this._fadeStartTime) this._fadeStartTime = this.scriptTimer;
                const fadeElapsed = this.scriptTimer - this._fadeStartTime;
                // Let the death screen sit for 3 seconds, then 5 second fade
                const fadeProgress = Math.max(0, fadeElapsed - 3.0) / 5.0;
                this.fadeToWhite = Math.min(1.0, fadeProgress);
            }

            if (this.fadeToWhite >= 1.0) {
                this.scriptPhase = 2;
                this.scriptTimer = 0; // KV timing starts now

                // Switch from fadeToWhite to fadeFromWhite — fades to reveal space background
                this.fadeToWhite = 0;
                this.fadeFromWhite = 1.0;

                // Hide death screen, restore player, zero camera
                const state = this.game.currentState;
                if (state) {
                    state.isDead = false;
                    state.showDeathScreen = false;
                    state.yellowOneDeathScreen = false;
                    state.shipDebris = [];
                    state.player.alive = true;
                    state.player.vx = 0;
                    state.player.vy = 0;
                    // Snap camera perfectly centered on player
                    this.game.camera.snapTo(state.player);
                }

                // Dramatic transition sound
                this.game.sounds.play('shield', { volume: 1.0, x: player.worldX, y: player.worldY });

                // Start King's Victory — completely bypass the sound manager
                const sounds = this.game.sounds;

                // 1. Kill everything the sound manager knows about
                sounds.musicLocked = false;
                sounds.isTransitioning = false;
                if (sounds.currentMusic) {
                    sounds.currentMusic.pause();
                    sounds.currentMusic.onended = null;
                }
                // Also kill any other boss track that might be playing
                for (const key in sounds.bossTracks) {
                    const t = sounds.bossTracks[key];
                    if (t && !t.paused) { t.pause(); t.onended = null; }
                }
                // Kill exploration/combat tracks too
                for (const t of sounds.explorationTracks) {
                    if (t && !t.paused) { t.pause(); t.onended = null; }
                }
                for (const t of sounds.combatTracks) {
                    if (t && !t.paused) { t.pause(); t.onended = null; }
                }

                sounds.currentMusic = null;
                sounds.musicState = MUSIC_STATE.NONE;
                sounds.targetMusicState = MUSIC_STATE.NONE;

                // 2. Play KV directly
                const kvTrack = sounds.bossTracks["King's Victory"];
                if (kvTrack) {
                    kvTrack.currentTime = 0;
                    kvTrack.loop = false;
                    if (kvTrack.trackGain && sounds.ctx) {
                        kvTrack.trackGain.gain.cancelScheduledValues(sounds.ctx.currentTime);
                        kvTrack.trackGain.gain.setValueAtTime(1, sounds.ctx.currentTime);
                    }
                    kvTrack.play().catch(() => {});
                    sounds.currentMusic = kvTrack;
                    sounds.musicState = MUSIC_STATE.BOSS;
                    sounds.targetMusicState = MUSIC_STATE.BOSS;
                }

                // 3. LOCK — nothing can change music until KV finishes
                sounds.musicLocked = true;

                if (kvTrack) {
                    kvTrack.onended = () => {
                        sounds.musicLocked = false;
                        sounds.currentMusic = null;
                        sounds.musicState = MUSIC_STATE.NONE;
                        sounds.targetMusicState = MUSIC_STATE.NONE;
                        sounds.restoreMusic();
                    };
                }

                // Restore player health and inventory from snapshot
                this._restorePlayer(player);

                // Clean up floating items in 3000 unit radius
                this._cleanupItems(player);

                // Position scripted entities
                this.worldX = player.worldX - 400;
                this.worldY = player.worldY;
                this.christusX = player.worldX + 400;
                this.christusY = player.worldY;
            }
            return;
        }

        // Phase 2: King's Victory sequence (timer relative to song start)
        // Fade back from white over 2 seconds — reveals HUD, player, scripted entities
        if (this.fadeFromWhite > 0) {
            this.fadeFromWhite = Math.max(0, this.fadeFromWhite - dt * 0.5); // 2 seconds
        }

        const kv = this.scriptTimer; // Time since King's Victory started

        // At 7s: Deed appears in shower of light
        if (kv >= 7 && !this.deedVisible) {
            this.deedVisible = true;
            this.deedWorldX = player.worldX;
            this.deedWorldY = player.worldY - 150;
            this.game.sounds.play('shield', { volume: 0.8, x: this.deedWorldX, y: this.deedWorldY });
            this.game.sounds.play('level', { volume: 0.6, x: this.deedWorldX, y: this.deedWorldY });
            this.game.camera.shake(0.5);
        }

        // At 10s: Deed shatters into 7 pieces
        if (kv >= 10 && !this.deedShattered) {
            this.deedShattered = true;
            this._shatterDeed();
            this.game.sounds.play('asteroid_break', { volume: 1.0, x: this.deedWorldX, y: this.deedWorldY });
            this.game.sounds.play('ship_explode', { volume: 0.6, x: this.deedWorldX, y: this.deedWorldY });
            this.game.sounds.play('shield_break', { volume: 0.7, x: this.deedWorldX, y: this.deedWorldY });
            this.game.camera.shake(3.0);
        }

        // Update deed pieces (ProceduralDebris)
        if (this.deedShattered) {
            for (const piece of this.deedPieces) {
                piece.update(dt);
            }
        }

        // At 15s: Yellow One death animation (plays once, sound on frame 7)
        if (kv >= 15 && !this.yellowOneDeathPlaying) {
            this.yellowOneDeathPlaying = true;
            this._deathAnimDone = false;
            this.currentGif = this.deadGif;
            this.gifFrame = 0;
            this.gifTimer = 0;
        }

        // Once death animation finishes, hide the Yellow One
        if (this._deathAnimDone && !this._yellowOneHidden) {
            this._yellowOneHidden = true;
            this.radius = 0; // Remove hitbox
        }

        // At 17s: Christus Victor starts glowing white
        if (kv >= 17 && !this.christusGlowing) {
            this.christusGlowing = true;
            this.game.sounds.play('shield', { volume: 0.7, x: this.christusX, y: this.christusY });
            this.game.sounds.play('railgun_target', { volume: 0.3, x: this.christusX, y: this.christusY });
        }

        // At 21s: Christus Victor vanishes, constellation appears, player regains control
        if (kv >= 21 && !this.playerControlRestored) {
            this.playerControlRestored = true;
            this.constellationVisible = true;
            this.christusAlpha = 0;

            // Constellation reveal sounds
            this.game.sounds.play('level', { volume: 0.8, x: this.christusX, y: this.christusY });
            this.game.sounds.play('teleport', { volume: 0.6, x: this.christusX, y: this.christusY });
            this.game.sounds.play('exp', { volume: 0.5, x: this.christusX, y: this.christusY });
            this.game.camera.shake(1.0);

            // Player regains control
            if (this.game.currentState) {
                this.game.currentState.yellowOneScriptActive = false;
                this.game.currentState.yellowOneFightActive = false;
                // Reset music tracking so exploration/combat won't try to override KV
                this.game.currentState.musicCombatTriggered = false;
                this.game.currentState.quietTimer = 0;
            }

            // Drop loot at yellow one's position
            this._dropLoot();
            this.game.sounds.play('scrap', { volume: 0.6, x: this.worldX, y: this.worldY });

            // Permanent yellow glow on the player
            if (this.game.currentState && this.game.currentState.player) {
                this.game.currentState.player.hasYellowGlow = true;
            }

            // Mark as finished
            this.isFinished = true;
            this.state = YO_STATE.FINISHED;

            // Let King's Victory continue playing - it will end naturally
            // and playingState will restore normal music
        }

        // Christus Victor glow fade (17s to 21s)
        if (this.christusGlowing && !this.constellationVisible) {
            const glowProgress = Math.min(1.0, (kv - 17) / 4.0);
            this.christusAlpha = 1.0 - glowProgress * 0.3; // Partial fade
        }

        // Update christus victor GIF
        if (this.christusGif && this.christusGif.length > 0) {
            this.christusTimer += dt * 1000;
            const frame = this.christusGif[this.christusFrame];
            if (frame && this.christusTimer >= (frame.delay || 100)) {
                this.christusTimer = 0;
                this.christusFrame = (this.christusFrame + 1) % this.christusGif.length;
            }
        }
    }

    // ─── MOVEMENT ──────────────────────────────────────────────────────

    _moveTowardPlayer(dt, player, dist, targetDist, speed) {
        // Gentle floating follow — he drifts near the player with inertia
        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const angleToPlayer = Math.atan2(dy, dx);

        // Slowly orbit around the player while following
        this.orbitAngle += this.orbitDir * 0.4 * dt;

        // Target: a point at orbitAngle around the player
        const targetX = player.worldX + Math.cos(this.orbitAngle) * targetDist;
        const targetY = player.worldY + Math.sin(this.orbitAngle) * targetDist;

        // Gentle steering force toward target
        const toDx = targetX - this.worldX;
        const toDy = targetY - this.worldY;
        const toDist = Math.sqrt(toDx * toDx + toDy * toDy);

        if (toDist > 1) {
            // Soft acceleration — never snaps, always floats
            const steer = Math.min(speed * 1.5, toDist * 1.2);
            this.vx += (toDx / toDist) * steer * dt;
            this.vy += (toDy / toDist) * steer * dt;
        }

        // If very far, boost toward player
        if (dist > targetDist * 4) {
            this.vx += Math.cos(angleToPlayer) * speed * 2 * dt;
            this.vy += Math.sin(angleToPlayer) * speed * 2 * dt;
        }

        // Clamp speed
        const vel = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (vel > speed) {
            this.vx = (this.vx / vel) * speed;
            this.vy = (this.vy / vel) * speed;
        }

        // Friction — gives that floating-in-space feel
        const friction = Math.pow(0.93, dt * 60);
        this.vx *= friction;
        this.vy *= friction;

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
    }

    _moveCombat(dt, player, dist, orbitDist, speed) {
        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const angleToPlayer = Math.atan2(dy, dx);

        // Slow, deliberate orbit — not jittery
        this.orbitAngle += this.orbitDir * 0.8 * dt;

        // Decide what to do based on distance
        let forceX = 0, forceY = 0;

        if (dist > orbitDist * 3) {
            // Way too far — strong pull straight toward player
            forceX = Math.cos(angleToPlayer) * speed * 3;
            forceY = Math.sin(angleToPlayer) * speed * 3;
        } else if (dist > orbitDist * 1.5) {
            // Far — curve in toward orbit distance
            const approachAngle = angleToPlayer + 0.3 * this.orbitDir;
            forceX = Math.cos(approachAngle) * speed * 2;
            forceY = Math.sin(approachAngle) * speed * 2;
        } else {
            // Near orbit distance — sweep around the player
            // Tangential force (orbiting)
            const tangentAngle = angleToPlayer + (Math.PI / 2) * this.orbitDir;
            forceX += Math.cos(tangentAngle) * speed * 1.2;
            forceY += Math.sin(tangentAngle) * speed * 1.2;

            // Radial correction (maintain orbit distance)
            const distError = dist - orbitDist;
            forceX += Math.cos(angleToPlayer) * distError * 2.5;
            forceY += Math.sin(angleToPlayer) * distError * 2.5;
        }

        // Apply force as acceleration (not instant — gives weight)
        this.vx += forceX * dt;
        this.vy += forceY * dt;

        // Clamp speed
        const vel = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (vel > speed) {
            this.vx = (this.vx / vel) * speed;
            this.vy = (this.vy / vel) * speed;
        }

        // Space friction — momentum carries, but doesn't last forever
        const friction = Math.pow(0.94, dt * 60);
        this.vx *= friction;
        this.vy *= friction;

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
    }

    _updateDashing(dt, player, dist) {
        this.dashTimer -= dt;
        if (this.dashTimer <= 0) {
            // Deliberate reposition — pick a new spot around the player and sweep there
            const newAngle = Math.random() * Math.PI * 2;
            const newDist = 200 + Math.random() * 250;
            const targetX = player.worldX + Math.cos(newAngle) * newDist;
            const targetY = player.worldY + Math.sin(newAngle) * newDist;

            const toDx = targetX - this.worldX;
            const toDy = targetY - this.worldY;
            const toDist = Math.sqrt(toDx * toDx + toDy * toDy);

            if (toDist > 50) {
                const dashSpeed = 800 + Math.random() * 400;
                this.vx = (toDx / toDist) * dashSpeed;
                this.vy = (toDy / toDist) * dashSpeed;
            }

            // Reverse orbit direction for variety
            this.orbitDir = -this.orbitDir;
            this.dashTimer = this.dashCooldown + Math.random() * 2.0;
            this.game.sounds.play('boost', { volume: 0.4, x: this.worldX, y: this.worldY });
        }
    }

    _teleportNearPlayer(player) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 300 + Math.random() * 250;
        this.worldX = player.worldX + Math.cos(angle) * dist;
        this.worldY = player.worldY + Math.sin(angle) * dist;
        this.vx = 0;
        this.vy = 0;
        this.game.sounds.play('teleport', { volume: 0.6, x: this.worldX, y: this.worldY });
        this.game.camera.shake(0.5);
    }

    // ─── ATTACKS ───────────────────────────────────────────────────────

    _summonAttack(player) {
        if (this.summonedShips.length >= this.maxSummonedShips) return;

        // Play summon animation — ships spawn when it finishes
        this.currentGif = this.summonGif;
        this.gifFrame = 0;
        this.gifTimer = 0;
        this._pendingSummonCount = 1 + (Math.random() < 0.4 ? 1 : 0);
        this._summonAnimPlaying = true;
        this._summonSoundPlayed = false;
    }

    _finishSummon(player) {
        const count = this._pendingSummonCount || 1;
        const diff = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
        const worldScale = this.game.worldScale || 1;
        const screenW = (this.game.width / 2) / worldScale;
        const screenH = (this.game.height / 2) / worldScale;

        for (let i = 0; i < count; i++) {
            if (this.summonedShips.length >= this.maxSummonedShips) break;

            // Spawn off-screen, past the edge
            const edge = Math.floor(Math.random() * 4);
            const margin = 400 + Math.random() * 300;
            let spawnX, spawnY;
            switch (edge) {
                case 0: // Top
                    spawnX = player.worldX + (Math.random() - 0.5) * screenW * 2;
                    spawnY = player.worldY - screenH - margin;
                    break;
                case 1: // Bottom
                    spawnX = player.worldX + (Math.random() - 0.5) * screenW * 2;
                    spawnY = player.worldY + screenH + margin;
                    break;
                case 2: // Left
                    spawnX = player.worldX - screenW - margin;
                    spawnY = player.worldY + (Math.random() - 0.5) * screenH * 2;
                    break;
                case 3: // Right
                    spawnX = player.worldX + screenW + margin;
                    spawnY = player.worldY + (Math.random() - 0.5) * screenH * 2;
                    break;
            }

            const enemy = new Enemy(this.game, spawnX, spawnY, diff);
            enemy.yellowArmada = true;
            const variant = Math.floor(Math.random() * 4);
            enemy.spriteKey = `yellow_armada_${variant}`;
            enemy.img = this.game.assets.get(enemy.spriteKey);
            enemy._yellowGlowSprite = null;
            enemy.health = Math.ceil(enemy.health * 1.5);
            enemy.speedMult = 1.3;
            enemy.fireRateMult = 1.3;
            enemy.summonedByYellowOne = true;

            this.summonedShips.push(enemy);
            this.pendingEnemies.push(enemy);
        }

        this._pendingSummonCount = 0;
        this.game.sounds.play('boost', { volume: 0.5, x: this.worldX, y: this.worldY });
        this.game.sounds.play('teleport', { volume: 0.4, x: this.worldX, y: this.worldY });
    }

    _crushAttack(player) {
        this.currentGif = this.crushGif;
        this.gifFrame = 0;
        this.gifTimer = 0;
        this._crushAnimPlaying = true;
        this._crushSoundPlayed = false;

        // Store the attack to execute on frame 6
        const pattern = Math.floor(Math.random() * 3);
        this._pendingCrush = { pattern, player };
    }

    _enragedCrush(player) {
        // Fire projectiles immediately without animation — enraged phase only
        const diff = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
        const pattern = Math.floor(Math.random() * 3);
        if (pattern === 0) {
            this._spawnEdgeProjectiles(player, 'yellow_laser_ball', 6 + Math.floor(diff * 2), 500 + diff * 50, 8 + diff * 2, 6.0);
            this.game.sounds.play('laser', { volume: 0.5, x: this.worldX, y: this.worldY });
        } else if (pattern === 1) {
            this._spawnEdgeProjectiles(player, 'yellow_laser_ball_big', 3 + Math.floor(diff), 300 + diff * 30, 15 + diff * 3, 8.0);
            this.game.sounds.play('railgun_shoot', { volume: 0.4, x: this.worldX, y: this.worldY });
        } else {
            this._spawnEdgeBeams(player, 1 + Math.floor(Math.random() * 4 + diff * 0.5));
        }
    }

    _spawnEdgeProjectiles(player, spriteKey, count, speed, damage, lifetime = 3.0) {
        const state = this.game.currentState;
        if (!state) return;

        const cam = state.camera || this.game.camera;
        const hw = this.game.width / 2;
        const hh = this.game.height / 2;

        for (let i = 0; i < count; i++) {
            // Pick a random edge in world space, spawning far off-screen
            const edge = Math.floor(Math.random() * 4);
            let spawnX, spawnY;
            const margin = 800 + Math.random() * 400; // Spawn far past screen edge

            // Calculate screen-space extents in world units
            const worldScale = this.game.worldScale || 1;
            const screenW = hw / worldScale;
            const screenH = hh / worldScale;

            switch (edge) {
                case 0: // Top
                    spawnX = player.worldX + (Math.random() - 0.5) * screenW * 3;
                    spawnY = player.worldY - screenH - margin;
                    break;
                case 1: // Bottom
                    spawnX = player.worldX + (Math.random() - 0.5) * screenW * 3;
                    spawnY = player.worldY + screenH + margin;
                    break;
                case 2: // Left
                    spawnX = player.worldX - screenW - margin;
                    spawnY = player.worldY + (Math.random() - 0.5) * screenH * 3;
                    break;
                case 3: // Right
                    spawnX = player.worldX + screenW + margin;
                    spawnY = player.worldY + (Math.random() - 0.5) * screenH * 3;
                    break;
            }

            // Aim toward player with some spread
            const angle = Math.atan2(player.worldY - spawnY, player.worldX - spawnX) + (Math.random() - 0.5) * 0.3;

            const proj = new Projectile(this.game, spawnX, spawnY, angle, speed, spriteKey, this, damage, lifetime);
            if (this.game.currentState) {
                this.game.currentState.projectiles.push(proj);
            }
        }
    }

    _spawnEdgeBeams(player, count) {
        const state = this.game.currentState;
        if (!state) return;

        const worldScale = this.game.worldScale || 1;
        const screenW = (this.game.width / 2) / worldScale;
        const screenH = (this.game.height / 2) / worldScale;
        const diff = (state.difficultyScale) || 1.0;

        for (let i = 0; i < count; i++) {
            // Pick an edge - origin far off-screen so beam stretches across view
            const edge = Math.floor(Math.random() * 4);
            let originX, originY, beamAngle;
            const farMargin = 3000; // Origin far off-screen

            switch (edge) {
                case 0: // Top
                    originX = player.worldX + (Math.random() - 0.5) * screenW * 2;
                    originY = player.worldY - screenH - farMargin;
                    beamAngle = Math.PI / 2 + (Math.random() - 0.5) * 0.3; // Downward
                    break;
                case 1: // Bottom
                    originX = player.worldX + (Math.random() - 0.5) * screenW * 2;
                    originY = player.worldY + screenH + farMargin;
                    beamAngle = -Math.PI / 2 + (Math.random() - 0.5) * 0.3; // Upward
                    break;
                case 2: // Left
                    originX = player.worldX - screenW - farMargin;
                    originY = player.worldY + (Math.random() - 0.5) * screenH * 2;
                    beamAngle = (Math.random() - 0.5) * 0.3; // Rightward
                    break;
                case 3: // Right
                    originX = player.worldX + screenW + farMargin;
                    originY = player.worldY + (Math.random() - 0.5) * screenH * 2;
                    beamAngle = Math.PI + (Math.random() - 0.5) * 0.3; // Leftward
                    break;
            }

            // Add targeting warning first (1.5s delay)
            this.targetingBeams.push({
                x: originX,
                y: originY,
                angle: beamAngle,
                timer: 1.5,
                damage: 15 + diff * 3
            });
        }

        this.game.sounds.play('railgun_target', { volume: 0.7, x: player.worldX, y: player.worldY });
    }

    _fireBeam(targeting) {
        // Spawn a beam visual
        this.activeBeams.push({
            x: targeting.x,
            y: targeting.y,
            angle: targeting.angle,
            timer: 0.4
        });

        // Hitscan damage check
        const player = this.game.currentState && this.game.currentState.player;
        if (player) {
            const dx = player.worldX - targeting.x;
            const dy = player.worldY - targeting.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 0) {
                const dirX = Math.cos(targeting.angle);
                const dirY = Math.sin(targeting.angle);
                const dot = (dx * dirX + dy * dirY) / dist;
                if (dot > 0) {
                    const cross = Math.abs(dx * dirY - dy * dirX);
                    if (cross < player.radius * 2.0) {
                        this.game.currentState._damagePlayer(targeting.damage);
                    }
                }
            }
        }

        this.game.sounds.play('railgun_shoot', { volume: 0.7, x: targeting.x, y: targeting.y });
    }

    _hurlAsteroids(player) {
        const state = this.game.currentState;
        if (!state || !state.asteroids) return;

        this.currentGif = this.crushGif;
        this.gifFrame = 0;
        this.gifTimer = 0;
        this.attackAnimTimer = 0.8;

        // Find nearby asteroids
        const hurled = [];
        for (const ast of state.asteroids) {
            if (!ast.alive) continue;
            const dx = ast.worldX - this.worldX;
            const dy = ast.worldY - this.worldY;
            if (dx * dx + dy * dy < 1200 * 1200) {
                hurled.push(ast);
                if (hurled.length >= 3) break;
            }
        }

        for (const ast of hurled) {
            // Hurl toward player
            const angle = Math.atan2(player.worldY - ast.worldY, player.worldX - ast.worldX);
            const speed = 800 + Math.random() * 400;
            ast.vx = Math.cos(angle) * speed;
            ast.vy = Math.sin(angle) * speed;
            ast.highlightRed = true;
        }

        if (hurled.length > 0) {
            this.game.sounds.play('boost', { volume: 0.7, x: this.worldX, y: this.worldY });
            this.game.sounds.play('railgun_shoot', { volume: 0.4, x: this.worldX, y: this.worldY });
            this.game.camera.shake(0.8);
        }
    }

    _hurlShip(player) {
        if (this.summonedShips.length === 0) return;

        this.currentGif = this.crushGif;
        this.gifFrame = 0;
        this.gifTimer = 0;
        this.attackAnimTimer = 0.8;

        // Grab a summoned ship and hurl it
        const ship = this.summonedShips[0];
        if (!ship.alive) return;

        const angle = Math.atan2(player.worldY - ship.worldY, player.worldX - ship.worldX);
        const speed = 1000 + Math.random() * 500;
        ship.vx = Math.cos(angle) * speed;
        ship.vy = Math.sin(angle) * speed;
        ship.externalVx = Math.cos(angle) * speed;
        ship.externalVy = Math.sin(angle) * speed;

        // Make it a projectile essentially
        ship.isHurled = true;

        this.game.sounds.play('boost', { volume: 0.8, x: ship.worldX, y: ship.worldY });
        this.game.sounds.play('railgun_shoot', { volume: 0.5, x: this.worldX, y: this.worldY });
        this.game.camera.shake(1.0);
    }

    // ─── DAMAGE ────────────────────────────────────────────────────────

    hit(damage) {
        if (this.invulnerable) return false;
        if (this.state === YO_STATE.ENRAGED || this.state === YO_STATE.SCRIPTED || this.state === YO_STATE.FINISHED) return false;

        this.health -= damage;

        if (this.game.currentState && this.game.currentState.spawnFloatingText) {
            this.game.currentState.spawnFloatingText(this.worldX, this.worldY, `-${Math.ceil(damage)}`, '#ffdd44');
        }
        this.game.sounds.play('hit', { volume: 0.5, x: this.worldX, y: this.worldY });

        return false;
    }

    // ─── SCRIPTED SEQUENCE HELPERS ─────────────────────────────────────

    _snapshotPlayer(player) {
        return {
            health: player.health,
            maxHealth: player.maxHealth,
            shieldEnergy: player.shieldEnergy,
            maxShieldEnergy: player.maxShieldEnergy,
            inventory: player.inventory.serialize()
        };
    }

    _restorePlayer(player) {
        if (!this.playerSnapshot) return;

        player.health = this.playerSnapshot.health;
        player.maxHealth = this.playerSnapshot.maxHealth;
        player.shieldEnergy = this.playerSnapshot.shieldEnergy;
        player.maxShieldEnergy = this.playerSnapshot.maxShieldEnergy;
        player.alive = true;
        player.invulnTimer = 5.0; // Brief invulnerability

        // Restore inventory
        player.inventory.deserialize(this.playerSnapshot.inventory);

        if (this.game.currentState) {
            this.game.currentState._onInventoryChanged(false);
        }
    }

    _cleanupItems(player) {
        const state = this.game.currentState;
        if (!state) return;

        const radiusSq = 3000 * 3000;

        // Clean item pickups
        for (const item of state.itemPickups) {
            const dx = item.worldX - player.worldX;
            const dy = item.worldY - player.worldY;
            if (dx * dx + dy * dy < radiusSq) {
                item.alive = false;
            }
        }

        // Clean scrap
        for (const s of state.scrapEntities) {
            const dx = s.worldX - player.worldX;
            const dy = s.worldY - player.worldY;
            if (dx * dx + dy * dy < radiusSq) {
                s.alive = false;
            }
        }
    }

    _shatterDeed() {
        // Use Voronoi fracture like other entities
        const deedAsset = this.game.assets.get('deed');
        if (!deedAsset) return;

        const fragments = VoronoiSlicer.slice(deedAsset, 7);
        for (const frag of fragments) {
            const wx = this.deedWorldX + frag.lx;
            const wy = this.deedWorldY + frag.ly;
            const outAngle = Math.atan2(frag.ly, frag.lx);
            const spread = 60 + Math.random() * 120;
            const vx = Math.cos(outAngle) * spread;
            const vy = Math.sin(outAngle) * spread;

            this.deedPieces.push(new ProceduralDebris(
                this.game, wx, wy, frag,
                vx, vy,
                0, // no base rotation
                (Math.random() - 0.5) * 4,
                5.0 // 5 second lifetime
            ));
        }
    }

    _dropLoot() {
        // Scrap
        for (let i = 0; i < 8; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * 100;
            this.pendingSpawns.push(new Scrap(this.game, this.worldX + Math.cos(angle) * dist, this.worldY + Math.sin(angle) * dist, 'big'));
        }
        for (let i = 0; i < 12; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * 80;
            this.pendingSpawns.push(new Scrap(this.game, this.worldX + Math.cos(angle) * dist, this.worldY + Math.sin(angle) * dist, 'small'));
        }

        // Experience
        const diff = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
        const expAmount = Math.floor(25 + 5 * diff);
        for (let i = 0; i < expAmount; i++) {
            this.pendingSpawns.push(new ExpOrb(this.game, this.worldX, this.worldY, 1));
        }

        // Cosmos Engine
        const cosmosData = UPGRADES.find(u => u.id === 'cosmos_engine');
        if (cosmosData) {
            const pickup = new ItemPickup(this.game, this.worldX, this.worldY, cosmosData);
            const angle = Math.random() * Math.PI * 2;
            const speed = 50 + Math.random() * 100;
            pickup.vx = Math.cos(angle) * speed;
            pickup.vy = Math.sin(angle) * speed;
            this.pendingSpawns.push(pickup);
        }
    }

    // ─── GIF HELPERS ───────────────────────────────────────────────────

    _updateGif(dt) {
        // Timed attack animations (hurl) — return to idle after timer
        if (this.attackAnimTimer > 0) {
            this.attackAnimTimer -= dt;
            if (this.attackAnimTimer <= 0 && !this._summonAnimPlaying && !this._crushAnimPlaying && !this.yellowOneDeathPlaying) {
                this.currentGif = this.idleGif;
                this.gifFrame = 0;
            }
        }

        const gif = this.currentGif;
        if (!gif || !gif.length) return;

        // If death animation finished, hold on last frame
        if (this._deathAnimDone) return;

        this.gifTimer += dt * 1000;
        const frame = gif[this.gifFrame];
        if (frame && this.gifTimer >= (frame.delay || 100)) {
            this.gifTimer = 0;
            const nextFrame = this.gifFrame + 1;

            // Death animation: play once, sound on frame 7
            if (this.yellowOneDeathPlaying) {
                if (nextFrame === 7) {
                    this.game.sounds.play('ship_explode', { volume: 0.8, x: this.worldX, y: this.worldY });
                    this.game.camera.shake(2.0);
                }
                if (nextFrame >= gif.length) {
                    this._deathAnimDone = true;
                    return;
                }
                this.gifFrame = nextFrame;
                return;
            }

            // Summon animation: sound on frame 10, spawn ships when it finishes
            if (this._summonAnimPlaying) {
                if (nextFrame === 10 && !this._summonSoundPlayed) {
                    this._summonSoundPlayed = true;
                    this.game.sounds.play('railgun_target', { volume: 0.5, x: this.worldX, y: this.worldY });
                    this.game.sounds.play('shield', { volume: 0.4, x: this.worldX, y: this.worldY });
                }
                if (nextFrame >= gif.length) {
                    this._summonAnimPlaying = false;
                    this.currentGif = this.idleGif;
                    this.gifFrame = 0;
                    const player = this.game.currentState && this.game.currentState.player;
                    if (player) this._finishSummon(player);
                    return;
                }
                this.gifFrame = nextFrame;
                return;
            }

            // Crush animation: play once, fire attack + sound on frame 6
            if (this._crushAnimPlaying) {
                if (nextFrame === 6 && !this._crushSoundPlayed && this._pendingCrush) {
                    this._crushSoundPlayed = true;
                    const { pattern, player } = this._pendingCrush;
                    const diff = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
                    if (pattern === 0) {
                        this._spawnEdgeProjectiles(player, 'yellow_laser_ball', 6 + Math.floor(diff * 2), 500 + diff * 50, 8 + diff * 2, 6.0);
                        this.game.sounds.play('laser', { volume: 0.6, x: this.worldX, y: this.worldY });
                        this.game.sounds.play('railgun_target', { volume: 0.3, x: this.worldX, y: this.worldY });
                    } else if (pattern === 1) {
                        this._spawnEdgeProjectiles(player, 'yellow_laser_ball_big', 3 + Math.floor(diff), 300 + diff * 30, 15 + diff * 3, 8.0);
                        this.game.sounds.play('railgun_shoot', { volume: 0.5, x: this.worldX, y: this.worldY });
                        this.game.sounds.play('railgun_target', { volume: 0.4, x: this.worldX, y: this.worldY });
                    } else {
                        this._spawnEdgeBeams(player, 1 + Math.floor(Math.random() * 4 + diff * 0.5));
                    }
                    this._pendingCrush = null;
                }
                if (nextFrame >= gif.length) {
                    this._crushAnimPlaying = false;
                    this.currentGif = this.idleGif;
                    this.gifFrame = 0;
                    return;
                }
                this.gifFrame = nextFrame;
                return;
            }

            // Normal looping animation
            this.gifFrame = nextFrame % gif.length;
        }
    }

    _getCurrentFrame() {
        const gif = this.currentGif;
        if (!gif || !gif.length) return null;
        const idx = Math.min(this.gifFrame, gif.length - 1);
        return gif[idx];
    }

    // ─── DRAWING ───────────────────────────────────────────────────────

    get isActive() {
        return this.state !== YO_STATE.IDLE && this.state !== YO_STATE.FINISHED;
    }

    get isAttackable() {
        return !this.invulnerable && (this.state === YO_STATE.PHASE1 || this.state === YO_STATE.PHASE2);
    }

    draw(ctx, camera) {
        if (this.state === YO_STATE.FINISHED && !this.constellationVisible) return;

        // NOTE: White background and fade overlays are drawn by playingState
        // at the correct layer order (background before entities, fades after HUD)

        // Draw Yellow One (not during finished state, not after death anim)
        if (this.state !== YO_STATE.FINISHED && !this._yellowOneHidden) {
            this._drawYellowOne(ctx, camera);
        }

        // Draw scripted sequence elements
        if (this.state === YO_STATE.SCRIPTED && this.scriptPhase === 2) {
            this._drawScriptedElements(ctx, camera);
        }

        // Draw constellation in finished state
        if (this.constellationVisible) {
            this._drawConstellation(ctx, camera);
        }

        // Draw targeting beams
        for (const tb of this.targetingBeams) {
            const targetImg = this.game.assets.get('yellow_laser_beam_targeting');
            if (targetImg) {
                const screen = camera.worldToScreen(tb.x, tb.y, this.game.width, this.game.height);
                this._drawTiledBeam(ctx, screen.x, screen.y, tb.angle, targetImg, 0.5 + Math.sin(Date.now() / 100) * 0.2);
            }
        }

        // Draw active beams
        const beamImg = this.game.assets.get('yellow_laser_beam_big');
        if (beamImg) {
            for (const beam of this.activeBeams) {
                const screen = camera.worldToScreen(beam.x, beam.y, this.game.width, this.game.height);
                this._drawTiledBeam(ctx, screen.x, screen.y, beam.angle, beamImg, beam.timer / 0.4);
            }
        }
    }

    _drawYellowOne(ctx, camera) {
        const frame = this._getCurrentFrame();
        if (!frame) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const img = frame.canvas || frame;
        const logicalW = frame.width || img.width;
        const logicalH = frame.height || img.height;
        const w = logicalW * this.game.worldScale;
        const h = logicalH * this.game.worldScale;

        ctx.save();
        ctx.translate(screen.x, screen.y);
        // No rotation - the yellow one doesn't turn like ships

        // Glow effect
        if (this.state === YO_STATE.PHASE2 || this.state === YO_STATE.ENRAGED) {
            ctx.shadowBlur = 25 * this.game.worldScale;
            ctx.shadowColor = this.glowColor;
        }

        // Phase 2 yellow glow
        if (this.state === YO_STATE.PHASE2) {
            const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 200);
            ctx.shadowBlur = 25 * this.game.worldScale * pulse;
            ctx.shadowColor = '#ffdd44';
        }

        // Enraged orange glow
        if (this.state === YO_STATE.ENRAGED) {
            const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 100);
            ctx.shadowBlur = 35 * this.game.worldScale * pulse;
            ctx.shadowColor = '#ff8800';
        }

        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
    }

    _drawScriptedElements(ctx, camera) {
        const kv = this.scriptTimer;

        // Draw Christus Victor
        if (this.christusAlpha > 0) {
            let cvFrame = null;
            if (this.christusGif && this.christusGif.length > 0) {
                cvFrame = this.christusGif[this.christusFrame];
            }
            // Fallback to static image
            if (!cvFrame) {
                cvFrame = this.game.assets.get('christus_victor');
            }

            if (cvFrame) {
                const screen = camera.worldToScreen(this.christusX, this.christusY, this.game.width, this.game.height);
                const img = cvFrame.canvas || cvFrame;
                const logicalW = cvFrame.width || img.width;
                const logicalH = cvFrame.height || img.height;
                const w = logicalW * this.game.worldScale;
                const h = logicalH * this.game.worldScale;

                ctx.save();
                ctx.globalAlpha = this.christusAlpha;

                if (this.christusGlowing) {
                    const glowProgress = Math.min(1.0, (kv - 17) / 4.0);
                    ctx.shadowBlur = 40 * this.game.worldScale * glowProgress;
                    ctx.shadowColor = '#ffffff';
                }

                ctx.drawImage(img, screen.x - w / 2, screen.y - h / 2, w, h);
                ctx.restore();
            }
        }

        // Draw Deed
        if (this.deedVisible && !this.deedShattered) {
            const deedImg = this.game.assets.get('deed');
            if (deedImg) {
                const screen = camera.worldToScreen(this.deedWorldX, this.deedWorldY, this.game.width, this.game.height);
                const img = deedImg.canvas || deedImg;
                const logicalW = deedImg.width || img.width;
                const logicalH = deedImg.height || img.height;
                const w = logicalW * this.game.worldScale;
                const h = logicalH * this.game.worldScale;

                // Shower of light effect
                const fadeIn = Math.min(1.0, (kv - 7) / 1.5);
                ctx.save();
                ctx.globalAlpha = fadeIn;

                // Light rays
                ctx.shadowBlur = 30 * this.game.worldScale;
                ctx.shadowColor = '#ffffcc';

                ctx.drawImage(img, screen.x - w / 2, screen.y - h / 2, w, h);
                ctx.restore();
            }
        }

        // Draw deed pieces after shatter (ProceduralDebris)
        if (this.deedShattered) {
            for (const piece of this.deedPieces) {
                piece.draw(ctx, camera);
            }
        }
    }

    _drawConstellation(ctx, camera) {
        const conImg = this.game.assets.get('christus_victor_constellation');
        if (!conImg) return;

        const screen = camera.worldToScreen(this.christusX, this.christusY, this.game.width, this.game.height);
        const img = conImg.canvas || conImg;
        const logicalW = conImg.width || img.width;
        const logicalH = conImg.height || img.height;
        const w = logicalW * this.game.worldScale;
        const h = logicalH * this.game.worldScale;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 1000);
        ctx.globalAlpha = pulse;
        ctx.drawImage(img, screen.x - w / 2, screen.y - h / 2, w, h);
        ctx.restore();
    }

    _drawTiledBeam(ctx, x, y, angle, img, alpha) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);
        ctx.rotate(angle);

        const canvas = img.canvas || img;
        const logicalW = img.width || canvas.width;
        const logicalH = img.height || canvas.height;
        const tileW = logicalW * this.game.worldScale;
        const tileH = logicalH * this.game.worldScale;
        const count = Math.ceil(15000 / logicalW);

        for (let i = 0; i < count; i++) {
            ctx.drawImage(canvas, i * tileW, -tileH / 2, tileW, tileH);
        }
        ctx.restore();
    }

    // For playingState to pop spawned entities
    popSpawns() {
        const spawns = [...this.pendingSpawns];
        this.pendingSpawns = [];
        return spawns;
    }

    popEnemies() {
        const enemies = [...this.pendingEnemies];
        this.pendingEnemies = [];
        return enemies;
    }

    getSpawnOnDeath() {
        return [];
    }
}
