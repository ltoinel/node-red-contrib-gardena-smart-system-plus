'use strict';

const { GardenaApiClient } = require('./client/GardenaApiClient.js');

/** Duration used when the msg property is empty, as in the original package. */
const DEFAULT_DURATION_MINUTES = 1;
const MISSING_CREDENTIALS_MESSAGE = 'Credentials are not properly set up. Cannot contact Gardena API.';
const STATUS_STYLES = {
    ok: { fill: 'green', shape: 'dot' },
    error: { fill: 'red', shape: 'ring' },
    warning: { fill: 'orange', shape: 'ring' },
};

module.exports = function(RED) {

    // Config node: one API client (and therefore one token and locations cache) per credentials.

    function ApiCredentialsNode(config) {
        RED.nodes.createNode(this, config);
        const credentials = this.credentials || {};
        this.client = (credentials.application && credentials.password)
            ? new GardenaApiClient(credentials)
            : null;
    }
    RED.nodes.registerType('api-credentials', ApiCredentialsNode, {
        credentials: {
            application: { type: 'text' },
            password: { type: 'password' }
        }
    });

    // Helpers

    function getClient(config) {
        const credentialsNode = RED.nodes.getNode(config.api);
        return credentialsNode && credentialsNode.client ? credentialsNode.client : null;
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
    RED.nodes.registerType('devices_status', GardenaDevicesStatusNode);

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
    RED.nodes.registerType('service_status', GardenaServiceStatusNode);

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

    registerControlNode('valve_control', 'sendValveControlAsync', 'valve');
    registerControlNode('mower_control', 'sendMowerControlAsync', 'mower');
    registerControlNode('powersocket_control', 'sendPowerSocketControlAsync', 'power socket');
};
