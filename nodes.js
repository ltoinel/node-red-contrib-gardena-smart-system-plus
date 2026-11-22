'use strict';

const { GardenaApiClient, JSONApiResponseDeserializer } = require('./client/GardenaApiClient.js');
const { GardenaEventStream } = require('./client/GardenaEventStream.js');

/** Duration used when the msg property is empty, as in the original package. */
const DEFAULT_DURATION_MINUTES = 1;
const MISSING_CREDENTIALS_MESSAGE = 'Credentials are not properly set up. Cannot contact Gardena API.';
const STATUS_STYLES = {
    ok: { fill: 'green', shape: 'dot' },
    error: { fill: 'red', shape: 'ring' },
    warning: { fill: 'orange', shape: 'ring' },
};

module.exports = function(RED) {

    /*
     * Config node: one API client (and therefore one token and locations cache) per credentials,
     * and one event stream per location, shared by all the Events nodes to save API quota.
     */
    function ApiCredentialsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const credentials = node.credentials || {};
        node.client = (credentials.application && credentials.password)
            ? new GardenaApiClient(credentials)
            : null;

        const streams = new Map(); // locationId -> { stream, users }

        /** @returns {GardenaEventStream} The started stream of the location; call releaseEventStream() when done. */
        node.acquireEventStream = function(locationId) {
            let entry = streams.get(locationId);
            if (!entry) {
                entry = { stream: new GardenaEventStream(node.client, locationId), users: 0 };
                streams.set(locationId, entry);
                entry.stream.start();
            }
            entry.users += 1;
            return entry.stream;
        };

        node.releaseEventStream = function(locationId) {
            const entry = streams.get(locationId);
            if (entry && --entry.users === 0) {
                entry.stream.stop();
                streams.delete(locationId);
            }
        };

        node.on('close', function() {
            streams.forEach((entry) => entry.stream.stop());
            streams.clear();
        });
    }
    RED.nodes.registerType('gardena-plus-credentials', ApiCredentialsNode, {
        credentials: {
            application: { type: 'text' },
            password: { type: 'password' }
        }
    });

    // Helpers

    /** @returns {object|null} The credentials config node, if it holds valid credentials. */
    function getCredentialsNode(config) {
        const credentialsNode = RED.nodes.getNode(config.api);
        return credentialsNode && credentialsNode.client ? credentialsNode : null;
    }

    function getClient(config) {
        const credentialsNode = getCredentialsNode(config);
        return credentialsNode ? credentialsNode.client : null;
    }

    function setStatus(node, kind, text) {
        // Counts status changes, see refreshConnectionStatus().
        node.gardenaStatusSeq = (node.gardenaStatusSeq || 0) + 1;
        node.status(Object.assign({ text }, STATUS_STYLES[kind]));
    }

    /** Shows whether the node can authenticate. Called once, when the node starts. */
    function refreshConnectionStatus(node, client) {
        if (!client) {
            setStatus(node, 'error', 'Credentials missing');
            return;
        }
        const seqBeforeCheck = node.gardenaStatusSeq || 0;
        client.getLoginStatusAsync().then(function(connected) {
            // Do not overwrite a status set by a message processed in the meantime.
            if ((node.gardenaStatusSeq || 0) === seqBeforeCheck) {
                setStatus(node, connected ? 'ok' : 'error', connected ? 'Connected' : 'Could not connect');
            }
        });
    }

    function failWithMissingCredentials(node, done) {
        setStatus(node, 'error', 'Credentials missing');
        done(new Error(MISSING_CREDENTIALS_MESSAGE));
    }

    function toError(error) {
        return error instanceof Error ? error : new Error(String(error));
    }

    /** Reports the error through done() so that it can be handled by a catch node. */
    function reportError(node, done, error, statusText) {
        setStatus(node, 'warning', statusText || 'Request error');
        if (error && error.details) {
            node.debug(JSON.stringify(error.details));
        }
        done(toError(error));
    }

    /**
     * Calls done() exactly once, even if send() throws: with then(ok).catch(err) done() would be
     * called twice, and with then(ok, err) the exception would become an unhandled rejection.
     */
    function sendAndDone(send, done, msg) {
        try {
            send(msg);
        } catch (error) {
            done(toError(error));
            return;
        }
        done();
    }

    /** @returns {number|string} Duration in minutes, from the node config or from the message. */
    function getDurationMinutes(node, config, msg) {
        if (config.durationtype !== 'msg') {
            return config.duration;
        }
        const value = RED.util.evaluateNodeProperty(config.duration, 'msg', node, msg);
        return value === undefined || value === null || value === '' ? DEFAULT_DURATION_MINUTES : value;
    }

    /** @returns {object|undefined} The first service matching id and type in the Devices Status output. */
    function findService(locations, serviceId, serviceType) {
        for (const location of locations) {
            const devices = location && Array.isArray(location.devices) ? location.devices : [];
            for (const device of devices) {
                const services = device && Array.isArray(device.services) ? device.services : [];
                const service = services.find((candidate) =>
                    candidate && candidate.id === serviceId && candidate.type === serviceType
                );
                if (service) {
                    return service;
                }
            }
        }
        return undefined;
    }

    // Devices status: outputs all locations with their devices and services.

    function GardenaDevicesStatusNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const client = getClient(config);
        refreshConnectionStatus(node, client);

        node.on('input', function(msg, send, done) {
            if (!client) {
                failWithMissingCredentials(node, done);
                return;
            }
            client.getAllDevicesStatusAsync().then(
                function(locations) {
                    setStatus(node, 'ok', 'Connected');
                    msg.payload = locations;
                    sendAndDone(send, done, msg);
                },
                function(error) {
                    reportError(node, done, error, 'Error getting devices');
                }
            );
        });
    }
    RED.nodes.registerType('gardena-plus-devices-status', GardenaDevicesStatusNode);

    // Service status: extracts one service from the Devices Status output, without calling the API.

    function GardenaServiceStatusNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.on('input', function(msg, send, done) {
            if (!Array.isArray(msg.payload)) {
                done(new Error('Input payload does not come from the Gardena Devices Status node. Cannot find service data.'));
                return;
            }
            const service = findService(msg.payload, config.service, config.servicetype);
            if (!service) {
                done(new Error(`Could not find service ${config.service} (${config.servicetype}) in node input data.`));
                return;
            }
            msg.payload = service;
            send(msg);
            done();
        });
    }
    RED.nodes.registerType('gardena-plus-service-status', GardenaServiceStatusNode);

    // Control nodes: send the configured command to a valve, mower or power socket.

    function registerControlNode(typeName, clientMethod, deviceLabel) {
        function GardenaControlNode(config) {
            RED.nodes.createNode(this, config);
            const node = this;
            const client = getClient(config);
            refreshConnectionStatus(node, client);

            node.on('input', function(msg, send, done) {
                if (!client) {
                    failWithMissingCredentials(node, done);
                    return;
                }
                let durationMinutes;
                try {
                    durationMinutes = getDurationMinutes(node, config, msg);
                } catch (error) {
                    reportError(node, done, error, 'Invalid duration');
                    return;
                }
                client[clientMethod](config.service, config.operation, durationMinutes).then(
                    function(response) {
                        setStatus(node, 'ok', 'Command sent');
                        msg.payload = response;
                        sendAndDone(send, done, msg);
                    },
                    function(error) {
                        const wrapped = toError(error);
                        wrapped.message = `Error when controlling ${deviceLabel}: ${wrapped.message}`;
                        reportError(node, done, wrapped);
                    }
                );
            });
        }
        RED.nodes.registerType(typeName, GardenaControlNode);
    }

    registerControlNode('gardena-plus-valve-control', 'sendValveControlAsync', 'valve');
    registerControlNode('gardena-plus-valveset-control', 'sendValveSetControlAsync', 'valve set');
    registerControlNode('gardena-plus-mower-control', 'sendMowerControlAsync', 'mower');
    registerControlNode('gardena-plus-powersocket-control', 'sendPowerSocketControlAsync', 'power socket');

    // Events: outputs realtime state changes received through the Gardena WebSocket.

    const deserializer = new JSONApiResponseDeserializer();

    function getDeviceId(resource) {
        if (resource.type === 'DEVICE') {
            return resource.id;
        }
        const device = resource.relationships && resource.relationships.device;
        return device && device.data ? device.data.id : undefined;
    }

    function eventToMessage(resource, changes) {
        return {
            topic: `gardena/${resource.type}/${resource.id}`,
            eventType: resource.type,
            deviceId: getDeviceId(resource),
            // Names of the attributes present in this update (the API sends partial updates).
            changed: changes || [],
            // Complete merged state, same shape as the services output by the Devices Status node.
            payload: deserializer.resolveResource(resource, [], []),
        };
    }

    function matchesFilter(config, resource) {
        if (config.eventtype && resource.type !== config.eventtype) {
            return false;
        }
        return !config.filterid || resource.id === config.filterid || getDeviceId(resource) === config.filterid;
    }

    function showStreamState(node, state, details) {
        if (state === 'connected') {
            setStatus(node, 'ok', 'Listening');
        } else if (state === 'connecting') {
            setStatus(node, 'warning', 'Connecting');
        } else if (state === 'waiting') {
            setStatus(node, 'error', `Disconnected, retry in ${Math.round(details.delayMs / 1000)}s`);
            if (details.error) {
                node.warn(`Gardena realtime connection lost: ${details.error.message}`);
            }
        }
    }

    function GardenaEventsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const credentialsNode = getCredentialsNode(config);
        const subscriptions = [];
        let closed = false;

        if (!credentialsNode) {
            setStatus(node, 'error', 'Credentials missing');
            return;
        }

        function subscribe(locationId) {
            const stream = credentialsNode.acquireEventStream(locationId);
            const onEvent = function(resource, changes) {
                if (matchesFilter(config, resource)) {
                    node.send(eventToMessage(resource, changes));
                }
            };
            const onState = function(state, details) {
                showStreamState(node, state, details);
            };
            stream.on('event', onEvent);
            stream.on('state', onState);
            subscriptions.push({ locationId, stream, onEvent, onState });
            if (stream.state !== 'stopped') {
                showStreamState(node, stream.state, {});
            }
        }

        const locationIds = config.location
            ? Promise.resolve([config.location])
            : credentialsNode.client.getLocationsAsync().then(Object.keys);

        setStatus(node, 'warning', 'Connecting');
        locationIds.then(
            function(ids) {
                if (!closed) {
                    ids.forEach(subscribe);
                }
            },
            function(error) {
                setStatus(node, 'error', 'Error getting locations');
                node.error(`Cannot start Gardena realtime events: ${error.message}`);
            }
        );

        node.on('close', function() {
            closed = true;
            for (const { locationId, stream, onEvent, onState } of subscriptions) {
                stream.off('event', onEvent);
                stream.off('state', onState);
                credentialsNode.releaseEventStream(locationId);
            }
            subscriptions.length = 0;
        });
    }
    RED.nodes.registerType('gardena-plus-events', GardenaEventsNode);
};
