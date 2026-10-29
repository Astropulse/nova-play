import { Game, CANVAS_2D_ATTRS } from './engine/game.js';

let game = null;

// Entry point
window.addEventListener('DOMContentLoaded', async () => {
    // Cleanup old instance if it exists (e.g. during HMR or manual re-init)
    if (game) {
        console.log('Cleaning up previous game instance...');
        game.destroy();
    }

    const canvas = document.getElementById('gameCanvas');
    game = new Game(canvas);
    // Exposed for the dev console / automated multiplayer tests.
    window.__novaGame = game;

    // Show loading text
    // Same attributes as Game's constructor (it ran first, so this returns
    // that context; the attrs must still match if the order ever changes).
    const ctx = canvas.getContext('2d', CANVAS_2D_ATTRS);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#445566';
    ctx.font = '16px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Loading...', canvas.width / 2, canvas.height / 2);

    try {
        await game.init();
    } catch (err) {
        console.error('Failed to initialize game:', err);
        ctx.fillStyle = '#ff4444';
        ctx.fillText('Failed to load assets', canvas.width / 2, canvas.height / 2 + 24);
    }
});

// Formal cleanup on page unload/reload
window.addEventListener('beforeunload', () => {
    if (game) game.destroy();
});
