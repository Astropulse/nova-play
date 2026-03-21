export class SaveManager {
    static SAVE_KEY = 'nova_save_data';

    /**
     * Saves the current game state to localStorage.
     * @param {PlayingState} playingState 
     */
    static save(playingState) {
        if (!playingState) return;

        try {
            const saveData = playingState.serialize();
            localStorage.setItem(this.SAVE_KEY, JSON.stringify(saveData));
            console.log('Game saved successfully.');
        } catch (err) {
            console.error('Failed to save game:', err);
        }
    }

    /**
     * Loads the game state from localStorage.
     * @param {Game} game 
     */
    static async load(game) {
        try {
            const rawData = localStorage.getItem(this.SAVE_KEY);
            if (!rawData) {
                console.log('No save data found.');
                return;
            }

            const saveData = JSON.parse(rawData);
            const { SHIPS } = await import('../data/ships.js');
            const { PlayingState } = await import('../states/playingState.js');
            
            let targetState = game.currentState;

            // If we're not in PlayingState or the ship has changed, we must transition
            const currentShipId = (game.currentState && game.currentState.shipData) ? game.currentState.shipData.id : null;
            const needsTransition = !(game.currentState instanceof PlayingState) || (saveData.shipId && currentShipId !== saveData.shipId);

            if (needsTransition) {
                const shipId = saveData.shipId || 'fighter'; // default to fighter if missing
                const shipData = SHIPS.find(s => s.id === shipId);
                if (!shipData) {
                    console.error('Saved ship ID not found:', shipId);
                    return;
                }
                targetState = new PlayingState(game, shipData);
                game.setState(targetState);
            }

            if (targetState instanceof PlayingState) {
                await targetState.deserialize(saveData);
                console.log('Game loaded successfully.');
            } else {
                console.warn('Could not load game: target state is not PlayingState.');
            }
        } catch (err) {
            console.error('Failed to load game:', err);
        }
    }
}
