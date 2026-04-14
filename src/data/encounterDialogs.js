/**
 * ═══════════════════════════════════════════════════════════════════
 *  ENCOUNTER DIALOG DATA
 *  Pure data file - edit freely to add/modify encounter scenarios.
 * ═══════════════════════════════════════════════════════════════════
 *
 * FORMAT REFERENCE:
 *
 * condition - when this scenario is available:
 *   "always"                  always available
 *   "player_has_rare_item"    player has rare/epic in inventory
 *   "player_has_any_item"     player has any non-unique item
 *   "player_has_battery"      player has a Small Battery
 *   "player_low_health"       player health < 50%
 *   "player_high_kills"       enemiesDefeated >= 15
 *   "has_unrevealed_events"   at least 1 unrevealed event exists
 *   "has_unrevealed_events_2" at least 2 unrevealed events exist
 *
 * vars - dynamically resolved values:
 *   { type: "random_rare_item" }             random rare/epic from player inv
 *   { type: "random_any_item" }              random non-unique from player inv
 *   { type: "random_upgrade", rarities: [] } random upgrade from UPGRADES pool
 *   { type: "random_int", min: N, max: N }   random integer
 *   { type: "item_cost_mult", item: "varName", mult: N }  var.item.cost * mult
 *   { type: "kill_reward" }                  40 + kills * 1.5
 *
 * message - dialog text. Use:
 *   {varName}         substitutes the var's value (or .name if object)
 *   {varName.prop}    substitutes a specific property
 *   [scrap]...[/scrap]       yellow highlight
 *   [upgrade]...[/upgrade]   cyan highlight
 *   [cost]...[/cost]         red highlight
 *   [good]...[/good]         green highlight
 *   [warn]...[/warn]         orange highlight
 *
 * options[].actions - array of action strings:
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
 * options[].negotiate - if present, this is a negotiation option:
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
            offer: { type: 'item_cost_mult', item: 'targetItem', mult: 2 },
            negotiate: { type: 'item_cost_mult', item: 'targetItem', mult: 3 }
        },
        message: "My scanners picked up a [upgrade]{targetItem}[/upgrade] in your cargo. I'll pay [scrap]{offer} scrap[/scrap] for it.",
        options: [
            {
                label: "Accept ([scrap]+{offer} scrap[/scrap])",
                actions: ['remove_item:targetItem', 'add_scrap:offer', 'recalc'],
                response: "Pleasure doing business."
            },
            {
                label: "Counter-offer ([scrap]+{negotiate} scrap[/scrap])",
                negotiate: { chance: 0.5, price: 'negotiate', fallbackPrice: 'offer' },
                actions: ['remove_item:targetItem', 'add_scrap:negotiate', 'recalc'],
                fallbackActions: ['remove_item:targetItem', 'add_scrap:offer', 'recalc'],
                response: "You drive a hard bargain."
            },
            { label: "Hold that thought", stay: true, response: "We'll be around." },
            { label: "Not interested", response: "Fine. Moving on then." },
            { label: "[warn]Attack them[/warn]", actions: ['convert_hostile'], response: "You'll regret this!" }
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
                label: "Haggle ([cost]-{negotiate} scrap[/cost])",
                negotiate: { chance: 0.45, price: 'negotiate', fallbackPrice: 'cost' },
                actions: ['remove_scrap:negotiate', 'add_upgrade:upgrade', 'recalc'],
                fallbackActions: ['remove_scrap:cost', 'add_upgrade:upgrade', 'recalc'],
                response: "Fine, take it."
            },
            { label: "I'll return later", stay: true, response: "Maybe next time." },
            { label: "No thanks", response: "Your loss. Moving on." },
            { label: "[warn]Take it by force[/warn]", actions: ['convert_hostile'], response: "Big mistake!" }
        ]
    },

    {
        type: 'cargo_trader',
        id: 'event_intel',
        condition: 'has_unrevealed_events',
        vars: {
            cost:      { type: 'random_int', min: 40, max: 60 },
            negotiate: { type: 'random_int', min: 25, max: 35 }
        },
        message: "We picked up [warn]a signal[/warn] on our scanners but can't afford to investigate. Coordinates for [cost]{cost} scrap[/cost].",
        steps: {
            signal_type: {
                message: "Massive energy reading, unknown origin. Could be a derelict with salvage, could be something active. We got close enough to log it, not close enough to find out.",
                options: [
                    {
                        label: "Buy coordinates ([cost]-{cost} scrap[/cost])",
                        actions: ['remove_scrap:cost', 'reveal_event'],
                        response: "Sent. Whatever it is, good luck."
                    },
                    {
                        label: "Haggle ([cost]-{negotiate} scrap[/cost])",
                        negotiate: { chance: 0.45, price: 'negotiate', fallbackPrice: 'cost' },
                        actions: ['remove_scrap:negotiate', 'reveal_event'],
                        fallbackActions: ['remove_scrap:cost', 'reveal_event'],
                        response: "Fine. Data's yours."
                    },
                    {
                        label: "Not worth it",
                        response: "Your call. Moving on."
                    }
                ]
            }
        },
        options: [
            {
                label: "Buy coordinates ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'reveal_event'],
                response: "Coordinates sent. Be careful out there."
            },
            {
                label: "What kind of signal?",
                chain: 'signal_type'
            },
            { label: "I'll think about it", stay: true, response: "Suit yourself. We're not moving just yet." },
            { label: "Pass", response: "Alright. Safe travels." }
        ]
    },

    {
        type: 'cargo_trader',
        id: 'cargo_expansion',
        condition: 'always',
        vars: { cost: 100 },
        message: "Your cargo hold looks a bit cramped. We can rip out some bulkheads and permanently [good]expand your inventory capacity[/good] by 1 column for [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Expand cargo ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_perm_capacity:1', 'recalc'],
                response: "All done. Enjoy the extra space."
            },
            { label: "Wait here, I'll return", stay: true, response: "We'll be here. Don't wait too long." },
            { label: "Not interested", response: "Understood. Safe travels." }
        ]
    },

    {
        type: 'cargo_trader',
        id: 'cargo_ship_lore',
        condition: 'has_unrevealed_cargo_ship',
        vars: { targetEvent: { type: 'random_unrevealed_event', className: 'CargoShipEvent' } },
        message: "One of our [scrap]supply ships[/scrap] got taken out somewhere in the [good]+/- 6000 radius[/good]. Whole month's cargo, gone. Never had time to salvage it.",
        steps: {
            coords: {
                message: "Emergency transponder was still pinging when we left the area. Signal's probably stale by now, but there'll still be something out there.",
                options: [
                    {
                        label: "Send me the signal",
                        actions: ['reveal_event_specific:targetEvent'],
                        response: "Sent. Take whatever's left - we won't be coming back for it."
                    },
                    {
                        label: "I'm not heading that way",
                        response: "Fair enough. Safe travels."
                    }
                ]
            }
        },
        options: [
            {
                label: "Do you know where it went down?",
                chain: 'coords'
            },
            {
                label: "That's rough. Safe travels.",
                response: "Happens out here. If you stumble across it, make good use of the scrap."
            },
            {
                label: "Ignore.",
                response: ""
            }
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
        message: "Your hull's seen better days. For [cost]{cost} scrap[/cost] I can reinforce it - [good]+30 max health[/good], permanent.",
        options: [
            {
                label: "Accept ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_perm_health:30', 'recalc'],
                response: "Hull reinforced. Much tougher now."
            },
            {
                label: "Negotiate ([cost]-{negotiate} scrap[/cost])",
                negotiate: { chance: 0.5, price: 'negotiate', fallbackPrice: 'cost' },
                actions: ['remove_scrap:negotiate', 'add_perm_health:50', 'recalc'],
                fallbackActions: ['remove_scrap:cost', 'add_perm_health:50', 'recalc'],
                response: "Done. Hull reinforced."
            },
            { label: "Hold on, I'll come back", stay: true, response: "We'll be around." },
            { label: "No thanks", response: "Your hull, your funeral. See ya." }
        ]
    },

    {
        type: 'engineer',
        id: 'shield_calibrate',
        condition: 'always',
        vars: { cost: 55 },
        message: "I can recalibrate your shields - [good]+50 max shield energy[/good]. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Accept ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_perm_shield:50', 'recalc'],
                response: "Shields recalibrated."
            },
            { label: "Give me some time to think", stay: true, response: "Your call. We're staying put for a bit." },
            { label: "I'm good", response: "Fine by me. Best of luck." }
        ]
    },

    {
        type: 'engineer',
        id: 'weapon_overhaul',
        condition: 'always',
        vars: { cost: 100 },
        message: "Your weapons need an overhaul. [cost]{cost} scrap[/cost] for a [good]permanent +10 damage boost[/good].",
        options: [
            {
                label: "Accept ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_perm_damage:10'],
                response: "Weapons overhauled. Hitting harder now."
            },
            { label: "Not right now, maybe later", stay: true, response: "Come back anytime." },
            { label: "Pass", response: "Have it your way. Moving out." }
        ]
    },

    {
        type: 'engineer',
        id: 'weapon_specialist',
        condition: 'always',
        vars: {
            upgrade: { type: 'random_upgrade', ids: ['railgun', 'repeater', 'rockets', 'energy_blaster'] },
            cost: { type: 'item_cost_mult', item: 'upgrade', mult: 1.1 }
        },
        message: "I've been tinkering with a [upgrade]{upgrade}[/upgrade]. It's a complex piece of tech, but I can install it for [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Buy and Install ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_upgrade:upgrade', 'recalc'],
                response: "System installed. Watch the heat signature on that one."
            },
            { label: "Let me think for a bit", stay: true, response: "Quality tech isn't cheap. We'll wait." },
            { label: "Not today", response: "Understood. On our way." }
        ]
    },

    {
        type: 'engineer',
        id: 'weapon_exchange',
        condition: 'player_has_any_item',
        vars: {
            targetItem: { type: 'random_any_item' },
            upgrade: { type: 'random_upgrade', ids: ['railgun', 'repeater', 'rockets', 'energy_blaster'] }
        },
        message: "That [upgrade]{targetItem}[/upgrade] you're carrying... I could use it for parts. Trade it for this [upgrade]{upgrade}[/upgrade] I just finished calibrating?",
        steps: {
            weapon_detail: {
                message: "Solid build. Just finished breaking in the housing - first few shots might feel [warn]a little rough[/warn], but it settles fast. Good piece of kit for what it is.",
                options: [
                    {
                        label: "Worth it. Trade ([upgrade]-{targetItem}[/upgrade], [upgrade]+{upgrade}[/upgrade])",
                        actions: ['remove_item:targetItem', 'add_upgrade:upgrade', 'recalc'],
                        response: "This'll make a fine donor unit. Enjoy."
                    },
                    {
                        label: "I'd rather keep what I have",
                        response: "Your call. Offer stands for now."
                    }
                ]
            }
        },
        options: [
            {
                label: "Trade ([upgrade]-{targetItem}[/upgrade], [upgrade]+{upgrade}[/upgrade])",
                actions: ['remove_item:targetItem', 'add_upgrade:upgrade', 'recalc'],
                response: "This'll make a fine donor unit."
            },
            {
                label: "Tell me more about this [upgrade]{upgrade}[/upgrade]",
                chain: 'weapon_detail'
            },
            { label: "I'll decide later", stay: true, response: "Fair enough. It's a solid piece of kit." },
            { label: "No deal", response: "As you wish. Safe travels." }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  CIVILIAN
    // ──────────────────────────────────────────────────────────────

    {
        type: 'civilian',
        id: 'grateful_survivor',
        condition: 'always',
        vars: { gift: { type: 'random_int', min: 5, max: 40 } },
        message: "A friendly face! Take some spare scrap - [scrap]{gift} scrap[/scrap]. You need it more than us.",
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
        steps: {
            thanks: {
                message: "You saved our crew. We have some nav data from our route - [good]supply station coordinates[/good] we won't reach now. Take them.",
                options: [
                    {
                        label: "Accept coordinates",
                        actions: ['reveal_shop'],
                        response: "Fly safe, pilot. We won't forget this."
                    },
                    {
                        label: "No need - take care out there",
                        response: "Thank you. Really."
                    }
                ]
            }
        },
        options: [
            {
                label: "Give battery ([scrap]+{reward} scrap[/scrap])",
                actions: ['remove_battery', 'add_scrap:reward', 'recalc'],
                chain: 'thanks'
            },
            { label: "I'll have to think about it", stay: true, response: "We'll be here. Be safe." },
            { label: "Sorry, I need it", response: "We understand. Best of luck out there." }
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

    {
        type: 'civilian',
        id: 'movement_upgrade_lore',
        condition: 'always',
        vars: {},
        message: "Sure would be nice to [good]move side-to-side[/good] huh! Bet there's an [upgrade]upgrade[/upgrade] out there for it.",
        options: [
            {
                label: "Know where I can find one?",
                response: "Who me? Nah but c'mon someone has to have found a way to do it."
            },
            {
                label: "Ignore.",
                response: ""
            }
        ]
    },

    {
        type: 'civilian',
        id: 'encounter_lore',
        condition: 'always',
        vars: {},
        message: "Hey pilot! You seen any [upgrade]shops[/upgrade] nearby? [good]The more shops you have the more people you see[/good], I'm trying to get to know this sector a bit better.",
        options: [
            {
                label: "Yeah I know some shops.",
                response: "Cool! Maybe I'll see you around."
            },
            {
                label: "Ignore.",
                response: ""
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
            targetItem:  { type: 'random_any_item' },
            offer:       { type: 'item_cost_mult', item: 'targetItem', mult: 2 },
            offer_high:  { type: 'item_cost_mult', item: 'targetItem', mult: 2.5 }
        },
        message: "Our colony needs supplies. We'll pay [scrap]{offer} scrap[/scrap] for your [upgrade]{targetItem}[/upgrade] - double market value.",
        steps: {
            pressure: {
                message: "...[scrap]{offer_high} scrap[/scrap]. That's genuinely everything we can spare. You'd be helping people who have almost nothing. Please.",
                options: [
                    {
                        label: "Deal ([scrap]+{offer_high} scrap[/scrap])",
                        actions: ['remove_item:targetItem', 'add_scrap:offer_high', 'recalc'],
                        response: "Thank you. Truly. The colony won't forget this."
                    },
                    {
                        label: "Fine, I'll take the original offer ([scrap]+{offer} scrap[/scrap])",
                        actions: ['remove_item:targetItem', 'add_scrap:offer', 'recalc'],
                        response: "Thank you. Safe travels."
                    },
                    {
                        label: "I can't help you",
                        response: "We understand. Stay safe out there."
                    }
                ]
            }
        },
        options: [
            {
                label: "Sell ([scrap]+{offer} scrap[/scrap])",
                actions: ['remove_item:targetItem', 'add_scrap:offer', 'recalc'],
                response: "The colony thanks you."
            },
            {
                label: "I need more than double for this",
                chain: 'pressure'
            },
            { label: "I'll decide later", stay: true, response: "Understandable. We'll be around." },
            { label: "Not interested", response: "The colony will look elsewhere. Safe travels." }
        ]
    },

    {
        type: 'colony',
        id: 'colony_intel',
        condition: 'always',
        vars: {},
        message: "We passed a [good]supply station[/good] on our route. Coordinates - no charge.",
        options: [
            {
                label: "Accept coordinates",
                actions: ['reveal_shop'],
                response: "Coordinates sent. Good stock when we passed."
            },
            { label: "No thanks", response: "Very well. Good luck, pilot." }
        ]
    },

    {
        type: 'colony',
        id: 'medical_facilities',
        condition: 'always',
        vars: { cost: 35, cost_partial: 18 },
        message: "We maintain medical and repair bays aboard the colony vessel. Full hull restoration for [cost]{cost} scrap[/cost], or a [cost]{cost_partial} scrap[/cost] emergency patch.",
        steps: {
            safety: {
                message: "Standard military-grade equipment, fully sterile. No complications in over 400 procedures. Same gear used by the Colonial Defense Fleet.",
                options: [
                    {
                        label: "Full restoration ([cost]-{cost} scrap[/cost])",
                        actions: ['remove_scrap:cost', 'heal:1.0'],
                        response: "Hull integrity fully restored. Take care out there."
                    },
                    {
                        label: "Emergency patch ([cost]-{cost_partial} scrap[/cost], 50% hull)",
                        actions: ['remove_scrap:cost_partial', 'heal:0.5'],
                        response: "Patched up. Come back for a full job when you can."
                    },
                    {
                        label: "I'm fine",
                        response: "Safe travels then."
                    }
                ]
            }
        },
        options: [
            {
                label: "Full restoration ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'heal:1.0'],
                response: "Hull integrity fully restored. Take care out there."
            },
            {
                label: "Emergency patch only ([cost]-{cost_partial} scrap[/cost], 50% hull)",
                actions: ['remove_scrap:cost_partial', 'heal:0.5'],
                response: "Patched up. Come back for the full job if you need it."
            },
            {
                label: "Is this equipment safe?",
                chain: 'safety'
            },
            { label: "I'll come back if I need it", stay: true, response: "Very well. Our bays remain open for now." },
            { label: "I'm fine", response: "Understood. Have a safe journey." }
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
            { label: "I'll come back later", stay: true, response: "We'll stay around for a bit." },
            { label: "Pass", response: "Suit yourself. Moving to the next sector." },
            { label: "[warn]Take the data[/warn]", actions: ['convert_hostile'], response: "Bad move, pilot!" }
        ]
    },

    {
        type: 'explorer',
        id: 'stellar_mapping',
        condition: 'has_unrevealed_events',
        vars: {
            targetEvent: { type: 'random_unrevealed_event' },
            cost: { type: 'random_int', min: 45, max: 65 }
        },
        message: "I've been charting this sector for months. I've located a [good]{targetEvent.displayName}[/good] nearby. For [cost]{cost} scrap[/cost], I can upload its precise coordinates to your nav-computer.",
        options: [
            {
                label: "Sync coordinates ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'reveal_event_specific:targetEvent'],
                response: "{targetEvent.displayName} confirmed. Be careful out there."
            },
            { label: "I'll return for the coords", stay: true, response: "We'll hang around for a little while longer." },
            { label: "Not interested", response: "Suit yourself. Space is big." }
        ]
    },

    {
        type: 'explorer',
        id: 'experimental_pulse',
        condition: 'always',
        vars: { reward: { type: 'random_int', min: 45, max: 75 } },
        message: "I'm studying local radiation and its effects on hull alloys. If you let me run a [warn]high-energy structural scan[/warn] on your ship, I can pay you [scrap]{reward} scrap[/scrap]. It'll stress your systems.",
        steps: {
            assess: {
                message: "The radiation interacts differently with each alloy grade. Standard scans cause 15-25% hull stress - I can't predict the exact interaction until it's done. The [scrap]{reward} scrap[/scrap] pays out regardless.",
                options: [
                    {
                        label: "Take the risk ([scrap]+{reward} scrap[/scrap])",
                        gamble: [
                            { weight: 6, message: "Data collection complete. Hull stress within expected range. Repairs recommended.", actions: ['add_scrap:reward', 'heal:-0.15'] },
                            { weight: 4, message: "[warn]Your alloy grade interacted unexpectedly.[/warn] Severe structural stress. Get repaired soon.", actions: ['add_scrap:reward', 'heal:-0.25'] }
                        ]
                    },
                    {
                        label: "Too unpredictable. No deal.",
                        response: "Fair call. Maybe another time."
                    }
                ]
            }
        },
        options: [
            {
                label: "Accept scan ([scrap]+{reward} scrap[/scrap], [warn]hull damage[/warn])",
                gamble: [
                    { weight: 6, message: "Data collection complete. Hull stress within expected range. Repairs recommended.", actions: ['add_scrap:reward', 'heal:-0.15'] },
                    { weight: 4, message: "[warn]Your alloy grade interacted unexpectedly.[/warn] Severe structural stress. Get repaired soon.", actions: ['add_scrap:reward', 'heal:-0.25'] }
                ]
            },
            {
                label: "What exactly are the risks?",
                chain: 'assess'
            },
            { label: "Maybe another time", stay: true, response: "Safety first. We'll stay on sensors." },
            { label: "No way", response: "Understandable. Hull integrity is paramount." }
        ]
    },

    {
        type: 'explorer',
        id: 'carcosa_lore',
        condition: 'always',
        vars: {},
        message: "There is... something out there. [cost]He stands waiting.[/cost] His magnificent robes covering decaying flesh... I- I must find [scrap]Carcosa[/scrap].",
        options: [
            {
                label: "What are you talking about?",
                response: "[scrap]Yellow. Yellow. Yellow. Yellow. Yellow. Yellow. Yellow. Yellow. Yello-[/scrap] [cost]TRANSMISSION TERMINATED[/cost]"
            },
            {
                label: "Ignore.",
                response: ""
            }
        ]
    },

    {
        type: 'explorer',
        id: 'asteroid_lore',
        condition: 'always',
        vars: {},
        message: "These damn asteroids keep messing up my sails! Feels like [good]the more I explore the more asteroids I run into[/good]! I can just never catch a break.",
        options: [
            {
                label: "Maybe invest in some better shields.",
                response: "Probably a good idea... at least I've got a lot of [scrap]scrap[/scrap] from all these space rocks."
            },
            {
                label: "Ignore.",
                response: ""
            }
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
            cost: { type: 'item_cost_mult', item: 'upgrade', mult: 0.6 }
        },
        message: "Got a [upgrade]{upgrade}[/upgrade]. Bit scratched up - [warn]might[/warn] work. [cost]{cost} scrap[/cost].",
        steps: {
            inspect: {
                message: "Yeah, it's rougher than I said. Fuses look questionable. Might boot fine, might not. Still [cost]{cost} scrap[/cost] - I'm not eating the loss.",
                options: [
                    {
                        label: "Worth the gamble ([cost]-{cost} scrap[/cost])",
                        actions: ['remove_scrap:cost'],
                        gamble: [
                            { weight: 7, message: "Boots clean. You got lucky.", actions: ['add_upgrade:upgrade', 'recalc'] },
                            { weight: 3, message: "[warn]Fuses on first boot.[/warn] Too far gone to salvage. Scrap's gone." }
                        ]
                    },
                    {
                        label: "Hard pass.",
                        response: "Figured."
                    }
                ]
            }
        },
        options: [
            {
                label: "Buy ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost'],
                gamble: [
                    { weight: 7, message: "Works fine. She's yours. Don't ask where I got it.", actions: ['add_upgrade:upgrade', 'recalc'] },
                    { weight: 3, message: "[warn]Fuses on first boot.[/warn] Too far gone to salvage. Scrap's gone." }
                ]
            },
            {
                label: "Let me look at it first",
                chain: 'inspect'
            },
            { label: "Give me a minute", stay: true, response: "Whatever. We're staying put for now." },
            { label: "Pass", response: "Scram then." },
            { label: "[warn]Just take it[/warn]", actions: ['convert_hostile'], response: "Hey! That's mine!" }
        ]
    },

    {
        type: 'junker',
        id: 'bulk_buy',
        condition: 'player_has_any_item',
        vars: {
            targetItem: { type: 'random_any_item' },
            offer:      { type: 'item_cost_mult', item: 'targetItem', mult: 0.9 },
            offer_high: { type: 'item_cost_mult', item: 'targetItem', mult: 1.1 }
        },
        message: "That [upgrade]{targetItem}[/upgrade] - I'll take it for [scrap]{offer} scrap[/scrap]. Quick deal.",
        steps: {
            counteroffer: {
                message: "Fine. [scrap]{offer_high} scrap[/scrap] and that's my ceiling. I know what it's worth, you know what it's worth. Deal?",
                options: [
                    {
                        label: "Deal ([scrap]+{offer_high} scrap[/scrap])",
                        actions: ['remove_item:targetItem', 'add_scrap:offer_high', 'recalc'],
                        response: "Done. Good doing business."
                    },
                    {
                        label: "Still not enough.",
                        response: "Then we're done here. Move along."
                    }
                ]
            }
        },
        options: [
            {
                label: "Sell ([scrap]+{offer} scrap[/scrap])",
                actions: ['remove_item:targetItem', 'add_scrap:offer', 'recalc'],
                response: "Done deal."
            },
            {
                label: "I know what this is worth. Higher offer.",
                chain: 'counteroffer'
            },
            { label: "I'll decide later", stay: true, response: "We're in no rush." },
            { label: "No thanks", response: "Suit yourself. Moving on." }
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
        message: "Found a [upgrade]{upgrade}[/upgrade] in some wreckage. I'll give it to you for [cost]{cost} scrap[/cost].",
        steps: {
            provenance: {
                message: "Drifted out of a combat wreck two sectors back. Looks intact but I haven't tested it. Might have taken heat during the fight.",
                options: [
                    {
                        label: "Worth the risk ([cost]-{cost} scrap[/cost])",
                        actions: ['remove_scrap:cost'],
                        gamble: [
                            { weight: 8, message: "Intact. Good find. One pilot's junk, another's treasure.", actions: ['add_upgrade:upgrade', 'recalc'] },
                            { weight: 2, message: "[warn]Internal damage from the firefight.[/warn] Doesn't power on. Scrap's gone." }
                        ]
                    },
                    {
                        label: "No thanks",
                        response: "Suit yourself."
                    }
                ]
            }
        },
        options: [
            {
                label: "Buy ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost'],
                gamble: [
                    { weight: 8, message: "One pilot's junk, another's treasure.", actions: ['add_upgrade:upgrade', 'recalc'] },
                    { weight: 2, message: "[warn]Internal damage from the wreck.[/warn] Doesn't power on. Scrap's gone." }
                ]
            },
            {
                label: "Where'd you find this?",
                chain: 'provenance'
            },
            { label: "Wait here, I'll return", stay: true, response: "Suit yourself. We're sticking around." },
            { label: "I'm good", response: "Safe travels." },
            { label: "[warn]Help myself[/warn]", actions: ['convert_hostile'], response: "You'll pay for that!" }
        ]
    },

    {
        type: 'junker',
        id: 'fractured_station_lore',
        condition: 'always',
        vars: {},
        message: "Have you seen any [scrap]abandoned stations[/scrap] around? We hear they got good parts for the taking.",
        options: [
            {
                label: "Abandoned stations?",
                response: "Yeah, the crews saw some [scrap]frozen rock[/scrap] pass by, supposedly [good]drove them all mad[/good]. Guess we'll keep looking."
            },
            {
                label: "Ignore.",
                response: ""
            }
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
        message: "Your ship is in rough shape. Standard protocol - issuing emergency [upgrade]Small Battery[/upgrade].",
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
                label: "Hold that thought",
                stay: true,
                response: "Probably for the best. We'll maintain patrol for now."
            },
            {
                label: "Not interested",
                response: "Understood. Patrol out."
            }
        ]
    },

    {
        type: 'law_enforcement',
        id: 'training_exercise',
        condition: 'always',
        vars: { reward: 80 },
        message: "Patrol unit. We're running combat drills to keep our edge. Care for a [good]training duel[/good]? We'll grant a bounty of [scrap]{reward} scrap[/scrap] to any pilot who can best us in a fair fight.",
        options: [
            {
                label: "Accept challenge",
                actions: ['convert_hostile', 'add_scrap:reward'],
                response: "Shields up, pilot! Let's see what you've got."
            },
            { label: "Decline challenge", response: "We'll keep our drills internal. Stay safe out there." }
        ]
    },

    {
        type: 'law_enforcement',
        id: 'cornered_boss',
        condition: 'always',
        vars: {},
        message: "We're tracking a [warn]High Value Target[/warn] nearby. Heavy armor - we don't have the firepower. Want the location?",
        steps: {
            briefing: {
                message: "[warn]STARCORE-CLASS designation.[/warn] Multiple weapon hardpoints, reinforced plating. We lost a patrol unit to one last week. High bounty if you bring it down, but it will not go quietly.",
                options: [
                    {
                        label: "Send the coordinates. I'll handle it.",
                        actions: ['spawn_boss'],
                        response: "Uploading targeting data now. Good luck - you'll need it."
                    },
                    {
                        label: "Wait here while I prep",
                        stay: true,
                        response: "Standing by. Don't take too long."
                    },
                    {
                        label: "Too dangerous. Not today.",
                        response: "Understood. We'll keep tracking. Patrol out."
                    }
                ]
            }
        },
        options: [
            {
                label: "Transmit coordinates",
                actions: ['spawn_boss'],
                response: "Uploading targeting data now. Bring 'em down!"
            },
            {
                label: "Tell me about the target first",
                chain: 'briefing'
            },
            {
                label: "Wait here, let me prep",
                stay: true,
                response: "Uploading targeting data now. Be ready."
            },
            {
                label: "Not my problem",
                response: "Understood. Patrol out."
            }
        ]
    },

    {
        type: 'law_enforcement',
        id: 'enemy_lore',
        condition: 'always',
        vars: {},
        message: "Hey pilot, if you get [good]far enough away[/good] from them, most [good]enemies[/good] will leave you alone. [warn]Not the big ones though[/warn], their engines can spin up too quick.",
        options: [
            {
                label: "Thanks for the tip.",
                response: "Keep out of trouble pilot."
            },
            {
                label: "Ignore.",
                response: ""
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
            { label: "I'll return shortly", stay: true, response: "We never met. Don't take too long." },
            { label: "I'm passing", response: "Your loss. This won't stay quiet long." },
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
        message: "Got a [upgrade]{upgrade}[/upgrade] - fell off a military transport. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Buy ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'add_upgrade:upgrade', 'recalc'],
                response: "Pleasure. Now get lost."
            },
            { label: "I'll think about it", stay: true, response: "Waste of my time. We're here for now though." },
            { label: "No thanks", response: "Get lost then." },
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
            { label: "Wait, I'll be back", stay: true, response: "Whatever. We're staying on sensors." },
            { label: "Pass", response: "Moving on then." },
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
        message: "I can recalibrate your thrusters - [good]+10% speed[/good], permanent. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Accept ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'encounter_speed:1.1', 'recalc'],
                response: "Thrusters recalibrated."
            },
            { label: "Hold that thought", stay: true, response: "We'll swing back sooner or later." },
            { label: "I'm good", response: "Thrusters are your life, pilot. Safe travels." }
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
            { label: "Wait, I'll return", stay: true, response: "Your loss. We're sticking around though." },
            { label: "No thanks", response: "Understood. Safe travels." }
        ]
    },

    {
        type: 'tuner',
        id: 'full_tune',
        condition: 'always',
        vars: { cost: 150 },
        message: "Full ship tune - [good]+5% speed, fire rate, and turning[/good]. [cost]{cost} scrap[/cost].",
        options: [
            {
                label: "Full tune ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'encounter_speed:1.05', 'encounter_fire_rate:0.95', 'encounter_turn:1.05', 'recalc'],
                response: "Peak performance. Enjoy."
            },
            { label: "Check back later", stay: true, response: "Premium service costs premium scrap. We're staying put for a bit." },
            { label: "No thanks", response: "Understood. Moving out." }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  FORCED / FTL-STYLE ENCOUNTERS
    //  These cannot be dismissed with Escape. Players must commit.
    // ──────────────────────────────────────────────────────────────

    // DISTRESS AMBUSH - civilian ship faking a distress call to lure you in.
    // Asking questions or demanding payment exposes the deception and gives
    // better options. Helping naively walks straight into the trap.
    {
        type: 'civilian',
        id: 'distress_ambush',
        forced: true,
        condition: 'always',
        vars: {
            tribute: { type: 'random_int', min: 55, max: 95 },
            reward:  { type: 'random_int', min: 70, max: 110 }
        },
        message: "MAYDAY - hull breach, life support failing. Please come closer, we need immediate assistance!",
        steps: {
            sprung: {
                message: "Nice of you to fly in range. [warn]Weapons armed.[/warn] Leave [cost]{tribute} scrap[/cost] and we let you go.",
                options: [
                    {
                        label: "Pay tribute ([cost]-{tribute} scrap[/cost])",
                        actions: ['remove_scrap:tribute'],
                        response: "Smart pilot. Now get clear."
                    },
                    {
                        label: "[warn]Fight back[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "Shouldn't have come close!"
                    }
                ]
            },
            scan: {
                message: "[warn]Multiple armed contacts detected[/warn] along their hull. The distress call is fabricated.",
                options: [
                    {
                        label: "Back off quietly",
                        response: "They power weapons then stand down - you're too far now. Good call."
                    },
                    {
                        label: "[warn]Open fire first[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "You anticipated the ambush."
                    }
                ]
            },
            probe: {
                message: "Our... payment systems were also damaged. Can't transfer anything until you dock first.",
                options: [
                    {
                        label: "That's not how this works. I'm leaving.",
                        response: "Their engines flare but you're already clear. Something was wrong with that signal."
                    },
                    {
                        label: "Fine - I'll dock anyway",
                        chain: 'sprung'
                    }
                ]
            }
        },
        options: [
            {
                label: "Approach and assist",
                chain: 'sprung'
            },
            {
                label: "Scan them before moving in",
                chain: 'scan'
            },
            {
                label: "Send payment details first - we'll settle before docking",
                chain: 'probe'
            }
        ]
    },

    // EXTORTION PATROL - pirate impersonating law enforcement demanding a "fee".
    // Paying is the safe path. Questioning or refusing escalates to a higher
    // demand or an immediate fight. Players learn the pattern quickly.
    {
        type: 'law_enforcement',
        id: 'extortion_patrol',
        forced: true,
        condition: 'player_has_scrap',
        vars: {
            tribute:      { type: 'random_int', min: 50, max: 75 },
            tribute_high: { type: 'random_int', min: 95, max: 140 },
            reward:       { type: 'random_int', min: 65, max: 105 }
        },
        message: "PATROL AUTHORITY - collecting [warn]sector security fees[/warn]. [cost]{tribute} scrap[/cost] or you are classified hostile.",
        steps: {
            escalate: {
                message: "Last chance. [cost]{tribute_high} scrap[/cost], final offer. We outnumber you.",
                options: [
                    {
                        label: "Pay the higher fee ([cost]-{tribute_high} scrap[/cost])",
                        actions: ['remove_scrap:tribute_high'],
                        response: "Smart. On your way."
                    },
                    {
                        label: "[warn]Open fire[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "Hostile confirmed. Engaging!"
                    }
                ]
            }
        },
        options: [
            {
                label: "Pay the fee ([cost]-{tribute} scrap[/cost])",
                actions: ['remove_scrap:tribute'],
                response: "Good. Patrol out."
            },
            {
                label: "I've never heard of this fee",
                chain: 'escalate'
            },
            {
                label: "Show me your authorization",
                chain: 'escalate'
            },
            {
                label: "[warn]I'm not paying[/warn]",
                actions: ['convert_hostile', 'add_scrap:reward'],
                response: "Engaging!"
            }
        ]
    },

    // SABOTEUR TUNE - engineer offers a "free" calibration that secretly debuffs you.
    // Naively accepting gets the worst debuff. Asking questions then declining
    // is the only way out clean. Refusing from the start triggers a pushback
    // where backing down gets a smaller debuff, but fighting escalates.
    {
        type: 'engineer',
        id: 'saboteur_tune',
        forced: true,
        condition: 'always',
        vars: {},
        message: "Hey pilot - testing a new [good]quantum resonance calibration[/good] tool. First trial is [good]completely free[/good]. Interested?",
        steps: {
            explain: {
                message: "Recalibrates your thruster harmonics - eliminates micro-oscillation. Your ship will handle... [warn]differently[/warn].",
                options: [
                    {
                        label: "Proceed with calibration",
                        actions: ['encounter_speed:0.88', 'encounter_turn:0.88'],
                        response: "All done. You'll notice the difference."
                    },
                    {
                        label: "That sounds like it hurts performance. Pass.",
                        response: "Your loss. I'll find a more willing test subject."
                    }
                ]
            },
            pushback: {
                message: "Hm. Our passive array already started a preliminary scan while we were talking. Just need your go-ahead.",
                options: [
                    {
                        label: "Fine, complete it",
                        actions: ['encounter_speed:0.93'],
                        response: "Already done actually. You'll barely notice."
                    },
                    {
                        label: "[warn]Pull it back right now[/warn]",
                        actions: ['convert_hostile'],
                        response: "Then I guess we do this the hard way."
                    }
                ]
            }
        },
        options: [
            {
                label: "Sure, let's do it",
                actions: ['encounter_speed:0.88', 'encounter_turn:0.88'],
                response: "Quick as promised. You'll feel the difference out there."
            },
            {
                label: "What does it actually do?",
                chain: 'explain'
            },
            {
                label: "No thanks",
                chain: 'pushback'
            }
        ]
    },

    // VOID GAMBLE - black market selling a sealed military container of unknown contents.
    // Buying costs scrap and rolls a weighted outcome: scattered mines + hull damage,
    // a scrap refund (less than paid), or a rare upgrade. Players learn the odds.
    {
        type: 'black_market',
        id: 'void_gamble',
        forced: true,
        condition: 'always',
        vars: {
            cost:         { type: 'random_int', min: 60, max: 90 },
            upgrade:      { type: 'random_upgrade', rarities: ['rare', 'epic'] },
            scrap_return: { type: 'random_int', min: 12, max: 28 }
        },
        message: "Got a [warn]sealed military container[/warn] off a wreck. Contents unknown. Could be a weapon system. Could be trash. [cost]{cost} scrap[/cost]. Final sale.",
        steps: {
            teaser: {
                message: "No idea. I've cracked three of these. One was worth ten times the cost. One nearly killed me. One was empty.",
                options: [
                    {
                        label: "I'll take it ([cost]-{cost} scrap[/cost])",
                        actions: ['remove_scrap:cost'],
                        gamble: [
                            {
                                weight: 4,
                                message: "[warn]The container starts beeping.[/warn] Proximity mines scatter across local space - their triggers are live.",
                                actions: ['increase_spawns:2.5:50', 'heal:-0.1']
                            },
                            {
                                weight: 3,
                                message: "Half empty. Scrap lining along the inner walls. [scrap]+{scrap_return} scrap[/scrap] recovered.",
                                actions: ['add_scrap:scrap_return']
                            },
                            {
                                weight: 3,
                                message: "[good]Military-grade hardware inside.[/good] Still in the packaging.",
                                actions: ['add_upgrade:upgrade']
                            }
                        ]
                    },
                    {
                        label: "Still not worth it",
                        response: "Fair enough. Stay lucky."
                    }
                ]
            }
        },
        options: [
            {
                label: "Buy it ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost'],
                gamble: [
                    {
                        weight: 4,
                        message: "[warn]The container starts beeping.[/warn] Proximity mines scatter across local space - their triggers are live.",
                        actions: ['increase_spawns:2.5:50', 'heal:-0.1']
                    },
                    {
                        weight: 3,
                        message: "Half empty. Scrap lining along the inner walls. [scrap]+{scrap_return} scrap[/scrap] recovered.",
                        actions: ['add_scrap:scrap_return']
                    },
                    {
                        weight: 3,
                        message: "[good]Military-grade hardware inside.[/good] Still in the packaging.",
                        actions: ['add_upgrade:upgrade']
                    }
                ]
            },
            {
                label: "What are the odds it's useful?",
                chain: 'teaser'
            },
            {
                label: "Pass",
                response: "One pilot's treasure. Moving on."
            }
        ]
    },

    // REFUGEE TRAP - colony ship faking an emergency to steal cargo.
    // They target a specific item from your hold. Helping freely or for
    // a low offer both lead to betrayal. Questioning triggers a guilt trip.
    // Attacking early is the only way to avoid the item loss entirely.
    {
        type: 'colony',
        id: 'refugee_trap',
        forced: true,
        condition: 'player_has_any_item',
        vars: {
            targetItem: { type: 'random_any_item' },
            low_offer:  { type: 'item_cost_mult', item: 'targetItem', mult: 0.25 },
            reward:     { type: 'random_int', min: 55, max: 90 }
        },
        message: "URGENT - colony evacuation vessel under attack from unknown ships. We need [upgrade]{targetItem}[/upgrade] from your hold for our defenses. Lives are at stake!",
        steps: {
            guilttrip: {
                message: "People are dying on this ship. How can you hesitate? Just the [upgrade]{targetItem}[/upgrade] - it's all we're asking.",
                options: [
                    {
                        label: "Fine - take it",
                        actions: ['remove_item:targetItem', 'recalc'],
                        chain: 'betrayal'
                    },
                    {
                        label: "[warn]I don't believe you. Leave now.[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "Plan B it is."
                    }
                ]
            },
            betrayal: {
                message: "Pleasure doing business. [warn]There was no attack.[/warn] We profile salvagers like you for a living.",
                options: [
                    {
                        label: "[warn]I want it back[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "Good luck recovering scrap, pilot."
                    },
                    {
                        label: "Remember this next time you need real help.",
                        response: "We never need real help. Good luck out there."
                    }
                ]
            }
        },
        options: [
            {
                label: "Give them the item",
                actions: ['remove_item:targetItem', 'recalc'],
                chain: 'betrayal'
            },
            {
                label: "I'll need something in return ([scrap]+{low_offer} scrap[/scrap])",
                actions: ['remove_item:targetItem', 'add_scrap:low_offer', 'recalc'],
                chain: 'betrayal'
            },
            {
                label: "This doesn't add up. Who are you really?",
                chain: 'guilttrip'
            },
            {
                label: "[warn]Something's wrong here. Open fire.[/warn]",
                actions: ['convert_hostile', 'add_scrap:reward'],
                response: "It was a setup all along!"
            }
        ]
    },

    // SALVAGE CLASH - junker claims you lifted cargo from their debris claim.
    // Paying is the safe path. Arguing always escalates to a larger demand or a fight.
    // Bluffing is a coin-flip: they either back down or immediately attack.
    {
        type: 'junker',
        id: 'salvage_clash',
        forced: true,
        condition: 'always',
        vars: {
            fine:      { type: 'random_int', min: 40, max: 65 },
            fine_high: { type: 'random_int', min: 90, max: 125 },
            reward:    { type: 'random_int', min: 60, max: 95 }
        },
        message: "Hey! That debris field was [warn]our claim[/warn]. You just helped yourself to our cargo. [cost]{fine} scrap[/cost] salvage compensation. Now.",
        steps: {
            escalate: {
                message: "You want to play it that way? Fine. [cost]{fine_high} scrap[/cost] - double it - and I walk. Last offer.",
                options: [
                    {
                        label: "Pay the higher fine ([cost]-{fine_high} scrap[/cost])",
                        actions: ['remove_scrap:fine_high'],
                        response: "Smart. Don't let me see you near our claims again."
                    },
                    {
                        label: "[warn]I'm not paying a cent[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "Then I'll take it in pieces!"
                    }
                ]
            }
        },
        options: [
            {
                label: "Pay the fine ([cost]-{fine} scrap[/cost])",
                actions: ['remove_scrap:fine'],
                response: "Smart. Don't let me catch you near our sector again."
            },
            {
                label: "I didn't take anything from your claim",
                chain: 'escalate'
            },
            {
                label: "That field was unclaimed space",
                chain: 'escalate'
            },
            {
                label: "[warn]Back off[/warn]",
                gamble: [
                    {
                        weight: 5,
                        message: "...You know what, forget it. You're not worth the trouble."
                    },
                    {
                        weight: 5,
                        message: "Big words.",
                        actions: ['convert_hostile', 'add_scrap:reward']
                    }
                ]
            }
        ]
    },

    // CONVERGENCE WARNING - explorer has mapped an incoming anomaly.
    // Paying avoids the encounter but grants map intel. Asking what it is
    // reveals the threat is already here, forcing a choice to fight for reward
    // or flee (triggering a lesser spawn wave). Going in bold is the best payout.
    {
        type: 'explorer',
        id: 'convergence_warning',
        forced: true,
        condition: 'always',
        vars: {
            cost:   { type: 'random_int', min: 55, max: 85 },
            reward: { type: 'random_int', min: 90, max: 150 }
        },
        message: "NAVIGATOR - I've triangulated a [warn]convergence anomaly[/warn] in this sector. Something massive is inbound. I can route you clear for [cost]{cost} scrap[/cost].",
        steps: {
            reveal: {
                message: "[cost]It is already here.[/cost] My instruments confirmed arrival sixty seconds ago. Run, or engage for everything it's worth.",
                options: [
                    {
                        label: "[warn]Engage it head-on[/warn]",
                        actions: ['spawn_boss', 'add_scrap:reward'],
                        response: "Then may fortune favor you. I'm clear."
                    },
                    {
                        label: "Broadcast a warning and flee",
                        actions: ['increase_spawns:1.8:40'],
                        response: "Your signal draws their scouts in. But you have a window."
                    }
                ]
            }
        },
        options: [
            {
                label: "Pay to reroute ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost', 'reveal_event'],
                response: "Rerouted. Stay on the path I've mapped."
            },
            {
                label: "What exactly is coming?",
                chain: 'reveal'
            },
            {
                label: "I can handle whatever it is",
                actions: ['spawn_boss', 'add_scrap:reward'],
                response: "Brave. Or foolish. It approaches now."
            }
        ]
    },

    // ──────────────────────────────────────────────────────────────
    //  MORE FORCED ENCOUNTERS
    // ──────────────────────────────────────────────────────────────

    // OVERCLOCKED - tuner pushes a military-spec fire rate upgrade with a hidden
    // turn cost. Asking about the tradeoff lets you decide cleanly. Saying no
    // triggers "already started" - you get a partial overclock whether you want
    // it or not. Just saying yes skips the warning entirely.
    {
        type: 'tuner',
        id: 'overclocked',
        forced: true,
        condition: 'always',
        vars: {},
        message: "Got military-spec overclock firmware here - [good]+15% fire rate[/good], permanent installation. There's a system cost, but it's standard procedure.",
        steps: {
            cost_reveal: {
                message: "The targeting sub-processor takes the load compensation. [warn]-8% turn response[/warn], permanent. Military consensus is it's a net gain in engagements. Your call.",
                options: [
                    {
                        label: "Worth it. Install the overclock.",
                        actions: ['encounter_fire_rate:0.85', 'encounter_turn:0.92'],
                        response: "Overclock complete. You'll feel the difference in sustained fire."
                    },
                    {
                        label: "Not worth the turn penalty.",
                        response: "Noted. Offer's off the table."
                    }
                ]
            },
            already_started: {
                message: "We initiated the handshake sequence when you flew in range. [warn]Can't abort cleanly[/warn] - partial install is already live.",
                options: [
                    {
                        label: "Fine. Complete the overclock.",
                        actions: ['encounter_fire_rate:0.85', 'encounter_turn:0.92'],
                        response: "Complete. Sorry for the surprise."
                    },
                    {
                        label: "Abort whatever you can.",
                        actions: ['encounter_fire_rate:0.95', 'encounter_turn:0.97'],
                        response: "Partial abort. Some residual effect remains. Should be minor."
                    }
                ]
            }
        },
        options: [
            {
                label: "What's the system cost?",
                chain: 'cost_reveal'
            },
            {
                label: "Just install it.",
                actions: ['encounter_fire_rate:0.85', 'encounter_turn:0.92'],
                response: "Done. Standard procedure. You'll notice the difference."
            },
            {
                label: "Pass on this.",
                chain: 'already_started'
            }
        ]
    },

    // CARGO INSPECTION - bogus authority vessel demanding a compliance check.
    // Standing by blind is a gamble: they either charge a processing fee (scrap loss)
    // or seize an item outright - no recourse either way. Asking what it involves
    // reveals the bribe first and lets you fight back. Refusing outright means combat.
    {
        type: 'cargo_trader',
        id: 'cargo_inspection',
        forced: true,
        condition: 'player_has_any_item',
        vars: {
            targetItem: { type: 'random_any_item' },
            cost:       { type: 'random_int', min: 40, max: 65 },
            reward:     { type: 'random_int', min: 55, max: 85 }
        },
        message: "AUTHORITY NOTICE - routine cargo compliance inspection. This vessel is licensed for regulatory checks. Stand by.",
        steps: {
            bribe_step: {
                message: "Processing fee of [cost]{cost} scrap[/cost] for administrative clearance. Pay and you're through without a full audit.",
                options: [
                    {
                        label: "Pay the fee ([cost]-{cost} scrap[/cost])",
                        actions: ['remove_scrap:cost'],
                        response: "Processed. On your way."
                    },
                    {
                        label: "[warn]This isn't a real authority check[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "Hostile confirmed. Engaging!"
                    }
                ]
            }
        },
        options: [
            {
                label: "Stand by for inspection",
                gamble: [
                    {
                        weight: 5,
                        message: "Inspector reviews manifest. [warn]Processing fee of {cost} scrap charged.[/warn] Compliance recorded.",
                        actions: ['remove_scrap:cost']
                    },
                    {
                        weight: 5,
                        message: "Inspector flags [upgrade]{targetItem}[/upgrade] as [warn]unlicensed hardware[/warn]. Item confiscated for regulatory review. Move along.",
                        actions: ['remove_item:targetItem', 'recalc']
                    }
                ]
            },
            {
                label: "What does this inspection involve?",
                chain: 'bribe_step'
            },
            {
                label: "[warn]I'm not stopping for this[/warn]",
                actions: ['convert_hostile', 'add_scrap:reward'],
                response: "Non-compliance confirmed. Engaging!"
            }
        ]
    },

    // DEBT COLLECTOR - black market enforcer claims you owe from a prior transaction.
    // Paying clears it. Denying escalates to a larger sum. Pointing out they may have
    // the wrong pilot gets a discounted "good faith" amount - but they still want
    // something. Fighting is always available.
    {
        type: 'black_market',
        id: 'debt_collector',
        forced: true,
        condition: 'player_has_scrap',
        vars: {
            debt:      { type: 'random_int', min: 50, max: 80 },
            debt_high: { type: 'random_int', min: 100, max: 140 },
            debt_low:  { type: 'random_int', min: 20, max: 38 },
            reward:    { type: 'random_int', min: 65, max: 100 }
        },
        message: "I represent interests who say you owe [cost]{debt} scrap[/cost] from a prior transaction. Outstanding balance - now due.",
        steps: {
            escalate: {
                message: "[cost]{debt_high} scrap[/cost] now that you've wasted my time. Final offer before this gets physical.",
                options: [
                    {
                        label: "Pay ([cost]-{debt_high} scrap[/cost])",
                        actions: ['remove_scrap:debt_high'],
                        response: "Pleasure."
                    },
                    {
                        label: "[warn]Come and take it[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "Your call."
                    }
                ]
            },
            wrong_pilot: {
                message: "...Possible manifest error. [warn]Could be.[/warn] Tell you what - [cost]{debt_low} scrap[/cost] as a good-faith gesture and we let this go. Everyone moves on.",
                options: [
                    {
                        label: "Fine. Pay the difference ([cost]-{debt_low} scrap[/cost])",
                        actions: ['remove_scrap:debt_low'],
                        response: "Smart. We're done here."
                    },
                    {
                        label: "[warn]I'm not paying anything[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "Then we take it another way."
                    }
                ]
            }
        },
        options: [
            {
                label: "Pay the balance ([cost]-{debt} scrap[/cost])",
                actions: ['remove_scrap:debt'],
                response: "Balance settled. Don't let it happen again."
            },
            {
                label: "I've never transacted with you",
                chain: 'escalate'
            },
            {
                label: "Check your records - you have the wrong pilot",
                chain: 'wrong_pilot'
            },
            {
                label: "[warn]I don't owe you anything[/warn]",
                actions: ['convert_hostile', 'add_scrap:reward'],
                response: "Hostile confirmed."
            }
        ]
    },

    // BLACKMAIL - civilian claiming to have footage of you violating sector law.
    // Paying blindly resolves it cheaply. Asking what the footage shows reveals it's
    // flimsy, and lets you call their bluff - a 50/50 that either exposes the scam
    // or triggers a fight. Refusing outright has the same 50/50.
    {
        type: 'civilian',
        id: 'blackmail',
        forced: true,
        condition: 'player_has_scrap',
        vars: {
            cost:   { type: 'random_int', min: 45, max: 75 },
            reward: { type: 'random_int', min: 55, max: 90 }
        },
        message: "Pilot. We have footage of you [warn]violating sector law[/warn]. We can keep this between us for [cost]{cost} scrap[/cost]. Or we file the report.",
        steps: {
            what_footage: {
                message: "Footage of your ship within [warn]1200 units of a contested debris field[/warn]. Illegal salvage claim. Our legal team is already drafting the charges.",
                options: [
                    {
                        label: "Pay to make it go away ([cost]-{cost} scrap[/cost])",
                        actions: ['remove_scrap:cost'],
                        response: "Footage deleted. Never happened."
                    },
                    {
                        label: "That footage proves nothing.",
                        chain: 'bluff'
                    },
                    {
                        label: "[warn]Open fire[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "...You called it."
                    }
                ]
            },
            bluff: {
                message: "Maybe not in isolation. But the investigation alone would [warn]freeze your sector access[/warn] for weeks. Worth {cost} scrap to skip all that?",
                options: [
                    {
                        label: "Pay it off ([cost]-{cost} scrap[/cost])",
                        actions: ['remove_scrap:cost'],
                        response: "Smart. All gone."
                    },
                    {
                        label: "I'll take my chances.",
                        gamble: [
                            { weight: 5, message: "...You called it. The footage doesn't hold up. They power away without another word." },
                            { weight: 5, message: "[warn]Turns out they weren't bluffing.[/warn]", actions: ['convert_hostile', 'add_scrap:reward'] }
                        ]
                    }
                ]
            }
        },
        options: [
            {
                label: "Pay to settle ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost'],
                response: "Footage deleted. Wise choice."
            },
            {
                label: "What footage exactly?",
                chain: 'what_footage'
            },
            {
                label: "File whatever you want.",
                gamble: [
                    { weight: 5, message: "...They back down. The bluff collapses without a mark who'll pay." },
                    { weight: 5, message: "[warn]They weren't bluffing.[/warn] Weapons go hot.", actions: ['convert_hostile', 'add_scrap:reward'] }
                ]
            }
        ]
    },

    // PRESSURE SALE - junker needs to offload hot goods before their previous owner
    // comes looking. Buying is cheap but risks bringing hunters. Asking what it is
    // reveals the upgrade before you decide - same odds either way. Refusing means
    // they try to dump it on you anyway at no cost, which STILL draws hunters.
    {
        type: 'junker',
        id: 'pressure_sale',
        forced: true,
        condition: 'always',
        vars: {
            upgrade:     { type: 'random_upgrade', rarities: ['rare', 'epic'] },
            cost:        { type: 'item_cost_mult', item: 'upgrade', mult: 0.45 },
            reward:      { type: 'random_int', min: 50, max: 80 }
        },
        message: "Got something I need to [warn]move fast[/warn]. Previous owner wants it back. [cost]{cost} scrap[/cost] - you take the risk, you take the reward.",
        steps: {
            what_is_it: {
                message: "A [upgrade]{upgrade}[/upgrade]. Rare piece - worth five times what I'm asking. Whoever wants it back has reach though. Might come looking.",
                options: [
                    {
                        label: "Worth it. Buy it ([cost]-{cost} scrap[/cost])",
                        actions: ['remove_scrap:cost'],
                        gamble: [
                            { weight: 5, message: "[warn]They come looking.[/warn] Multiple ships on sensors. The upgrade is yours but so is the problem.", actions: ['add_upgrade:upgrade', 'recalc', 'increase_spawns:2.0:45'] },
                            { weight: 5, message: "[good]No one came.[/good] Either they gave up or they never traced it. The upgrade is clean.", actions: ['add_upgrade:upgrade', 'recalc'] }
                        ]
                    },
                    {
                        label: "Not my problem.",
                        chain: 'dump'
                    }
                ]
            },
            dump: {
                message: "I can't keep it. I'm leaving it on your hull whether you want it or not. [warn]Good luck.[/warn]",
                options: [
                    {
                        label: "Fine. Keep it.",
                        gamble: [
                            { weight: 5, message: "[warn]They traced it.[/warn] Ships incoming.", actions: ['add_upgrade:upgrade', 'recalc', 'increase_spawns:2.0:45'] },
                            { weight: 5, message: "No one followed. You got a [good]{upgrade}[/good] for free.", actions: ['add_upgrade:upgrade', 'recalc'] }
                        ]
                    },
                    {
                        label: "[warn]Get away from my ship[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "Then I take it back the hard way!"
                    }
                ]
            }
        },
        options: [
            {
                label: "Buy it ([cost]-{cost} scrap[/cost])",
                actions: ['remove_scrap:cost'],
                gamble: [
                    { weight: 5, message: "[warn]They come looking.[/warn] Multiple ships on sensors. The upgrade is yours but so is the problem.", actions: ['add_upgrade:upgrade', 'recalc', 'increase_spawns:2.0:45'] },
                    { weight: 5, message: "[good]No one came.[/good] Either they gave up or they never traced it. The upgrade is clean.", actions: ['add_upgrade:upgrade', 'recalc'] }
                ]
            },
            {
                label: "What is it exactly?",
                chain: 'what_is_it'
            },
            {
                label: "Not interested.",
                chain: 'dump'
            }
        ]
    },

    // WARRANTY VOID - engineer claims your ship has an unregistered modification
    // that violates their guild's warranty terms. It's a shakedown.
    // Complying leads to a "fine." Demanding proof triggers escalation.
    // Questioning the guild itself leads to a bluff they may or may not back up.
    {
        type: 'engineer',
        id: 'warranty_void',
        forced: true,
        condition: 'always',
        vars: {
            fine:      { type: 'random_int', min: 45, max: 70 },
            fine_high: { type: 'random_int', min: 90, max: 130 },
            reward:    { type: 'random_int', min: 60, max: 95 }
        },
        message: "Guild compliance check. Your ship carries [warn]unregistered modifications[/warn] in violation of certified installation standards. Remediation fee: [cost]{fine} scrap[/cost].",
        steps: {
            escalate: {
                message: "Documentation is on file. [cost]{fine_high} scrap[/cost] - final figure - or we flag your transponder for sector-wide audit.",
                options: [
                    {
                        label: "Pay ([cost]-{fine_high} scrap[/cost])",
                        actions: ['remove_scrap:fine_high'],
                        response: "Compliance noted. Carry on."
                    },
                    {
                        label: "[warn]I don't recognize your guild[/warn]",
                        actions: ['convert_hostile', 'add_scrap:reward'],
                        response: "Non-compliance. Enforcing manually."
                    }
                ]
            },
            guild_check: {
                message: "The Certified Starship Engineers Alliance, sector chapter seven. [warn]Fully accredited.[/warn] The fee stands.",
                options: [
                    {
                        label: "Pay the fine ([cost]-{fine} scrap[/cost])",
                        actions: ['remove_scrap:fine'],
                        response: "Thank you for your cooperation."
                    },
                    {
                        label: "I've never heard of that guild.",
                        gamble: [
                            { weight: 4, message: "...Neither has anyone else apparently. They cut comms and drift away." },
                            { weight: 6, message: "Enough. [warn]We're doing this the other way.[/warn]", actions: ['convert_hostile', 'add_scrap:reward'] }
                        ]
                    }
                ]
            }
        },
        options: [
            {
                label: "Pay the remediation fee ([cost]-{fine} scrap[/cost])",
                actions: ['remove_scrap:fine'],
                response: "Compliance noted. You're clear to continue."
            },
            {
                label: "Show me the documentation",
                chain: 'escalate'
            },
            {
                label: "What guild exactly?",
                chain: 'guild_check'
            },
            {
                label: "[warn]This is a shakedown[/warn]",
                actions: ['convert_hostile', 'add_scrap:reward'],
                response: "Non-compliance confirmed. Enforcing!"
            }
        ]
    }
];
