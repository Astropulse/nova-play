/**
 * EncounterShip — friendly NPC ship that flies to the player for interaction.
 * Immune to all world projectiles/collisions. Only becomes hostile via dialog option.
 */

import { ENCOUNTER_ASSETS, ENCOUNTER_INFO, PORTRAIT_ASSETS } from '../data/encounters.js';

const ENC_STATE = {
    APPROACHING: 0,
    ORBITING: 1,
    INTERACTING: 2,
    DEPARTING: 3,
    HOSTILE: 4
};

export { ENC_STATE };

export class EncounterShip {
    constructor(game, worldX, worldY, encounterType) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.encounterType = encounterType;
        this.alive = true;
        this.revealed = true;

        // Pick random sprite variant
        const assets = ENCOUNTER_ASSETS[encounterType] || ['encounter_civilian_1'];
        const assetKey = assets[Math.floor(Math.random() * assets.length)];
        this.assetKey = assetKey;
        this.img = game.assets.get(assetKey);

        // Pick random portrait (shown in dialog)
        const portraits = PORTRAIT_ASSETS[encounterType];
        if (portraits && portraits.length > 0) {
            const portraitKey = portraits[Math.floor(Math.random() * portraits.length)];
            this.portraitKey = portraitKey;
            this.portraitImg = game.assets.get(portraitKey);
        } else {
            this.portraitKey = null;
            this.portraitImg = null;
        }

        // Display info
        const info = ENCOUNTER_INFO[encounterType] || { name: 'UNKNOWN', color: '#44ffaa' };
        this.displayName = info.name;
        this.indicatorColor = info.color;

        // Physics
        this.vx = 0;
        this.vy = 0;
        this.angle = Math.random() * Math.PI * 2;
        this.state = ENC_STATE.APPROACHING;

        // Interaction
        this.interactRange = 250;
        this.fleeTimer = 300; // 5 minutes
        this.shouldConvertHostile = false;
        this.dialogData = null; // Set by playingState when generating

        // Orbit params
        this.orbitAngle = Math.random() * Math.PI * 2;
        this.orbitSpeed = 0.3 + Math.random() * 0.2;
        this.orbitRadius = 180 + Math.random() * 60;

        // Radius for drawing/indicators
        this.radius = this.img ? Math.max(this.img.width, this.img.height) / 2 : 32;
    }

    update(dt, player) {
        if (!this.alive) return;

        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angleToPlayer = Math.atan2(dy, dx);

        switch (this.state) {
            case ENC_STATE.APPROACHING: {
                // Fly toward player, slowing as we approach
                const approachSpeed = dist > 600 ? 250 : Math.max(40, dist * 0.4);
                this.vx = Math.cos(angleToPlayer) * approachSpeed;
                this.vy = Math.sin(angleToPlayer) * approachSpeed;

                // Smoothly rotate to face player
                this._turnToward(angleToPlayer, dt, 3.0);

                if (dist < this.orbitRadius + 50) {
                    this.state = ENC_STATE.ORBITING;
                    this.orbitAngle = Math.atan2(
                        this.worldY - player.worldY,
                        this.worldX - player.worldX
                    );
                }
                break;
            }

            case ENC_STATE.ORBITING: {
                // Gentle orbit around player
                this.orbitAngle += this.orbitSpeed * dt;
                const targetX = player.worldX + Math.cos(this.orbitAngle) * this.orbitRadius;
                const targetY = player.worldY + Math.sin(this.orbitAngle) * this.orbitRadius;

                const tdx = targetX - this.worldX;
                const tdy = targetY - this.worldY;
                const tDist = Math.sqrt(tdx * tdx + tdy * tdy);

                const orbitMoveSpeed = Math.min(120, tDist * 2);
                if (tDist > 1) {
                    this.vx = (tdx / tDist) * orbitMoveSpeed;
                    this.vy = (tdy / tDist) * orbitMoveSpeed;
                }

                // Face direction of travel
                const moveAngle = Math.atan2(this.vy, this.vx);
                this._turnToward(moveAngle, dt, 2.0);

                // Flee timer
                this.fleeTimer -= dt;
                if (this.fleeTimer <= 0) {
                    this.state = ENC_STATE.DEPARTING;
                }
                break;
            }

            case ENC_STATE.INTERACTING: {
                // Stay still while dialog is open
                this.vx *= 0.9;
                this.vy *= 0.9;
                this._turnToward(angleToPlayer, dt, 2.0);
                break;
            }

            case ENC_STATE.DEPARTING: {
                // Fly away from player
                const awayAngle = Math.atan2(-dy, -dx);
                this.vx += Math.cos(awayAngle) * 2000 * dt;
                this.vy += Math.sin(awayAngle) * 2000 * dt;

                // Cap speed
                const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
                if (speed > 2000) {
                    this.vx = (this.vx / speed) * 2000;
                    this.vy = (this.vy / speed) * 2000;
                }

                this._turnToward(awayAngle, dt, 4.0);

                if (dist > 3000) {
                    this.alive = false;
                }
                break;
            }
        }

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // --- Thruster sound ---
        const speedSq = this.vx * this.vx + this.vy * this.vy;
        if (speedSq > 100) {
            this.thrustSoundTimer = (this.thrustSoundTimer || 0) - dt;
            if (this.thrustSoundTimer <= 0) {
                this.thrustSoundTimer = 0.1; // 10 times a second
                const speedMult = Math.min(1.0, Math.sqrt(speedSq) / 300);
                this.game.sounds.play('thrust', { volume: 0.05 + speedMult * 0.1, x: this.worldX, y: this.worldY });
            }
        }
    }

    _turnToward(targetAngle, dt, turnSpeed) {
        let diff = targetAngle - this.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), turnSpeed * dt);
    }

    depart() {
        this.state = ENC_STATE.DEPARTING;
    }

    startInteraction() {
        this.state = ENC_STATE.INTERACTING;
    }

    draw(ctx, camera) {
        if (!this.alive || !this.img) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const w = (this.img.width || this.img.canvas.width) * this.game.worldScale;
        const h = (this.img.height || this.img.canvas.height) * this.game.worldScale;

        // Culling
        if (screen.x + w < -100 || screen.x - w > this.game.width + 100 ||
            screen.y + h < -100 || screen.y - h > this.game.height + 100) return;

        ctx.save();
        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.angle + Math.PI / 2);
        ctx.drawImage(this.img.canvas || this.img, -w / 2, -h / 2, w, h);
        ctx.restore();
    }
}
