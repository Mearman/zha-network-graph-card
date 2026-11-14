import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { MAX_LQI } from "./graph";
import type { Graph, Role } from "./graph";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  /** Position of every node by id, inside `size`. */
  positions: ReadonlyMap<string, Point>;
  /** The area the positions occupy. At least the requested size, and larger when the nodes need the room to stay apart. */
  size: Size;
  /** Pairs of links that cross each other in these positions, ignoring links that share an end. */
  crossings: number;
}

/** Drawn radius of each kind of node, as the card draws it. */
export const NODE_RADIUS: Readonly<Record<Role, number>> = { coordinator: 12, router: 8, "end-device": 5 };
/** Clear space kept between any two drawn nodes, outline included. */
export const NODE_GAP = 6;

/** Link lengths before fitting, in arbitrary units: the strongest link is shortest. */
export const MIN_LENGTH = 30;
export const MAX_LENGTH = 220;

/** Independent starts tried per layout; each is a separate force simulation from a seeded random start. */
export const DEFAULT_RESTARTS = 12;
const TICKS = 400;
/** Candidate layouts, best first by crossings, that go on to the annealing pass. */
export const REFINED_CANDIDATES = 3;
/** Moves tried per annealed candidate. */
export const DEFAULT_REFINE_STEPS = 60000;
/** What one crossing costs the annealer, in the squared length error of links: about a 45 unit error. */
const CROSSING_COST = 2000;
/** A moved node may not come closer than this to another node, so annealing cannot pile nodes together. */
const MIN_SEPARATION = MIN_LENGTH * 0.7;
const PADDING = 24;
/** Spacing of the row of devices that have no known link, in the same units as the size. */
const ROW_SPACING = 2 * NODE_RADIUS.coordinator + NODE_GAP;
/** Pull towards the centre that keeps separate groups of linked devices from drifting apart. */
const GRAVITY = 0.04;

/** The length a link of this quality wants: linear from MAX_LENGTH at LQI 0 down to MIN_LENGTH at 255. */
export function idealLength(lqi: number): number {
  const clamped = Math.min(Math.max(lqi, 0), MAX_LQI);
  return MAX_LENGTH - ((MAX_LENGTH - MIN_LENGTH) * clamped) / MAX_LQI;
}

type Segment = readonly [Point, Point];

function orientation(a: Point, b: Point, c: Point): number {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

function cross(first: Segment, second: Segment): boolean {
  const [a, b] = first;
  const [c, d] = second;
  return orientation(a, b, c) !== orientation(a, b, d) && orientation(c, d, a) !== orientation(c, d, b);
}

/** Counts pairs of links whose drawn segments properly cross. Links that share a node never count. */
export function countCrossings(
  positions: ReadonlyMap<string, Point>,
  links: readonly { source: string; target: string }[],
): number {
  let crossings = 0;
  for (let i = 0; i < links.length; i += 1) {
    for (let j = i + 1; j < links.length; j += 1) {
      const first = links[i];
      const second = links[j];
      if (first === undefined || second === undefined) {
        continue;
      }
      if (
        first.source === second.source ||
        first.source === second.target ||
        first.target === second.source ||
        first.target === second.target
      ) {
        continue;
      }
      const a = positions.get(first.source);
      const b = positions.get(first.target);
      const c = positions.get(second.source);
      const d = positions.get(second.target);
      if (a !== undefined && b !== undefined && c !== undefined && d !== undefined && cross([a, b], [c, d])) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

/** A small seeded generator (mulberry32) so a layout is reproducible: the same data always draws the same picture. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

type SimNode = SimulationNodeDatum & { id: string };
type SimLink = SimulationLinkDatum<SimNode> & { lqi: number };

/** How far each link is from the length its quality asks for, squared and summed. Lower is a truer picture. */
function stress(positions: ReadonlyMap<string, Point>, links: Graph["links"]): number {
  let total = 0;
  for (const link of links) {
    const a = positions.get(link.source);
    const b = positions.get(link.target);
    if (a !== undefined && b !== undefined) {
      total += (Math.hypot(a.x - b.x, a.y - b.y) - idealLength(link.lqi)) ** 2;
    }
  }
  return total;
}

function simulate(graph: Graph, seed: number): Map<string, Point> {
  const random = seededRandom(seed);
  const spread = MAX_LENGTH * Math.sqrt(graph.nodes.length);
  const nodes: SimNode[] = graph.nodes.map((node) => ({
    id: node.id,
    x: random() * spread,
    y: random() * spread,
  }));
  const links: SimLink[] = graph.links.map((link) => ({ source: link.source, target: link.target, lqi: link.lqi }));
  forceSimulation(nodes)
    .randomSource(random)
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((node) => node.id)
        .distance((link) => idealLength(link.lqi))
        .strength(1),
    )
    .force("charge", forceManyBody().strength(-120))
    .force("collide", forceCollide(MIN_LENGTH / 2))
    .force("centre", forceCenter(0, 0))
    .force("gravity-x", forceX(0).strength(GRAVITY))
    .force("gravity-y", forceY(0).strength(GRAVITY))
    .stop()
    .tick(TICKS);
  return new Map(nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
}

/**
 * The smallest uniform scale at which no two nodes overlap: for every pair, the distance between them must
 * be at least their radii plus NODE_GAP. This is exact, unlike a collision force, which only discourages
 * overlap. Positions that coincide exactly are separated first, because no scale can pull them apart.
 */
function clearanceScale(positions: Map<string, Point>, radii: ReadonlyMap<string, number>): number {
  const entries = [...positions];
  entries.forEach(([id, point], index) => {
    if (entries.slice(0, index).some(([, other]) => other.x === point.x && other.y === point.y)) {
      positions.set(id, { x: point.x + (index + 1) * 1e-3, y: point.y });
    }
  });
  let scale = 0;
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [firstId] = entries[i] ?? [];
      const [secondId] = entries[j] ?? [];
      const a = firstId === undefined ? undefined : positions.get(firstId);
      const b = secondId === undefined ? undefined : positions.get(secondId);
      if (firstId === undefined || secondId === undefined || a === undefined || b === undefined) {
        continue;
      }
      const required = (radii.get(firstId) ?? 0) + (radii.get(secondId) ?? 0) + NODE_GAP;
      scale = Math.max(scale, required / Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return scale;
}

interface Fitted {
  positions: Map<string, Point>;
  width: number;
  height: number;
}

/**
 * Scales and moves the positions uniformly so they fill the size when that keeps every node clear of the
 * others, and otherwise scales further, growing the area, until they are clear. Uniform scaling leaves relative
 * link lengths and crossings unchanged.
 */
function fit(positions: Map<string, Point>, size: Size, radii: ReadonlyMap<string, number>): Fitted {
  const points = [...positions.values()];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  const toFill = Math.min(
    spanX === 0 ? Infinity : (size.width - 2 * PADDING) / spanX,
    spanY === 0 ? Infinity : (size.height - 2 * PADDING) / spanY,
  );
  const scale = Math.max(Number.isFinite(toFill) ? toFill : 1, clearanceScale(positions, radii));
  const width = Math.max(size.width, spanX * scale + 2 * PADDING);
  const height = Math.max(size.height, spanY * scale + 2 * PADDING);
  return {
    positions: new Map(
      [...positions].map(([id, point]) => [
        id,
        { x: (point.x - minX) * scale + (width - spanX * scale) / 2, y: (point.y - minY) * scale + (height - spanY * scale) / 2 },
      ]),
    ),
    width,
    height,
  };
}


/**
 * Simulated annealing on the finished force layout. Each step moves one node by a random offset and keeps the
 * move when it lowers a cost of crossings plus squared link-length error, or, early on while the temperature is
 * high, sometimes when it does not, so the search can leave a poor arrangement. Only links at the moved node are
 * re-examined, so a step costs a small multiple of the link count. Seeded, so the result is reproducible.
 */
function anneal(start: ReadonlyMap<string, Point>, graph: Graph, seed: number, steps: number): Map<string, Point> {
  const ids = [...start.keys()];
  const slot = new Map(ids.map((id, index) => [id, index]));
  const xs = Float64Array.from(ids, (id) => start.get(id)?.x ?? 0);
  const ys = Float64Array.from(ids, (id) => start.get(id)?.y ?? 0);
  const ends: [number, number][] = [];
  const ideal: number[] = [];
  const incident: number[][] = ids.map(() => []);
  for (const link of graph.links) {
    const a = slot.get(link.source);
    const b = slot.get(link.target);
    if (a !== undefined && b !== undefined) {
      incident[a]?.push(ends.length);
      incident[b]?.push(ends.length);
      ends.push([a, b]);
      ideal.push(idealLength(link.lqi));
    }
  }
  const x = (index: number): number => xs[index] ?? 0;
  const y = (index: number): number => ys[index] ?? 0;
  const side = (a: number, b: number, c: number): number => Math.sign((x(b) - x(a)) * (y(c) - y(a)) - (y(b) - y(a)) * (x(c) - x(a)));
  const crosses = (l: number, m: number): boolean => {
    const [a, b] = ends[l] ?? [0, 0];
    const [c, d] = ends[m] ?? [0, 0];
    if (a === c || a === d || b === c || b === d) {
      return false;
    }
    return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
  };
  /** Crossings of the links at `node` with every other link. */
  const crossingsAt = (node: number): number => {
    let count = 0;
    for (const l of incident[node] ?? []) {
      for (let m = 0; m < ends.length; m += 1) {
        if (m !== l && crosses(l, m)) {
          count += 1;
        }
      }
    }
    return count;
  };
  const lengthError = (node: number): number => {
    let total = 0;
    for (const l of incident[node] ?? []) {
      const [a, b] = ends[l] ?? [0, 0];
      total += (Math.hypot(x(a) - x(b), y(a) - y(b)) - (ideal[l] ?? 0)) ** 2;
    }
    return total;
  };
  const crowded = (node: number): boolean => {
    for (let other = 0; other < ids.length; other += 1) {
      if (other !== node && Math.hypot(x(node) - x(other), y(node) - y(other)) < MIN_SEPARATION) {
        return true;
      }
    }
    return false;
  };

  const random = seededRandom(seed);
  const hot = CROSSING_COST;
  const cold = 2;
  for (let step = 0; step < steps; step += 1) {
    const progress = step / steps;
    const temperature = hot * (cold / hot) ** progress;
    const reach = MIN_LENGTH + MAX_LENGTH * 0.5 * (1 - progress);
    const node = Math.floor(random() * ids.length);
    const [oldX, oldY] = [x(node), y(node)];
    const before = CROSSING_COST * crossingsAt(node) + lengthError(node);
    xs[node] = oldX + (random() * 2 - 1) * reach;
    ys[node] = oldY + (random() * 2 - 1) * reach;
    const delta = CROSSING_COST * crossingsAt(node) + lengthError(node) - before;
    if (crowded(node) || (delta > 0 && random() >= Math.exp(-delta / temperature))) {
      xs[node] = oldX;
      ys[node] = oldY;
    }
  }
  return new Map(ids.map((id, index) => [id, { x: x(index), y: y(index) }]));
}

/**
 * Devices that appear in no link are not part of the mesh as far as ZHA's neighbour tables say, so they are
 * kept out of the force simulation (nothing would hold them near the rest) and drawn as a tidy row below it.
 */
function placeUnlinked(ids: readonly string[], size: Size, top: number): Map<string, Point> {
  const perRow = Math.max(1, Math.floor((size.width - 2 * PADDING) / ROW_SPACING));
  return new Map(
    [...ids].sort().map((id, index) => {
      const inRow = Math.min(perRow, ids.length - Math.floor(index / perRow) * perRow);
      const column = index % perRow;
      return [
        id,
        {
          x: (size.width - (inRow - 1) * ROW_SPACING) / 2 + column * ROW_SPACING,
          y: top + Math.floor(index / perRow) * ROW_SPACING,
        },
      ];
    }),
  );
}

/**
 * Lays the graph out by running several force simulations from different seeded random starts and keeping
 * the one with the fewest crossing links. Ties go to the layout whose link lengths best match their signal
 * quality. Crossing minimisation is NP-hard, so this is a search over starts, not a guarantee of the minimum.
 * It yields to the event loop between starts so a large network does not freeze the page while it searches.
 * Devices with no link are placed in a row below the mesh.
 */
export interface LayoutOptions {
  /** Independent force-simulation starts to try. */
  restarts?: number;
  /** Annealing moves for each of the best starts; 0 turns the annealing pass off. */
  refineSteps?: number;
}

export async function layoutGraph(graph: Graph, size: Size, options: LayoutOptions = {}): Promise<Placement> {
  const { restarts = DEFAULT_RESTARTS, refineSteps = DEFAULT_REFINE_STEPS } = options;
  const radii = new Map(graph.nodes.map((node) => [node.id, NODE_RADIUS[node.role]]));
  const linked = new Set(graph.links.flatMap((link) => [link.source, link.target]));
  const unlinked = graph.nodes.filter((node) => !linked.has(node.id)).map((node) => node.id);
  const meshNodes = graph.nodes.filter((node) => linked.has(node.id));

  let mesh: Fitted = { positions: new Map(), width: size.width, height: 0 };
  let crossings = 0;
  if (meshNodes.length > 0) {
    const meshGraph: Graph = { nodes: meshNodes, links: graph.links };
    const candidates: { positions: Map<string, Point>; crossings: number; stress: number }[] = [];
    for (let seed = 1; seed <= restarts; seed += 1) {
      await yieldToEventLoop();
      const positions = simulate(meshGraph, seed);
      candidates.push({ positions, crossings: countCrossings(positions, graph.links), stress: stress(positions, graph.links) });
    }
    const byQuality = (a: { crossings: number; stress: number }, b: { crossings: number; stress: number }): number =>
      a.crossings - b.crossings || a.stress - b.stress;
    candidates.sort(byQuality);
    for (const [rank, candidate] of candidates.slice(0, REFINED_CANDIDATES).entries()) {
      await yieldToEventLoop();
      const positions = anneal(candidate.positions, meshGraph, 1000 + rank, refineSteps);
      candidates.push({ positions, crossings: countCrossings(positions, graph.links), stress: stress(positions, graph.links) });
    }
    candidates.sort(byQuality);
    const best = candidates[0];
    if (best === undefined) {
      throw new Error("layoutGraph needs at least one restart");
    }
    crossings = best.crossings;
    const reserved = unlinked.length === 0 ? 0 : 2 * ROW_SPACING + PADDING;
    mesh = fit(best.positions, { width: size.width, height: Math.max(size.height - reserved, 2 * PADDING) }, radii);
  }

  const width = Math.max(size.width, mesh.width);
  const perRow = Math.max(1, Math.floor((width - 2 * PADDING) / ROW_SPACING));
  const rows = Math.ceil(unlinked.length / perRow);
  const rowTop = (meshNodes.length === 0 ? 0 : mesh.height) + PADDING;
  const height = Math.max(size.height, rowTop + (rows === 0 ? 0 : (rows - 1) * ROW_SPACING + PADDING));
  const positions = new Map(mesh.positions);
  if (mesh.width < width) {
    for (const [id, point] of positions) {
      positions.set(id, { x: point.x + (width - mesh.width) / 2, y: point.y });
    }
  }
  for (const [id, point] of placeUnlinked(unlinked, { width, height }, rowTop)) {
    positions.set(id, point);
  }
  return { positions, size: { width, height }, crossings };
}
