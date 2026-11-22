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
