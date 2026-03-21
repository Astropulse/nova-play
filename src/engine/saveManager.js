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
            
            // If we are already in PlayingState, we can just deserialize.
            // If not (e.g. from Menu), we need to transition to PlayingState first.
            if (game.currentState && game.currentState.constructor.name === 'PlayingState') {
                await game.currentState.deserialize(saveData);
                console.log('Game loaded successfully.');
            } else {
                // This part might need adjustment depending on how shipData is handled.
                // For now, let's assume we load from within an active game.
                console.log('Load can only be performed from within an active game session for now.');
            }
        } catch (err) {
            console.error('Failed to load game:', err);
        }
    }
}
