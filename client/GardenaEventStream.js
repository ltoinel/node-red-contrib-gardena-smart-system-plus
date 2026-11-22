'use strict';

const { EventEmitter } = require('node:events');

/*
 * Reconnection delays. Every connection costs one POST /websocket request, and the Gardena API
 * quota is 700 requests per week: retry quickly a few times, then once per hour.
 */
const FAST_RETRY_BASE_MS = 30 * 1000;
const FAST_RETRY_MAX_MS = 15 * 60 * 1000;
const FAST_RETRY_ATTEMPTS = 10;
const SLOW_RETRY_MS = 60 * 60 * 1000;
/*
 * A connection that stayed open this long ended normally (the API closes every connection after
 * at most 2 hours): reconnect right away and start retries over. Shorter connections count as
 * failures, so that a server closing connections early cannot exhaust the quota.
 */
const STABLE_CONNECTION_MS = 30 * 60 * 1000;
const IMMEDIATE_RECONNECT_MS = 1000;
/** The API closes connections idle for about 10 minutes; its documentation recommends 150s pings. */
const KEEPALIVE_INTERVAL_MS = 150 * 1000;
/** The API closes connections after about 2 hours: reconnect a little before. */
const MAX_CONNECTION_MS = 110 * 60 * 1000;

const PING_TYPE = 'WEBSOCKET_PING';
const PONG_MESSAGE = JSON.stringify({ data: { type: 'WEBSOCKET_PONG', attributes: {} } });

/**
 * Realtime events of one Gardena location, received through the API WebSocket.
 *
 * The API sends partial updates (JSON:API PATCH semantics: only the changed attributes, `null`
 * meaning removed). The stream keeps the state of every resource since the connection opened and
 * emits the complete, merged resource.
 *
 * Events:
 * - `event` (resource, changes): the merged JSON:API resource (service, device or location) whose
 *   state changed, and the names of the attributes present in the update. Right after connecting,
 *   the API sends the current state of every resource.
 * - `state` (state, details): `connecting`, `connected` or `waiting` (before a reconnection,
 *   details contains `error` and `delayMs`).
 */
class GardenaEventStream extends EventEmitter {
    /**
     * @param {import('./GardenaApiClient').GardenaApiClient} client Authenticated API client
     * @param {string} locationId Location to receive the events of
     * @param {object} [options] Injectable dependencies, for tests
     */
    constructor(client, locationId, options = {}) {
        super();
        this.setMaxListeners(0); // One listener per Events node, no meaningful limit.
        this.client = client;
        this.locationId = locationId;
        this.WebSocket = options.WebSocket || require('ws');
        this.timers = options.timers || { setTimeout, clearTimeout };

        this.state = 'stopped';
        this.socket = null;
        this.retryTimer = null;
        this.keepaliveTimer = null;
        this.lifetimeTimer = null;
        this.failedAttempts = 0;
        this.connectedAt = 0;
        this.resources = new Map(); // "type/id" -> merged resource
    }

    start() {
        if (this.state === 'stopped') {
            this.connect();
        }
    }

    stop() {
        this.setState('stopped');
        if (this.retryTimer) {
            this.timers.clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.closeSocket();
    }

    /** Closes the current socket, if any, without triggering a reconnection. */
    closeSocket() {
        this.clearConnectionTimers();
        if (this.socket) {
            const socket = this.socket;
            this.socket = null;
            socket.removeAllListeners();
            socket.on('error', () => {}); // Closing a socket that is still connecting may emit one.
            socket.close();
        }
    }

    clearConnectionTimers() {
        for (const name of ['keepaliveTimer', 'lifetimeTimer']) {
            if (this[name]) {
                this.timers.clearTimeout(this[name]);
                this[name] = null;
            }
        }
    }

    async connect() {
        this.setState('connecting');
        let url;
        try {
            url = await this.client.createWebSocketUrlAsync(this.locationId);
        } catch (error) {
            this.scheduleReconnect(error);
            return;
        }
        if (this.state === 'stopped') {
            return;
        }

        const socket = new this.WebSocket(url);
        let lastError;
        this.socket = socket;
        socket.on('open', () => {
            this.connectedAt = Date.now();
            // The API sends the full state on each connection: forget the previous one.
            this.resources.clear();
            this.scheduleKeepalive(socket);
            this.lifetimeTimer = this.timers.setTimeout(() => this.renewConnection(), MAX_CONNECTION_MS);
            this.setState('connected');
        });
        socket.on('message', (raw) => this.handleMessage(socket, raw));
        socket.on('error', (error) => {
            lastError = error; // Always followed by 'close', which reconnects.
        });
        socket.on('close', () => {
            if (this.socket !== socket) {
                return;
            }
            this.socket = null;
            this.clearConnectionTimers();
            const stable = this.connectedAt && Date.now() - this.connectedAt >= STABLE_CONNECTION_MS;
            this.connectedAt = 0;
            if (stable) {
                // Normal end of a connection: no error to report unless the socket reported one.
                this.failedAttempts = 0;
                this.scheduleReconnect(lastError, IMMEDIATE_RECONNECT_MS);
            } else {
                this.scheduleReconnect(lastError || new Error('WebSocket connection closed.'));
            }
        });
    }

    /** Sends a WebSocket ping every 150s so that the API does not close an idle connection. */
    scheduleKeepalive(socket) {
        this.keepaliveTimer = this.timers.setTimeout(() => {
            this.keepaliveTimer = null;
            if (this.socket === socket) {
                try {
                    socket.ping();
                } catch (error) {
                    // The socket is closing: its 'close' event handles the reconnection.
                }
                this.scheduleKeepalive(socket);
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    /** Replaces the connection before the API closes it because of its maximum lifetime. */
    renewConnection() {
        this.lifetimeTimer = null;
        if (this.state !== 'connected') {
            return;
        }
        this.closeSocket();
        this.connectedAt = 0;
        this.failedAttempts = 0;
        this.connect();
    }

    handleMessage(socket, raw) {
        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch (error) {
            return; // Not JSON: nothing we can use.
        }
        if (message && message.data && message.data.type === PING_TYPE) {
            socket.send(PONG_MESSAGE);
            return;
        }
        if (message && message.id && message.type) {
            const changes = Object.keys(message.attributes || {});
            // A copy, so that listeners cannot alter the stored state.
            this.emit('event', structuredClone(this.mergeResource(message)), changes);
        }
    }

    /** Applies a partial update to the stored state of the resource. @returns {object} The merged resource. */
    mergeResource(update) {
        const key = `${update.type}/${update.id}`;
        const merged = this.resources.get(key) || { id: update.id, type: update.type };
        for (const section of ['attributes', 'relationships']) {
            if (update[section]) {
                merged[section] = applyPatch(merged[section] || {}, update[section]);
            }
        }
        this.resources.set(key, merged);
        return merged;
    }

    scheduleReconnect(error, delayOverrideMs) {
        if (this.state === 'stopped') {
            return;
        }
        let delayMs = delayOverrideMs;
        if (delayMs === undefined) {
            this.failedAttempts += 1;
            delayMs = this.failedAttempts <= FAST_RETRY_ATTEMPTS
                ? Math.min(FAST_RETRY_MAX_MS, FAST_RETRY_BASE_MS * 2 ** (this.failedAttempts - 1))
                : SLOW_RETRY_MS;
        }
        this.setState('waiting', { error, delayMs });
        this.retryTimer = this.timers.setTimeout(() => {
            this.retryTimer = null;
            this.connect();
        }, delayMs);
    }

    setState(state, details) {
        this.state = state;
        this.emit('state', state, details || {});
    }
}

/** JSON:API PATCH: the given members replace the existing ones, `null` removes them. */
function applyPatch(target, patch) {
    const result = Object.assign({}, target);
    for (const [name, value] of Object.entries(patch)) {
        if (value === null) {
            delete result[name];
        } else {
            result[name] = value;
        }
    }
    return result;
}

module.exports = { GardenaEventStream };
