'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GardenaApiClient, GardenaApiError } = require('../client/GardenaApiClient.js');

const CREDENTIALS = { application: 'app-key', password: 'app-secret' };

function httpError(status, data) {
    const e = new Error(`Request failed with status code ${status}`);
    e.response = { status, data };
    return e;
}

function fakeHttp({ tokenResponses = [], requestHandler } = {}) {
    const calls = { post: [], request: [] };
    let tokenIndex = 0;
    return {
        calls,
        async post(url, params) {
            calls.post.push({ url, params: Object.fromEntries(params) });
            const r = tokenResponses[Math.min(tokenIndex++, tokenResponses.length - 1)];
            if (r instanceof Error) throw r;
            return r || { status: 200, data: { access_token: `token-${tokenIndex}`, expires_in: 3600 } };
        },
        async request(config) {
            calls.request.push(config);
            return requestHandler(config, calls.request.length);
        },
    };
}

const LOCATION_RESPONSE = {
    status: 200,
    data: {
        data: {
            id: 'loc-1', type: 'LOCATION', attributes: { name: 'Home' },
            relationships: { devices: { data: [{ id: 'dev-1', type: 'DEVICE' }] } },
        },
        included: [
            {
                id: 'dev-1', type: 'DEVICE',
                relationships: {
                    location: { data: { id: 'loc-1', type: 'LOCATION' } },
                    services: { data: [{ id: 'svc-1', type: 'VALVE' }] },
                },
            },
            { id: 'svc-1', type: 'VALVE', attributes: { name: { value: 'Valve 1' } } },
        ],
    },
};

test('rejects missing credentials', () => {
    assert.throws(() => new GardenaApiClient({ application: 'x' }), GardenaApiError);
});

test('authenticates once for concurrent callers and caches the token', async () => {
    const http = fakeHttp();
    const client = new GardenaApiClient(CREDENTIALS, http);
    const [a, b] = await Promise.all([client.getAccessTokenAsync(), client.getAccessTokenAsync()]);
    assert.equal(a, 'token-1');
    assert.equal(b, 'token-1');
    assert.equal(await client.getAccessTokenAsync(), 'token-1');
    assert.equal(http.calls.post.length, 1);
    assert.deepEqual(http.calls.post[0].params, {
        grant_type: 'client_credentials', client_id: 'app-key', client_secret: 'app-secret',
    });
});

test('re-authenticates when the token is expired', async () => {
    const http = fakeHttp({ tokenResponses: [
        { status: 200, data: { access_token: 'short', expires_in: 1 } },
        { status: 200, data: { access_token: 'fresh', expires_in: 3600 } },
    ] });
    const client = new GardenaApiClient(CREDENTIALS, http);
    assert.equal(await client.getAccessTokenAsync(), 'short');
    assert.equal(await client.getAccessTokenAsync(), 'fresh');
});

test('login status is false on authentication failure', async () => {
    const http = fakeHttp({ tokenResponses: [httpError(400, { error: 'invalid_client' })] });
    const client = new GardenaApiClient(CREDENTIALS, http);
    assert.equal(await client.getLoginStatusAsync(), false);
});

test('retries once with a new token on 401', async () => {
    const http = fakeHttp({
        requestHandler: (config, n) => {
            if (n === 1) throw httpError(401);
            return { status: 202, data: {} };
        },
    });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await client.sendValveControlAsync('svc-1', 'STOP_UNTIL_NEXT_TASK', 1);
    assert.equal(http.calls.post.length, 2);
    assert.equal(http.calls.request[1].headers.Authorization, 'Bearer token-2');
});

test('propagates non-401 errors with status instead of returning null', async () => {
    const http = fakeHttp({ requestHandler: () => { throw httpError(429, { errors: [] }); } });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await assert.rejects(client.getAllDevicesStatusAsync(), (e) => {
        assert.ok(e instanceof GardenaApiError);
        assert.equal(e.status, 429);
        assert.match(e.message, /Rate limit/);
        return true;
    });
});

test('fetches locations (cached) and deserializes devices', async () => {
    const http = fakeHttp({
        requestHandler: (config) => {
            if (config.url.endsWith('/locations')) {
                return { status: 200, data: { data: [{ id: 'loc-1', type: 'LOCATION', attributes: { name: 'Home' } }] } };
            }
            return LOCATION_RESPONSE;
        },
    });
    const client = new GardenaApiClient(CREDENTIALS, http);
    const result = await client.getAllDevicesStatusAsync();
    await client.getAllDevicesStatusAsync();

    const locationCalls = http.calls.request.filter((c) => c.url.endsWith('/locations'));
    assert.equal(locationCalls.length, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Home');
    assert.equal(result[0].devices[0].id, 'dev-1');
    assert.equal(result[0].devices[0].services[0].id, 'svc-1');
    assert.equal(result[0].devices[0].location, undefined, 'back-reference to parent is not expanded');
});

test('sends control command and returns only plain data', async () => {
    const http = fakeHttp({ requestHandler: () => ({ status: 202, data: { ok: true }, config: { headers: { Authorization: 'secret' } } }) });
    const client = new GardenaApiClient(CREDENTIALS, http);
    const result = await client.sendMowerControlAsync('svc/1', 'START_SECONDS_TO_OVERRIDE', '5');
    assert.deepEqual(result, { status: 202, data: { ok: true } });

    const req = http.calls.request[0];
    assert.equal(req.method, 'put');
    assert.equal(req.url, 'https://api.smart.gardena.dev/v2/command/svc%2F1');
    assert.equal(req.headers['X-Api-Key'], 'app-key');
    assert.equal(req.data.data.type, 'MOWER_CONTROL');
    assert.deepEqual(req.data.data.attributes, { command: 'START_SECONDS_TO_OVERRIDE', seconds: 300 });
});

test('validates command parameters before calling the API', async () => {
    const http = fakeHttp({ requestHandler: () => assert.fail('should not be called') });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await assert.rejects(client.sendValveControlAsync('', 'PAUSE', 1), /Service ID/);
    await assert.rejects(client.sendValveControlAsync('svc', 'START_SECONDS_TO_OVERRIDE', 'abc'), /positive duration/);
    await assert.rejects(client.sendValveControlAsync('svc', 'START_SECONDS_TO_OVERRIDE', 0), /positive duration/);
});

test('rejects unexpected command status', async () => {
    const http = fakeHttp({ requestHandler: () => ({ status: 200, data: {} }) });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await assert.rejects(client.sendPowerSocketControlAsync('svc', 'START_OVERRIDE', 1), /Unexpected response status 200/);
});

test('deserializer does not recurse forever on relationship cycles', () => {
    const { JSONApiResponseDeserializer } = require('../client/GardenaApiClient.js');
    const ref = (id) => ({ data: { id, type: 'T' } });
    const result = new JSONApiResponseDeserializer().deserialize({
        data: { id: 'a', type: 'T', relationships: { next: ref('b') } },
        included: [
            { id: 'b', type: 'T', relationships: { next: ref('c') } },
            { id: 'c', type: 'T', relationships: { next: ref('a'), missing: ref('zz'), empty: { data: null } } },
        ],
    });
    assert.equal(result.next.id, 'b');
    assert.equal(result.next.next.id, 'c');
    assert.equal(result.next.next.next, undefined);
    assert.equal(result.next.next.missing, undefined);
});

test('deserializer rejects malformed responses', () => {
    const { JSONApiResponseDeserializer } = require('../client/GardenaApiClient.js');
    assert.throws(() => new JSONApiResponseDeserializer().deserialize({}), GardenaApiError);
});

test('a stale 401 does not discard a token renewed by a concurrent request', async () => {
    const http = fakeHttp();
    const client = new GardenaApiClient(CREDENTIALS, http);
    await client.getAccessTokenAsync();
    client.accessToken = 'renewed-by-someone-else';
    client.invalidateToken('token-1');
    assert.equal(client.accessToken, 'renewed-by-someone-else');
    client.invalidateToken();
    assert.equal(client.accessToken, null);
});

test('network errors are wrapped with their message and no status', async () => {
    const http = fakeHttp({ requestHandler: () => { throw new Error('timeout of 15000ms exceeded'); } });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await assert.rejects(client.getLocationsAsync(), (e) => {
        assert.ok(e instanceof GardenaApiError);
        assert.equal(e.status, undefined);
        assert.match(e.message, /timeout/);
        return true;
    });
});

test('authentication response without token is rejected', async () => {
    const http = fakeHttp({ tokenResponses: [{ status: 200, data: {} }] });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await assert.rejects(client.getAccessTokenAsync(), /did not contain an access token/);
});

test('a 404 on a location invalidates the locations cache', async () => {
    const http = fakeHttp({
        requestHandler: (config) => {
            if (config.url.endsWith('/locations')) {
                return { status: 200, data: { data: [{ id: 'gone', type: 'LOCATION' }] } };
            }
            throw httpError(404);
        },
    });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await assert.rejects(client.getAllDevicesStatusAsync(), (e) => e.status === 404);
    assert.equal(client.locations, null);
});

test('durations are sent as whole minutes, as required by the API', async () => {
    const http = fakeHttp({ requestHandler: () => ({ status: 202, data: {} }) });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await client.sendValveControlAsync('svc', 'START_SECONDS_TO_OVERRIDE', 0.001);
    await client.sendValveControlAsync('svc', 'START_SECONDS_TO_OVERRIDE', '2.6');
    assert.equal(http.calls.request[0].data.data.attributes.seconds, 60);
    assert.equal(http.calls.request[1].data.data.attributes.seconds, 180);
});

test('valve set control sends the command without duration', async () => {
    const http = fakeHttp({ requestHandler: () => ({ status: 202, data: {} }) });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await client.sendValveSetControlAsync('set-1', 'STOP_UNTIL_NEXT_TASK');
    assert.deepEqual(http.calls.request[0].data.data.type, 'VALVE_SET_CONTROL');
    assert.deepEqual(http.calls.request[0].data.data.attributes, { command: 'STOP_UNTIL_NEXT_TASK' });
});

test('creates a WebSocket URL for a location', async () => {
    const http = fakeHttp({
        requestHandler: () => ({ status: 201, data: { data: { id: 'ws', type: 'WEBSOCKET', attributes: { url: 'wss://example/ws', validity: 30 } } } }),
    });
    const client = new GardenaApiClient(CREDENTIALS, http);
    assert.equal(await client.createWebSocketUrlAsync('loc-1'), 'wss://example/ws');
    const req = http.calls.request[0];
    assert.equal(req.method, 'post');
    assert.equal(req.url, 'https://api.smart.gardena.dev/v2/websocket');
    assert.deepEqual(req.data.data.attributes, { locationId: 'loc-1' });
    assert.equal(req.data.data.type, 'WEBSOCKET');
});

test('rejects a WebSocket creation response without URL', async () => {
    const http = fakeHttp({ requestHandler: () => ({ status: 201, data: { data: {} } }) });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await assert.rejects(client.createWebSocketUrlAsync('loc-1'), /did not contain a URL/);
});

test('concurrent location requests share one API call', async () => {
    const http = fakeHttp({ requestHandler: () => ({ status: 200, data: { data: [null, { id: 'loc-1', type: 'LOCATION', attributes: { name: 'Home' } }] } }) });
    const client = new GardenaApiClient(CREDENTIALS, http);
    const [a, b] = await Promise.all([client.getLocationsAsync(), client.getLocationsAsync()]);
    assert.deepEqual(a, { 'loc-1': 'Home' });
    assert.equal(a, b);
    assert.equal(http.calls.request.length, 1);
});

test('duration is only sent with the operations that use it, and must be finite', async () => {
    const http = fakeHttp({ requestHandler: () => ({ status: 202, data: {} }) });
    const client = new GardenaApiClient(CREDENTIALS, http);
    await client.sendValveControlAsync('svc', 'STOP_UNTIL_NEXT_TASK', 1);
    await client.sendPowerSocketControlAsync('svc', 'PAUSE', 30);
    assert.deepEqual(http.calls.request[0].data.data.attributes, { command: 'STOP_UNTIL_NEXT_TASK' });
    assert.deepEqual(http.calls.request[1].data.data.attributes, { command: 'PAUSE', seconds: 1800 });
    await assert.rejects(client.sendValveControlAsync('svc', 'START_SECONDS_TO_OVERRIDE', 'Infinity'), /positive duration/);
});
