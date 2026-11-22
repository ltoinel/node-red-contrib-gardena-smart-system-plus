'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// Minimal fake of the Node-RED runtime API used by nodes.js.
function createFakeRED() {
    const types = {};
    const instances = {};
    const RED = {
        nodes: {
            registerType(name, ctor) { types[name] = ctor; },
            createNode(node, config) {
                Object.setPrototypeOf(node, Object.assign(Object.create(EventEmitter.prototype), Object.getPrototypeOf(node)));
                EventEmitter.call(node);
                node.id = config.id;
                node.credentials = config.credentials;
                node.statuses = [];
                node.status = (s) => node.statuses.push(s);
                node.debug = () => {};
                node.sentMessages = [];
                node.send = (m) => node.sentMessages.push(m);
                node.warnings = [];
                node.warn = (w) => node.warnings.push(w);
                node.errors = [];
                node.error = (e) => node.errors.push(e);
                instances[config.id] = node;
            },
            getNode(id) { return instances[id]; },
        },
        util: {
            evaluateNodeProperty(value, type, node, msg) {
                // Like Node-RED, an empty msg property expression is invalid.
                if (type === 'msg' && value === '') throw new Error('Invalid property expression: zero-length');
                return type === 'msg' ? value.split('.').reduce((o, k) => (o == null ? o : o[k]), msg) : value;
            },
        },
    };
    require('../nodes.js')(RED);
    return {
        create(type, config) {
            const Ctor = types[type];
            return new Ctor(config);
        },
    };
}

function sendInput(node, msg) {
    return new Promise((resolve) => {
        const sent = [];
        node.emit('input', msg, (m) => sent.push(m), (err) => resolve({ sent, err }));
    });
}

test('control nodes report missing credentials through done()', async () => {
    const runtime = createFakeRED();
    const node = runtime.create('valve_control', { id: 'n1', api: 'missing', service: 's', operation: 'PAUSE', duration: 1, durationtype: 'num' });
    const { sent, err } = await sendInput(node, { payload: 1 });
    assert.equal(sent.length, 0);
    assert.match(err.message, /Credentials/);
    assert.equal(node.statuses.at(-1).text, 'Credentials missing');
});

test('control node reads duration from msg and sends command', async () => {
    const runtime = createFakeRED();
    const creds = runtime.create('api-credentials', { id: 'c1', credentials: { application: 'a', password: 'p' } });
    const calls = [];
    creds.client.getLoginStatusAsync = async () => true;
    creds.client.sendMowerControlAsync = async (...args) => { calls.push(args); return { status: 202, data: {} }; };

    const node = runtime.create('mower_control', {
        id: 'n2', api: 'c1', service: 'svc', operation: 'START_SECONDS_TO_OVERRIDE', duration: 'payload.minutes', durationtype: 'msg',
    });
    const { sent, err } = await sendInput(node, { payload: { minutes: 42 } });
    assert.equal(err, undefined);
    assert.deepEqual(calls[0], ['svc', 'START_SECONDS_TO_OVERRIDE', 42]);
    assert.deepEqual(sent[0].payload, { status: 202, data: {} });
});

test('control node surfaces API errors through done()', async () => {
    const runtime = createFakeRED();
    const creds = runtime.create('api-credentials', { id: 'c1', credentials: { application: 'a', password: 'p' } });
    creds.client.getLoginStatusAsync = async () => true;
    creds.client.sendValveControlAsync = async () => { throw new Error('boom'); };
    const node = runtime.create('valve_control', { id: 'n3', api: 'c1', service: 's', operation: 'PAUSE', duration: 1, durationtype: 'num' });
    const { sent, err } = await sendInput(node, {});
    assert.equal(sent.length, 0);
    assert.match(err.message, /controlling valve: boom/);
});

test('service status finds the matching service', async () => {
    const runtime = createFakeRED();
    const node = runtime.create('service_status', { id: 'n4', service: 'svc-2', servicetype: 'VALVE' });
    const payload = [
        { devices: [{ services: [{ id: 'svc-1', type: 'VALVE' }] }] },
        { devices: [{ services: [{ id: 'svc-2', type: 'MOWER' }, { id: 'svc-2', type: 'VALVE', state: 'OK' }] }] },
    ];
    const { sent, err } = await sendInput(node, { payload });
    assert.equal(err, undefined);
    assert.deepEqual(sent[0].payload, { id: 'svc-2', type: 'VALVE', state: 'OK' });
});

test('service status errors on unexpected input or missing service', async () => {
    const runtime = createFakeRED();
    const node = runtime.create('service_status', { id: 'n5', service: 'x', servicetype: 'VALVE' });
    assert.match((await sendInput(node, { payload: 'nope' })).err.message, /Devices Status/);
    assert.match((await sendInput(node, { payload: [{ devices: [] }] })).err.message, /Could not find service/);
});

test('devices status node outputs locations and reports errors', async () => {
    const runtime = createFakeRED();
    const creds = runtime.create('api-credentials', { id: 'c1', credentials: { application: 'a', password: 'p' } });
    creds.client.getLoginStatusAsync = async () => false;
    let fail = false;
    creds.client.getAllDevicesStatusAsync = async () => {
        if (fail) throw new Error('down');
        return [{ id: 'loc' }];
    };
    const node = runtime.create('devices_status', { id: 'n6', api: 'c1' });
    await new Promise((r) => setImmediate(r));
    assert.equal(node.statuses.at(-1).text, 'Could not connect');

    const ok = await sendInput(node, {});
    assert.deepEqual(ok.sent[0].payload, [{ id: 'loc' }]);
    assert.equal(node.statuses.at(-1).text, 'Connected');

    fail = true;
    const ko = await sendInput(node, {});
    assert.equal(ko.sent.length, 0);
    assert.equal(ko.err.message, 'down');
    assert.equal(node.statuses.at(-1).text, 'Error getting devices');
});

test('devices status node without credentials reports through done()', async () => {
    const runtime = createFakeRED();
    const node = runtime.create('devices_status', { id: 'n7', api: 'none' });
    assert.match((await sendInput(node, {})).err.message, /Credentials/);
});

test('done() is called exactly once with the error if send() throws', async () => {
    const runtime = createFakeRED();
    const creds = runtime.create('api-credentials', { id: 'c1', credentials: { application: 'a', password: 'p' } });
    creds.client.getLoginStatusAsync = async () => true;
    creds.client.sendValveControlAsync = async () => ({ status: 202, data: {} });
    const node = runtime.create('valve_control', { id: 'n8', api: 'c1', service: 's', operation: 'PAUSE', duration: 1, durationtype: 'num' });
    const doneArgs = [];
    node.emit('input', {}, () => { throw new Error('downstream'); }, (err) => doneArgs.push(err));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(doneArgs.length, 1);
    assert.equal(doneArgs[0].message, 'downstream');
});

test('service status ignores null devices and services', async () => {
    const runtime = createFakeRED();
    const node = runtime.create('service_status', { id: 'n9', service: 's', servicetype: 'VALVE' });
    const payload = [null, { devices: [null, { services: [null, { id: 's', type: 'VALVE' }] }] }];
    const { sent, err } = await sendInput(node, { payload });
    assert.equal(err, undefined);
    assert.equal(sent[0].payload.id, 's');
});

test('invalid msg duration expression is reported without calling the API', async () => {
    const runtime = createFakeRED();
    const creds = runtime.create('api-credentials', { id: 'c1', credentials: { application: 'a', password: 'p' } });
    creds.client.getLoginStatusAsync = async () => true;
    creds.client.sendMowerControlAsync = async () => assert.fail('should not be called');
    const node = runtime.create('mower_control', { id: 'n10', api: 'c1', service: 's', operation: 'PAUSE', duration: '', durationtype: 'msg' });
    const { sent, err } = await sendInput(node, {});
    assert.equal(sent.length, 0);
    assert.match(err.message, /zero-length/);
    assert.equal(node.statuses.at(-1).text, 'Invalid duration');
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createCredentials(runtime) {
    const creds = runtime.create('api-credentials', { id: 'c1', credentials: { application: 'a', password: 'p' } });
    creds.client.getLoginStatusAsync = async () => true;
    creds.client.getLocationsAsync = async () => ({ 'loc-1': 'Home' });
    // Keep the streams in "connecting" state: no network in unit tests.
    creds.client.createWebSocketUrlAsync = () => new Promise(() => {});
    return creds;
}

test('events nodes share one stream per location and filter events', async () => {
    const runtime = createFakeRED();
    const creds = createCredentials(runtime);
    const all = runtime.create('gardena_events', { id: 'e1', api: 'c1', eventtype: '', filterid: '' });
    const mowers = runtime.create('gardena_events', { id: 'e2', api: 'c1', eventtype: 'MOWER', filterid: '' });
    const oneDevice = runtime.create('gardena_events', { id: 'e3', api: 'c1', eventtype: '', filterid: 'dev-1' });
    await flush();

    const stream = creds.acquireEventStream('loc-1');
    creds.releaseEventStream('loc-1');
    assert.equal(stream.listenerCount('event'), 3, 'one shared stream for the three nodes');

    stream.emit('event', {
        id: 'dev-1:1', type: 'MOWER',
        attributes: { activity: { value: 'OK_CUTTING' } },
        relationships: { device: { data: { id: 'dev-1', type: 'DEVICE' } } },
    }, ['activity']);
    stream.emit('event', { id: 'svc-2', type: 'SENSOR', attributes: { soilHumidity: { value: 40 } } });

    assert.equal(all.sentMessages.length, 2);
    assert.equal(mowers.sentMessages.length, 1);
    assert.equal(oneDevice.sentMessages.length, 1);
    assert.deepEqual(mowers.sentMessages[0], {
        topic: 'gardena/MOWER/dev-1:1',
        eventType: 'MOWER',
        deviceId: 'dev-1',
        changed: ['activity'],
        payload: { id: 'dev-1:1', type: 'MOWER', activity: { value: 'OK_CUTTING' } },
    });

    stream.emit('state', 'waiting', { error: new Error('lost'), delayMs: 30000 });
    assert.equal(all.statuses.at(-1).text, 'Disconnected, retry in 30s');
    assert.match(all.warnings[0], /lost/);
    stream.emit('state', 'connected', {});
    assert.equal(all.statuses.at(-1).text, 'Listening');

    for (const node of [all, mowers, oneDevice]) node.emit('close');
    assert.equal(stream.state, 'stopped', 'stream stopped when its last node closes');
    assert.equal(stream.listenerCount('event'), 0);
});

test('events node uses the configured location and reports location errors', async () => {
    const runtime = createFakeRED();
    const creds = createCredentials(runtime);
    const acquired = [];
    const original = creds.acquireEventStream;
    creds.acquireEventStream = (id) => { acquired.push(id); return original(id); };

    const node = runtime.create('gardena_events', { id: 'e4', api: 'c1', location: 'loc-9' });
    await flush();
    assert.deepEqual(acquired, ['loc-9']);
    node.emit('close');

    creds.client.getLocationsAsync = async () => { throw new Error('quota'); };
    const failing = runtime.create('gardena_events', { id: 'e5', api: 'c1' });
    await flush();
    assert.equal(failing.statuses.at(-1).text, 'Error getting locations');
    assert.match(failing.errors[0], /quota/);
});

test('events node closed before locations are known does not subscribe', async () => {
    const runtime = createFakeRED();
    const creds = createCredentials(runtime);
    const node = runtime.create('gardena_events', { id: 'e6', api: 'c1' });
    node.emit('close');
    await flush();
    const stream = creds.acquireEventStream('loc-1');
    assert.equal(stream.listenerCount('event'), 0);
    creds.emit('close');
    assert.equal(stream.state, 'stopped');
});

test('events node without credentials shows it', () => {
    const runtime = createFakeRED();
    const node = runtime.create('gardena_events', { id: 'e7', api: 'none' });
    assert.equal(node.statuses.at(-1).text, 'Credentials missing');
});

test('valve set control sends the operation without duration', async () => {
    const runtime = createFakeRED();
    const creds = createCredentials(runtime);
    const calls = [];
    creds.client.sendValveSetControlAsync = async (...args) => { calls.push(args); return { status: 202, data: {} }; };
    const node = runtime.create('valveset_control', { id: 'v1', api: 'c1', service: 'set-1', operation: 'STOP_UNTIL_NEXT_TASK' });
    const { err } = await sendInput(node, {});
    assert.equal(err, undefined);
    assert.deepEqual(calls[0], ['set-1', 'STOP_UNTIL_NEXT_TASK', undefined]);
});
