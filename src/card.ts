import { LitElement, css, html, nothing, svg } from "lit";
import { state } from "lit/decorators.js";
import { z } from "zod";
import { MAX_LQI, buildGraph, deviceListSchema, lqiColour } from "./graph";
import type { Graph, GraphNode } from "./graph";
import { LINE_HEIGHT_EM, textBoxFor, wrapName } from "./label";
import { MIN_LENGTH, NODE_RADIUS, layoutGraph } from "./layout";
import type { Placement } from "./layout";

const configSchema = z.object({
  type: z.string(),
  title: z.string().optional(),
  /** `selected` names only the selected device. `inside` tries nodes big enough to hold their own names and falls back to `selected` when they cannot be read. */
  node_labels: z.enum(["selected", "inside"]).default("selected"),
});
type CardConfig = z.infer<typeof configSchema>;

interface Plan {
  inside: boolean;
  /** Pixels per drawing unit the layout was planned for. */
  k: number;
}

/** The part of Home Assistant's frontend `hass` object this card uses. */
interface Hass {
  callWS(message: { type: string }): Promise<unknown>;
}

const WIDTH = 640;
const HEIGHT = 480;
/** Radius, in drawing units, of a node that holds its own name. */
const NODE_UNITS = NODE_RADIUS.coordinator;
/** A node's on-screen radius is this fraction of the room each device has on average, within the bounds below. */
const NODE_ROOM_FRACTION = 0.14;
const NODE_PX_MIN = 24;
const NODE_PX_MAX = 40;
/** Text height inside a node, in pixels, and the smallest that counts as readable. */
const NODE_FONT_PX = 11;
const MIN_TEXT_PX = 8.5;
/** How many short waits to allow for the card to be laid out before planning for a default width. */
const MAX_WAIT_FRAMES = 60;
const FRAME_WAIT_MS = 16;
/** The weakest link is drawn this many average spacings long. */
const LENGTH_SPACINGS = 1.6;
/** Left and right padding of the card, which the drawing does not use. */
const CARD_PADDING = 32;
/** Links get thicker as the signal improves, so quality reads from width as well as colour. */
/** Space kept clear below the card. */
const BOTTOM_MARGIN = 12;
/** How long the card's room must stay unchanged before the layout is planned again. */
const RELAYOUT_DELAY_MS = 400;
/** How much the room may change, as a fraction, before the layout is planned again. */
const RELAYOUT_CHANGE = 0.12;
/** The graph never shrinks below this height, even on a very short screen. */
const MIN_GRAPH_PX = 200;
/** Average width of one label character in screen pixels at the label's font size. */
const LABEL_CHAR_PX = 7.2;
const MIN_STROKE = 1;
const MAX_STROKE = 3.5;
/** What an unselected part of the drawing fades to while a device is selected. */
const FADED = 0.18;

const strokeFor = (lqi: number): number => MIN_STROKE + ((MAX_STROKE - MIN_STROKE) * Math.min(Math.max(lqi, 0), MAX_LQI)) / MAX_LQI;

export class ZhaNetworkGraphCard extends LitElement {
  static override styles = css`
    :host { display: block; --u: 1; }
    ha-card { padding: 16px; display: block; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .title { font-size: 1.2em; font-weight: 500; }
    /* The graph shrinks to fit the screen, keeping its proportions, so the legend and details stay in view. */
    .graph { width: 100%; height: auto; max-height: calc(100vh - 230px); min-height: 200px; display: block; }
    .node { cursor: pointer; transition: opacity 0.15s; }
    .node:focus-visible { outline: none; }
    .node:focus-visible circle { stroke-width: calc(var(--u) * 4px); }
    .link { transition: opacity 0.15s; }
    .graph-wrap { position: relative; }
    /* Colours come from the theme's own variables in ordinary CSS, because that is what a colour-adjusting
       extension such as Dark Reader rewrites consistently; colours copied into attributes are missed. */
    /* --u is one screen pixel in drawing units, so outlines keep one thickness however far the drawing is scaled. */
    /* No fill: the name sits directly on the card, whatever background and colour adjustment it has, and links stop at the ring. */
    .node-shape { fill: transparent; pointer-events: all; stroke: var(--primary-text-color, CanvasText); stroke-width: calc(var(--u) * 2px); }
    .node-shape.coordinator { stroke: var(--primary-color, #03a9f4); stroke-width: calc(var(--u) * 3px); }
    .node-shape.battery { stroke-dasharray: calc(var(--u) * 4px) calc(var(--u) * 3px); }
    .node-text { fill: var(--primary-text-color, CanvasText); pointer-events: none; text-anchor: middle; }
    .label {
      position: absolute; transform: translate(-50%, -100%); white-space: nowrap; pointer-events: none;
      font-size: 13px; line-height: 1.2; padding: 2px 6px; border-radius: 4px;
      background: var(--ha-card-background, var(--card-background-color, Canvas));
      color: var(--primary-text-color, CanvasText);
      border: 1px solid var(--divider-color, GrayText);
    }
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
  /** Whether names are drawn inside the nodes and the pixels per drawing unit the layout was planned for. */
  @state() private plan: Plan = { inside: false, k: 1 };
  @state() private selected: string | undefined;
  @state() private error: string | undefined;
  @state() private scanning = false;
  /** Where the drawing sits inside its frame on screen: pixels per drawing unit and the margins left by fitting it uniformly. */
  @state() private frame = { scale: 1, offsetX: 0, offsetY: 0, width: WIDTH };

  /** The tallest the graph may be, in pixels, so the whole card fits the space left on the screen. */
  @state() private maxGraphHeight: number | undefined;

  /** The frame, in pixels, the current layout was planned for. */
  private layoutFrame = { width: 0, height: 0 };
  private relayoutTimer: ReturnType<typeof setTimeout> | undefined;
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
    if (this.graph !== undefined) {
      this.scheduleRelayout();
    }
  }

  getCardSize(): number {
    return 8;
  }

  static getStubConfig(): CardConfig {
    return { type: "custom:zha-network-graph-card", node_labels: "selected" };
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
      const { placement, plan } = await this.layoutFor(graph);
      if (loadId !== this.loadId) {
        return;
      }
      this.placement = placement;
      this.plan = plan;
      this.graph = graph;
      this.error = undefined;
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /**
   * Plans the layout for the room the card has on screen. In `inside` mode every node is drawn big enough to hold its
   * name, at a radius chosen from the room each device has; when the result still has to be drawn so small that the
   * names would be unreadable, the card falls back to small nodes and names only the selected device.
   */
  private async layoutFor(graph: Graph): Promise<{ placement: Placement; plan: Plan }> {
    const compact = async () => ({ placement: await layoutGraph(graph, { width: WIDTH, height: HEIGHT }), plan: { inside: false, k: 1 } });
    if (this.config?.node_labels !== "inside") {
      return compact();
    }
    // The card has no width until it has been laid out by the page.
    for (let frames = 0; this.clientWidth === 0 && frames < MAX_WAIT_FRAMES; frames += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, FRAME_WAIT_MS);
      });
    }
    const width = Math.max(this.clientWidth - CARD_PADDING, WIDTH / 2);
    const height = this.maxGraphHeight ?? Math.max(window.innerHeight - 300, MIN_GRAPH_PX);
    this.layoutFrame = { width, height };
    const roomPerDevice = Math.sqrt((width * height) / Math.max(graph.nodes.length, 1));
    const px = Math.min(Math.max(roomPerDevice * NODE_ROOM_FRACTION, NODE_PX_MIN), NODE_PX_MAX);
    const k = px / NODE_UNITS;
    const size = { width: width / k, height: height / k };
    // The longest a link may be drawn is a couple of device spacings: longer spreads the network past the frame
    // and shrinks the nodes, and with them their names.
    const spacing = Math.sqrt((size.width * size.height) / Math.max(graph.nodes.length, 1));
    const placement = await layoutGraph(graph, size, {
      radius: NODE_UNITS,
      aspect: size.width / size.height,
      maxLength: Math.max(MIN_LENGTH * 1.5, spacing * LENGTH_SPACINGS),
    });
    const textPx = (NODE_FONT_PX * Math.min(width / placement.size.width, height / placement.size.height)) / k;
    return textPx >= MIN_TEXT_PX ? { placement, plan: { inside: true, k } } : compact();
  }

  /** Re-plans the layout once the card's room has stopped changing, so a resize does not run the search on every step. */
  private scheduleRelayout(): void {
    clearTimeout(this.relayoutTimer);
    this.relayoutTimer = setTimeout(() => {
      const graph = this.graph;
      if (graph === undefined) {
        return;
      }
      this.loadId += 1;
      const loadId = this.loadId;
      void this.layoutFor(graph).then(({ placement, plan }) => {
        if (loadId === this.loadId) {
          this.placement = placement;
          this.plan = plan;
        }
      });
    }, RELAYOUT_DELAY_MS);
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

  /** Reads where the drawing sits on screen and the room left for it. */
  private measure(): void {
    const graph = this.renderRoot.querySelector(".graph");
    const card = this.renderRoot.querySelector("ha-card");
    if (graph === null || card === null) {
      return;
    }
    const view = this.placement?.size ?? { width: WIDTH, height: HEIGHT };
    const box = graph.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      // The drawing is scaled uniformly to fit the frame and centred, so the smaller ratio applies.
      const scale = Math.min(box.width / view.width, box.height / view.height);
      const next = {
        scale,
        offsetX: (box.width - view.width * scale) / 2,
        offsetY: (box.height - view.height * scale) / 2,
        width: box.width,
      };
      const now = this.frame;
      if (Math.abs(next.scale - now.scale) > 1e-3 || Math.abs(next.offsetX - now.offsetX) > 0.5 || Math.abs(next.offsetY - now.offsetY) > 0.5 || next.width !== now.width) {
        this.frame = next;
      }
    }
    // Everything in the card that is not the graph (toolbar, legend, details, padding) keeps its height.
    const chrome = card.getBoundingClientRect().height - box.height;
    const room = Math.floor(window.innerHeight - card.getBoundingClientRect().top - chrome - BOTTOM_MARGIN);
    const limit = Math.max(MIN_GRAPH_PX, room);
    if (limit !== this.maxGraphHeight) {
      this.maxGraphHeight = limit;
    }
    const planned = this.layoutFrame;
    const width = Math.max(this.clientWidth - CARD_PADDING, WIDTH / 2);
    if (
      this.config?.node_labels === "inside" &&
      this.graph !== undefined &&
      (Math.abs(width - planned.width) > planned.width * RELAYOUT_CHANGE || Math.abs(limit - planned.height) > planned.height * RELAYOUT_CHANGE)
    ) {
      this.scheduleRelayout();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    clearTimeout(this.relayoutTimer);
    this.observed = undefined;
    window.removeEventListener("resize", this.onWindowResize);
  }

  override render() {
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
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    return html`
      <div class="graph-wrap">
      <svg class="graph" style=${`--u: ${String(1 / Math.max(this.frame.scale, 0.05))};${this.maxGraphHeight === undefined ? "" : ` max-height: ${String(this.maxGraphHeight)}px`}`} viewBox="0 0 ${size.width} ${size.height}" role="group" aria-label="ZHA network graph" @click=${() => { this.selected = undefined; }}>
        ${graph.links.map((link) => {
          const from = positions.get(link.source);
          const to = positions.get(link.target);
          const fromNode = byId.get(link.source);
          const toNode = byId.get(link.target);
          if (from === undefined || to === undefined || fromNode === undefined || toNode === undefined) {
            return nothing;
          }
          const [start, end] = this.rimToRim(from, this.radiusOf(fromNode), to, this.radiusOf(toNode));
          const touching = link.source === focus || link.target === focus;
          return svg`<line class="link" x1=${start.x} y1=${start.y} x2=${end.x} y2=${end.y}
            stroke=${lqiColour(link.lqi)} style=${`stroke-width: calc(var(--u) * ${String(strokeFor(link.lqi))}px)`} stroke-linecap="round"
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
            <circle class=${`node-shape ${node.role === "coordinator" ? "coordinator" : node.battery ? "battery" : "mains"}`}
              cx=${at.x} cy=${at.y} r=${this.radiusOf(node)}
              style=${node.id === focus ? "stroke-width: calc(var(--u) * 4px)" : nothing} />
            ${this.plan.inside ? this.renderNodeText(node.name, at) : nothing}
            <title>${node.name}</title>
          </g>`;
        })}
      </svg>
      ${named.map((node) => {
        const at = positions.get(node.id);
        return at === undefined ? nothing : this.renderLabel(node, at);
      })}
      </div>
    `;
  }

  /** The two ends of a link, moved from the node centres out to the rims so a link never runs through a node's name. */
  private rimToRim(a: { x: number; y: number }, ra: number, b: { x: number; y: number }, rb: number): [{ x: number; y: number }, { x: number; y: number }] {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length <= ra + rb) {
      return [a, b];
    }
    const ux = dx / length;
    const uy = dy / length;
    return [
      { x: a.x + ux * ra, y: a.y + uy * ra },
      { x: b.x - ux * rb, y: b.y - uy * rb },
    ];
  }

  /** Radius in drawing units: one size when names are inside, otherwise by kind of device. */
  private radiusOf(node: GraphNode): number {
    return this.plan.inside ? NODE_UNITS : NODE_RADIUS[node.role];
  }

  /** The device name wrapped inside its node, vertically centred. */
  private renderNodeText(name: string, at: { x: number; y: number }) {
    const fontUnits = NODE_FONT_PX / this.plan.k;
    const lines = wrapName(name, textBoxFor(NODE_UNITS, fontUnits));
    const lineHeight = fontUnits * LINE_HEIGHT_EM;
    const first = at.y - ((lines.length - 1) * lineHeight) / 2;
    return svg`<text class="node-text" font-size=${fontUnits}>${lines.map(
      (line, index) => svg`<tspan x=${at.x} y=${first + index * lineHeight} dominant-baseline="central">${line}</tspan>`,
    )}</text>`;
  }

  /** A name tag above the node, an HTML element so it is themed like the rest of the card, kept inside the frame. */
  private renderLabel(node: GraphNode, at: { x: number; y: number }) {
    const { scale, offsetX, offsetY, width } = this.frame;
    // Half the tag's width, estimated from the name, so the tag can be kept inside the frame before it is measured.
    const half = (node.name.length * LABEL_CHAR_PX + 14) / 2;
    const left = Math.min(Math.max(offsetX + at.x * scale, half), Math.max(width - half, half));
    const top = Math.max(offsetY + (at.y - this.radiusOf(node)) * scale - 4, 20);
    return html`<div class="label" style=${`left: ${String(left)}px; top: ${String(top)}px`}>${node.name}</div>`;
  }

  private renderLegend() {
    const key = (role: GraphNode["role"], battery: boolean, label: string) => html`
      <span class="legend-item">
        <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle class=${`node-shape ${role === "coordinator" ? "coordinator" : battery ? "battery" : "mains"}`} r="6.5" stroke-width="2" />
        </svg>${label}
      </span>`;
    return html`
      <div class="legend">
        <span class="legend-item">Weak <span class="scale" role="img" aria-label="Link quality from weak, red, to strong, green"></span> Strong</span>
        ${key("coordinator", false, "Coordinator")}
        ${key("router", false, "Mains powered")}
        ${key("end-device", true, "Battery powered")}
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
