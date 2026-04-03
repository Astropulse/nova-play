/**
 * Encounter system — interpreter for encounterDialogs.js data.
 * Resolves conditions, vars, template strings, and actions at runtime.
 */

import { UPGRADES } from './upgrades.js';
import { DIALOG_SCENARIOS } from './encounterDialogs.js';

// ── Ship asset mappings ──────────────────────────────────────────
export const ENCOUNTER_ASSETS = {
    cargo_trader:    ['encounter_cargo_trader_1', 'encounter_cargo_trader_2'],
    civilian:        ['encounter_civilian_1', 'encounter_civilian_2', 'encounter_civilian_3'],
    colony:          ['encounter_colony_1', 'encounter_colony_2', 'encounter_colony_3'],
    engineer:        ['encounter_engineer_1', 'encounter_engineer_2', 'encounter_engineer_3', 'encounter_engineer_4'],
    explorer:        ['encounter_explorer_1', 'encounter_explorer_2'],
    junker:          ['encounter_junker_1', 'encounter_junker_2'],
    law_enforcement: ['encounter_law_enforcement_1', 'encounter_law_enforcement_2'],
    black_market:    ['encounter_black_market_1', 'encounter_black_market_2', 'encounter_black_market_3'],
    tuner:           ['encounter_tuner_1', 'encounter_tuner_2']
};

// ── Display info ─────────────────────────────────────────────────
export const ENCOUNTER_INFO = {
    cargo_trader:    { name: 'CARGO TRADER',    color: '#44ffaa' },
    civilian:        { name: 'CIVILIAN',        color: '#88bbdd' },
    colony:          { name: 'COLONY SHIP',     color: '#ddaa44' },
    engineer:        { name: 'ENGINEER',        color: '#44ddff' },
    explorer:        { name: 'EXPLORER',        color: '#aa88ff' },
    junker:          { name: 'JUNKER',          color: '#bb8844' },
    law_enforcement: { name: 'PATROL',          color: '#4488ff' },
    black_market:    { name: 'UNKNOWN VESSEL',  color: '#ff4488' },
    tuner:           { name: 'TUNER',           color: '#ff8844' }
};

// ── Spawn weights ────────────────────────────────────────────────
const ENCOUNTER_WEIGHTS = {
    cargo_trader: 15, civilian: 15, colony: 10, engineer: 12,
    explorer: 12, junker: 12, law_enforcement: 8, black_market: 6, tuner: 10
};

// ── Helpers ──────────────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Condition checker ────────────────────────────────────────────
function checkCondition(cond, player, state) {
    if (!cond || cond === 'always') return true;
    switch (cond) {
        case 'player_has_rare_item':
            return player.inventory && player.inventory.items.some(e =>
                e.item.rarity === 'rare' || e.item.rarity === 'epic');
        case 'player_has_any_item':
            return player.inventory && player.inventory.items.some(e =>
                e.item.rarity !== 'unique');
        case 'player_has_battery':
            return player.inventory && player.inventory.items.some(e =>
                e.item.id === 'small_battery');
        case 'player_low_health':
            return player.health < player.maxHealth * 0.5;
        case 'player_high_kills':
            return (state.stats && state.stats.enemiesDefeated >= 15);
        case 'has_unrevealed_events':
            return state.events && state.events.some(ev => !ev.revealed && !ev.isFinished);
        case 'has_unrevealed_events_2':
            return state.events && state.events.filter(ev => !ev.revealed && !ev.isFinished).length >= 2;
        default: return true;
    }
}

// ── Var resolver ─────────────────────────────────────────────────
function resolveVars(varDefs, player, state) {
    if (!varDefs) return {};
    const resolved = {};

    for (const [key, def] of Object.entries(varDefs)) {
        // Literal value
        if (typeof def === 'number' || typeof def === 'string') {
            resolved[key] = def;
            continue;
        }

        if (!def.type) { resolved[key] = def; continue; }

        switch (def.type) {
            case 'random_rare_item': {
                const items = player.inventory.items.filter(e =>
                    e.item.rarity === 'rare' || e.item.rarity === 'epic');
                if (items.length === 0) return null;
                resolved[key] = pick(items);
                break;
            }
            case 'random_any_item': {
                const items = player.inventory.items.filter(e => e.item.rarity !== 'unique');
                if (items.length === 0) return null;
                resolved[key] = pick(items);
                break;
            }
            case 'random_upgrade': {
                const pool = UPGRADES.filter(u =>
                    def.rarities.includes(u.rarity) && !u.consumable);
                if (pool.length === 0) return null;
                resolved[key] = pick(pool);
                break;
            }
            case 'item_cost_mult': {
                const ref = resolved[def.item];
                if (!ref) return null;
                const cost = ref.item ? ref.item.cost : ref.cost;
                resolved[key] = Math.floor((cost || 1) * def.mult);
                break;
            }
            case 'random_int': {
                resolved[key] = def.min + Math.floor(Math.random() * (def.max - def.min + 1));
                break;
            }
            case 'kill_reward': {
                const kills = state.stats ? state.stats.enemiesDefeated : 0;
                resolved[key] = 40 + Math.floor(kills * 1.5);
                break;
            }
            default:
                resolved[key] = def;
        }
    }
    return resolved;
}

// ── Template substitution ────────────────────────────────────────
function substitute(template, vars) {
    if (!template) return '';
    return template.replace(/\{(\w+)(?:\.(\w+))?\}/g, (match, varName, prop) => {
        const val = vars[varName];
        if (val === undefined || val === null) return match;
        if (prop) {
            // inventory entry (has .item.prop) or direct object
            if (val.item) return val.item[prop] !== undefined ? val.item[prop] : match;
            return val[prop] !== undefined ? val[prop] : match;
        }
        // Default: show name for objects, number for numbers
        if (typeof val === 'object') {
            return val.item ? val.item.name : (val.name || match);
        }
        return String(val);
    });
}

// ── Action executor ──────────────────────────────────────────────
function executeActions(actions, vars, player, state, encounter) {
    if (!actions) return 'ok';

    for (const actionStr of actions) {
        const colonIdx = actionStr.indexOf(':');
        const type = colonIdx >= 0 ? actionStr.slice(0, colonIdx) : actionStr;
        const paramStr = colonIdx >= 0 ? actionStr.slice(colonIdx + 1) : null;

        // Resolve param: could be a var name or literal number
        const resolveParam = () => {
            if (!paramStr) return 0;
            if (vars[paramStr] !== undefined) {
                const v = vars[paramStr];
                return typeof v === 'number' ? v : (v.item ? v.item : v);
            }
            const num = parseFloat(paramStr);
            return isNaN(num) ? paramStr : num;
        };

        switch (type) {
            case 'remove_item': {
                const entry = vars[paramStr];
                if (entry && entry.x !== undefined) {
                    player.inventory.removeItemAt(entry.x, entry.y);
                }
                break;
            }
            case 'add_scrap': {
                const amount = resolveParam();
                player.scrap += typeof amount === 'number' ? amount : 0;
                break;
            }
            case 'remove_scrap': {
                const amount = resolveParam();
                if (typeof amount === 'number' && player.scrap < amount) return 'not_enough_scrap';
                player.scrap -= typeof amount === 'number' ? amount : 0;
                break;
            }
            case 'add_upgrade': {
                const upgrade = resolveParam();
                if (!upgrade) break;
                if (!player.inventory.autoAdd(upgrade)) return 'inventory_full';
                break;
            }
            case 'add_perm_health': {
                const amt = resolveParam();
                player.permHealthBonus += amt;
                state._onInventoryChanged(true);
                break;
            }
            case 'add_perm_shield': {
                const amt = resolveParam();
                player.updateMaxShield(amt);
                break;
            }
            case 'add_perm_damage': {
                const amt = resolveParam();
                player.permDamageBonus += amt;
                break;
            }
            case 'encounter_speed': {
                const mult = resolveParam();
                state.encounterBonuses.speedMult *= mult;
                break;
            }
            case 'encounter_fire_rate': {
                const mult = resolveParam();
                state.encounterBonuses.fireRateMult *= mult;
                break;
            }
            case 'encounter_turn': {
                const mult = resolveParam();
                state.encounterBonuses.turnMult *= mult;
                break;
            }
            case 'reveal_event': {
                const events = state.events.filter(ev => !ev.revealed && !ev.isFinished);
                if (events.length > 0) events[0].revealed = true;
                break;
            }
            case 'reveal_event_2': {
                const events = state.events.filter(ev => !ev.revealed && !ev.isFinished);
                if (events.length > 0) events[0].revealed = true;
                if (events.length > 1) events[1].revealed = true;
                break;
            }
            case 'reveal_shop': {
                state.spawnDistantShop();
                break;
            }
            case 'heal': {
                const frac = resolveParam();
                player.heal(frac);
                break;
            }
            case 'give_battery': {
                const battery = UPGRADES.find(u => u.id === 'small_battery');
                if (battery) {
                    if (!player.inventory.autoAdd(battery)) {
                        player.heal(0.3);
                    }
                }
                break;
            }
            case 'remove_battery': {
                const entry = player.inventory.items.find(e => e.item.id === 'small_battery');
                if (entry) player.inventory.removeItemAt(entry.x, entry.y);
                break;
            }
            case 'convert_hostile': {
                encounter.shouldConvertHostile = true;
                break;
            }
            case 'increase_spawns': {
                const params = paramStr.split(':');
                const mult = parseFloat(params[0]) || 2.0;
                const dur = parseFloat(params[1]) || 60;
                if (state.enemySpawner) {
                    state.enemySpawner.applySpawnMultiplier(mult, dur);
                }
                break;
            }
            case 'spawn_boss': {
                if (state.enemySpawner) {
                    const bossArr = state.enemySpawner.forceBoss(player.worldX, player.worldY, state.difficultyScale);
                    state.enemies.push(...bossArr);
                    // Dramatic reveal
                    state.triggerFlash('#ffffff', 1.2, 0.5);
                    if (state.game.sounds.playSpecificMusic) {
                        state.game.sounds.playSpecificMusic('Starcore Showdown');
                    }
                    if (state.game.camera) {
                        state.game.camera.shake(1.5);
                    }
                }
                break;
            }
            case 'recalc': {
                state._onInventoryChanged();
                break;
            }
        }
    }
    return 'ok';
}

// ── Build runtime dialog from scenario data ──────────────────────
function buildDialog(scenario, vars, player, state) {
    const message = substitute(scenario.message, vars);

    const options = scenario.options.map(opt => {
        const label = substitute(opt.label, vars);

        if (opt.negotiate) {
            // Negotiate option: produces branching dialog
            return {
                label,
                action: (p, s, enc) => {
                    const success = Math.random() < opt.negotiate.chance;
                    if (success) {
                        const priceVar = opt.negotiate.price;
                        const price = vars[priceVar];
                        const result = executeActions(opt.actions, vars, p, s, enc);
                        if (result === 'not_enough_scrap') return { message: "Not enough scrap.", close: true };
                        if (result === 'inventory_full') return { message: "Cargo hold is full.", close: true };
                        const resp = substitute(opt.response || "Deal.", vars);
                        return { message: resp, close: true };
                    } else {
                        const fbPrice = opt.negotiate.fallbackPrice;
                        const fbPriceVal = vars[fbPrice];
                        return {
                            message: `Price is firm at [scrap]${fbPriceVal}[/scrap] scrap.`,
                            options: [
                                {
                                    label: `Accept ([cost]-${fbPriceVal} scrap[/cost])`,
                                    action: (p2, s2, enc2) => {
                                        const r = executeActions(opt.fallbackActions || opt.actions, vars, p2, s2, enc2);
                                        if (r === 'not_enough_scrap') return { message: "Not enough scrap.", close: true };
                                        if (r === 'inventory_full') return { message: "Cargo hold is full.", close: true };
                                        return { message: substitute(opt.response || "Done.", vars), close: true };
                                    }
                                },
                                {
                                    label: 'Walk away',
                                    action: () => ({ message: "Your call.", close: true })
                                }
                            ]
                        };
                    }
                }
            };
        }

        // Standard option
        return {
            label,
            action: (p, s, enc) => {
                if (opt.actions && opt.actions.length > 0) {
                    const result = executeActions(opt.actions, vars, p, s, enc);
                    if (result === 'not_enough_scrap') return { message: "Not enough scrap.", close: true };
                    if (result === 'inventory_full') return { message: "Cargo hold is full.", close: true };
                }
                const resp = substitute(opt.response || "...", vars);
                return { message: resp, close: true };
            }
        };
    });

    return { message, options, rawScenario: scenario, vars };
}

// ── Public API ───────────────────────────────────────────────────

export function rollEncounterType() {
    const entries = Object.entries(ENCOUNTER_WEIGHTS);
    let total = entries.reduce((s, [, w]) => s + w, 0);
    let roll = Math.random() * total;
    for (const [type, weight] of entries) {
        roll -= weight;
        if (roll <= 0) return type;
    }
    return entries[0][0];
}

export function generateEncounterDialog(type, player, state) {
    // Get applicable scenarios for this type
    const scenarios = DIALOG_SCENARIOS.filter(s => s.type === type);
    if (scenarios.length === 0) return _fallback();

    // Shuffle and try each
    const shuffled = [...scenarios].sort(() => Math.random() - 0.5);
    for (const scenario of shuffled) {
        if (!checkCondition(scenario.condition, player, state)) continue;
        const vars = resolveVars(scenario.vars, player, state);
        if (vars === null) continue; // var resolution failed (missing items etc)
        return buildDialog(scenario, vars, player, state);
    }

    return _fallback();
}

function _fallback() {
    return {
        message: "Greetings, pilot. Just passing through.",
        options: [
            { label: 'Safe travels', action: () => ({ message: "Fly safe.", close: true }) }
        ]
    };
}
