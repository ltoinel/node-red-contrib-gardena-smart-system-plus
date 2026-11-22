'use strict';

const { GardenaApiClient } = require('./client/GardenaApiClient.js');

module.exports = function(RED) {

    // ------------------------------------------------------------ config node

    function ApiCredentialsNode(n) {
        RED.nodes.createNode(this, n);
        const credentials = this.credentials || {};
        // One client (and therefore one token / locations cache) per credentials config.
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

    // ---------------------------------------------------------------- helpers

    function getClient(node, config) {
        const apiNode = RED.nodes.getNode(config.api);
        return apiNode && apiNode.client ? apiNode.client : null;
    }

    function setStatus(node, kind, text) {
        const styles = {
            ok: { fill: 'green', shape: 'dot' },
            error: { fill: 'red', shape: 'ring' },
            warning: { fill: 'orange', shape: 'ring' },
        };
        node.gardenaStatusSeq = (node.gardenaStatusSeq || 0) + 1;
        node.status(Object.assign({ text }, styles[kind]));
    }

    function refreshConnectionStatus(node, client) {
        if (!client) {
            setStatus(node, 'error', 'Credentials missing');
            return;
        }
        const seq = node.gardenaStatusSeq || 0;
        client.getLoginStatusAsync().then(function(connected) {
            // Do not overwrite a status set by a message processed in the meantime.
            if ((node.gardenaStatusSeq || 0) === seq) {
                setStatus(node, connected ? 'ok' : 'error', connected ? 'Connected' : 'Could not connect');
            }
        });
    }

    function toError(error) {
        return error instanceof Error ? error : new Error(String(error));
    }

    function reportError(node, done, error, statusText) {
        setStatus(node, 'warning', statusText || 'Request error');
        if (error && error.details) {
            node.debug(JSON.stringify(error.details));
        }
        done(toError(error));
    }

    // Calls done() exactly once, even if send() throws: a then(ok).catch(err) chain would
    // otherwise call done() twice, and a then(ok, err) one would leave an unhandled rejection.
    function sendAndDone(node, send, done, msg) {
        try {
            send(msg);
        } catch (e) {
            done(toError(e));
            return;
        }
        done();
    }

    function getDuration(node, config, msg) {
        if (config.durationtype === 'msg') {
            const value = RED.util.evaluateNodeProperty(config.duration, 'msg', node, msg);
            return value === undefined || value === null || value === '' ? 1 : value;
        }
        return config.duration;
    }

    // --------------------------------------------------------- devices status

    function GardenaDevicesStatusNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const client = getClient(node, config);
        refreshConnectionStatus(node, client);

        node.on('input', function(msg, send, done) {
            if (!client) {
                setStatus(node, 'error', 'Credentials missing');
                done(new Error('Credentials are not properly set up. Cannot contact Gardena API.'));
                return;
            }
            client.getAllDevicesStatusAsync().then(
                function(locations) {
                    setStatus(node, 'ok', 'Connected');
                    msg.payload = locations;
                    sendAndDone(node, send, done, msg);
                },
                function(error) {
                    reportError(node, done, error, 'Error getting devices');
                }
            );
        });
    }
    RED.nodes.registerType('devices_status', GardenaDevicesStatusNode);

    // --------------------------------------------------------- service status

    function GardenaServiceStatusNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const serviceId = config.service;
        const serviceType = config.servicetype;

        node.on('input', function(msg, send, done) {
            const locations = msg.payload;
            if (!Array.isArray(locations)) {
                done(new Error('Input payload does not come from the Gardena Devices Status node. Cannot find service data.'));
                return;
            }

            let found = null;
            for (const location of locations) {
                if (!location || !Array.isArray(location.devices)) {
                    continue;
                }
                for (const device of location.devices) {
                    const services = device && Array.isArray(device.services) ? device.services : [];
                    found = services.find(function(service) {
                        return service && service.id === serviceId && service.type === serviceType;
                    });
                    if (found) {
                        break;
                    }
                }
                if (found) {
                    break;
                }
            }

            if (!found) {
                done(new Error(`Could not find service ${serviceId} (${serviceType}) in node input data.`));
                return;
            }
            msg.payload = found;
            send(msg);
            done();
        });
    }
    RED.nodes.registerType('service_status', GardenaServiceStatusNode);

    // ------------------------------------------------------- control nodes

    function createControlNode(typeName, method, label) {
        function GardenaControlNode(config) {
            RED.nodes.createNode(this, config);
            const node = this;
            const client = getClient(node, config);
            refreshConnectionStatus(node, client);

            node.on('input', function(msg, send, done) {
                if (!client) {
                    setStatus(node, 'error', 'Credentials missing');
                    done(new Error('Credentials are not properly set up. Cannot contact Gardena API.'));
                    return;
                }
                let duration;
                try {
                    duration = getDuration(node, config, msg);
                } catch (e) {
                    reportError(node, done, e, 'Invalid duration');
                    return;
                }
                client[method](config.service, config.operation, duration).then(
                    function(response) {
                        setStatus(node, 'ok', 'Command sent');
                        msg.payload = response;
                        sendAndDone(node, send, done, msg);
                    },
                    function(error) {
                        const err = toError(error);
                        err.message = `Error when controlling ${label}: ${err.message}`;
                        reportError(node, done, err);
                    }
                );
            });
        }
        RED.nodes.registerType(typeName, GardenaControlNode);
    }

    createControlNode('valve_control', 'sendValveControlAsync', 'valve');
    createControlNode('mower_control', 'sendMowerControlAsync', 'mower');
    createControlNode('powersocket_control', 'sendPowerSocketControlAsync', 'power socket');
};
