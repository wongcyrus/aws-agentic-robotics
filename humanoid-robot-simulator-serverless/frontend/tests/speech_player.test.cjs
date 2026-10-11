const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/../js/speech_player.js`, 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const blocked = () => Object.assign(new Error('User gesture required'), { name: 'NotAllowedError' });

function setup() {
    const listeners = new Map();
    const audios = [];
    const notifications = [];
    const nextFailures = [];
    let enumerationCalls = 0;
    class Audio {
        constructor() {
            this.listeners = new Map();
            this.paused = true;
            this.ended = false;
            this.playCalls = 0;
            this.failures = nextFailures.splice(0);
            audios.push(this);
        }
        addEventListener(event, callback) { this.listeners.set(event, callback); }
        removeEventListener(event) { this.listeners.delete(event); }
        play() {
            this.playCalls++;
            const error = this.failures.shift();
            if (error) return Promise.reject(error);
            this.paused = false;
            return Promise.resolve();
        }
        pause() { this.paused = true; }
        load() {}
    }
    const context = {
        Audio,
        console: { log() {}, warn() {}, error() {} },
        navigator: { mediaDevices: { enumerateDevices() {
            enumerationCalls++;
            return Promise.resolve([]);
        } } },
        document: { addEventListener(event, callback) { listeners.set(event, callback); } },
        window: { simulator: { showNotification(...args) { notifications.push(args); } } },
    };
    vm.runInNewContext(source, context);
    return {
        player: context.window.speechPlayer, audios, notifications, context, nextFailures,
        gesture: event => listeners.get(event)(),
        enumerationCalls: () => enumerationCalls,
    };
}

test('plays on browsers with no enumerated audio outputs', async () => {
    const env = setup();
    env.player.play('robot_1', 'https://example.com/speech.mp3', 'hello');
    await flush();
    assert.equal(env.enumerationCalls(), 0);
    assert.equal(env.audios[0].playCalls, 1);
    assert.equal(env.player.isPlaying('robot_1'), true);
});

for (const event of ['touchend', 'click', 'keydown']) {
    test(`retries blocked playback synchronously on ${event}`, async () => {
        const env = setup();
        env.nextFailures.push(blocked());
        env.player.play('robot_1', 'https://example.com/speech.mp3');
        await flush();
        assert.equal(env.player.isPlaying('robot_1'), false);
        assert.match(env.notifications[0][0], /Tap or click/);
        env.gesture(event);
        assert.equal(env.audios[0].playCalls, 2);
        await flush();
        assert.equal(env.player.isPlaying('robot_1'), true);
        env.gesture('click');
        assert.equal(env.audios[0].playCalls, 2);

        // A later clip may require its own gesture.
        env.nextFailures.push(blocked());
        env.player.play('robot_2', 'https://example.com/next.mp3');
        await flush();
        env.gesture(event);
        assert.equal(env.audios[1].playCalls, 2);
        await flush();
        assert.equal(env.player.activeSpeakers.length, 2);
    });
}

test('keeps blocked retries available and reports retry failures', async () => {
    const env = setup();
    env.nextFailures.push(blocked(), blocked(), new Error('Network failed'));
    env.player.play('robot_1', 'https://example.com/speech.mp3');
    await flush();
    env.gesture('touchend');
    await flush();
    env.gesture('click');
    await flush();
    assert.deepEqual(env.notifications.at(-1), ['Speech failed for robot_1: Network failed', 'error']);
    env.gesture('click');
    assert.equal(env.audios[0].playCalls, 3);
    assert.equal(env.player._channels.size, 0);
});

test('stopped or replaced clips are not retried', async () => {
    const env = setup();
    env.nextFailures.push(blocked());
    env.player.play('robot_1', 'https://example.com/old.mp3');
    await flush();
    env.player.play('robot_1', 'https://example.com/new.mp3');
    await flush();
    env.gesture('click');
    assert.equal(env.audios[0].playCalls, 1);
    assert.equal(env.audios[1].playCalls, 1);
    env.nextFailures.push(blocked());
    env.player.play('robot_2', 'https://example.com/stopped.mp3');
    await flush();
    env.player.stopAll();
    env.gesture('touchend');
    assert.equal(env.audios[2].playCalls, 1);
    assert.equal(env.player._channels.size, 0);
});

test('ignores a stale rejection after replacing a clip', async () => {
    const env = setup();
    env.nextFailures.push(blocked());
    env.player.play('robot_1', 'https://example.com/old.mp3');
    env.player.play('robot_1', 'https://example.com/new.mp3');
    await flush();
    assert.equal(env.notifications.some(([message]) => message.includes('Tap or click')), false);
    env.gesture('click');
    assert.equal(env.audios[0].playCalls, 1);
    assert.equal(env.audios[1].playCalls, 1);
});

test('does not retry disabled speech and cleans up finished clips', async () => {
    const env = setup();
    env.nextFailures.push(blocked());
    env.player.play('robot_1', 'https://example.com/speech.mp3');
    await flush();
    env.player.enabled = false;
    env.gesture('click');
    env.player.play('robot_2', 'https://example.com/disabled.mp3');
    assert.equal(env.audios.length, 1);
    assert.equal(env.audios[0].playCalls, 1);
    env.player.enabled = true;
    env.gesture('touchend');
    await flush();
    env.audios[0].listeners.get('ended')();
    assert.equal(env.player._channels.size, 0);
    assert.equal(env.audios[0].listeners.size, 0);
});

test('reports unsupported audio without attempting device enumeration', () => {
    const env = setup();
    env.context.Audio = undefined;
    env.player.play('robot_1', 'https://example.com/speech.mp3');
    assert.deepEqual(env.notifications[0], ['Audio playback is not supported in this browser', 'error']);
    assert.equal(env.enumerationCalls(), 0);
});
