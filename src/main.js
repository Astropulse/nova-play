import { Game } from './engine/game.js';

// Entry point
window.addEventListener('DOMContentLoaded', async () => {
    const canvas = document.getElementById('gameCanvas');
    const game = new Game(canvas);

    // Show loading text
    const ctx = canvas.getContext('2d');
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
