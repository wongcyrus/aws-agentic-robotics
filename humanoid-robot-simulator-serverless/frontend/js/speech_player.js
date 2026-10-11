/**
 * SpeechPlayer - Per-robot concurrent audio player for the simulator.
 *
 * Manages one Audio instance per robot so multiple robots can speak
 * simultaneously.  If a new speech arrives for the SAME robot while
 * it is still speaking, the old one is interrupted and the new one
 * starts.  Speech for DIFFERENT robots plays concurrently.
 *
 * Usage:
 *   window.speechPlayer.play(robotId, url, text);
 *   window.speechPlayer.stop(robotId);   // stop one robot
 *   window.speechPlayer.stopAll();       // stop every robot
 */
class SpeechPlayer {
    constructor() {
        if (SpeechPlayer._instance) {
            return SpeechPlayer._instance;
        }
        SpeechPlayer._instance = this;

        /** @type {Map<string, HTMLAudioElement>} robotId → Audio */
        this._channels = new Map();

        this._pendingPlayback = new Map();

        /** @type {boolean} Whether speech playback is enabled (controlled by UI toggle) */
        this.enabled = true;

        const retryPlayback = () => {
            if (!this.enabled) return;
            const pending = [...this._pendingPlayback.values()];
            this._pendingPlayback.clear();
            // Call play synchronously inside the gesture for Safari's autoplay policy.
            for (const retry of pending) retry();
        };
        document.addEventListener('click', retryPlayback);
        document.addEventListener('touchend', retryPlayback);
        document.addEventListener('keydown', retryPlayback);

        console.log('🔊 SpeechPlayer initialized (per-robot)');
    }

    /* ------------------------------------------------------------------ */
    /*  Public API                                                         */
    /* ------------------------------------------------------------------ */

    /**
     * Play speech audio for a specific robot.
     * If the same robot is already speaking, the old audio is stopped first.
     * Different robots play concurrently.
     *
     * @param {string} robotId  Robot identifier (e.g. "robot_1").
     * @param {string} url      Presigned S3 URL for the audio file.
     * @param {string} [text]   Optional display text (for logging / UI).
     */
    play(robotId, url, text) {
        if (!url) {
            console.warn('🔊 SpeechPlayer.play() called with empty URL');
            return;
        }

        if (!this.enabled) {
            console.log(`🔇 Speech disabled, ignoring: [${robotId}] "${text || ''}"`);
            return;
        }

        if (typeof Audio === 'undefined') {
            this._showNotification('Audio playback is not supported in this browser', 'error');
            return;
        }

        // Stop any current speech for THIS robot only
        this.stop(robotId);

        console.log(`🔊 [${robotId}] Playing: "${text || '(no text)'}" — ${url.substring(0, 80)}…`);

        const audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.preload = 'auto';
        audio.volume = 1.0;

        // Named functions for easy removal
        const onEnded = () => {
            console.log(`🔊 [${robotId}] Speech finished`);
            this._cleanupChannel(robotId, audio, onEnded, onError, onLoadedMetadata);
        };

        const onLoadedMetadata = () => {
            console.log(`🔊 [${robotId}] Metadata loaded - Duration: ${audio.duration.toFixed(2)}s`);
        };

        const onError = (e) => {
            // Only log if not already cleaned up
            if (audio.src) {
                const err = audio.error;
                let msg = 'Unknown error';
                if (err) {
                    switch (err.code) {
                        case 1: msg = 'Aborted'; break;
                        case 2: msg = 'Network error'; break;
                        case 3: msg = 'Decoding error'; break;
                        case 4: msg = 'Source not supported'; break;
                    }
                }
                console.error(`🔊 [${robotId}] Speech error (${msg}):`, e);
                this._showNotification(`Speech failed for ${robotId}: ${msg}`, 'error');
            }
            this._cleanupChannel(robotId, audio, onEnded, onError, onLoadedMetadata);
        };

        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);
        audio.addEventListener('loadedmetadata', onLoadedMetadata);

        this._channels.set(robotId, audio);
        audio.src = url;

        const attemptPlayback = () => {
            if (this._channels.get(robotId) !== audio || !this.enabled) return;
            this._pendingPlayback.delete(robotId);
            audio.play().then(() => {
                if (this._channels.get(robotId) !== audio) return;
                console.log(`🔊 [${robotId}] Playback started`);
                if (text) {
                    this._showNotification(`🗣️ ${robotId}: "${text}"`, 'info');
                }
            }).catch((err) => {
                if (this._channels.get(robotId) !== audio) return;
                if (err.name === 'NotAllowedError') {
                    console.warn(`🔊 [${robotId}] Autoplay blocked:`, err.message);
                    this._pendingPlayback.set(robotId, attemptPlayback);
                    this._showNotification('Tap or click anywhere to enable speech audio', 'warning');
                } else {
                    console.error(`🔊 [${robotId}] Playback failed:`, err);
                    this._showNotification(`Speech failed for ${robotId}: ${err.message}`, 'error');
                    this._cleanupChannel(robotId, audio, onEnded, onError, onLoadedMetadata);
                }
            });
        };
        attemptPlayback();
    }

    /**
     * Stop speech for a specific robot.
     * @param {string} robotId
     */
    stop(robotId) {
        this._pendingPlayback.delete(robotId);
        const audio = this._channels.get(robotId);
        if (audio) {
            try {
                audio.pause();
                // We don't have the original listeners here, so we just clear src
                // If it was called from stop(), it's likely a manual override
                audio.src = '';
                audio.load(); // Force release of resources
            } catch (_) { /* ignore */ }
            this._channels.delete(robotId);
        }
    }

    /**
     * Stop all robots' speech.
     */
    stopAll() {
        for (const robotId of [...this._channels.keys()]) {
            this.stop(robotId);
        }
    }

    /**
     * Check if a specific robot is currently speaking.
     * @param {string} robotId
     * @returns {boolean}
     */
    isPlaying(robotId) {
        const audio = this._channels.get(robotId);
        return audio !== undefined && !audio.paused && !audio.ended;
    }

    /**
     * @returns {string[]} List of robot IDs currently speaking.
     */
    get activeSpeakers() {
        return [...this._channels.keys()].filter(id => this.isPlaying(id));
    }

    /* ------------------------------------------------------------------ */
    /*  Internal helpers                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Proper cleanup of an audio channel.
     */
    _cleanupChannel(robotId, audio, onEnded, onError, onLoadedMetadata) {
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        if (onLoadedMetadata) {
            audio.removeEventListener('loadedmetadata', onLoadedMetadata);
        }
        
        if (this._channels.get(robotId) === audio) {
            this._pendingPlayback.delete(robotId);
            this._channels.delete(robotId);
        }
        
        try {
            audio.pause();
            audio.src = '';
            audio.load();
        } catch (_) { }
    }

    _showNotification(message, type) {
        if (window.simulator && typeof window.simulator.showNotification === 'function') {
            window.simulator.showNotification(message, type);
        }
    }
}

// Export singleton instance
window.speechPlayer = new SpeechPlayer();
