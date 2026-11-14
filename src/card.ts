import { LitElement, css, html, nothing, svg } from "lit";
import { state } from "lit/decorators.js";
import { z } from "zod";
import { buildGraph, deviceListSchema, lqiColour } from "./graph";
import type { Graph, GraphNode } from "./graph";
import { NODE_RADIUS, layoutGraph } from "./layout";
import type { Placement } from "./layout";

const configSchema = z.object({
  type: z.string(),
  title: z.string().optional(),
});
type CardConfig = z.infer<typeof configSchema>;

const WIDTH = 640;
const HEIGHT = 480;

/** The part of Home Assistant's frontend `hass` object this card uses. */
interface Hass {
  callWS(message: { type: string }): Promise<unknown>;
}

export class ZhaNetworkGraphCard extends LitElement {
  static override styles = css`
    ha-card { padding: 16px; }
    svg { width: 100%; height: auto; display: block; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; }
    .title { font-size: 1.2em; }
    .detail { margin-top: 8px; font-size: 0.9em; }
    .error { color: var(--error-color, #db4437); }
    button { cursor: pointer; }
    circle { cursor: pointer; }
  `;

  @state() private config: CardConfig | undefined;
  @state() private graph: Graph | undefined;
  /** Laid out once per data load, because searching many starts is too slow to repeat on every render. */
  @state() private placement: Placement | undefined;
  @state() private selected: string | undefined;
  @state() private error: string | undefined;
  @state() private scanning = false;

  private hassObject: Hass | undefined;
  /** Incremented per load so a slow layout from an earlier load cannot overwrite a newer one. */
  private loadId = 0;

  set hass(hass: Hass) {
    const first = this.hassObject === undefined;
    this.hassObject = hass;
    if (first) {
      void this.load();
    }
  }

  setConfig(config: unknown): void {
    this.config = configSchema.parse(config);
  }

  getCardSize(): number {
    return 6;
  }

  static getStubConfig(): CardConfig {
    return { type: "custom:zha-network-graph-card" };
  }

  private async load(): Promise<void> {
    if (this.hassObject === undefined) {
      return;
    }
    try {
      const devices = deviceListSchema.parse(await this.hassObject.callWS({ type: "zha/devices" }));
      const graph = buildGraph(devices);
      this.loadId += 1;
      const loadId = this.loadId;
      const placement = await layoutGraph(graph, { width: WIDTH, height: HEIGHT });
      if (loadId !== this.loadId) {
        return;
      }
      this.placement = placement;
      this.graph = graph;
      this.error = undefined;
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** Asks ZHA to re-read every device's neighbour table, which is slow on a large network. */
  private async rescan(): Promise<void> {
    if (this.hassObject === undefined) {
      return;
    }
    this.scanning = true;
    try {
      await this.hassObject.callWS({ type: "zha/topology/update" });
      await this.load();
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.scanning = false;
    }
  }

  override render() {
    const selected = this.graph?.nodes.find((node) => node.id === this.selected);
    return html`
      <ha-card>
        <div class="toolbar">
          <span class="title">${this.config?.title ?? "ZHA network"}</span>
          <button ?disabled=${this.scanning} @click=${() => void this.rescan()}>
            ${this.scanning ? "Scanning..." : "Rescan"}
          </button>
        </div>
        ${this.error === undefined ? nothing : html`<div class="error">${this.error}</div>`}
        ${this.graph === undefined || this.placement === undefined ? nothing : this.renderGraph(this.graph, this.placement)}
        ${selected === undefined ? nothing : this.renderDetail(selected)}
      </ha-card>
    `;
  }

  private renderGraph(graph: Graph, { positions, size }: Placement) {
    return html`
      <svg viewBox="0 0 ${size.width} ${size.height}" role="img" aria-label="ZHA network graph">
        ${graph.links.map((link) => {
          const from = positions.get(link.source);
          const to = positions.get(link.target);
          return from === undefined || to === undefined
            ? nothing
            : svg`<line x1=${from.x} y1=${from.y} x2=${to.x} y2=${to.y}
                stroke=${lqiColour(link.lqi)} stroke-width="2" />`;
        })}
        ${graph.nodes.map((node) => {
          const at = positions.get(node.id);
          return at === undefined
            ? nothing
            : svg`<circle
                cx=${at.x} cy=${at.y} r=${NODE_RADIUS[node.role]}
                fill=${node.battery ? "none" : "var(--primary-text-color, currentColor)"}
                stroke="var(--primary-text-color, currentColor)" stroke-width="2"
                opacity=${node.available ? 1 : 0.35}
                @click=${() => { this.selected = node.id; }}>
                <title>${node.name}</title>
              </circle>`;
        })}
      </svg>
    `;
  }

  private renderDetail(node: GraphNode) {
    return html`
      <div class="detail">
        <strong>${node.name}</strong>: ${node.role}${node.battery ? ", battery" : ""},
        LQI ${node.lqi ?? "unknown"}, RSSI ${node.rssi ?? "unknown"}
        ${node.available ? nothing : html`(unavailable)`}
      </div>
    `;
  }
}

customElements.define("zha-network-graph-card", ZhaNetworkGraphCard);

declare global {
  interface Window {
    customCards?: { type: string; name: string; description: string }[];
  }
}
window.customCards = window.customCards ?? [];
window.customCards.push({
  type: "zha-network-graph-card",
  name: "ZHA network graph",
  description: "Draws the ZHA Zigbee network as a graph, with links coloured by link quality.",
});
