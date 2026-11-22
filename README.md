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

> **Note:** this package registers the same node types as the original one. Uninstall `node-red-contrib-gardena-smart-system` before installing this package; your existing flows will keep working without changes.

```
npm install node-red-contrib-gardena-smart-system-plus
```

## General

This flow is intended for people who want to control their gardena smart system via Node RED.

As of now, the node can handle

* Valves
* Mowers
* Sockets

that can be controlled via the Gardena/Husqvarna API.

### Prerequisites

* Register at https://developer.husqvarnagroup.cloud/
* Create an application
* Connect it to Gardena API (application details and then bottom > connect new api)

### Setup

When using one of the actions on the node, you'll need credentials. These should be easy to setup, pass in the app client ID and secret.

### Service IDs

When controlling anything, you'll need the service ID. In order to get these, use the **Gardena Devices Status** node, which lists all the devices you can use. For each device, each service is listed including its ID.

Sadly, the services aren't really labeled, so you'll need to try out which is which.


## Notes

* Locations are cached in memory for one hour (per credentials configuration). If you add or remove a location, wait for the cache to expire or redeploy/restart Node-RED. If you don't know what a location is: Basically you can handle multiple houses/locations in one gardena account.
* Errors are reported through the standard Node-RED mechanism and can be handled with a `catch` node.
* Requires Node.js 18+ and Node-RED 3+.
* I wasn't able to test on many things, so basically the old saying "it works on my machine" applies. If something does not work, let me know.
* Gardena has rate limits, see [here](https://developer.husqvarnagroup.cloud/apis/gardena-smart-system-api?tab=readme#rate-limits) - keep those in mind! Do NOT setup too frequent calls to the API. For ongoing status requests, try to stick to something below one request every 30 minutes.

## Changelog

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
