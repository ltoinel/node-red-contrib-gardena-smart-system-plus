'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { GardenaEventStream } = require('../client/GardenaEventStream.js');

function createFakes({ urls = ['wss://example/1'] } = {}) {
    const sockets = [];
    const timers = [];
    let urlIndex = 0;

    class FakeWebSocket extends EventEmitter {
        constructor(url) {
            super();
            this.url = url;
            this.sent = [];
            this.pings = 0;
            this.closed = false;
            sockets.push(this);
        }
        send(data) { this.sent.push(data); }
        ping() { this.pings += 1; }
        close() { this.closed = true; }
    }

    const client = {
        async createWebSocketUrlAsync() {
            const url = urls[Math.min(urlIndex++, urls.length - 1)];
            if (url instanceof Error) throw url;
            return url;
        },
    };
    const fakeTimers = {
        setTimeout(fn, delay) {
            const timer = { fn, delay, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout(timer) { timer.cleared = true; },
    };
    return { sockets, timers, client, options: { WebSocket: FakeWebSocket, timers: fakeTimers } };
}

const MESSAGE = (body) => Buffer.from(JSON.stringify(body));
const timerWithDelay = (timers, delay) => timers.filter((t) => t.delay === delay && !t.cleared).at(-1);

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('connects, answers pings and emits resource events', async () => {
    const { sockets, client, options } = createFakes();
    const stream = new GardenaEventStream(client, 'loc-1', options);
    const states = [];
    const events = [];
    stream.on('state', (state) => states.push(state));
    stream.on('event', (event) => events.push(event));

    stream.start();
    await flush();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, 'wss://example/1');
    sockets[0].emit('open');

    sockets[0].emit('message', Buffer.from(JSON.stringify({ data: { type: 'WEBSOCKET_PING', attributes: {} } })));
    sockets[0].emit('message', Buffer.from(JSON.stringify({ id: 'svc-1', type: 'MOWER', attributes: { activity: { value: 'OK_CUTTING' } } })));
    sockets[0].emit('message', Buffer.from('not json'));
    sockets[0].emit('message', Buffer.from(JSON.stringify({ unrelated: true })));

    assert.deepEqual(states, ['connecting', 'connected']);
    assert.deepEqual(JSON.parse(sockets[0].sent[0]), { data: { type: 'WEBSOCKET_PONG', attributes: {} } });
    assert.equal(events.length, 1);
    assert.equal(events[0].id, 'svc-1');
    stream.stop();
});

test('reconnects with an exponential, then hourly, delay', async () => {
    const failures = Array.from({ length: 12 }, () => new Error('API down'));
    const { timers, client, options } = createFakes({ urls: failures });
    const stream = new GardenaEventStream(client, 'loc-1', options);
    const waits = [];
    stream.on('state', (state, details) => {
        if (state === 'waiting') waits.push(details.delayMs);
    });

    stream.start();
    for (let i = 0; i < 12; i++) {
        await flush();
        timers.at(-1).fn();
    }
    await flush();

    assert.deepEqual(waits.slice(0, 7).map((ms) => ms / 1000), [30, 60, 120, 240, 480, 900, 900]);
    assert.equal(waits[10], 60 * 60 * 1000);
    stream.stop();
});

test('reconnects with backoff when a connection closes early', async () => {
    const { sockets, timers, client, options } = createFakes({ urls: ['wss://a', 'wss://b'] });
    const stream = new GardenaEventStream(client, 'loc-1', options);
    const waits = [];
    stream.on('state', (state, details) => { if (state === 'waiting') waits.push(details); });

    stream.start();
    await flush();
    sockets[0].emit('open');
    sockets[0].emit('error', new Error('reset'));
    sockets[0].emit('close');

    assert.equal(stream.state, 'waiting');
    assert.equal(waits[0].delayMs, 30 * 1000);
    assert.match(waits[0].error.message, /reset/);
    assert.ok(timers.filter((t) => t.delay !== 30 * 1000).every((t) => t.cleared), 'connection timers cleared');
    timers.at(-1).fn();
    await flush();
    assert.equal(sockets[1].url, 'wss://b');
    stream.stop();
});

test('reconnects immediately, without error, after a long connection ends', async () => {
    const { sockets, timers, client, options } = createFakes({ urls: ['wss://a', 'wss://b'] });
    const stream = new GardenaEventStream(client, 'loc-1', options);
    stream.failedAttempts = 5;
    const waits = [];
    stream.on('state', (state, details) => { if (state === 'waiting') waits.push(details); });
    const realNow = Date.now;

    stream.start();
    await flush();
    sockets[0].emit('open');
    Date.now = () => realNow() + 40 * 60 * 1000; // connection stayed open for 40 minutes
    try {
        sockets[0].emit('close');
    } finally {
        Date.now = realNow;
    }

    assert.equal(waits[0].delayMs, 1000);
    assert.equal(waits[0].error, undefined);
    assert.equal(stream.failedAttempts, 0, 'retries start over after a stable connection');
    timers.at(-1).fn();
    await flush();
    assert.equal(sockets[1].url, 'wss://b');
    stream.stop();
});

test('sends keepalive pings every 150 seconds while connected', async () => {
    const { sockets, timers, client, options } = createFakes();
    const stream = new GardenaEventStream(client, 'loc-1', options);
    stream.start();
    await flush();
    sockets[0].emit('open');

    timerWithDelay(timers, 150 * 1000).fn();
    timerWithDelay(timers, 150 * 1000).fn();
    assert.equal(sockets[0].pings, 2);

    const pending = timers.filter((t) => t.delay === 150 * 1000).at(-1);
    stream.stop();
    assert.equal(pending.cleared, true, 'no keepalive left after stop()');
});

test('renews the connection before the 2 hours maximum lifetime', async () => {
    const { sockets, timers, client, options } = createFakes({ urls: ['wss://a', 'wss://b'] });
    const stream = new GardenaEventStream(client, 'loc-1', options);
    stream.start();
    await flush();
    sockets[0].emit('open');

    timerWithDelay(timers, 110 * 60 * 1000).fn();
    assert.equal(sockets[0].closed, true);
    await flush();
    assert.equal(sockets.length, 2);
    assert.equal(sockets[1].url, 'wss://b');
    sockets[0].emit('close'); // late close of the old socket must not schedule a reconnection
    assert.equal(stream.state, 'connecting');
    stream.stop();
});

test('merges partial updates and resets the state on reconnection', async () => {
    const { sockets, client, options } = createFakes({ urls: ['wss://a', 'wss://b'] });
    const stream = new GardenaEventStream(client, 'loc-1', options);
    const events = [];
    stream.on('event', (resource, changes) => events.push({ resource, changes }));
    stream.start();
    await flush();
    sockets[0].emit('open');

    sockets[0].emit('message', MESSAGE({
        id: 'm1', type: 'MOWER',
        attributes: { activity: { value: 'PARKED_TIMER' }, batteryLevel: { value: 80 }, lastErrorCode: { value: 'X' } },
        relationships: { device: { data: { id: 'd1', type: 'DEVICE' } } },
    }));
    sockets[0].emit('message', MESSAGE({ id: 'm1', type: 'MOWER', attributes: { activity: { value: 'OK_CUTTING' }, lastErrorCode: null } }));

    assert.deepEqual(events[1].changes, ['activity', 'lastErrorCode']);
    assert.deepEqual(events[1].resource, {
        id: 'm1', type: 'MOWER',
        attributes: { activity: { value: 'OK_CUTTING' }, batteryLevel: { value: 80 } },
        relationships: { device: { data: { id: 'd1', type: 'DEVICE' } } },
    });

    events[1].resource.attributes.batteryLevel.value = 0; // listeners cannot alter the stored state
    sockets[0].emit('message', MESSAGE({ id: 'm1', type: 'MOWER', attributes: {} }));
    assert.equal(events[2].resource.attributes.batteryLevel.value, 80);

    stream.renewConnection();
    await flush();
    sockets[1].emit('open');
    sockets[1].emit('message', MESSAGE({ id: 'm1', type: 'MOWER', attributes: { activity: { value: 'PARKED_TIMER' } } }));
    assert.deepEqual(events[3].resource.attributes, { activity: { value: 'PARKED_TIMER' } }, 'state reset on new connection');
    stream.stop();
});

test('stop() closes the socket and cancels pending reconnections', async () => {
    const { sockets, timers, client, options } = createFakes({ urls: [new Error('down'), 'wss://a'] });
    const stream = new GardenaEventStream(client, 'loc-1', options);
    stream.start();
    await flush();
    stream.stop();
    assert.equal(timers[0].cleared, true);
    assert.equal(stream.state, 'stopped');

    stream.start();
    await flush();
    await flush();
    sockets[0].emit('open');
    stream.stop();
    assert.equal(sockets[0].closed, true);
    sockets[0].emit('close'); // late close event must not schedule a reconnection
    assert.ok(timers.every((t) => t.cleared || t === timers[0]));
    assert.equal(stream.state, 'stopped');
});

test('stop() during URL creation does not open a socket', async () => {
    const { sockets, client, options } = createFakes();
    const stream = new GardenaEventStream(client, 'loc-1', options);
    stream.start();
    stream.stop();
    await flush();
    assert.equal(sockets.length, 0);
});

test('an invalid WebSocket URL schedules a reconnection instead of rejecting', async () => {
    const { timers, client, options } = createFakes();
    options.WebSocket = function() { throw new Error('Invalid URL'); };
    const stream = new GardenaEventStream(client, 'loc-1', options);
    const waits = [];
    stream.on('state', (state, details) => { if (state === 'waiting') waits.push(details); });
    stream.start();
    await flush();
    assert.equal(stream.state, 'waiting');
    assert.match(waits[0].error.message, /Invalid URL/);
    assert.equal(timers.length, 1);
    stream.stop();
});

test('stop() then start() during URL creation opens a single socket', async () => {
    let resolveFirst;
    const { sockets, client, options } = createFakes();
    const original = client.createWebSocketUrlAsync;
    let calls = 0;
    client.createWebSocketUrlAsync = () => (++calls === 1 ? new Promise((r) => { resolveFirst = r; }) : original());
    const stream = new GardenaEventStream(client, 'loc-1', options);
    stream.start();
    stream.stop();
    stream.start();
    await flush();
    resolveFirst('wss://stale');
    await flush();
    assert.deepEqual(sockets.map((s) => s.url), ['wss://example/1']);
    stream.stop();
});
