import { SaveManager } from '../engine/saveManager.js';

export class DevConsole {
    constructor(game) {
        this.game = game;
        this.active = false;
        this.inputBuffer = '';
        this.history = [];
        this.historyIndex = -1;
        this.cursorTimer = 0;
        this.showCursor = true;

        this.commands = {
            'time': (args) => this._cmdTime(args),
            'spawn': (args) => this._cmdSpawn(args),
            'stat': (args) => this._cmdStat(args),
            'wave': (args) => this._cmdWave(args),
            'scrap': (args) => this._cmdScrap(args),
            'locate': (args) => this._cmdLocate(args),
            'save': () => this._cmdSave(),
            'load': () => this._cmdLoad(),
            'help': () => this._cmdHelp()
        };

        window.addEventListener('keydown', (e) => this._handleKeydown(e));
    }

    toggle() {
        this.active = !this.active;
        if (this.active) {
            this.inputBuffer = '';
            this.historyIndex = -1;
            this.game.sounds.play('click', 0.5);
        }
    }

    update(dt) {
        if (!this.active) return;

        this.cursorTimer += dt;
        if (this.cursorTimer >= 0.5) {
            this.cursorTimer = 0;
            this.showCursor = !this.showCursor;
        }

        const input = this.game.input;

        // Command history navigation
        if (input.isKeyJustPressed('ArrowUp')) {
            if (this.history.length > 0) {
                this.historyIndex = Math.min(this.historyIndex + 1, this.history.length - 1);
                this.inputBuffer = this.history[this.history.length - 1 - this.historyIndex];
            }
        } else if (input.isKeyJustPressed('ArrowDown')) {
            if (this.historyIndex > 0) {
                this.historyIndex--;
                this.inputBuffer = this.history[this.history.length - 1 - this.historyIndex];
            } else {
                this.historyIndex = -1;
                this.inputBuffer = '';
            }
        }
    }

    _handleKeydown(e) {
        if (!this.active) return;
        
        if (e.key === 'Enter') {
            this._executeCommand();
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === 'Backspace') {
            this.inputBuffer = this.inputBuffer.slice(0, -1);
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === 'Escape') {
            this.active = false;
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key.length === 1) {
            this.inputBuffer += e.key;
            e.preventDefault();
            e.stopPropagation();
        }
    }

    _executeCommand() {
        const fullCmd = this.inputBuffer.trim();
        if (fullCmd) {
            this.history.push(fullCmd);
            this.historyIndex = -1;

            const parts = fullCmd.split(' ');
            const cmdName = parts[0].toLowerCase();
            const args = parts.slice(1);

            if (this.commands[cmdName]) {
                this.commands[cmdName](args);
            } else {
                console.log(`Unknown command: ${cmdName}`);
            }
        }
        this.inputBuffer = '';
        this.active = false;
    }

    _cmdTime(args) {
        if (args.length < 1) return;
        const time = parseFloat(args[0]);
        if (!isNaN(time) && this.game.currentState && this.game.currentState.totalGameTime !== undefined) {
            this.game.currentState.totalGameTime = time;
        }
    }

    _cmdSpawn(args) {
        if (args.length < 1) return;
        const upgradeId = args[0];
        const state = this.game.currentState;
        if (state && state.player && state.player.inventory) {
            import('../data/upgrades.js').then(({ UPGRADES }) => {
                const upgradeData = UPGRADES.find(u => u.id === upgradeId);
                if (upgradeData) {
                    if (!state.player.inventory.autoAdd(upgradeData)) {
                        // If inventory full, maybe drop as ItemPickup?
                        // For now just console log
                        console.log("Inventory full, could not spawn upgrade.");
                    } else {
                        if (state._onInventoryChanged) state._onInventoryChanged();
                    }
                }
            });
        }
    }

    _cmdStat(args) {
        if (args.length < 2) return;
        const stat = args[0].toLowerCase();
        const value = parseFloat(args[1]);
        if (isNaN(value)) return;

        const p = this.game.currentState?.player;
        if (!p) return;

        switch (stat) {
            case 'scrap': p.scrap = value; break;
            case 'health': p.health = value; p.maxHealth = Math.max(p.health, p.maxHealth); break;
            case 'speed': p.speedMult = value; break;
            case 'shield': p.maxShieldEnergy = value; p.shieldEnergy = value; break;
        }
    }

    _cmdWave(args) {
        if (args.length < 1) return;
        const time = parseFloat(args[0]);
        if (!isNaN(time) && this.game.currentState && this.game.currentState.waveTimer !== undefined) {
            this.game.currentState.waveTimer = time;
        }
    }

    _cmdScrap(args) {
        if (args.length < 1) return;
        const amount = parseFloat(args[0]);
        const p = this.game.currentState?.player;
        if (!isNaN(amount) && p) {
            p.scrap = (p.scrap || 0) + amount;
        }
    }

    _cmdLocate(args) {
        const state = this.game.currentState;
        if (!state || !state.events) return;

        if (args.length < 1) {
            console.log("Locate requires an event type: knowledge, cthulhu, station, cargo");
            return;
        }

        const type = args[0].toLowerCase();
        let targetEvent = null;

        for (const ev of state.events) {
            const name = ev.constructor ? ev.constructor.name.toLowerCase() : '';
            if (type === 'knowledge' && name.includes('knowledge')) targetEvent = ev;
            else if (type === 'cthulhu' && name.includes('cthulhu')) targetEvent = ev;
            else if (type === 'station' && name.includes('station')) targetEvent = ev;
            else if (type === 'cargo' && name.includes('cargo')) targetEvent = ev;
        }

        if (targetEvent) {
            targetEvent.revealed = true;
            console.log(`Signal activated for ${targetEvent.constructor.name} at ${Math.floor(targetEvent.worldX)}, ${Math.floor(targetEvent.worldY)}`);
        } else {
            console.log(`Could not find event of type: ${type}`);
        }
    }

    _cmdSave() {
        SaveManager.save(this.game.currentState);
    }

    _cmdLoad() {
        SaveManager.load(this.game);
    }

    _cmdHelp() {
        console.log("Available commands: time, spawn, stat, wave, scrap, locate, save, load, help");
    }

    draw(ctx) {
        if (!this.active) return;

        const cw = this.game.width;
        const ch = this.game.height;
        const h = 40 * this.game.uiScale;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(0, ch - h, cw, h);

        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, ch - h, cw, h);

        ctx.fillStyle = '#00ff00';
        ctx.font = `${12 * this.game.uiScale}px monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        let text = '> ' + this.inputBuffer;
        if (this.showCursor) text += '_';
        
        ctx.fillText(text, 20, ch - h / 2);
    }
}
