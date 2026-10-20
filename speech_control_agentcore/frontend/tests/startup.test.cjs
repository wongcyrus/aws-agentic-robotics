const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const vm = require('node:vm');
const { randomFillSync } = require('node:crypto');

const frontend = resolve(__dirname, '..');
const flush = async () => {
    for (let i = 0; i < 12; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
};
function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function setup(options = {}) {
    const timers = new Map();
    let now = 0;
    let timerId = 0;
    const setTimeout = (callback, delay) => {
        const id = ++timerId;
        timers.set(id, { callback, due: now + delay });
        return id;
    };
    const advance = async duration => {
        const target = now + duration;
        while (true) {
            const next = [...timers.entries()]
                .filter(([, timer]) => timer.due <= target)
                .sort((a, b) => a[1].due - b[1].due)[0];
            if (!next) break;
            now = next[1].due;
            timers.delete(next[0]);
            next[1].callback();
            await flush();
        }
        now = target;
        await flush();
    };
    function element() {
        return {
            disabled: false, selectedOptions: [{ value: 'robot_1' }],
            listeners: {},
            addEventListener(event, callback) { this.listeners[event] = callback; },
            appendChild() {}, remove() {},
            classList: { add() {}, remove() {} },
            style: {}, querySelectorAll: () => [], textContent: '',
        };
    }
    const elements = new Map();
    const contexts = [];
    const streams = [];
    const sockets = [];
    const requests = [];
    const processors = [];
    const storage = new Map(options.savedLanguage === undefined ? [] : [
        ['speech-control.reply-language', options.savedLanguage],
    ]);
    class AudioContext {
        constructor() {
            this.state = 'suspended';
            this.sampleRate = 16000;
            this.audioWorklet = {
                addModule: () => options.worklet ? options.worklet() : Promise.resolve(),
            };
            contexts.push(this);
        }
        resume() { this.state = 'running'; return Promise.resolve(); }
        close() { this.state = 'closed'; return Promise.resolve(); }
        createMediaStreamSource() {
            return { connect() {}, disconnect() {} };
        }
        createScriptProcessor() {
            const processor = { connect() {}, disconnect() {} };
            processors.push(processor);
            return processor;
        }
    }
    class AudioWorkletNode {
        constructor() { this.port = { postMessage() {} }; }
        connect() {}
        disconnect() {}
    }
    class WebSocket {
        static OPEN = 1;
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            sockets.push(this);
        }
        open() { this.readyState = 1; this.onopen?.(); }
        close() { this.readyState = 3; }
        serverClose(code = 1000, reason = '') {
            this.readyState = 3;
            this.onclose?.({ code, reason });
        }
        send(data) {
            assert.equal(this.readyState, 1);
            this.sent.push(JSON.parse(data));
        }
    }
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        URL, URLSearchParams, AbortController, WebSocket, AudioContext, AudioWorkletNode,
        crypto: options.crypto || { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
        setTimeout, clearTimeout: id => timers.delete(id),
        setInterval: () => 0, clearInterval() {},
        btoa: value => Buffer.from(value, 'binary').toString('base64'),
        localStorage: {
            getItem(key) {
                if (key === 'idToken') return options.noToken ? null : 'test-token';
                if (options.storageReadError) throw new Error('Storage unavailable');
                return storage.get(key) ?? null;
            },
            setItem(key, value) {
                if (options.storageWriteError) throw new Error('Storage unavailable');
                storage.set(key, value);
            },
            clear() { storage.clear(); },
        },
        window: { location: { search: options.search || '', href: '' } },
        document: {
            addEventListener(event, callback) {
                if (event === 'DOMContentLoaded') this.onReady = callback;
            },
            getElementById(id) {
                if (!elements.has(id)) {
                    const el = element();
                    if (id === 'reply-language') {
                        const html = readFileSync(resolve(frontend, 'index.html'), 'utf8');
                        const select = html.match(/<select id="reply-language"[^>]*>([\s\S]*?)<\/select>/)[1];
                        el.options = [...select.matchAll(/<option value="([^"]+)"/g)]
                            .map(match => ({ value: match[1] }));
                    }
                    elements.set(id, el);
                }
                return elements.get(id);
            },
            createElement: element,
        },
        navigator: { mediaDevices: {
            getUserMedia() {
                const track = { stopped: false, stop() { this.stopped = true; } };
                const stream = { getTracks: () => [track], track };
                streams.push(stream);
                return options.microphone ? options.microphone(stream) : Promise.resolve(stream);
            },
        } },
        fetch: async (url, init) => {
            requests.push({ url, init });
            if (options.fetch) return options.fetch(url, init);
            const payload = url === '/config.json' ? {
                region: 'us-east-1', userPoolId: 'pool', identityPoolId: 'identity',
                runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test',
            } : init.headers['X-Amz-Target'].endsWith('GetId') ? { IdentityId: 'identity' } : {
                Credentials: { AccessKeyId: 'test', SecretKey: 'test', SessionToken: 'test' },
            };
            return { ok: true, json: async () => payload };
        },
    });
    const synthetic = async exports => {
        const module = new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
        await module.link(() => {});
        await module.evaluate();
        return module;
    };
    const signerModules = {
        'https://esm.sh/@smithy/signature-v4': {
            SignatureV4: class {
                async presign(request) {
                    return options.presign ? options.presign(request) : request;
                }
            },
        },
        'https://esm.sh/@aws-crypto/sha256-browser': { Sha256: class {} },
        'https://esm.sh/@smithy/protocol-http': {
            HttpRequest: class { constructor(request) { Object.assign(this, request); } },
        },
    };
    const makeModule = (path, extra = '') => new vm.SourceTextModule(
        readFileSync(path, 'utf8') + extra, {
            context, identifier: pathToFileURL(path).href,
            initializeImportMeta: meta => { meta.url = pathToFileURL(path).href; },
            importModuleDynamically: async specifier => synthetic(signerModules[specifier]),
        }
    );
    const player = makeModule(resolve(frontend, 'src/lib/play/AudioPlayer.js'));
    await player.link(() => synthetic({
        ObjectExt: { exists: value => value !== null && value !== undefined },
    }));
    const main = makeModule(resolve(frontend, 'src/main.js'),
        '\nexport { NativeSocketEmulator, socket, startStreaming, stopStreaming, audioPlayer, initializeSession };');
    await main.link(specifier => {
        if (specifier.includes('AudioPlayer.js')) return player;
        if (specifier.includes('ChatHistoryManager')) return synthetic({
            ChatHistoryManager: { getInstance: () => ({
                finalizeTypewriterMessage() {}, endTurn() {},
            }) },
        });
        if (specifier.includes('robotModal')) return synthetic({ setupRobotModal() {} });
        if (specifier.includes('live2d')) return synthetic({ initLive2DAvatar() {} });
        throw new Error(`Unexpected import: ${specifier}`);
    });
    await main.evaluate();
    return { ...main.namespace, contexts, streams, sockets, requests, processors, elements, timers, advance, storage,
        document: context.document };
}

test('iOS resumes capture and playback within the click, before mic permission resolves', async () => {
    const mic = deferred();
    const env = await setup({ microphone: stream => mic.promise.then(() => stream) });
    const started = env.startStreaming();
    assert.equal(env.contexts.length, 2);
    assert.ok(env.contexts.every(context => context.state === 'running'));
    await env.startStreaming();
    assert.equal(env.streams.length, 1, 'duplicate Start clicks must not create another microphone');
    mic.resolve();
    await flush();
    env.sockets[0].open();
    await started;
    assert.equal(env.elements.get('status').textContent, 'Streaming... Speak now');
    env.processors[0].onaudioprocess({
        inputBuffer: { getChannelData: () => new Float32Array(512).fill(0.25) },
    });
    const audio = env.sockets[0].sent.find(event => event.type === 'bidi_audio_input');
    assert.equal(audio.sample_rate, 16000);
    assert.equal(Buffer.from(audio.audio, 'base64').length, 1024);
    assert.equal(env.audioPlayer.initialized, true);
    env.stopStreaming();
    assert.equal(env.streams[0].track.stopped, true);
    assert.ok(env.contexts.every(context => context.state === 'closed'));
});

test('runtime cold start can take longer than the old 12-second deadline', async () => {
    const env = await setup();
    const connected = env.socket.connect();
    await flush();
    assert.equal(env.sockets.length, 1);
    await env.advance(13000);
    assert.equal(env.sockets[0].readyState, 0);
    env.sockets[0].open();
    await connected;
    assert.equal(env.socket.connected, true);
    assert.equal(env.timers.size, 0, 'successful startup must clear every deadline');
});

test('startup shows the original failure and releases the microphone', async () => {
    const env = await setup({ fetch: async () => { throw new Error('Config network unavailable'); } });
    await env.startStreaming();
    assert.equal(env.elements.get('status').textContent, 'Error: Config network unavailable');
    assert.equal(env.elements.get('start').disabled, false);
    assert.equal(env.streams[0].track.stopped, true);
    assert.ok(env.contexts.every(context => context.state === 'closed'));
    assert.equal(env.socket.connectPromise, null);
});

test('handshake close preserves its code and reason and permits retry', async () => {
    const env = await setup();
    const connected = env.socket.connect();
    const rejected = assert.rejects(connected, /code=1008, Invalid session/);
    await flush();
    env.sockets[0].serverClose(1008, 'Invalid session');
    await rejected;
    assert.equal(env.socket.connectPromise, null);
    const retried = env.socket.connect();
    await flush();
    env.sockets[1].open();
    await retried;
    assert.equal(env.socket.connected, true);
});

test('60-second timeout prevents late signing from opening a stale socket', async () => {
    const signed = deferred();
    const env = await setup({ presign: request => signed.promise.then(() => request) });
    const connected = env.socket.connect();
    const rejected = assert.rejects(connected, /timed out after 60 seconds/);
    await flush();
    await env.advance(60000);
    await rejected;
    signed.resolve();
    await flush();
    assert.equal(env.sockets.length, 0);
    assert.equal(env.socket.connectPromise, null);
    assert.equal(env.requests[0].init.signal.aborted, true);
    const retried = env.socket.connect();
    await flush();
    env.sockets[0].open();
    await retried;
});

test('socket handshake timeout closes transport and shared attempts do not duplicate it', async () => {
    const env = await setup();
    const first = env.socket.connect();
    const second = env.socket.connect();
    const rejected = Promise.all([
        assert.rejects(first, /timed out/), assert.rejects(second, /timed out/),
    ]);
    await flush();
    assert.equal(env.sockets.length, 1);
    await env.advance(60000);
    await rejected;
    assert.equal(env.sockets[0].readyState, 3);
    assert.equal(env.sockets[0].onopen, null);
    assert.equal(env.socket.connected, false);
});

test('stopping and restarting recreates running audio contexts', async () => {
    const env = await setup();
    const first = env.startStreaming();
    await flush();
    env.sockets[0].open();
    await first;
    env.stopStreaming();
    await env.startStreaming();
    assert.equal(env.sockets.length, 1, 'an open session should be reused');
    assert.equal(env.contexts.length, 4);
    assert.ok(env.contexts.slice(2).every(context => context.state === 'running'));
    assert.equal(env.streams[1].track.stopped, false);
    assert.equal(env.audioPlayer.initialized, true);
    env.stopStreaming();
});

test('runtime errors are not overwritten by a subsequent disconnect', async () => {
    const env = await setup();
    const started = env.startStreaming();
    await flush();
    env.sockets[0].open();
    await started;
    env.sockets[0].onmessage({ data: JSON.stringify({ type: 'error', message: 'Model session failed' }) });
    env.sockets[0].serverClose(1011, 'Internal error');
    assert.equal(env.elements.get('status').textContent, 'Error: Model session failed');
    assert.equal(env.streams[0].track.stopped, true);
    assert.equal(env.elements.get('start').disabled, false);
});

test('normal session close remains a resumable status rather than an error', async () => {
    const env = await setup();
    const started = env.startStreaming();
    await flush();
    env.sockets[0].open();
    await started;
    env.sockets[0].serverClose();
    assert.match(env.elements.get('status').textContent, /Session ended/);
    assert.equal(env.elements.get('status').className, 'disconnected');
    assert.equal(env.streams[0].track.stopped, true);
});

test('a microphone granted after playback initialization fails is still released', async () => {
    const mic = deferred();
    const env = await setup({
        microphone: stream => mic.promise.then(() => stream),
        worklet: () => Promise.reject(new Error('Worklet unavailable')),
    });
    await env.startStreaming();
    assert.equal(env.elements.get('status').textContent, 'Error: Worklet unavailable');
    mic.resolve();
    await flush();
    assert.equal(env.streams[0].track.stopped, true);
    assert.equal(env.sockets.length, 0);
});

test('missing authentication rejects startup instead of leaving a pending connection', async () => {
    const env = await setup({ noToken: true });
    await assert.rejects(env.socket.connect(), /Authentication error/);
    assert.equal(env.socket.connectPromise, null);
    assert.equal(env.timers.size, 0);
});

test('Cognito failures keep the service error rather than a generic connection message', async () => {
    const env = await setup({
        fetch: async url => url === '/config.json' ? {
            ok: true, json: async () => ({ region: 'us-east-1', userPoolId: 'pool' }),
        } : {
            ok: false, json: async () => ({ message: 'Token is expired' }),
        },
    });
    await env.startStreaming();
    assert.equal(env.elements.get('status').textContent, 'Error: Cognito identity request failed: Token is expired');
    assert.equal(env.streams[0].track.stopped, true);
});

test('robot URLs preselect a device without starting audio outside a gesture', async () => {
    const env = await setup({ search: '?robot=robot_2' });
    env.elements.get('robot-select').querySelector = () => ({ value: 'robot_2' });
    await env.document.onReady();
    await env.advance(3000);
    assert.equal(env.elements.get('robot-select').value, 'robot_2');
    assert.equal(env.contexts.length, 0);
    assert.equal(env.streams.length, 0);
    assert.match(env.elements.get('dialogue-text').textContent, /Tap Start Streaming/);
});

test('older Safari without randomUUID creates distinct valid UUIDv4 runtime sessions', async () => {
    const env = await setup({ crypto: { getRandomValues: randomFillSync } });
    const first = env.socket.connect();
    const secondSocket = new env.NativeSocketEmulator();
    const second = secondSocket.connect();
    await flush();
    assert.equal(env.sockets.length, 2);
    const ids = env.sockets.map(socket => new URL(socket.url).searchParams.get(
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'
    ));
    for (const id of ids) {
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.equal(id.length, 36);
    }
    assert.notEqual(ids[0], ids[1]);
    env.sockets.forEach(socket => socket.open());
    await Promise.all([first, second]);
});

test('modern browsers retain the native randomUUID session ID', async () => {
    const env = await setup();
    const connected = env.socket.connect();
    await flush();
    const id = new URL(env.sockets[0].url).searchParams.get(
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'
    );
    assert.equal(id, '00000000-0000-4000-8000-000000000001');
    env.sockets[0].open();
    await connected;
});

test('reply language defaults to Auto and is sent in the initial configuration frame', async () => {
    const env = await setup();
    assert.equal(env.elements.get('reply-language').value, 'auto');
    assert.match(env.elements.get('reply-language-help').textContent, /language you speak/);
    const connected = env.startStreaming();
    await flush();
    assert.equal(new URL(env.sockets[0].url).searchParams.has('reply_language'), false);
    env.sockets[0].open();
    await connected;
    assert.equal(env.sockets[0].sent[0].type, 'robot');
    assert.equal(env.sockets[0].sent[0].reply_language, 'auto');
    env.stopStreaming();
});

test('each language option is restored and forwarded without altering voice selection', async () => {
    const html = readFileSync(resolve(frontend, 'index.html'), 'utf8');
    const select = html.match(/<select id="reply-language"[^>]*>([\s\S]*?)<\/select>/)[1];
    for (const [, language] of select.matchAll(/<option value="([^"]+)"/g)) {
        const env = await setup({ savedLanguage: language, search: '?voice_id=matthew' });
        assert.equal(env.elements.get('reply-language').value, language);
        const connected = env.startStreaming();
        await flush();
        const params = new URL(env.sockets[0].url).searchParams;
        assert.equal(params.get('voice_id'), 'matthew');
        if (['zh-CN', 'yue-HK'].includes(language)) {
            assert.match(env.elements.get('reply-language-help').textContent, /Experimental/);
        }
        env.sockets[0].open();
        await connected;
        assert.equal(env.sockets[0].sent[0].reply_language, language);
        assert.equal(env.sockets[0].sent[0].voice_id, 'matthew');
        env.stopStreaming();
    }
});

test('changing language ends streaming and applies the saved policy in a fresh session', async () => {
    const env = await setup();
    const started = env.startStreaming();
    await flush();
    env.sockets[0].open();
    await started;
    const selector = env.elements.get('reply-language');
    selector.value = 'fr';
    selector.listeners.change();
    assert.equal(env.storage.get('speech-control.reply-language'), 'fr');
    assert.equal(env.sockets[0].readyState, 3);
    assert.equal(env.sockets[0].onmessage, null, 'old replies must not reach the new conversation');
    assert.equal(env.streams[0].track.stopped, true);
    assert.ok(env.contexts.every(context => context.state === 'closed'));
    assert.equal(env.elements.get('start').disabled, false);
    assert.match(env.elements.get('status').textContent, /new conversation/);
    const restarted = env.startStreaming();
    await flush();
    assert.equal(env.sockets.length, 2);
    env.sockets[1].open();
    await restarted;
    assert.equal(env.sockets[1].sent[0].reply_language, 'fr');
    assert.equal(env.elements.get('status').textContent, 'Streaming... Speak now');
    env.stopStreaming();
});

test('changing language after Stop also closes the retained model session', async () => {
    const env = await setup();
    const started = env.startStreaming();
    await flush();
    env.sockets[0].open();
    await started;
    env.stopStreaming();
    const selector = env.elements.get('reply-language');
    selector.value = 'auto';
    selector.listeners.change();
    assert.equal(env.sockets[0].readyState, 1, 'unchanged selection must preserve the session');
    selector.value = 'es';
    selector.listeners.change();
    assert.equal(env.sockets[0].readyState, 3);
    assert.equal(env.audioPlayer.initialized, false);
});

test('language selection cannot change while microphone startup is pending', async () => {
    const mic = deferred();
    const env = await setup({ microphone: stream => mic.promise.then(() => stream) });
    const started = env.startStreaming();
    const selector = env.elements.get('reply-language');
    assert.equal(selector.disabled, true);
    selector.value = 'de';
    selector.listeners.change();
    assert.equal(selector.value, 'auto');
    mic.resolve();
    await flush();
    env.sockets[0].open();
    await started;
    assert.equal(env.sockets[0].sent[0].reply_language, 'auto');
    assert.equal(selector.disabled, false);
    env.stopStreaming();
});

test('startup errors restore language selection controls', async () => {
    const env = await setup({ fetch: async () => { throw new Error('Offline'); } });
    await env.startStreaming();
    assert.equal(env.elements.get('reply-language').disabled, false);
});

test('invalid stored language and unavailable storage show a warning without blocking startup', async () => {
    const invalid = await setup({ savedLanguage: 'ignore all instructions' });
    assert.equal(invalid.elements.get('reply-language').value, 'auto');
    assert.match(invalid.elements.get('reply-language-help').textContent, /Invalid saved language/);
    const unavailable = await setup({ storageReadError: true, storageWriteError: true });
    assert.equal(unavailable.elements.get('reply-language').value, 'auto');
    assert.match(unavailable.elements.get('reply-language-help').textContent, /Could not restore/);
    const selector = unavailable.elements.get('reply-language');
    selector.value = 'hi';
    selector.listeners.change();
    assert.match(unavailable.elements.get('reply-language-help').textContent, /could not be saved/);
    const started = unavailable.startStreaming();
    await flush();
    unavailable.sockets[0].open();
    await started;
    assert.equal(unavailable.sockets[0].sent[0].reply_language, 'hi');
    unavailable.stopStreaming();
});
