import { LitElement, css, html, nothing, svg } from "lit";
import { state } from "lit/decorators.js";
import { z } from "zod";
import { MAX_LQI, buildGraph, deviceListSchema, lqiColour } from "./graph";
import type { Graph, GraphNode } from "./graph";
import { NODE_RADIUS, layoutGraph } from "./layout";
import type { Placement } from "./layout";

const configSchema = z.object({
  type: z.string(),
  title: z.string().optional(),
});
type CardConfig = z.infer<typeof configSchema>;

/** The part of Home Assistant's frontend `hass` object this card uses. */
interface Hass {
  callWS(message: { type: string }): Promise<unknown>;
}

const WIDTH = 640;
const HEIGHT = 480;
/** Links get thicker as the signal improves, so quality reads from width as well as colour. */
/** Space kept clear below the card. */
const BOTTOM_MARGIN = 12;
/** The graph never shrinks below this height, even on a very short screen. */
const MIN_GRAPH_PX = 200;
/** Label text height in screen pixels. */
const LABEL_PX = 13;
const MIN_STROKE = 1;
const MAX_STROKE = 3.5;
/** What an unselected part of the drawing fades to while a device is selected. */
const FADED = 0.18;

/**
 * The first opaque background colour at or above `start`, walking out through shadow roots, or a dark
 * default. A card in a themed dashboard is often transparent and the colour comes from a parent.
 */
function resolvedBackground(start: Element): string {
  let node: Element | null = start;
  while (node !== null) {
    const colour = getComputedStyle(node).backgroundColor;
    const alpha = /^rgba\(.*,\s*([\d.]+)\)$/.exec(colour)?.[1];
    if (colour !== "transparent" && (alpha === undefined ? colour.startsWith("rgb") : Number(alpha) > 0.9)) {
      return colour;
    }
    const root: Node = node.getRootNode();
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return "#1c1c1c";
}

const strokeFor = (lqi: number): number => MIN_STROKE + ((MAX_STROKE - MIN_STROKE) * Math.min(Math.max(lqi, 0), MAX_LQI)) / MAX_LQI;

export class ZhaNetworkGraphCard extends LitElement {
  static override styles = css`
    ha-card { padding: 16px; display: block; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .title { font-size: 1.2em; font-weight: 500; }
    /* The graph shrinks to fit the screen, keeping its proportions, so the legend and details stay in view. */
    .graph { width: 100%; height: auto; max-height: calc(100vh - 230px); min-height: 200px; display: block; }
    .node { cursor: pointer; transition: opacity 0.15s; }
    .node:focus-visible { outline: none; }
    .node:focus-visible circle { stroke-width: 4; }
    .link { transition: opacity 0.15s; }
    .label-box { fill: var(--zgc-bg); stroke: var(--zgc-fg); stroke-opacity: 0.5; pointer-events: none; }
    .label { fill: var(--zgc-fg); pointer-events: none; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; margin-top: 8px; font-size: 0.85em; color: var(--secondary-text-color, inherit); }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .scale { width: 90px; height: 8px; border-radius: 4px; background: linear-gradient(to right, hsl(0 75% 45%), hsl(60 75% 45%), hsl(120 75% 45%)); }
    /* A fixed-height region, so selecting a device never changes the room left for the graph. */
    .detail { margin-top: 12px; font-size: 0.9em; height: 7.5em; overflow-y: auto; }
    .detail ul { margin: 6px 0 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 2px 28px; }
    .detail li { display: flex; justify-content: space-between; gap: 12px; }
    .detail li span:last-child { white-space: nowrap; }
    .error { color: var(--error-color, #db4437); margin-bottom: 8px; }
    button { cursor: pointer; }
  `;

  @state() private config: CardConfig | undefined;
  @state() private graph: Graph | undefined;
  /** Laid out once per data load, because the search for a good layout is too slow to repeat on every render. */
  @state() private placement: Placement | undefined;
  @state() private selected: string | undefined;
  @state() private error: string | undefined;
  @state() private scanning = false;
  /** How many screen pixels one drawing unit takes (the frame fits the drawing uniformly), so labels keep one readable size however far the graph is scaled down. */
  @state() private scale = 1;

  /** The colours the theme really resolves to, read from the page, because themes do not all set the same variables. */
  @state() private colours = { background: "#1c1c1c", foreground: "#e1e1e1" };
  /** The tallest the graph may be, in pixels, so the whole card fits the space left on the screen. */
  @state() private maxGraphHeight: number | undefined;

  private resizeObserver: ResizeObserver | undefined;
  private observed: Element | undefined;

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
    return 8;
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

  private select(id: string | undefined): void {
    this.selected = this.selected === id ? undefined : id;
  }

  override updated(): void {
    const graph = this.renderRoot.querySelector(".graph");
    if (graph !== null && graph !== this.observed) {
      this.resizeObserver?.disconnect();
      this.observed = graph;
      this.resizeObserver = new ResizeObserver(() => {
        this.measure();
      });
      this.resizeObserver.observe(graph);
      window.addEventListener("resize", this.onWindowResize);
    }
  }

  private readonly onWindowResize = (): void => {
    this.measure();
  };

  /** Reads the drawing scale, the theme colours and the room left on screen for the graph. */
  private measure(): void {
    const graph = this.renderRoot.querySelector(".graph");
    const card = this.renderRoot.querySelector("ha-card");
    if (graph === null || card === null) {
      return;
    }
    const view = this.placement?.size ?? { width: WIDTH, height: HEIGHT };
    const box = graph.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      // The drawing is scaled uniformly to fit the frame, so the smaller of the two ratios applies.
      this.scale = Math.min(box.width / view.width, box.height / view.height);
    }
    const foreground = getComputedStyle(card).color;
    const background = resolvedBackground(card);
    if (foreground !== this.colours.foreground || background !== this.colours.background) {
      this.colours = { background, foreground };
    }
    // Everything in the card that is not the graph (toolbar, legend, details, padding) keeps its height.
    const chrome = card.getBoundingClientRect().height - box.height;
    const room = Math.floor(window.innerHeight - card.getBoundingClientRect().top - chrome - BOTTOM_MARGIN);
    const limit = Math.max(MIN_GRAPH_PX, room);
    if (limit !== this.maxGraphHeight) {
      this.maxGraphHeight = limit;
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.observed = undefined;
    window.removeEventListener("resize", this.onWindowResize);
  }

  override render() {
    return html`
      <ha-card style=${`--zgc-bg: ${this.colours.background}; --zgc-fg: ${this.colours.foreground}`}>
        <div class="toolbar">
          <span class="title">${this.config?.title ?? "ZHA network"}</span>
          <button ?disabled=${this.scanning} @click=${() => void this.rescan()}>
            ${this.scanning ? "Scanning..." : "Rescan"}
          </button>
        </div>
        ${this.error === undefined ? nothing : html`<div class="error">${this.error}</div>`}
        ${this.graph === undefined || this.placement === undefined ? nothing : this.renderGraph(this.graph, this.placement)}
        ${this.graph === undefined ? nothing : this.renderLegend()}
        ${this.graph === undefined ? nothing : this.renderDetail(this.graph)}
      </ha-card>
    `;
  }

  private renderGraph(graph: Graph, { positions, size }: Placement) {
    const focus = this.selected;
    const near = new Set<string>(focus === undefined ? [] : [focus]);
    if (focus !== undefined) {
      for (const link of graph.links) {
        if (link.source === focus) {
          near.add(link.target);
        } else if (link.target === focus) {
          near.add(link.source);
        }
      }
    }
    const named = graph.nodes.filter((node) => node.id === focus);
    return html`
      <svg class="graph" style=${this.maxGraphHeight === undefined ? nothing : `max-height: ${String(this.maxGraphHeight)}px`} viewBox="0 0 ${size.width} ${size.height}" role="group" aria-label="ZHA network graph" @click=${() => { this.selected = undefined; }}>
        ${graph.links.map((link) => {
          const from = positions.get(link.source);
          const to = positions.get(link.target);
          if (from === undefined || to === undefined) {
            return nothing;
          }
          const touching = link.source === focus || link.target === focus;
          return svg`<line class="link" x1=${from.x} y1=${from.y} x2=${to.x} y2=${to.y}
            stroke=${lqiColour(link.lqi)} stroke-width=${strokeFor(link.lqi)} stroke-linecap="round"
            opacity=${focus === undefined || touching ? 1 : FADED}>
            <title>LQI ${Math.round(link.lqi)}</title>
          </line>`;
        })}
        ${graph.nodes.map((node) => {
          const at = positions.get(node.id);
          if (at === undefined) {
            return nothing;
          }
          const faded = focus !== undefined && !near.has(node.id);
          return svg`<g class="node" tabindex="0" role="button" aria-label=${node.name}
              opacity=${faded ? FADED : node.available ? 1 : 0.4}
              @click=${(event: Event) => { event.stopPropagation(); this.select(node.id); }}
              @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.select(node.id); } }}>
            <circle cx=${at.x} cy=${at.y} r=${NODE_RADIUS[node.role]}
              fill=${this.fillFor(node)} stroke="var(--zgc-fg)"
              stroke-width=${node.id === focus ? 4 : 2} />
            <title>${node.name}</title>
          </g>`;
        })}
        ${named.map((node) => {
          const at = positions.get(node.id);
          return at === undefined ? nothing : this.renderLabel(node, at, size.width);
        })}
      </svg>
    `;
  }

  /** A name tag with a solid background above the node, kept at LABEL_PX on screen and inside the drawing's edges. */
  private renderLabel(node: GraphNode, at: { x: number; y: number }, viewWidth: number) {
    const unit = 1 / this.scale;
    const fontSize = LABEL_PX * unit;
    const padX = 6 * unit;
    const padY = 3 * unit;
    const width = node.name.length * 0.6 * fontSize + 2 * padX;
    const height = fontSize + 2 * padY;
    const x = Math.min(Math.max(at.x, width / 2 + unit), viewWidth - width / 2 - unit);
    const bottom = at.y - NODE_RADIUS[node.role] - 4 * unit;
    const top = Math.max(bottom - height, unit);
    return svg`
      <rect class="label-box" x=${x - width / 2} y=${top} width=${width} height=${height} rx=${4 * unit} stroke-width=${unit} />
      <text class="label" x=${x} y=${top + height / 2} font-size=${fontSize} text-anchor="middle" dominant-baseline="central">${node.name}</text>
    `;
  }

  /** Coordinator in the accent colour, routers solid, battery devices hollow. */
  private fillFor(node: Pick<GraphNode, "role" | "battery">): string {
    if (node.role === "coordinator") {
      return "var(--primary-color, #03a9f4)";
    }
    return node.battery ? "var(--zgc-bg)" : "var(--zgc-fg)";
  }

  private renderLegend() {
    const key = (role: GraphNode["role"], battery: boolean, label: string) => html`
      <span class="legend-item">
        <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle r=${Math.min(NODE_RADIUS[role], 7)} fill=${this.fillFor({ role, battery })} stroke="var(--zgc-fg)" stroke-width="2" />
        </svg>${label}
      </span>`;
    return html`
      <div class="legend">
        <span class="legend-item">Weak <span class="scale" role="img" aria-label="Link quality from weak, red, to strong, green"></span> Strong</span>
        ${key("coordinator", false, "Coordinator")}
        ${key("router", false, "Router")}
        ${key("end-device", true, "Battery device")}
        <span class="legend-item">Dimmed: unavailable</span>
      </div>
    `;
  }

  private renderDetail(graph: Graph) {
    const node = graph.nodes.find((candidate) => candidate.id === this.selected);
    if (node === undefined) {
      return html`<div class="detail">Select a device to see its links.</div>`;
    }
    const names = new Map(graph.nodes.map((candidate) => [candidate.id, candidate.name]));
    const links = graph.links
      .filter((link) => link.source === node.id || link.target === node.id)
      .map((link) => ({ other: names.get(link.source === node.id ? link.target : link.source) ?? "unknown", lqi: link.lqi }))
      .sort((a, b) => b.lqi - a.lqi);
    return html`
      <div class="detail">
        <strong>${node.name}</strong>: ${node.role}${node.battery ? ", battery" : ""},
        LQI ${node.lqi ?? "unknown"}, RSSI ${node.rssi ?? "unknown"}${node.available ? nothing : html`, unavailable`}
        ${links.length === 0
          ? html`<div>No links are known for this device.</div>`
          : html`<ul>${links.map((link) => html`<li><span>${link.other}</span><span>LQI ${Math.round(link.lqi)}</span></li>`)}</ul>`}
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
