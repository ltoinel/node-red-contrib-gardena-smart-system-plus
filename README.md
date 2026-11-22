# node-red-contrib-gardena-smart-system-plus

[![CI](https://github.com/ltoinel/node-red-contrib-gardena-smart-system-plus/actions/workflows/ci.yml/badge.svg)](https://github.com/ltoinel/node-red-contrib-gardena-smart-system-plus/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/ltoinel/node-red-contrib-gardena-smart-system-plus/graph/badge.svg)](https://codecov.io/gh/ltoinel/node-red-contrib-gardena-smart-system-plus)
[![npm version](https://img.shields.io/npm/v/node-red-contrib-gardena-smart-system-plus.svg)](https://www.npmjs.com/package/node-red-contrib-gardena-smart-system-plus)
[![npm downloads](https://img.shields.io/npm/dm/node-red-contrib-gardena-smart-system-plus.svg)](https://www.npmjs.com/package/node-red-contrib-gardena-smart-system-plus)
[![Node.js](https://img.shields.io/node/v/node-red-contrib-gardena-smart-system-plus.svg)](https://nodejs.org)
[![Node-RED](https://img.shields.io/badge/Node--RED-%3E%3D3.0-8f0000?logo=nodered)](https://nodered.org)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

A flow for Node RED integrating the Gardena Smart System.

## Origin of this package

This is a fork of [node-red-contrib-gardena-smart-system](https://www.npmjs.com/package/node-red-contrib-gardena-smart-system) by moay, distributed under the same GPL-3.0 license.

* Source: version **1.1.4** of the original package, as published on npm on 2025-04-28 ([code tab](https://www.npmjs.com/package/node-red-contrib-gardena-smart-system?activeTab=code)). The original package does not reference a public source repository.

## Why this update

**The original nodes could freeze in Node-RED**: they stopped responding and no longer produced any output or error, until Node-RED was restarted. The code review found several causes:

* Promises that never settled: errors thrown inside asynchronous storage callbacks were not caught, and some `reject()` calls were not followed by a `return`. A failed token request or locations request left the node waiting forever.
* HTTP errors other than 401/404 were silently swallowed, so failures surfaced later as unrelated `TypeError`s instead of a clear error.
* A single API client was shared by every node, and its authentication was bound to the first credentials and flow context. Several flows or credentials configurations interfered with each other.
* Concurrent token requests were not deduplicated, which multiplied authentication calls and made hitting the Gardena rate limits more likely.

The update also fixes a security issue (access tokens and API keys were written to the Node-RED logs and exposed in `msg.payload`) and modernizes the dependencies. The full list of changes is in the [changelog](#changelog).

> **Note:** since version 2.0.0, the nodes have their own types (`gardena-plus-*`), so this package can be installed next to the original `node-red-contrib-gardena-smart-system`. Flows created with the original package or with version 1.x of this one must be migrated, see [Migrating from 1.x or from the original package](#migrating-from-1x-or-from-the-original-package).

```
npm install node-red-contrib-gardena-smart-system-plus
```

## General

This flow is intended for people who want to control their gardena smart system via Node RED.

## Features

All the nodes are in the **Gardena** category of the palette.

### Status

| Node | What it does |
|------|--------------|
| **Gardena Devices Status** | On any input message, outputs every location of the account, with its devices and their services (IDs and current state). |
| **Gardena Service Status** | Extracts one service, by ID and type (mower, valve, irrigation control, power socket, sensor, device information), from the output of the Devices Status node. |
| **Gardena Events** | Outputs the state changes of the devices in realtime (mower activity, valve opened or closed, sensor values, battery, radio link...), with optional filters by event type and by service or device ID. See [Realtime events](#realtime-events). |

### Control

| Node | Operations |
|------|------------|
| **Gardena Valve Control** | Start watering for a given duration · Cancel watering · Pause schedule · Continue schedule |
| **Gardena Valve Set Control** | Close all the valves of an irrigation control, then continue with the schedule |
| **Gardena Mower Control** | Start mowing for a given duration · Start mowing by schedule · Park until next task · Park until further notice |
| **Gardena Power Socket Control** | Switch on for a given duration · Switch on · Switch off and return to schedule · Disable schedule for a given duration · Continue with schedule |

* Durations are in minutes (rounded to whole minutes, as required by the API). They can be a fixed number or read from a `msg` property, so one node can be driven by different flows.
* The control nodes output `{ status, data }` of the Gardena API response (`202` when the command was accepted).

### Reliability

* Errors (API errors, missing credentials, invalid duration, rate limit `429`) are raised through `done(err)` and can be handled with a `catch` node; the node status shows the last result.
* One API client per credentials configuration: tokens are kept in memory, renewed automatically, and concurrent token requests are deduplicated. Several credentials configurations and flows work independently.
* Locations are cached for one hour to save API quota.
* Tokens and API keys are never written to the logs or to the messages.

## Getting started

### Prerequisites

* Register at https://developer.husqvarnagroup.cloud/
* Create an application
* Connect it to Gardena API (application details and then bottom > connect new api)

The Gardena smart system API is documented on the [Husqvarna Group developer portal](https://developer.husqvarnagroup.cloud/apis).

The source code of the Gardena smart Gateway firmware is published by Husqvarna: [smart-garden-gateway-public](https://github.com/husqvarnagroup/smart-garden-gateway-public).

### Setup

When using one of the actions on the node, you'll need credentials. These should be easy to setup, pass in the app client ID and secret.

### Service IDs

When controlling anything, you'll need the service ID. In order to get these, use the **Gardena Devices Status** node, which lists all the devices you can use. For each device, each service is listed including its ID.

Sadly, the services aren't really labeled, so you'll need to try out which is which.

### Realtime events

The **Gardena Events** node outputs a message as soon as a device changes (mower activity, valve opened or closed, sensor values, battery, radio link...). The events are pushed by the Gardena API through a WebSocket, which uses almost none of the API quota: prefer it to polling the Devices Status node.

* Right after connecting, the current state of every device and service is sent.
* Events can be filtered by type (`MOWER`, `VALVE`, `SENSOR`...) and by service or device ID.
* The API sends partial updates: they are merged, so `msg.payload` is always the complete state of the service, with the same shape as in the Devices Status output. `msg.changed` lists the attributes present in the update (e.g. `["activity"]`), `msg.topic` is `gardena/<type>/<id>` and `msg.deviceId` is the ID of the device.
* All the Events nodes using the same credentials share one connection per location. The connection is kept alive with a ping every 150 seconds and renewed every 110 minutes (the API closes connections after 2 hours); lost connections are re-established automatically: quickly at first, then once per hour, to stay within the quota.


## Notes

* Locations are cached in memory for one hour (per credentials configuration). If you add or remove a location, wait for the cache to expire or redeploy/restart Node-RED. If you don't know what a location is: Basically you can handle multiple houses/locations in one gardena account.
* Errors are reported through the standard Node-RED mechanism and can be handled with a `catch` node.
* Requires Node.js 18+ and Node-RED 3+.
* I wasn't able to test on many things, so basically the old saying "it works on my machine" applies. If something does not work, let me know.
* Gardena has rate limits, see [here](https://developer.husqvarnagroup.cloud/apis/gardena-smart-system-api?tab=readme#rate-limits) - keep those in mind! Do NOT setup too frequent calls to the API. For ongoing status requests, try to stick to something below one request every 30 minutes.

## Migrating from 1.x or from the original package

Version 2.0.0 renamed the node types to avoid conflicts with the original package in the Node-RED palette and Flow Library:

| Before | Since 2.0.0 |
|--------|-------------|
| `api-credentials` | `gardena-plus-credentials` |
| `devices_status` | `gardena-plus-devices-status` |
| `service_status` | `gardena-plus-service-status` |
| `valve_control` | `gardena-plus-valve-control` |
| `valveset_control` | `gardena-plus-valveset-control` |
| `mower_control` | `gardena-plus-mower-control` |
| `powersocket_control` | `gardena-plus-powersocket-control` |
| `gardena_events` | `gardena-plus-events` |

Node-RED does not convert node types: after the upgrade, the old nodes are shown as *unknown*. To migrate, stop Node-RED, back up your flows file (by default `~/.node-red/flows.json`), rename the types, then restart:

```
cd ~/.node-red
cp flows.json flows.json.bak
sed -i -E 's/"type": ?"(api-credentials)"/"type":"gardena-plus-credentials"/g; s/"type": ?"(devices_status|service_status|valve_control|valveset_control|mower_control|powersocket_control)"/"type":"gardena-plus-\1"/g; s/"type": ?"gardena_events"/"type":"gardena-plus-events"/g' flows.json
sed -i -E 's/"type":"gardena-plus-([a-z]+)_([a-z]+)"/"type":"gardena-plus-\1-\2"/g' flows.json
```

The node IDs do not change, so the credentials (stored in `flows_cred.json`) and the wires are kept. Alternatively, export your flows, replace the types in the JSON with a text editor and import them again.

## Changelog

### 2.0.0

* **Breaking:** the node types are renamed with a `gardena-plus-` prefix, so that they no longer conflict with the original package. Existing flows must be migrated, see [Migrating](#migrating-from-1x-or-from-the-original-package).
* Example flows (devices status, realtime events, control), available from *Import > Examples* in Node-RED.


### 1.3.0

* New **Gardena Events** node: realtime state changes through the Gardena WebSocket API, with one shared connection per location, keepalive pings, automatic reconnection, and partial updates merged into the complete state of each service (`msg.changed` lists the updated attributes).
* New **Gardena Valve Set Control** node: closes all the valves of an irrigation control.
* Durations are now rounded to whole minutes, as required by the Gardena API (a fractional duration was rejected).
* New dependency: `ws`.

### 1.2.0

* Security: access tokens and API keys are no longer written to the logs, and the control nodes no longer put the raw HTTP response (which contained the request headers) in `msg.payload`. The payload is now `{ status, data }`.
* One API client per credentials configuration: several credentials configurations and several flows now work independently. Tokens are kept in memory only (no longer in the flow context).
* Fixed credential change detection, concurrent token requests, swallowed HTTP errors, and promises that never settled.
* Errors are raised with `done(err)` so they can be caught with a `catch` node; HTTP 429 (rate limit) is reported explicitly.
* Dependencies: axios upgraded to 1.x; unused `form-data`, `url` and `json-api-deserialize` removed.
* Added unit tests (`npm test`).

## Releasing

CI runs the tests on Node.js 18 to 24 for every push and pull request. To publish a new version to npm:

```
npm version patch   # or minor / major: updates package.json and creates the v* tag
git push --follow-tags
```

The `Release` workflow checks that the tag matches `package.json`, runs the tests, publishes to npm with provenance and creates the GitHub release.
