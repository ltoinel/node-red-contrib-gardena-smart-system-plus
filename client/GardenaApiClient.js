'use strict';

const AUTH_URL = 'https://api.authentication.husqvarnagroup.dev/v1/oauth2/token';
const API_BASE_URL = 'https://api.smart.gardena.dev/v2/';
const TOKEN_EXPIRY_MARGIN_MS = 30 * 1000;
const LOCATIONS_CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

const COMMAND_TYPES = {
	valve: 'VALVE_CONTROL',
	mower: 'MOWER_CONTROL',
	powerSocket: 'POWER_SOCKET_CONTROL',
};

class GardenaApiError extends Error {
	constructor(message, status, details) {
		super(message);
		this.name = 'GardenaApiError';
		this.status = status;
		this.details = details;
	}
}

class GardenaApiClient {
	/**
	 * @param {{application: string, password: string}} credentials Application key and secret
	 * @param {object} httpClient An axios-compatible client (injectable for tests)
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
		this.tokenPromise = null;

		this.locations = null;
		this.locationsFetchedAt = 0;
	}

	// ---------------------------------------------------------------- auth

	async getAccessTokenAsync() {
		if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
			return this.accessToken;
		}
		// Share a single in-flight authentication between concurrent callers.
		if (!this.tokenPromise) {
			this.tokenPromise = this.authenticateAsync().finally(() => {
				this.tokenPromise = null;
			});
		}
		return this.tokenPromise;
	}

	async authenticateAsync() {
		const params = new URLSearchParams();
		params.set('grant_type', 'client_credentials');
		params.set('client_id', this.credentials.application);
		params.set('client_secret', this.credentials.password);

		let response;
		try {
			response = await this.http.post(AUTH_URL, params);
		} catch (e) {
			throw toApiError(e, 'Could not authenticate to Gardena API. Check your application key and secret.');
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

	invalidateToken(expectedToken) {
		if (expectedToken !== undefined && this.accessToken !== expectedToken) {
			return;
		}
		this.accessToken = null;
		this.accessTokenExpiresAt = 0;
	}

	async getLoginStatusAsync() {
		try {
			await this.getAccessTokenAsync();
			return true;
		} catch (e) {
			return false;
		}
	}

	// ------------------------------------------------------------- requests

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
		} catch (e) {
			if (allowRetry && e && e.response && e.response.status === 401) {
				// Token was revoked or expired early: re-authenticate once.
				// Only drop it if no concurrent request has already renewed it.
				this.invalidateToken(token);
				return this.sendAuthenticatedRequestAsync(method, path, data, false);
			}
			throw toApiError(e, `Gardena API request ${method.toUpperCase()} ${path} failed.`);
		}
	}

	// ------------------------------------------------------------ locations

	async getLocationsAsync() {
		if (this.locations && Date.now() - this.locationsFetchedAt < LOCATIONS_CACHE_TTL_MS) {
			return this.locations;
		}
		const response = await this.sendAuthenticatedRequestAsync('get', 'locations');
		this.locations = parseLocations(response.data && response.data.data);
		this.locationsFetchedAt = Date.now();
		return this.locations;
	}

	invalidateLocations() {
		this.locations = null;
		this.locationsFetchedAt = 0;
	}

	async getLocationDevicesAsync(locationId) {
		const response = await this.sendAuthenticatedRequestAsync('get', `locations/${encodeURIComponent(locationId)}`);
		return this.deserializer.deserialize(response.data);
	}

	async getAllDevicesStatusAsync() {
		const locations = await this.getLocationsAsync();
		try {
			return await Promise.all(
				Object.keys(locations).map((locationId) => this.getLocationDevicesAsync(locationId))
			);
		} catch (e) {
			if (e.status === 404) {
				// A cached location no longer exists: refresh on next call.
				this.invalidateLocations();
			}
			throw e;
		}
	}

	// ------------------------------------------------------------- commands

	async sendValveControlAsync(serviceId, operation, durationMinutes) {
		return this.sendServiceControlAsync(serviceId, operation, durationMinutes, COMMAND_TYPES.valve);
	}

	async sendMowerControlAsync(serviceId, operation, durationMinutes) {
		return this.sendServiceControlAsync(serviceId, operation, durationMinutes, COMMAND_TYPES.mower);
	}

	async sendPowerSocketControlAsync(serviceId, operation, durationMinutes) {
		return this.sendServiceControlAsync(serviceId, operation, durationMinutes, COMMAND_TYPES.powerSocket);
	}

	async sendServiceControlAsync(serviceId, operation, durationMinutes, commandType) {
		if (!serviceId) {
			throw new GardenaApiError('Service ID was not given. Set up the node properly to run a command.');
		}
		if (!operation) {
			throw new GardenaApiError('Operation was not given. Set up the node properly to run a command.');
		}

		const attributes = { command: operation };
		const minutes = Number(durationMinutes);
		if (operation === 'START_SECONDS_TO_OVERRIDE' && !(minutes > 0)) {
			throw new GardenaApiError(`A positive duration in minutes is required for ${operation}, got "${durationMinutes}".`);
		}
		if (minutes > 0) {
			attributes.seconds = Math.max(1, Math.round(minutes * 60));
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
		// Only expose plain data: the raw axios response contains the request headers (token, api key).
		return { status: response.status, data: response.data };
	}
}

function toApiError(e, message) {
	if (e instanceof GardenaApiError) {
		return e;
	}
	const status = e && e.response ? e.response.status : undefined;
	const details = e && e.response ? e.response.data : (e && e.message);
	let fullMessage = message;
	if (status) {
		fullMessage += ` HTTP ${status}.`;
		if (status === 429) {
			fullMessage += ' Rate limit reached, reduce the request frequency.';
		}
	} else if (e && e.message) {
		fullMessage += ` ${e.message}`;
	}
	return new GardenaApiError(fullMessage, status, details);
}

function parseLocations(locationsFromGardenaApi) {
	const parsed = {};
	if (!Array.isArray(locationsFromGardenaApi)) {
		throw new GardenaApiError('Unexpected locations response from Gardena API.');
	}
	for (const location of locationsFromGardenaApi) {
		if (location.type !== 'LOCATION' || !location.id) {
			continue;
		}
		parsed[location.id] = (location.attributes && location.attributes.name) || 'Unknown location';
	}
	return parsed;
}

class JSONApiResponseDeserializer {
	deserialize(toDeserialize) {
		if (!toDeserialize || !toDeserialize.data) {
			throw new GardenaApiError('Unexpected JSON:API response from Gardena API.');
		}
		return this.resolveObject(toDeserialize.data, toDeserialize.included || [], []);
	}

	/**
	 * @param {object} objectData JSON:API resource object
	 * @param {object[]} includedObjects The "included" array of the response
	 * @param {object[]} ancestors Resources already being resolved above this one; relationships
	 *   pointing back to any of them are skipped, which prevents infinite recursion on cycles.
	 */
	resolveObject(objectData, includedObjects, ancestors) {
		const resolved = {};
		if (objectData.id) {
			resolved.id = objectData.id;
		}
		if (objectData.type) {
			resolved.type = objectData.type;
		}
		if (objectData.attributes) {
			Object.assign(resolved, objectData.attributes);
		}
		if (objectData.relationships) {
			const chain = ancestors.concat([objectData]);
			for (const [key, value] of Object.entries(objectData.relationships)) {
				if (!value || !value.data) {
					continue;
				}
				const relatedObjects = this.resolveRelatedObjects(value.data, includedObjects, chain);
				if (relatedObjects) {
					resolved[key] = relatedObjects;
				}
			}
		}
		return resolved;
	}

	resolveRelatedObjects(references, includedObjects, ancestors) {
		const resolveOne = (reference) => {
			const relatedObject = this.findRelationshipTarget(reference, includedObjects);
			if (!relatedObject || ancestors.some((ancestor) => this.objectsAreTheSame(relatedObject, ancestor))) {
				return null;
			}
			return this.resolveObject(relatedObject, includedObjects, ancestors);
		};

		if (!Array.isArray(references)) {
			return resolveOne(references);
		}
		const resolved = references.map(resolveOne).filter(Boolean);
		return resolved.length > 0 ? resolved : null;
	}

	findRelationshipTarget(reference, includedObjects) {
		if (!reference) {
			return undefined;
		}
		return includedObjects.find((includedObject) =>
			reference.id === includedObject.id && reference.type === includedObject.type
		);
	}

	objectsAreTheSame(object1, object2) {
		return Boolean(object1 && object2 && object1.id === object2.id && object1.type === object2.type);
	}
}

module.exports = { GardenaApiClient, GardenaApiError, JSONApiResponseDeserializer, COMMAND_TYPES };
