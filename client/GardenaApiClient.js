'use strict';

const AUTH_URL = 'https://api.authentication.husqvarnagroup.dev/v1/oauth2/token';
const API_BASE_URL = 'https://api.smart.gardena.dev/v2/';
const REQUEST_TIMEOUT_MS = 15 * 1000;
/** Renew the access token slightly before it really expires. */
const TOKEN_EXPIRY_MARGIN_MS = 30 * 1000;
/** Locations rarely change and count towards the API rate limit. */
const LOCATIONS_CACHE_TTL_MS = 60 * 60 * 1000;

const COMMAND_TYPES = {
    valve: 'VALVE_CONTROL',
    mower: 'MOWER_CONTROL',
    powerSocket: 'POWER_SOCKET_CONTROL',
    valveSet: 'VALVE_SET_CONTROL',
};
/** The only operation for which the Gardena API requires a duration. */
const TIMED_OPERATION = 'START_SECONDS_TO_OVERRIDE';
/** Operations that use the duration: other commands are sent without `seconds`. */
const OPERATIONS_WITH_DURATION = [TIMED_OPERATION, 'PAUSE'];

/** Error raised for any failure of the Gardena API or of a command's parameters. */
class GardenaApiError extends Error {
    /**
     * @param {string} message Human readable message
     * @param {number} [status] HTTP status, when the error comes from an HTTP response
     * @param {*} [details] Response body or low-level error message, for debugging
     */
    constructor(message, status, details) {
        super(message);
        this.name = 'GardenaApiError';
        this.status = status;
        this.details = details;
    }
}

/**
 * Client for the Gardena Smart System API v2.
 *
 * Keeps its own access token and locations cache in memory: create one instance per set of
 * credentials and share it between all the nodes using them.
 */
class GardenaApiClient {
    /**
     * @param {{application: string, password: string}} credentials Application key and secret
     * @param {object} [httpClient] axios-compatible client, injectable for tests
     */
    constructor(credentials, httpClient) {
        if (!credentials || !credentials.application || !credentials.password) {
            throw new GardenaApiError('Gardena application key and secret are required.');
        }
        this.credentials = credentials;
        this.http = httpClient || require('axios').create({ timeout: REQUEST_TIMEOUT_MS });
        this.deserializer = new JSONApiResponseDeserializer();

        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
        this.pendingAuthentication = null;

        this.locations = null;
        this.locationsFetchedAt = 0;
        this.pendingLocations = null;
    }

    // Authentication

    /** @returns {Promise<string>} A valid access token, authenticating only when needed. */
    async getAccessTokenAsync() {
        if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
            return this.accessToken;
        }
        // Concurrent callers share the same authentication request.
        if (!this.pendingAuthentication) {
            this.pendingAuthentication = this.authenticateAsync().finally(() => {
                this.pendingAuthentication = null;
            });
        }
        return this.pendingAuthentication;
    }

    async authenticateAsync() {
        const params = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.credentials.application,
            client_secret: this.credentials.password,
        });

        let response;
        try {
            response = await this.http.post(AUTH_URL, params);
        } catch (error) {
            throw toApiError(error, 'Could not authenticate to Gardena API. Check your application key and secret.');
        }

        const data = response && response.data;
        if (!data || !data.access_token) {
            throw new GardenaApiError('Authentication response did not contain an access token.', response && response.status);
        }

        const expiresInMs = (Number(data.expires_in) || 0) * 1000;
        this.accessToken = data.access_token;
        this.accessTokenExpiresAt = Date.now() + Math.max(expiresInMs - TOKEN_EXPIRY_MARGIN_MS, 0);
        return this.accessToken;
    }

    /**
     * Forgets the access token so that the next request authenticates again.
     * @param {string} [rejectedToken] Only forget the token if it is still this one, so that a
     *   token already renewed by a concurrent request is kept.
     */
    invalidateToken(rejectedToken) {
        if (rejectedToken !== undefined && this.accessToken !== rejectedToken) {
            return;
        }
        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
    }

    /** @returns {Promise<boolean>} Whether the credentials allow to authenticate. Never rejects. */
    async getLoginStatusAsync() {
        try {
            await this.getAccessTokenAsync();
            return true;
        } catch (error) {
            return false;
        }
    }

    // Requests

    /**
     * Sends a request to the Gardena API, re-authenticating once if the token is rejected.
     * @throws {GardenaApiError} On any network or HTTP error
     */
    async sendAuthenticatedRequestAsync(method, path, data, allowRetry = true) {
        const token = await this.getAccessTokenAsync();
        const requestConfig = {
            url: API_BASE_URL + path,
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Api-Key': this.credentials.application,
                'Content-Type': 'application/vnd.api+json',
            },
        };
        if (data !== undefined) {
            requestConfig.data = data;
        }

        try {
            return await this.http.request(requestConfig);
        } catch (error) {
            const tokenRejected = error && error.response && error.response.status === 401;
            if (allowRetry && tokenRejected) {
                this.invalidateToken(token);
                return this.sendAuthenticatedRequestAsync(method, path, data, false);
            }
            throw toApiError(error, `Gardena API request ${method.toUpperCase()} ${path} failed.`);
        }
    }

    // Locations and devices

    /** @returns {Promise<Object<string, string>>} Location names indexed by location ID (cached). */
    async getLocationsAsync() {
        const cacheIsFresh = this.locations && Date.now() - this.locationsFetchedAt < LOCATIONS_CACHE_TTL_MS;
        if (cacheIsFresh) {
            return this.locations;
        }
        // Concurrent callers (e.g. Events nodes starting together) share the same request.
        if (!this.pendingLocations) {
            this.pendingLocations = this.fetchLocationsAsync().finally(() => {
                this.pendingLocations = null;
            });
        }
        return this.pendingLocations;
    }

    async fetchLocationsAsync() {
        const response = await this.sendAuthenticatedRequestAsync('get', 'locations');
        this.locations = parseLocations(response.data && response.data.data);
        this.locationsFetchedAt = Date.now();
        return this.locations;
    }

    invalidateLocations() {
        this.locations = null;
        this.locationsFetchedAt = 0;
    }

    /** @returns {Promise<object>} The location with its `devices`, each with its `services`. */
    async getLocationDevicesAsync(locationId) {
        const response = await this.sendAuthenticatedRequestAsync('get', `locations/${encodeURIComponent(locationId)}`);
        return this.deserializer.deserialize(response.data);
    }

    /** @returns {Promise<object[]>} One entry per location, see {@link getLocationDevicesAsync}. */
    async getAllDevicesStatusAsync() {
        const locations = await this.getLocationsAsync();
        try {
            return await Promise.all(
                Object.keys(locations).map((locationId) => this.getLocationDevicesAsync(locationId))
            );
        } catch (error) {
            if (error.status === 404) {
                // A cached location no longer exists: fetch the list again on the next call.
                this.invalidateLocations();
            }
            throw error;
        }
    }

    // Realtime events

    /**
     * Creates a WebSocket endpoint for the realtime events of a location. The returned URL must
     * be connected to quickly: it is only valid for a short time.
     * @returns {Promise<string>} The wss:// URL
     */
    async createWebSocketUrlAsync(locationId) {
        const response = await this.sendAuthenticatedRequestAsync('post', 'websocket', {
            data: {
                id: `request-${Date.now()}`,
                type: 'WEBSOCKET',
                attributes: { locationId },
            },
        });
        const resource = response.data && response.data.data;
        const url = resource && resource.attributes && resource.attributes.url;
        if (!url) {
            throw new GardenaApiError('WebSocket creation response did not contain a URL.', response.status, response.data);
        }
        return url;
    }

    // Commands

    async sendValveControlAsync(serviceId, operation, durationMinutes) {
        return this.sendServiceControlAsync(serviceId, operation, durationMinutes, COMMAND_TYPES.valve);
    }

    async sendMowerControlAsync(serviceId, operation, durationMinutes) {
        return this.sendServiceControlAsync(serviceId, operation, durationMinutes, COMMAND_TYPES.mower);
    }

    async sendPowerSocketControlAsync(serviceId, operation, durationMinutes) {
        return this.sendServiceControlAsync(serviceId, operation, durationMinutes, COMMAND_TYPES.powerSocket);
    }

    /** Closes all the valves of an irrigation control (the only operation of a valve set). */
    async sendValveSetControlAsync(serviceId, operation) {
        return this.sendServiceControlAsync(serviceId, operation, undefined, COMMAND_TYPES.valveSet);
    }

    /**
     * @param {string} serviceId ID of the service to control
     * @param {string} operation Gardena command, e.g. START_SECONDS_TO_OVERRIDE or PAUSE
     * @param {number|string} durationMinutes Duration in minutes, required for START_SECONDS_TO_OVERRIDE
     * @param {string} commandType One of COMMAND_TYPES
     * @returns {Promise<{status: number, data: *}>} The accepted (HTTP 202) response
     * @throws {GardenaApiError} On invalid parameters or if the command is not accepted
     */
    async sendServiceControlAsync(serviceId, operation, durationMinutes, commandType) {
        if (!serviceId) {
            throw new GardenaApiError('Service ID was not given. Set up the node properly to run a command.');
        }
        if (!operation) {
            throw new GardenaApiError('Operation was not given. Set up the node properly to run a command.');
        }

        const attributes = { command: operation };
        const minutes = Number(durationMinutes);
        const validDuration = Number.isFinite(minutes) && minutes > 0;
        if (operation === TIMED_OPERATION && !validDuration) {
            throw new GardenaApiError(`A positive duration in minutes is required for ${operation}, got "${durationMinutes}".`);
        }
        if (validDuration && OPERATIONS_WITH_DURATION.includes(operation)) {
            // The API only accepts whole minutes, expressed in seconds.
            attributes.seconds = Math.max(1, Math.round(minutes)) * 60;
        }

        const response = await this.sendAuthenticatedRequestAsync('put', `command/${encodeURIComponent(serviceId)}`, {
            data: {
                id: `request-${Date.now()}`,
                type: commandType,
                attributes,
            },
        });

        if (response.status !== 202) {
            throw new GardenaApiError(`Unexpected response status ${response.status} for ${commandType}.`, response.status, response.data);
        }
        // Never expose the raw axios response: it contains the request headers (token, API key).
        return { status: response.status, data: response.data };
    }
}

/** Wraps an axios (or any) error into a GardenaApiError, without leaking the request config. */
function toApiError(error, message) {
    if (error instanceof GardenaApiError) {
        return error;
    }
    const response = error && error.response;
    const status = response ? response.status : undefined;
    const details = response ? response.data : (error && error.message);

    let fullMessage = message;
    if (status) {
        fullMessage += ` HTTP ${status}.`;
        if (status === 429) {
            fullMessage += ' Rate limit reached, reduce the request frequency.';
        }
    } else if (error && error.message) {
        fullMessage += ` ${error.message}`;
    }
    return new GardenaApiError(fullMessage, status, details);
}

/** @returns {Object<string, string>} Location names indexed by location ID. */
function parseLocations(locationsFromGardenaApi) {
    if (!Array.isArray(locationsFromGardenaApi)) {
        throw new GardenaApiError('Unexpected locations response from Gardena API.');
    }
    const locations = {};
    for (const location of locationsFromGardenaApi) {
        if (location && location.type === 'LOCATION' && location.id) {
            locations[location.id] = (location.attributes && location.attributes.name) || 'Unknown location';
        }
    }
    return locations;
}

/**
 * Turns a JSON:API document into nested plain objects: attributes are flattened onto each
 * resource and relationships are replaced by the matching resources of the `included` array.
 */
class JSONApiResponseDeserializer {
    deserialize(document) {
        if (!document || !document.data) {
            throw new GardenaApiError('Unexpected JSON:API response from Gardena API.');
        }
        return this.resolveResource(document.data, document.included || [], []);
    }

    /**
     * @param {object} resource JSON:API resource object
     * @param {object[]} included The `included` array of the document
     * @param {object[]} ancestors Resources being resolved above this one. Relationships pointing
     *   back to one of them are skipped, which prevents infinite recursion on cycles.
     */
    resolveResource(resource, included, ancestors) {
        const resolved = {};
        if (resource.id) {
            resolved.id = resource.id;
        }
        if (resource.type) {
            resolved.type = resource.type;
        }
        Object.assign(resolved, resource.attributes);

        if (resource.relationships) {
            const chain = ancestors.concat([resource]);
            for (const [name, relationship] of Object.entries(resource.relationships)) {
                if (!relationship || !relationship.data) {
                    continue;
                }
                const related = this.resolveRelationship(relationship.data, included, chain);
                if (related) {
                    resolved[name] = related;
                }
            }
        }
        return resolved;
    }

    /** @returns {object|object[]|null} The related resource(s), or null if none can be resolved. */
    resolveRelationship(linkage, included, ancestors) {
        const resolveOne = (identifier) => {
            const target = findResource(identifier, included);
            if (!target || ancestors.some((ancestor) => isSameResource(target, ancestor))) {
                return null;
            }
            return this.resolveResource(target, included, ancestors);
        };

        if (!Array.isArray(linkage)) {
            return resolveOne(linkage);
        }
        const resolved = linkage.map(resolveOne).filter(Boolean);
        return resolved.length > 0 ? resolved : null;
    }
}

function findResource(identifier, included) {
    return identifier ? included.find((resource) => isSameResource(resource, identifier)) : undefined;
}

function isSameResource(a, b) {
    return Boolean(a && b && a.id === b.id && a.type === b.type);
}

module.exports = { GardenaApiClient, GardenaApiError, JSONApiResponseDeserializer };
