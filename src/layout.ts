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
  /** Pairs of a link and a node that is not one of its ends but is drawn on top of it. */
  edgeHits: number;
}

/** Drawn radius of each kind of node, as the card draws it. */
export const NODE_RADIUS: Readonly<Record<Role, number>> = { coordinator: 12, router: 8, "end-device": 5 };
/** Clear space kept between any two drawn nodes, outline included. */
export const NODE_GAP = 6;
/** Clear space kept between a drawn node and any link that is not its own, measured from the node's edge. */
export const EDGE_CLEARANCE = 10;

/** Link lengths before fitting, in arbitrary units: the strongest link is shortest. */
export const MIN_LENGTH = 30;
export const MAX_LENGTH = 220;

/** Independent starts tried per layout; each is a separate force simulation from a seeded random start. */
export const DEFAULT_RESTARTS = 12;
const TICKS = 400;
/** Candidate layouts, best first by crossings, that go on to the annealing pass. */
export const REFINED_CANDIDATES = 3;
/** Moves tried per annealed candidate. */
export const DEFAULT_REFINE_STEPS = 100000;

/**
 * Link-pair and node-link tests one annealing pass may perform. A pass runs without yielding, so this bounds how long
 * it can hold the page; networks small enough to fit keep the full step count.
 */
export const ANNEAL_WORK_BUDGET = 4e7;

/**
 * The tests one annealing step performs on average, before and after the move: the links at the moved node against
 * every link, plus every link against the node and every node against the links at the moved node. A node has
 * `2 * links / nodes` links on average.
 */
export function annealStepCost(nodes: number, links: number): number {
  const perNode = nodes === 0 ? 0 : (2 * links) / nodes;
  return 2 * (perNode * links + links + perNode * nodes);
}

/** The annealing steps to run: the requested count, cut to what ANNEAL_WORK_BUDGET allows for a network of this size. */
export function stepsWithinBudget(nodes: number, links: number, requested: number): number {
  const cost = annealStepCost(nodes, links);
  return cost === 0 ? requested : Math.min(requested, Math.floor(ANNEAL_WORK_BUDGET / cost));
}
/** What one crossing costs the annealer, in the squared length error of links: about a 45 unit error. */
const CROSSING_COST = 2000;
/** A moved node may not come closer than this to another node, so annealing cannot pile nodes together. */
const MIN_SEPARATION = MIN_LENGTH * 0.7;
/** Passes of the repair that walks nodes off links they sit on. */
const REPAIR_ROUNDS = 60;
/** Passes of the leaf placement, angles tried around the parent, and distances as fractions of the signal's length. */
const LEAF_PASSES = 3;
/** The core is small, so its annealing runs this many times longer than a whole-network pass. */
const CORE_STEP_FACTOR = 4;
const LEAF_ANGLES = 72;
const LEAF_DISTANCES = [1, 0.75, 0.55, 0.4, 0.3, 1.3, 1.7] as const;
/** What one defect costs a leaf's score, in length units: far more than any length error. */
const LEAF_DEFECT = 1000;
const PADDING = 24;
/** Spacing of the row of devices that have no known link, in the same units as the size. */
const ROW_SPACING = 2 * NODE_RADIUS.coordinator + NODE_GAP;
/** Pull towards the centre that keeps separate groups of linked devices from drifting apart. */
const GRAVITY = 0.04;

/** The length a link of this quality wants: linear from `maxLength` at LQI 0 down to MIN_LENGTH at 255. */
export function idealLength(lqi: number, maxLength: number = MAX_LENGTH): number {
  const clamped = Math.min(Math.max(lqi, 0), MAX_LQI);
  return maxLength - ((maxLength - MIN_LENGTH) * clamped) / MAX_LQI;
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

/** Squared distance from (px, py) to the segment (ax, ay) to (bx, by). Takes plain numbers so the annealer's inner loop allocates nothing. */
function segmentDistanceSquared(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0), 1);
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}

/** Counts pairs of a link and a node, other than its two ends, whose drawn node comes within EDGE_CLEARANCE of the link. */
export function countEdgeHits(
  positions: ReadonlyMap<string, Point>,
  links: readonly { source: string; target: string }[],
  radii: ReadonlyMap<string, number>,
): number {
  let hits = 0;
  for (const link of links) {
    const a = positions.get(link.source);
    const b = positions.get(link.target);
    if (a === undefined || b === undefined) {
      continue;
    }
    for (const [id, point] of positions) {
      if (id !== link.source && id !== link.target && segmentDistanceSquared(point.x, point.y, a.x, a.y, b.x, b.y) < ((radii.get(id) ?? 0) + EDGE_CLEARANCE) ** 2) {
        hits += 1;
      }
    }
  }
  return hits;
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
function stress(positions: ReadonlyMap<string, Point>, links: Graph["links"], maxLength: number): number {
  let total = 0;
  for (const link of links) {
    const a = positions.get(link.source);
    const b = positions.get(link.target);
    if (a !== undefined && b !== undefined) {
      total += (Math.hypot(a.x - b.x, a.y - b.y) - idealLength(link.lqi, maxLength)) ** 2;
    }
  }
  return total;
}

function simulate(graph: Graph, seed: number, maxLength: number, aspect: number): Map<string, Point> {
  const random = seededRandom(seed);
  const spread = maxLength * Math.sqrt(graph.nodes.length);
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
        .distance((link) => idealLength(link.lqi, maxLength))
        .strength(1),
    )
    .force("charge", forceManyBody().strength(-120))
    .force("collide", forceCollide(MIN_LENGTH / 2))
    .force("centre", forceCenter(0, 0))
    // A wide frame pulls less along x and more along y, so the network spreads to fill the room it has.
    .force("gravity-x", forceX(0).strength(GRAVITY / aspect))
    .force("gravity-y", forceY(0).strength(GRAVITY * aspect))
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
  /** The factor the input positions were multiplied by. */
  scale: number;
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
    scale,
  };
}


/**
 * Simulated annealing on the finished force layout. Each step moves one node by a random offset and keeps the
 * move when it lowers a cost of crossings plus squared link-length error, or, early on while the temperature is
 * high, sometimes when it does not, so the search can leave a poor arrangement. Only links at the moved node are
 * re-examined, so a step costs a small multiple of the link count. Seeded, so the result is reproducible.
 */
function anneal(
  start: ReadonlyMap<string, Point>,
  graph: Graph,
  seed: number,
  steps: number,
  clearance: ReadonlyMap<string, number>,
  maxLength: number,
): Map<string, Point> {
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
      ideal.push(idealLength(link.lqi, maxLength));
    }
  }
  const budgeted = stepsWithinBudget(ids.length, ends.length, steps);
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
  const reach2 = ids.map((id) => clearance.get(id) ?? 0);
  const near = (node: number, link: number): boolean => {
    const [a, b] = ends[link] ?? [0, 0];
    const reach = reach2[node] ?? 0;
    return node !== a && node !== b && segmentDistanceSquared(x(node), y(node), x(a), y(a), x(b), y(b)) < reach * reach;
  };
  /** Node-over-link overlaps involving `node`, either as the node sitting on a link or as an end of the link being sat on. */
  const hitsAt = (node: number): number => {
    let count = 0;
    for (let l = 0; l < ends.length; l += 1) {
      if (near(node, l)) {
        count += 1;
      }
    }
    for (const l of incident[node] ?? []) {
      for (let k = 0; k < ids.length; k += 1) {
        if (near(k, l)) {
          count += 1;
        }
      }
    }
    return count;
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
  for (let step = 0; step < budgeted; step += 1) {
    const progress = step / budgeted;
    const temperature = hot * (cold / hot) ** progress;
    const reach = MIN_LENGTH + maxLength * 0.5 * (1 - progress);
    const node = Math.floor(random() * ids.length);
    const [oldX, oldY] = [x(node), y(node)];
    const before = CROSSING_COST * (crossingsAt(node) + hitsAt(node)) + lengthError(node);
    xs[node] = oldX + (random() * 2 - 1) * reach;
    ys[node] = oldY + (random() * 2 - 1) * reach;
    const delta = CROSSING_COST * (crossingsAt(node) + hitsAt(node)) + lengthError(node) - before;
    if (crowded(node) || (delta > 0 && random() >= Math.exp(-delta / temperature))) {
      xs[node] = oldX;
      ys[node] = oldY;
    }
  }
  return new Map(ids.map((id, index) => [id, { x: x(index), y: y(index) }]));
}

/**
 * Moves every device with a single link to the best free spot around its parent. A leaf cannot take part in a
 * crossing except through its own one link, so no arrangement of the rest forces it to cross anything: trying
 * each angle and a few distances around the parent finds a spot that crosses no link, touches no node and keeps
 * the link near the length its signal asks for. `reach` is each node's radius plus clearance and `body` its radius,
 * both in the same units as the positions, and `gap` is the clear space kept between two nodes.
 */
function placeLeaves(
  start: ReadonlyMap<string, Point>,
  graph: Graph,
  reach: ReadonlyMap<string, number>,
  body: ReadonlyMap<string, number>,
  gap: number,
  maxLength: number,
): Map<string, Point> {
  const ids = [...start.keys()];
  const slot = new Map(ids.map((id, index) => [id, index]));
  const xs = Float64Array.from(ids, (id) => start.get(id)?.x ?? 0);
  const ys = Float64Array.from(ids, (id) => start.get(id)?.y ?? 0);
  const ends: [number, number][] = [];
  const ideal: number[] = [];
  const degree = new Array<number>(ids.length).fill(0);
  for (const link of graph.links) {
    const a = slot.get(link.source);
    const b = slot.get(link.target);
    if (a !== undefined && b !== undefined) {
      ends.push([a, b]);
      ideal.push(idealLength(link.lqi, maxLength));
      degree[a] = (degree[a] ?? 0) + 1;
      degree[b] = (degree[b] ?? 0) + 1;
    }
  }
  const x = (index: number): number => xs[index] ?? 0;
  const y = (index: number): number => ys[index] ?? 0;
  const side = (a: number, b: number, c: number): number => Math.sign((x(b) - x(a)) * (y(c) - y(a)) - (y(b) - y(a)) * (x(c) - x(a)));
  const radiusOf = (index: number): number => body.get(ids[index] ?? "") ?? 0;
  const reachOf = (index: number): number => reach.get(ids[index] ?? "") ?? 0;
  const distanceToLink = (node: number, link: number): number => {
    const [a, b] = ends[link] ?? [0, 0];
    return Math.sqrt(segmentDistanceSquared(x(node), y(node), x(a), y(a), x(b), y(b)));
  };

  /** Defects of the one link `link` and the node `leaf` at the leaf's current position, weighted equally. */
  const defects = (leaf: number, link: number): number => {
    const [a, b] = ends[link] ?? [0, 0];
    let count = 0;
    for (let m = 0; m < ends.length; m += 1) {
      const [c, d] = ends[m] ?? [0, 0];
      if (m === link || a === c || a === d || b === c || b === d) {
        continue;
      }
      if (side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b)) {
        count += 1;
      }
      if (c !== leaf && d !== leaf && distanceToLink(leaf, m) < reachOf(leaf)) {
        count += 1;
      }
    }
    for (let k = 0; k < ids.length; k += 1) {
      if (k !== a && k !== b && distanceToLink(k, link) < reachOf(k)) {
        count += 1;
      }
      if (k !== leaf && Math.hypot(x(k) - x(leaf), y(k) - y(leaf)) < radiusOf(k) + radiusOf(leaf) + gap) {
        count += 1;
      }
    }
    return count;
  };

  const leaves = ids.map((_, index) => index).filter((index) => degree[index] === 1);
  for (let pass = 0; pass < LEAF_PASSES; pass += 1) {
    for (const leaf of leaves) {
      const link = ends.findIndex(([a, b]) => a === leaf || b === leaf);
      const [a, b] = ends[link] ?? [0, 0];
      const parent = a === leaf ? b : a;
      const wanted = ideal[link] ?? 0;
      const [startX, startY] = [x(leaf), y(leaf)];
      let best = { x: startX, y: startY, score: defects(leaf, link) * LEAF_DEFECT + Math.abs(Math.hypot(startX - x(parent), startY - y(parent)) - wanted) };
      for (let step = 0; step < LEAF_ANGLES; step += 1) {
        const angle = (2 * Math.PI * step) / LEAF_ANGLES;
        for (const factor of LEAF_DISTANCES) {
          const distance = Math.max(wanted * factor, reachOf(parent) + reachOf(leaf));
          xs[leaf] = x(parent) + Math.cos(angle) * distance;
          ys[leaf] = y(parent) + Math.sin(angle) * distance;
          const score = defects(leaf, link) * LEAF_DEFECT + Math.abs(distance - wanted);
          if (score < best.score) {
            best = { x: x(leaf), y: y(leaf), score };
          }
        }
      }
      xs[leaf] = best.x;
      ys[leaf] = best.y;
    }
  }
  return new Map(ids.map((id, index) => [id, { x: x(index), y: y(index) }]));
}

/**
 * Layouts that arrange only the devices with two or more links, which are the ones whose placement decides the
 * crossings, with far more annealing than the whole network could afford since the core is small, and then
 * hang each single-link device off its parent in the best free spot. A leaf placed afterwards cannot be forced
 * across anything, so the crossings left are the core's own.
 */
async function coreCandidates(
  mesh: Graph,
  options: { restarts: number; refineSteps: number; maxLength: number; aspect: number },
  scale: number,
  radii: ReadonlyMap<string, number>,
  yieldNow: () => Promise<void>,
): Promise<Map<string, Point>[]> {
  const degree = new Map<string, number>();
  for (const link of mesh.links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }
  const isCore = (id: string): boolean => (degree.get(id) ?? 0) > 1;
  const coreNodes = mesh.nodes.filter((node) => isCore(node.id));
  if (coreNodes.length < 3 || coreNodes.length === mesh.nodes.length) {
    return [];
  }
  const core: Graph = { nodes: coreNodes, links: mesh.links.filter((link) => isCore(link.source) && isCore(link.target)) };
  const reach = new Map([...radii].map(([id, radius]) => [id, (radius + EDGE_CLEARANCE) / scale]));
  const body = new Map([...radii].map(([id, radius]) => [id, radius / scale]));

  const starts: { positions: Map<string, Point>; crossings: number; stress: number }[] = [];
  for (let seed = 1; seed <= options.restarts; seed += 1) {
    await yieldNow();
    const positions = simulate(core, seed, options.maxLength, options.aspect);
    starts.push({ positions, crossings: countCrossings(positions, core.links), stress: stress(positions, core.links, options.maxLength) });
  }
  starts.sort((a, b) => a.crossings - b.crossings || a.stress - b.stress);

  const results: Map<string, Point>[] = [];
  for (const [rank, start] of starts.slice(0, REFINED_CANDIDATES).entries()) {
    await yieldNow();
    const refined = anneal(start.positions, core, 2000 + rank, options.refineSteps * CORE_STEP_FACTOR, reach, options.maxLength);
    // Each leaf starts just outside its parent, away from the middle of the core, and is then moved to the best spot.
    const centre = { x: 0, y: 0 };
    for (const point of refined.values()) {
      centre.x += point.x / refined.size;
      centre.y += point.y / refined.size;
    }
    const all = new Map(refined);
    let index = 0;
    for (const link of mesh.links) {
      // A link between a core device and a single-link device: the single-link end is the leaf.
      if (isCore(link.source) === isCore(link.target)) {
        continue;
      }
      const leaf = isCore(link.source) ? link.target : link.source;
      const parent = isCore(link.source) ? link.source : link.target;
      const at = refined.get(parent);
      if (at === undefined) {
        continue;
      }
      const angle = at.x === centre.x && at.y === centre.y ? index : Math.atan2(at.y - centre.y, at.x - centre.x);
      const length = idealLength(link.lqi, options.maxLength);
      all.set(leaf, { x: at.x + Math.cos(angle) * length, y: at.y + Math.sin(angle) * length });
      index += 1;
    }
    // Links between two single-link devices leave both unplaced above; give them a spot next to the centre.
    for (const node of mesh.nodes) {
      if (!all.has(node.id)) {
        all.set(node.id, { x: centre.x + index * 7, y: centre.y + 40 });
        index += 1;
      }
    }
    results.push(placeLeaves(all, mesh, reach, body, NODE_GAP / scale, options.maxLength));
  }
  return results;
}

/**
 * Pushes every node that sits on a link that is not its own straight off that link, to just past the clearance,
 * and repeats while that creates no endless chase. Annealing minimises these overlaps but cannot promise to
 * remove the last one, so this walks them out directly. `clearance` is each node's radius plus EDGE_CLEARANCE in
 * the same units as the positions.
 */
function repair(start: ReadonlyMap<string, Point>, links: Graph["links"], clearance: ReadonlyMap<string, number>): Map<string, Point> {
  const positions = new Map(start);
  for (let round = 0; round < REPAIR_ROUNDS; round += 1) {
    let moved = false;
    for (const link of links) {
      const a = positions.get(link.source);
      const b = positions.get(link.target);
      if (a === undefined || b === undefined) {
        continue;
      }
      for (const [id, point] of positions) {
        const reach = clearance.get(id) ?? 0;
        if (id === link.source || id === link.target || segmentDistanceSquared(point.x, point.y, a.x, a.y, b.x, b.y) >= reach * reach) {
          continue;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared === 0 ? 0 : Math.min(Math.max(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0), 1);
        const nearestX = a.x + t * dx;
        const nearestY = a.y + t * dy;
        const away = Math.hypot(point.x - nearestX, point.y - nearestY);
        // A node exactly on the link has no direction to leave by, so it leaves along the link's normal.
        const [ux, uy] = away === 0 ? [-dy / Math.sqrt(lengthSquared || 1), dx / Math.sqrt(lengthSquared || 1)] : [(point.x - nearestX) / away, (point.y - nearestY) / away];
        positions.set(id, { x: nearestX + ux * (reach + 0.5), y: nearestY + uy * (reach + 0.5) });
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
  return positions;
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
 * Devices with no link are placed in a row below the mesh. Drawing no link over a node that is not its end is
 * pursued the same way (annealing penalty, then a repair pass, then ranking by it first) but is not guaranteed.
 */
export interface LayoutOptions {
  /** Independent force-simulation starts to try. */
  restarts?: number;
  /** Annealing moves for each of the best starts; 0 turns the annealing pass off. */
  refineSteps?: number;
  /** Width over height of the frame, so a wide frame spreads the network along x. Leave unset for a symmetric pull. */
  aspect?: number;
  /** The length a link of LQI 0 is drawn at; the strongest link is MIN_LENGTH. Smaller values pack the network into less room. */
  maxLength?: number;
  /** Draws every node with this radius instead of the radius for its kind, so a node can hold its own label. */
  radius?: number;
}

export async function layoutGraph(graph: Graph, size: Size, options: LayoutOptions = {}): Promise<Placement> {
  const { restarts = DEFAULT_RESTARTS, refineSteps = DEFAULT_REFINE_STEPS, radius, maxLength = MAX_LENGTH, aspect = 1 } = options;
  const radii = new Map(graph.nodes.map((node) => [node.id, radius ?? NODE_RADIUS[node.role]]));
  const linked = new Set(graph.links.flatMap((link) => [link.source, link.target]));
  const unlinked = graph.nodes.filter((node) => !linked.has(node.id)).map((node) => node.id);
  const meshNodes = graph.nodes.filter((node) => linked.has(node.id));

  let mesh: Fitted = { positions: new Map(), width: size.width, height: 0, scale: 1 };
  let crossings = 0;
  let edgeHits = 0;
  if (meshNodes.length > 0) {
    const meshGraph: Graph = { nodes: meshNodes, links: graph.links };
    const reserved = unlinked.length === 0 ? 0 : 2 * ROW_SPACING + PADDING;
    const meshSize = { width: size.width, height: Math.max(size.height - reserved, 2 * PADDING) };
    /** Judges a layout as it will be drawn, because fitting scales positions but not node sizes. */
    const evaluate = (positions: Map<string, Point>) => {
      const fitted = fit(new Map(positions), meshSize, radii);
      return {
        positions,
        fitted,
        edgeHits: countEdgeHits(fitted.positions, graph.links, radii),
        crossings: countCrossings(fitted.positions, graph.links),
        stress: stress(positions, graph.links, maxLength),
      };
    };
    type Candidate = ReturnType<typeof evaluate>;
    const byQuality = (a: Candidate, b: Candidate): number =>
      a.edgeHits + a.crossings - (b.edgeHits + b.crossings) || a.edgeHits - b.edgeHits || a.stress - b.stress;

    const candidates: Candidate[] = [];
    for (let seed = 1; seed <= restarts; seed += 1) {
      await yieldToEventLoop();
      candidates.push(evaluate(simulate(meshGraph, seed, maxLength, aspect)));
    }
    candidates.sort(byQuality);
    for (const [rank, candidate] of candidates.slice(0, REFINED_CANDIDATES).entries()) {
      await yieldToEventLoop();
      const clearance = new Map([...radii].map(([id, radius]) => [id, (radius + EDGE_CLEARANCE) / candidate.fitted.scale]));
      const annealed = anneal(candidate.positions, meshGraph, 1000 + rank, refineSteps, clearance, maxLength);
      const bodies = new Map([...radii].map(([id, radius]) => [id, radius / candidate.fitted.scale]));
      const leafed = placeLeaves(annealed, meshGraph, clearance, bodies, NODE_GAP / candidate.fitted.scale, maxLength);
      candidates.push(evaluate(annealed), evaluate(repair(leafed, graph.links, clearance)));
    }
    const scale = candidates[0]?.fitted.scale ?? 1;
    for (const positions of await coreCandidates(meshGraph, { restarts, refineSteps, maxLength, aspect }, scale, radii, yieldToEventLoop)) {
      const clearance = new Map([...radii].map(([id, radius]) => [id, (radius + EDGE_CLEARANCE) / scale]));
      candidates.push(evaluate(positions), evaluate(repair(positions, graph.links, clearance)));
    }
    candidates.sort(byQuality);
    const best = candidates[0];
    if (best === undefined) {
      throw new Error("layoutGraph needs at least one restart");
    }
    crossings = best.crossings;
    edgeHits = best.edgeHits;
    mesh = best.fitted;
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
  return { positions, size: { width, height }, crossings, edgeHits };
}
