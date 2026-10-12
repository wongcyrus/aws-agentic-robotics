import { ObjectExt } from '../util/ObjectsExt.js';
const AudioPlayerWorkletUrl = new URL('./AudioPlayerProcessor.worklet.js', import.meta.url).toString();

export class AudioPlayer {
    constructor() {
        this.onAudioPlayedListeners = [];
        this.initialized = false;
        this.currentVolume = 0;
        this.inputVolume = 0;
        this.websocketVolume = 0;
        this.lastWebsocketVolumeTime = 0;
        this.samplesPlayed = 0;
    }

    setInputVolume(vol) {
        this.inputVolume = vol;
    }

    getInputVolume() {
        return this.inputVolume || 0;
    }

    addEventListener(event, callback) {
        switch (event) {
            case "onAudioPlayed":
                this.onAudioPlayedListeners.push(callback);
                break;
            default:
                console.error("Listener registered for event type: " + JSON.stringify(event) + " which is not supported");
        }
    }

    async start() {
        if (this.initialized) {
            await this.audioContext.resume();
            return;
        }
        this.audioContext = new AudioContext({ "sampleRate": 16000 });
        const context = this.audioContext;
        const playbackReady = context.resume();

        // Chrome caches worklet code more aggressively, so add a nocache parameter to make sure we get the latest
        await Promise.all([playbackReady, context.audioWorklet.addModule(AudioPlayerWorkletUrl)]);
        if (this.audioContext !== context) {
            throw new Error("Audio playback initialization was cancelled.");
        }
        this.workletNode = new AudioWorkletNode(context, "audio-player-processor");
        
        // Listen for high-priority background volume calculations from the AudioWorklet
        this.workletNode.port.onmessage = (event) => {
            if (event.data) {
                if (event.data.type === "volume") {
                    this.currentVolume = event.data.volume;
                    if (event.data.samplesPlayed !== undefined) {
                        this.samplesPlayed = event.data.samplesPlayed;
                    }
                }
            }
        };

        // Direct low-latency connection: workletNode -> speakers (destination)
        this.workletNode.connect(this.audioContext.destination);

        this.#maybeOverrideInitialBufferLength();
        this.initialized = true;
    }

    bargeIn() {
        this.workletNode.port.postMessage({
            type: "barge-in",
        })
    }

    stop() {
        if (ObjectExt.exists(this.audioContext)) {
            this.audioContext.close().catch(error => console.warn("Error closing playback audio context:", error));
        }

        if (ObjectExt.exists(this.workletNode)) {
            this.workletNode.disconnect();
        }

        this.initialized = false;
        this.audioContext = null;
        this.workletNode = null;
    }

    #maybeOverrideInitialBufferLength() {
        // Read a user-specified initial buffer length from the URL parameters to help with tinkering
        const params = new URLSearchParams(window.location.search);
        const value = params.get("audioPlayerInitialBufferLength");
        if (value === null) {
            return;  // No override specified
        }
        const bufferLength = parseInt(value);
        if (isNaN(bufferLength)) {
            console.error("Invalid audioPlayerInitialBufferLength value:", JSON.stringify(value));
            return;
        }
        this.workletNode.port.postMessage({
            type: "initial-buffer-length",
            bufferLength: bufferLength,
        });
    }

    playAudio(samples) {
        if (!this.initialized) {
            console.error("The audio player is not initialized. Call init() before attempting to play audio.");
            return;
        }
        this.workletNode.port.postMessage({
            type: "audio",
            audioData: samples,
        });
    }

    getSamplesPlayed() {
        return this.samplesPlayed || 0;
    }

    resetSamplesPlayed() {
        this.samplesPlayed = 0;
        if (this.initialized && this.workletNode) {
            this.workletNode.port.postMessage({
                type: "reset-samples-played"
            });
        }
    }

    getSamples() {
        return null; // Deprecated and superseded by high-performance background AudioWorklet processing
    }

    setWebSocketVolume(vol) {
        this.websocketVolume = vol;
        this.lastWebsocketVolumeTime = Date.now();
    }

    getVolume() {
        if (this.initialized) {
            // When Web Audio is active, use the exact speaker playback volume for perfect voice-lip sync
            return this.currentVolume || 0;
        }

        // Fallback: If Web Audio is blocked or loading, use immediate network packet volume decay
        const now = Date.now();
        const elapsed = now - (this.lastWebsocketVolumeTime || 0);

        if (elapsed > 120) {
            this.websocketVolume *= 0.85;
        }
        if (this.websocketVolume < 0.005) {
            this.websocketVolume = 0;
        }

        return this.websocketVolume || 0;
    }
}
