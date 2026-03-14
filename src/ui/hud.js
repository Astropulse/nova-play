// HUD uses its own scaling factor (4x)

export class HUD {
    constructor(game, player) {
        this.game = game;
        this.player = player;

        this.healthBarEmpty = game.assets.get('health_bar_empty');
        this.healthBarFull = game.assets.get('health_bar_full');
        this.shieldBarEmpty = game.assets.get('shield_bar_empty');
        this.shieldBarFull = game.assets.get('shield_bar_full');
    }

    draw(ctx) {
        ctx.textBaseline = 'alphabetic';
        const p = this.player;
        const cw = this.game.width;
        const ch = this.game.height;
        const margin = this.game.hudScale * 4;

        // Health bar — lower left
        // Bar fill region: source pixels 27–118 (91px wide fill area)
        const hbW = this.healthBarEmpty.width * this.game.hudScale;
        const hbH = this.healthBarEmpty.height * this.game.hudScale;
        const hbX = margin;
        const hbY = ch - hbH - margin;
        ctx.drawImage(this.healthBarEmpty, hbX, hbY, hbW, hbH);

        const healthPct = Math.max(0, Math.min(1, p.health / p.maxHealth));
        if (healthPct > 0) {
            const fillStart = 27;   // source px where bar starts
            const fillEnd = 118;    // source px where bar ends
            const fillWidth = fillEnd - fillStart;
            const srcFillW = Math.floor(fillWidth * healthPct);
            // Draw the fill portion: left dead space + filled region
            const srcClipW = fillStart + srcFillW;
            ctx.drawImage(
                this.healthBarFull,
                0, 0, srcClipW, this.healthBarFull.height,
                hbX, hbY, srcClipW * this.game.hudScale, hbH
            );
        }

        // Shield bar — above health bar (dimmed when broken)
        // Bar fill region: source pixels 4–75 (71px wide fill area)
        const sbW = this.shieldBarEmpty.width * this.game.hudScale;
        const sbH = this.shieldBarEmpty.height * this.game.hudScale;
        const sbX = margin;
        const sbY = hbY - sbH - this.game.hudScale * 2;

        if (p.shieldBroken) ctx.globalAlpha = 0.3;

        ctx.drawImage(this.shieldBarEmpty, sbX, sbY, sbW, sbH);

        const shieldPct = Math.max(0, Math.min(1, p.shieldEnergy / p.maxShieldEnergy));
        if (shieldPct > 0) {
            const fillStart = 4;
            const fillEnd = 75;
            const fillWidth = fillEnd - fillStart;
            const srcFillW = Math.floor(fillWidth * shieldPct);
            const srcClipW = fillStart + srcFillW;
            ctx.drawImage(
                this.shieldBarFull,
                0, 0, srcClipW, this.shieldBarFull.height,
                sbX, sbY, srcClipW * this.game.hudScale, sbH
            );
        }

        if (p.shieldBroken) ctx.globalAlpha = 1;

        // Scrap counter — upper right
        ctx.fillStyle = '#ccddee';
        ctx.font = `${8 * this.game.hudScale}px Astro4x`;
        ctx.textAlign = 'right';
        ctx.fillText(`SCRAP: ${p.scrap}`, cw - margin, this.game.hudScale * 10);
        ctx.textAlign = 'left';

        // Coordinates
        ctx.fillStyle = '#445566';
        ctx.font = `${8 * this.game.hudScale}px Astro4x`;
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.floor(p.worldX)}, ${Math.floor(p.worldY)}`, cw - margin, ch - margin);
        ctx.textAlign = 'left';

        // Wave Timer — top left
        const waveTimer = this.game.currentState.waveTimer;
        if (waveTimer !== undefined) {
            const mins = Math.floor(waveTimer / 60);
            const secs = Math.floor(waveTimer % 60).toString().padStart(2, '0');
            ctx.fillStyle = '#ff4444';
            ctx.font = `${10 * this.game.hudScale}px Astro5x`;
            ctx.textAlign = 'left';
            ctx.fillText(`NEXT WAVE: ${mins}:${secs}`, margin, this.game.hudScale * 10);
        }
    }
}
