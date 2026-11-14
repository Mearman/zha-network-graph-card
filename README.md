# ZHA Network Graph Card

A Lovelace card that draws a [ZHA](https://www.home-assistant.io/integrations/zha/) Zigbee network as a graph: the coordinator, routers and end devices as nodes, and the links between them coloured by link quality.

## What it shows

- **Nodes:** rings with no fill: the coordinator in the accent colour and thicker, mains-powered devices solid, battery-powered devices dashed. A device that is unavailable is dimmed. Links stop at each ring. Click a node to highlight it and the devices it links to, name it on the graph, and list its links with their LQI below.
- **Links:** one line per pair of devices, shaded from red (LQI 0) to green (LQI 255). Zigbee neighbour tables are directional, so a link reported by both ends shows the mean of the two values.
- **Layout:** a stronger link is drawn shorter, so devices with a good connection sit close together. The card runs several force simulations from different seeded starting points, then improves the best few with simulated annealing on crossings and link-length error, and keeps the drawing with the fewest crossing links (then the one whose lengths best match the signal). Crossing minimisation is NP-hard, so this is a search, not a guarantee of the minimum, and the same data always draws the same picture. Nodes never overlap: the drawing is scaled until every pair keeps its drawn size plus a gap apart, and the view grows if it has to. Devices that appear in no link are drawn in a row below the mesh.
- **Rescan:** ZHA stores the last neighbour scan. The Rescan button asks ZHA to re-read every device's neighbour table, which can take a while on a large network.

The card reads the same `zha/devices` and `zha/topology/update` websocket commands that ZHA's own Visualization page uses, so it needs no extra integration.

## Install

With [HACS](https://hacs.xyz): add this repository as a custom repository of type Dashboard, install it, and reload the browser. Without HACS, copy `zha-network-graph-card.js` from a release into `config/www/` and add it as a dashboard resource of type JavaScript module at `/local/zha-network-graph-card.js`.

## Use

```yaml
type: custom:zha-network-graph-card
title: ZHA network
node_labels: inside
```

| Option | Type | Description |
| --- | --- | --- |
| `title` | string | Card heading. Defaults to "ZHA network". |
| `node_labels` | `selected` or `inside` | `selected` (default) names only the selected device. `inside` draws every node big enough to hold its own name, wrapped and cut with an ellipsis, and plans the layout for the room the card has. It only stays on when the text can be drawn at 8.5 px or more, which on a network of a few dozen devices needs a large card; on a smaller card it falls back to `selected`. |

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
