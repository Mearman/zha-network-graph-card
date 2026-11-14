import { LitElement, css, html, nothing, svg } from "lit";
import { state } from "lit/decorators.js";
import { forceCenter, forceLink, forceManyBody, forceSimulation } from "d3-force";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { z } from "zod";
import { MAX_LQI, buildGraph, deviceListSchema, lqiColour } from "./graph";
import type { Graph, GraphLink, GraphNode } from "./graph";

const configSchema = z.object({
  type: z.string(),
  title: z.string().optional(),
});
type CardConfig = z.infer<typeof configSchema>;

/** The part of Home Assistant's frontend `hass` object this card uses. */
interface Hass {
  callWS(message: { type: string }): Promise<unknown>;
}

type PositionedNode = GraphNode & SimulationNodeDatum;
type PositionedLink = SimulationLinkDatum<PositionedNode> & GraphLink;

const WIDTH = 640;
const HEIGHT = 480;
/** Enough ticks for d3's default cooling schedule to settle, so the layout is stable between renders. */
const LAYOUT_TICKS = 300;
const NODE_RADIUS = { coordinator: 12, router: 8, "end-device": 5 } as const;

/** Lays the graph out once, synchronously. Strong links pull their ends closer together. */
function layout(graph: Graph): { nodes: PositionedNode[]; links: PositionedLink[] } {
  const nodes: PositionedNode[] = graph.nodes.map((node) => ({ ...node }));
  const links: PositionedLink[] = graph.links.map((link) => ({ ...link }));
  forceSimulation(nodes)
    .force(
      "link",
      forceLink<PositionedNode, PositionedLink>(links)
        .id((node) => node.id)
        .distance((link) => 40 + (MAX_LQI - link.lqi) * 0.5),
    )
    .force("charge", forceManyBody().strength(-140))
    .force("centre", forceCenter(WIDTH / 2, HEIGHT / 2))
    .stop()
    .tick(LAYOUT_TICKS);
  return { nodes, links };
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
  @state() private selected: string | undefined;
  @state() private error: string | undefined;
  @state() private scanning = false;

  private hassObject: Hass | undefined;

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
      this.graph = buildGraph(devices);
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
    const positioned = this.graph === undefined ? undefined : layout(this.graph);
    const selected = positioned?.nodes.find((node) => node.id === this.selected);
    return html`
      <ha-card>
        <div class="toolbar">
          <span class="title">${this.config?.title ?? "ZHA network"}</span>
          <button ?disabled=${this.scanning} @click=${() => void this.rescan()}>
            ${this.scanning ? "Scanning..." : "Rescan"}
          </button>
        </div>
        ${this.error === undefined ? nothing : html`<div class="error">${this.error}</div>`}
        ${positioned === undefined ? nothing : this.renderGraph(positioned)}
        ${selected === undefined ? nothing : this.renderDetail(selected)}
      </ha-card>
    `;
  }

  private renderGraph({ nodes, links }: { nodes: PositionedNode[]; links: PositionedLink[] }) {
    const at = (end: PositionedLink["source"]): PositionedNode =>
      end as PositionedNode;
    return html`
      <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="ZHA network graph">
        ${links.map((link) =>
          svg`<line
            x1=${at(link.source).x ?? 0} y1=${at(link.source).y ?? 0}
            x2=${at(link.target).x ?? 0} y2=${at(link.target).y ?? 0}
            stroke=${lqiColour(link.lqi)} stroke-width="2" />`,
        )}
        ${nodes.map(
          (node) => svg`<circle
            cx=${node.x ?? 0} cy=${node.y ?? 0} r=${NODE_RADIUS[node.role]}
            fill=${node.battery ? "none" : "var(--primary-text-color, #333)"}
            stroke="var(--primary-text-color, #333)" stroke-width="2"
            opacity=${node.available ? 1 : 0.35}
            @click=${() => { this.selected = node.id; }}>
            <title>${node.name}</title>
          </circle>`,
        )}
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
