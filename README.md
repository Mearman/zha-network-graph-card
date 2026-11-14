# ZHA Network Graph Card

A Lovelace card that draws a [ZHA](https://www.home-assistant.io/integrations/zha/) Zigbee network as a graph: the coordinator, routers and end devices as nodes, and the links between them coloured by link quality.

## What it shows

- **Nodes:** the coordinator is the largest circle, routers are filled, and battery-powered devices are hollow. A device that is unavailable is dimmed. Click a node for its role, LQI and RSSI.
- **Links:** one line per pair of devices, shaded from red (LQI 0) to green (LQI 255). Zigbee neighbour tables are directional, so a link reported by both ends shows the mean of the two values.
- **Layout:** a stronger link is drawn shorter, so devices with a good connection sit close together. The card runs many force simulations from different seeded starting points and keeps the one with the fewest crossing links, then the one whose lengths best match the signal. Crossing minimisation is NP-hard, so this is a search, not a guarantee of the minimum, and the same data always draws the same picture. Nodes never overlap: the drawing is scaled until every pair keeps its drawn size plus a gap apart, and the view grows if it has to. Devices that appear in no link are drawn in a row below the mesh.
- **Rescan:** ZHA stores the last neighbour scan. The Rescan button asks ZHA to re-read every device's neighbour table, which can take a while on a large network.

The card reads the same `zha/devices` and `zha/topology/update` websocket commands that ZHA's own Visualization page uses, so it needs no extra integration.

## Install

With [HACS](https://hacs.xyz): add this repository as a custom repository of type Dashboard, install it, and reload the browser. Without HACS, copy `zha-network-graph-card.js` from a release into `config/www/` and add it as a dashboard resource of type JavaScript module at `/local/zha-network-graph-card.js`.

## Use

```yaml
type: custom:zha-network-graph-card
title: ZHA network
```

| Option | Type | Description |
| --- | --- | --- |
| `title` | string | Card heading. Defaults to "ZHA network". |

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

`dist/` is build output and is not committed. The graph model (`src/graph.ts`) is pure and tested; the custom element (`src/card.ts`) only lays out and draws it.

TypeScript is held at version 6 because typescript-eslint does not yet support 7.

## Licence

Apache-2.0.
