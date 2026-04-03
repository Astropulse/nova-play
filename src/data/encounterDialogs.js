/**
 * ═══════════════════════════════════════════════════════════════════
 *  ENCOUNTER DIALOG DATA
 *  Pure data file — edit freely to add/modify encounter scenarios.
 * ═══════════════════════════════════════════════════════════════════
 *
 * FORMAT REFERENCE:
 *
 * condition — when this scenario is available:
 *   "always"                  always available
 *   "player_has_rare_item"    player has rare/epic in inventory
 *   "player_has_any_item"     player has any non-unique item
 *   "player_has_battery"      player has a Small Battery
 *   "player_low_health"       player health < 50%
 *   "player_high_kills"       enemiesDefeated >= 15
 *   "has_unrevealed_events"   at least 1 unrevealed event exists
 *   "has_unrevealed_events_2" at least 2 unrevealed events exist
 *
 * vars — dynamically resolved values:
 *   { type: "random_rare_item" }             random rare/epic from player inv
 *   { type: "random_any_item" }              random non-unique from player inv
 *   { type: "random_upgrade", rarities: [] } random upgrade from UPGRADES pool
 *   { type: "random_int", min: N, max: N }   random integer
 *   { type: "item_cost_mult", item: "varName", mult: N }  var.item.cost * mult
 *   { type: "kill_reward" }                  40 + kills * 1.5
 *
 * message — dialog text. Use:
 *   {varName}         substitutes the var's value (or .name if object)
 *   {varName.prop}    substitutes a specific property
 *   [scrap]...[/scrap]       yellow highlight
 *   [upgrade]...[/upgrade]   cyan highlight
 *   [cost]...[/cost]         red highlight
 *   [good]...[/good]         green highlight
 *   [warn]...[/warn]         orange highlight
 *
 * options[].actions — array of action strings:
 *   "remove_item:varName"       remove item referenced by var from player inv
 *   "add_scrap:varName"         add scrap (amount = resolved var or literal number)
 *   "remove_scrap:varName"      remove scrap (fails if can't afford)
 *   "add_upgrade:varName"       add upgrade to player inv (fails if full)
 *   "add_perm_health:N"         permanent +N max health
 *   "add_perm_shield:N"         permanent +N max shield
 *   "add_perm_damage:N"         permanent +N damage bonus
 *   "encounter_speed:N"         multiply encounter speed bonus by N
 *   "encounter_fire_rate:N"     multiply encounter fire rate bonus by N
 *   "encounter_turn:N"          multiply encounter turn bonus by N
 *   "reveal_event"              reveal nearest unrevealed event
 *   "reveal_event_2"            reveal 2 nearest unrevealed events
 *   "reveal_shop"               spawn and reveal a distant shop
 *   "heal:N"                    heal player by N fraction (0.2 = 20%)
 *   "convert_hostile"           convert encounter to hostile enemy
 *   "recalc"                    recalculate player stats
 *
 * options[].negotiate — if present, this is a negotiation option:
 *   { chance: 0.5, price: "varName", fallbackPrice: "varName" }
 *   On success: runs actions with the negotiate price
 *   On fail: offers accept at original price or walk away
 *
 * ═══════════════════════════════════════════════════════════════════
 */

export const DIALOG_SCENARIOS = [

    // ──────────────────────────────────────────────────────────────
    //  CARGO TRADER
    // ──────────────────────────────────────────────────────────────

    {
        type: 'cargo_trader',
        id: 'rare_buyback',
        condition: 'player_has_rare_item',
        vars: {
            targetItem: { type: 'random_rare_item' },
            offer: { type: 'item_cost_mult', item: 'targetItem', mult: 3 },
            negotiate: { type: 'item_cost_mult', item: 'targetItem', mult: 4 }
        },
        message: "My scanners picked up a [upgrade]{targetItem}[/upgrade] in your cargo. I'll pay [scrap]{offer} scrap[/scrap] for it.",
        options: [
            {
                label: "Accept ([scrap]+{offer} scrap[/scrap])",
                actions: ['remove_item:targetItem', 'add_scrap:offer', 'recalc'],
                response: "Pleasure doing business."
            },
            {
                label: "Counter-offer ([scrap]{negotiate} scrap[/scrap])",
                negotiate: { chance: 0.5, price: 'negotiate', fallbackPrice: 'offer' },
                actions: ['remove_item:targetItem', 'add_scrap:negotiate', 'recalc'],
                fallbackActions: ['remove_item:targetItem', 'add_scrap:offer', 'recalc'],
                response: "You drive a hard bargain."
            },
            { label: "Decline", response: "No worries. Safe travels." },
            { label: "[warn]Board their ship[/warn]", actions: ['convert_hostile'], response: "You'll regret this!" }
        ]
    },

    {
        type: 'cargo_trader',
        id: 'sell_upgrade',
        condition: 'always',
        vars: {
            upgrade: { type: 'random_upgrade', rarities: ['common', 'uncommon', 'rare'] },
            cost: { type: 'item_cost_mult', item: 'upgrade', mult: 0.85 },
            negotiate: { type: 'item_cost_mult', item: 'upgrade', mult: 0.6 }
        },
        message: "Looking to stock up? I've got a [upgrade]{upgrade}[/upgrade]. [cost]{cost} scrap[/cost] and it's yours.",
        options: [
            {
                label: "Buy it ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_upgrade:upgrade', 'recalc'],
                response: "Good choice."
            },
            {
                label: "Haggle ([cost]{negotiate} scrap[/cost])",
                negotiate: { chance: 0.45, price: 'negotiate', fallbackPrice: 'cost' },
                actions: ['remove_scrap:negotiate', 'add_upgrade:upgrade', 'recalc'],
                fallbackActions: ['remove_scrap:cost', 'add_upgrade:upgrade', 'recalc'],
                response: "Fine, take it."
            },
            { label: "No thanks", response: "Maybe next time." },
            { label: "[warn]Take it by force[/warn]", actions: ['convert_hostile'], response: "Big mistake!" }
        ]
    },

    {
        type: 'cargo_trader',
        id: 'event_intel',
        condition: 'has_unrevealed_events',
        vars: {
            cost: { type: 'random_int', min: 40, max: 60 }
        },
        message: "We picked up [warn]a signal[/warn] on our scanners but can't investigate. Coordinates for [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Buy coordinates ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'reveal_event'],
                response: "Coordinates sent. Be careful out there."
            },
            { label: "Not interested", response: "Suit yourself." }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  ENGINEER
    // ──────────────────────────────────────────────────────────────

    {
        type: 'engineer',
        id: 'hull_reinforce',
        condition: 'always',
        vars: { cost: 80, negotiate: 60 },
        message: "Your hull's seen better days. For [cost]{cost} scrap[/cost] I can reinforce it — [good]+5 max health[/good], permanent.",
        options: [
            {
                label: "Accept ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_perm_health:5', 'recalc'],
                response: "Hull reinforced. Much tougher now."
            },
            {
                label: "Negotiate ([cost]{negotiate} scrap[/cost])",
                negotiate: { chance: 0.5, price: 'negotiate', fallbackPrice: 'cost' },
                actions: ['remove_scrap:negotiate', 'add_perm_health:5', 'recalc'],
                fallbackActions: ['remove_scrap:cost', 'add_perm_health:5', 'recalc'],
                response: "Done. Hull reinforced."
            },
            { label: "Maybe later", response: "We'll be around." }
        ]
    },

    {
        type: 'engineer',
        id: 'shield_calibrate',
        condition: 'always',
        vars: { cost: 70 },
        message: "I can recalibrate your shields — [good]+10 max shield energy[/good]. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Accept ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_perm_shield:10', 'recalc'],
                response: "Shields recalibrated."
            },
            { label: "Decline", response: "Your call." }
        ]
    },

    {
        type: 'engineer',
        id: 'weapon_overhaul',
        condition: 'always',
        vars: { cost: 100 },
        message: "Your weapons need an overhaul. [cost]{cost} scrap[/cost] for a [good]permanent damage boost[/good].",
        options: [
            {
                label: "Accept ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_perm_damage:0.5'],
                response: "Weapons overhauled. Hitting harder now."
            },
            { label: "Decline", response: "Come back anytime." }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  CIVILIAN
    // ──────────────────────────────────────────────────────────────

    {
        type: 'civilian',
        id: 'grateful_survivor',
        condition: 'always',
        vars: { gift: { type: 'random_int', min: 15, max: 40 } },
        message: "A friendly face! Take some spare scrap — [scrap]{gift} scrap[/scrap]. You need it more than us.",
        options: [
            {
                label: "Accept ([scrap]+{gift} scrap[/scrap])",
                actions: ['add_scrap:gift'],
                response: "Bless you, pilot. Stay safe."
            },
            { label: "Decline politely", response: "You're too kind. Safe travels." }
        ]
    },

    {
        type: 'civilian',
        id: 'battery_request',
        condition: 'player_has_battery',
        vars: { reward: { type: 'random_int', min: 50, max: 80 } },
        message: "Our power cells are failing! Got a [upgrade]Small Battery[/upgrade] to spare? We'll pay [scrap]{reward} scrap[/scrap].",
        options: [
            {
                label: "Give battery ([scrap]+{reward} scrap[/scrap])",
                actions: ['remove_battery', 'add_scrap:reward', 'recalc'],
                response: "You saved our crew! Thank you!"
            },
            { label: "Sorry, I need it", response: "We understand. Be safe." }
        ]
    },

    {
        type: 'civilian',
        id: 'wanderer',
        condition: 'always',
        vars: { gift: { type: 'random_int', min: 5, max: 12 } },
        message: "Just passing through. Here's [scrap]{gift} scrap[/scrap] for the road.",
        options: [
            {
                label: "Thanks ([scrap]+{gift} scrap[/scrap])",
                actions: ['add_scrap:gift'],
                response: "Fly safe."
            }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  COLONY
    // ──────────────────────────────────────────────────────────────

    {
        type: 'colony',
        id: 'resource_trade',
        condition: 'player_has_any_item',
        vars: {
            targetItem: { type: 'random_any_item' },
            offer: { type: 'item_cost_mult', item: 'targetItem', mult: 2 }
        },
        message: "Our colony needs supplies. We'll pay [scrap]{offer} scrap[/scrap] for your [upgrade]{targetItem}[/upgrade] — double market value.",
        options: [
            {
                label: "Sell ([scrap]+{offer} scrap[/scrap])",
                actions: ['remove_item:targetItem', 'add_scrap:offer', 'recalc'],
                response: "The colony thanks you."
            },
            { label: "Can't spare it", response: "Understandable." }
        ]
    },

    {
        type: 'colony',
        id: 'colony_intel',
        condition: 'always',
        vars: {},
        message: "We passed a [good]supply station[/good] on our route. Coordinates — no charge.",
        options: [
            {
                label: "Accept coordinates",
                actions: ['reveal_shop'],
                response: "Coordinates sent. Good stock when we passed."
            },
            { label: "No thanks", response: "Safe travels." }
        ]
    },

    {
        type: 'colony',
        id: 'bulk_trade',
        condition: 'always',
        vars: {
            cost: 30,
            reward: { type: 'random_int', min: 80, max: 120 }
        },
        message: "We produce surplus materials. Trade [scrap]{reward} scrap[/scrap] worth of raw materials for [cost]{cost} scrap[/cost] in fuel.",
        options: [
            {
                label: "Trade ([cost]-{cost}[/cost], [scrap]+{reward}[/scrap])",
                actions: ['remove_scrap:cost', 'add_scrap:reward'],
                response: "Fair trade."
            },
            { label: "Decline", response: "Maybe next time." }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  EXPLORER
    // ──────────────────────────────────────────────────────────────

    {
        type: 'explorer',
        id: 'event_coords',
        condition: 'has_unrevealed_events',
        vars: { cost: { type: 'random_int', min: 35, max: 50 } },
        message: "I've mapped anomalies in this sector. [warn]Signal source[/warn] coordinates for [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Buy ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'reveal_event'],
                response: "Data transferred. Good hunting."
            },
            { label: "No thanks", response: "Your loss." },
            { label: "[warn]Take the data[/warn]", actions: ['convert_hostile'], response: "Bad move, pilot!" }
        ]
    },

    {
        type: 'explorer',
        id: 'danger_report',
        condition: 'always',
        vars: { gift: { type: 'random_int', min: 10, max: 20 } },
        message: "Strange readings in this sector. Be careful. Here, [scrap]{gift} scrap[/scrap] from my last expedition.",
        options: [
            {
                label: "Thanks ([scrap]+{gift} scrap[/scrap])",
                actions: ['add_scrap:gift'],
                response: "Stay sharp."
            }
        ]
    },

    {
        type: 'explorer',
        id: 'trade_for_data',
        condition: 'has_unrevealed_events_2',
        vars: { targetItem: { type: 'random_any_item' } },
        message: "I'll trade coordinates to [warn]two signal sources[/warn] for your [upgrade]{targetItem}[/upgrade].",
        options: [
            {
                label: "Accept trade",
                actions: ['remove_item:targetItem', 'reveal_event_2', 'recalc'],
                response: "Two sets of coordinates sent."
            },
            { label: "Decline", response: "Fair enough." },
            { label: "[warn]Take it by force[/warn]", actions: ['convert_hostile'], response: "You just made an enemy!" }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  JUNKER
    // ──────────────────────────────────────────────────────────────

    {
        type: 'junker',
        id: 'cheap_parts',
        condition: 'always',
        vars: {
            upgrade: { type: 'random_upgrade', rarities: ['common'] },
            cost: { type: 'item_cost_mult', item: 'upgrade', mult: 0.5 }
        },
        message: "Got a [upgrade]{upgrade}[/upgrade]. Bit scratched up but works. Only [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Buy ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_upgrade:upgrade', 'recalc'],
                response: "She's yours. Don't ask where I got it."
            },
            { label: "Pass", response: "Whatever." },
            { label: "[warn]Just take it[/warn]", actions: ['convert_hostile'], response: "Hey! That's mine!" }
        ]
    },

    {
        type: 'junker',
        id: 'bulk_buy',
        condition: 'player_has_any_item',
        vars: {
            targetItem: { type: 'random_any_item' },
            offer: { type: 'item_cost_mult', item: 'targetItem', mult: 0.4 }
        },
        message: "That [upgrade]{targetItem}[/upgrade] — I'll take it for [scrap]{offer} scrap[/scrap]. Quick deal.",
        options: [
            {
                label: "Sell ([scrap]+{offer} scrap[/scrap])",
                actions: ['remove_item:targetItem', 'add_scrap:offer', 'recalc'],
                response: "Done deal."
            },
            { label: "Too low", response: "Your loss." }
        ]
    },

    {
        type: 'junker',
        id: 'lucky_find',
        condition: 'always',
        vars: {
            upgrade: { type: 'random_upgrade', rarities: ['uncommon'] },
            cost: { type: 'item_cost_mult', item: 'upgrade', mult: 0.7 }
        },
        message: "Found a [upgrade]{upgrade}[/upgrade] in some wreckage. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Buy ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_upgrade:upgrade', 'recalc'],
                response: "One pilot's junk, another's treasure."
            },
            { label: "Not interested", response: "Suit yourself." },
            { label: "[warn]Help myself[/warn]", actions: ['convert_hostile'], response: "You'll pay for that!" }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  LAW ENFORCEMENT
    // ──────────────────────────────────────────────────────────────

    {
        type: 'law_enforcement',
        id: 'bounty_reward',
        condition: 'player_high_kills',
        vars: { reward: { type: 'kill_reward' } },
        message: "Patrol check. You've neutralized [good]{reward}[/good] hostiles. Bounty payment of [scrap]{reward} scrap[/scrap].",
        options: [
            {
                label: "Collect bounty ([scrap]+{reward} scrap[/scrap])",
                actions: ['add_scrap:reward'],
                response: "Keep up the good work."
            }
        ]
    },

    {
        type: 'law_enforcement',
        id: 'emergency_supply',
        condition: 'player_low_health',
        vars: {},
        message: "Your ship is in rough shape. Standard protocol — issuing emergency [upgrade]Small Battery[/upgrade].",
        options: [
            {
                label: "Accept supply",
                actions: ['give_battery'],
                response: "Get patched up. Stay safe."
            }
        ]
    },

    {
        type: 'law_enforcement',
        id: 'distress_beacon',
        condition: 'always',
        vars: { cost: 40 },
        message: "Patrol unit. We have a broad-spectrum [warn]Distress Beacon[/warn] we can deploy. It'll bring every pirate in the sector down on us. You want the target practice? [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Activate it ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'increase_spawns:3.0:60'],
                response: "Beacon active. Spawns are tripled for 60 seconds. Get ready!"
            },
            {
                label: "No thanks",
                response: "Probably for the best."
            }
        ]
    },

    {
        type: 'law_enforcement',
        id: 'cornered_boss',
        condition: 'always',
        vars: {},
        message: "We're tracking a [warn]High Value Target[/warn] nearby. They're heavy armor, and we don't have the firepower to take them. Want the location?",
        options: [
            {
                label: "Transmit coordinates",
                actions: ['spawn_boss'],
                response: "Uploading targeting data now. Bring 'em down!"
            },
            {
                label: "Not my problem",
                response: "Understood. Patrol out."
            }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  BLACK MARKET
    // ──────────────────────────────────────────────────────────────

    {
        type: 'black_market',
        id: 'exclusive_stock',
        condition: 'always',
        vars: {
            upgrade: { type: 'random_upgrade', rarities: ['unique', 'legendary'] },
            cost: 500
        },
        message: "Psst. Got something [warn]special[/warn]. A [upgrade]{upgrade}[/upgrade]. [cost]{cost} scrap[/cost], no questions.",
        options: [
            {
                label: "Buy ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_upgrade:upgrade', 'recalc'],
                response: "We never met."
            },
            { label: "Too expensive", response: "Your loss. This doesn't come around twice." },
            { label: "[warn]Take it by force[/warn]", actions: ['convert_hostile'], response: "Bad idea!" }
        ]
    },

    {
        type: 'black_market',
        id: 'hot_goods',
        condition: 'always',
        vars: {
            upgrade: { type: 'random_upgrade', rarities: ['epic'] },
            cost: { type: 'item_cost_mult', item: 'upgrade', mult: 2.5 }
        },
        message: "Got a [upgrade]{upgrade}[/upgrade] — fell off a military transport. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Buy ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_upgrade:upgrade', 'recalc'],
                response: "Pleasure. Now get lost."
            },
            { label: "Pass", response: "Waste of my time." },
            { label: "[warn]Just take it[/warn]", actions: ['convert_hostile'], response: "You're dead!" }
        ]
    },

    {
        type: 'black_market',
        id: 'rare_contraband',
        condition: 'always',
        vars: {
            upgrade: { type: 'random_upgrade', rarities: ['rare'] },
            cost: { type: 'item_cost_mult', item: 'upgrade', mult: 1.8 }
        },
        message: "Obtained a [upgrade]{upgrade}[/upgrade] through... channels. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Buy ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_upgrade:upgrade', 'recalc'],
                response: "Don't tell anyone."
            },
            { label: "Not interested", response: "Whatever." },
            { label: "[warn]Hand it over[/warn]", actions: ['convert_hostile'], response: "You're making a mistake!" }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  TUNER
    // ──────────────────────────────────────────────────────────────

    {
        type: 'tuner',
        id: 'speed_boost',
        condition: 'always',
        vars: { cost: 60 },
        message: "I can recalibrate your thrusters — [good]+10% speed[/good], permanent. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Accept ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'encounter_speed:1.1', 'recalc'],
                response: "Thrusters recalibrated."
            },
            { label: "Not now", response: "Come back anytime." }
        ]
    },

    {
        type: 'tuner',
        id: 'fire_rate_tune',
        condition: 'always',
        vars: { cost: 80 },
        message: "Your weapon cycling could be faster. [good]+10% fire rate[/good] tune. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Accept ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'encounter_fire_rate:0.9', 'recalc'],
                response: "Fire control optimized."
            },
            { label: "Pass", response: "Your loss." }
        ]
    },

    {
        type: 'tuner',
        id: 'full_tune',
        condition: 'always',
        vars: { cost: 150 },
        message: "Full ship tune — [good]+5% speed, fire rate, and turning[/good]. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Full tune ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'encounter_speed:1.05', 'encounter_fire_rate:0.95', 'encounter_turn:1.05', 'recalc'],
                response: "Peak performance. Enjoy."
            },
            { label: "Too expensive", response: "Premium service costs premium scrap." }
        ]
    }
];
