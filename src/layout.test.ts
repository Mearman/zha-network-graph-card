import { describe, expect, it } from "vitest";
import type { Graph, GraphNode } from "./graph";
import { EDGE_CLEARANCE, MAX_LENGTH, MIN_LENGTH, NODE_GAP, NODE_RADIUS, countCrossings, countEdgeHits, idealLength, layoutGraph } from "./layout";
import type { Placement } from "./layout";

const SIZE = { width: 640, height: 480 };
/** Enough search for the small graphs here to settle; the card's own defaults are sized for a whole house and are far slower. */
const SMALL = { restarts: 4, refineSteps: 3000 };

function node(id: string): GraphNode {
  return { id, name: id, role: "router", battery: false, available: true, lqi: null, rssi: null };
}

function graphOf(ids: string[], links: [string, string, number][]): Graph {
  return {
    nodes: ids.map(node),
    links: links.map(([source, target, lqi]) => ({ source, target, lqi })),
  };
}

const at = (x: number, y: number) => ({ x, y });

describe("countCrossings", () => {
  const links = [
    { source: "a", target: "b" },
    { source: "c", target: "d" },
  ];

  it("counts two links that cross", () => {
    const positions = new Map([["a", at(0, 0)], ["b", at(10, 10)], ["c", at(0, 10)], ["d", at(10, 0)]]);
    expect(countCrossings(positions, links)).toBe(1);
  });

  it("does not count links that miss each other", () => {
    const positions = new Map([["a", at(0, 0)], ["b", at(10, 0)], ["c", at(0, 5)], ["d", at(10, 5)]]);
    expect(countCrossings(positions, links)).toBe(0);
  });

  it("does not count links that share a node", () => {
    const positions = new Map([["a", at(0, 0)], ["b", at(10, 10)], ["c", at(0, 10)]]);
    const shared = [{ source: "a", target: "b" }, { source: "a", target: "c" }];
    expect(countCrossings(positions, shared)).toBe(0);
  });
});

describe("idealLength", () => {
  it("is shorter for a stronger link and clamps outside the LQI range", () => {
    expect(idealLength(255)).toBe(MIN_LENGTH);
    expect(idealLength(0)).toBe(MAX_LENGTH);
    expect(idealLength(200)).toBeLessThan(idealLength(100));
    expect(idealLength(-10)).toBe(MAX_LENGTH);
    expect(idealLength(900)).toBe(MIN_LENGTH);
  });
});

describe("layoutGraph", () => {
  const wheel = graphOf(
    ["hub", "r1", "r2", "r3", "r4", "r5", "r6", "r7"],
    [
      ...["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((id): [string, string, number] => ["hub", id, 150]),
      ...[["r1", "r2"], ["r2", "r3"], ["r3", "r4"], ["r4", "r5"], ["r5", "r6"], ["r6", "r7"], ["r7", "r1"]].map(
        ([a, b]): [string, string, number] => [a ?? "", b ?? "", 150],
      ),
    ],
  );

  it("finds a drawing with no crossings for a planar graph", async () => {
    expect((await layoutGraph(wheel, SIZE, SMALL)).crossings).toBe(0);
  });

  it("crosses no more links with many restarts than with a single start", async () => {
    const dense = graphOf(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      [["a", "e"], ["b", "f"], ["c", "g"], ["d", "h"], ["e", "i"], ["f", "j"], ["a", "j"], ["b", "i"], ["c", "h"], ["d", "g"], ["a", "d"], ["b", "e"], ["c", "f"]].map(
        ([s, t]): [string, string, number] => [s ?? "", t ?? "", 120],
      ),
    );
    expect((await layoutGraph(dense, SIZE, { restarts: 12, refineSteps: 0 })).crossings).toBeLessThanOrEqual((await layoutGraph(dense, SIZE, { restarts: 1, refineSteps: 0 })).crossings);
  });

  it("draws a strong link shorter than a weak one from the same node", async () => {
    const fork = graphOf(["hub", "near", "far"], [["hub", "near", 250], ["hub", "far", 20]]);
    const { positions } = await layoutGraph(fork, SIZE, SMALL);
    const hub = positions.get("hub");
    const near = positions.get("near");
    const far = positions.get("far");
    if (hub === undefined || near === undefined || far === undefined) {
      throw new Error("missing position");
    }
    expect(Math.hypot(near.x - hub.x, near.y - hub.y)).toBeLessThan(Math.hypot(far.x - hub.x, far.y - hub.y) * 0.5);
  });

  it("keeps every node inside the size and gives the same picture for the same data", async () => {
    const first = await layoutGraph(wheel, SIZE, SMALL);
    const second = await layoutGraph(wheel, SIZE, SMALL);
    expect([...first.positions]).toEqual([...second.positions]);
    for (const { x, y } of first.positions.values()) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(first.size.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(first.size.height);
    }
  });

  it("handles an empty graph and a single node", async () => {
    expect((await layoutGraph({ nodes: [], links: [] }, SIZE, SMALL)).positions.size).toBe(0);
    const alone = await layoutGraph(graphOf(["only"], []), SIZE, SMALL);
    const lone = alone.positions.get("only");
    expect(lone?.x).toBe(320);
    expect(lone?.y).toBeGreaterThan(0);
    expect(lone?.y).toBeLessThan(alone.size.height);
  });

  it("keeps devices with no link out of the mesh and below it, so they do not shrink it", async () => {
    const ids = ["a", "b", ...Array.from({ length: 12 }, (_, index) => `lone${String(index)}`)];
    const { positions, size } = await layoutGraph(graphOf(ids, [["a", "b", 100]]), SIZE, SMALL);
    const a = positions.get("a");
    const b = positions.get("b");
    if (a === undefined || b === undefined) {
      throw new Error("missing position");
    }
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(SIZE.width * 0.3);
    for (const id of ids.filter((id) => id.startsWith("lone"))) {
      const lone = positions.get(id);
      expect(lone?.y).toBeGreaterThan(Math.max(a.y, b.y));
      expect(lone?.y).toBeLessThan(size.height);
      expect(lone?.x).toBeGreaterThanOrEqual(0);
      expect(lone?.x).toBeLessThanOrEqual(size.width);
    }
  });

  describe("never overlaps nodes", () => {
    /** The smallest amount by which any two drawn nodes fail to keep NODE_GAP clear; at most 0 when none overlap. */
    function worstOverlap(placement: Placement, graph: Graph): number {
      const radius = new Map(graph.nodes.map((n) => [n.id, NODE_RADIUS[n.role]]));
      const entries = [...placement.positions];
      let worst = -Infinity;
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
          const [aId, a] = entries[i] ?? ["", { x: 0, y: 0 }];
          const [bId, b] = entries[j] ?? ["", { x: 0, y: 0 }];
          const required = (radius.get(aId) ?? 0) + (radius.get(bId) ?? 0) + NODE_GAP;
          worst = Math.max(worst, required - Math.hypot(a.x - b.x, a.y - b.y));
        }
      }
      return worst;
    }

    function dense(count: number, roles: GraphNode["role"][]): Graph {
      const ids = Array.from({ length: count }, (_, index) => `n${String(index)}`);
      const links: [string, string, number][] = [];
      ids.forEach((id, index) => {
        links.push([id, ids[(index + 1) % count] ?? id, 60 + ((index * 37) % 190)]);
        links.push([id, ids[(index * 7 + 3) % count] ?? id, 30 + ((index * 53) % 220)]);
      });
      return {
        nodes: ids.map((id, index) => ({ ...node(id), role: roles[index % roles.length] ?? "router" })),
        links: links.filter(([s, t]) => s !== t).map(([source, target, lqi]) => ({ source, target, lqi })),
      };
    }

    it("keeps every pair clear in a dense mixed network", async () => {
      const graph = dense(38, ["coordinator", "router", "end-device", "end-device"]);
      const placement = await layoutGraph(graph, { width: 300, height: 220 }, { restarts: 4, refineSteps: 500 });
      expect(worstOverlap(placement, graph)).toBeLessThanOrEqual(1e-6);
    });

    it("keeps every pair clear when many devices have no link, including large ones in a row", async () => {
      const graph = dense(10, ["router"]);
      const lone = Array.from({ length: 40 }, (_, index) => ({ ...node(`lone${String(index)}`), role: index % 5 === 0 ? ("coordinator" as const) : ("end-device" as const) }));
      const mixed = { nodes: [...graph.nodes, ...lone], links: graph.links };
      expect(worstOverlap(await layoutGraph(mixed, { width: 300, height: 220 }, { restarts: 4, refineSteps: 500 }), mixed)).toBeLessThanOrEqual(1e-6);
    });

    it("grows the area instead of letting nodes overlap when the requested size is too small", async () => {
      const graph = dense(38, ["router"]);
      const tiny = { width: 120, height: 90 };
      const placement = await layoutGraph(graph, tiny, { restarts: 4, refineSteps: 500 });
      expect(worstOverlap(placement, graph)).toBeLessThanOrEqual(1e-6);
      expect(placement.size.width).toBeGreaterThan(tiny.width);
    });
  });

  describe("annealing", () => {
    function dense(count: number): Graph {
      const ids = Array.from({ length: count }, (_, index) => `n${String(index)}`);
      const links: [string, string, number][] = [];
      ids.forEach((id, index) => {
        links.push([id, ids[(index + 1) % count] ?? id, 60 + ((index * 37) % 190)]);
        links.push([id, ids[(index * 7 + 3) % count] ?? id, 30 + ((index * 53) % 220)]);
      });
      return graphOf(ids, links.filter(([source, target]) => source !== target));
    }

    it("leaves fewer crossings than the force layout alone on a dense network", async () => {
      const graph = dense(24);
      const forceOnly = await layoutGraph(graph, SIZE, { restarts: 6, refineSteps: 0 });
      const annealed = await layoutGraph(graph, SIZE, { restarts: 6, refineSteps: 8000 });
      expect(forceOnly.crossings).toBeGreaterThan(0);
      expect(annealed.crossings).toBeLessThan(forceOnly.crossings);
    });

    it("reports the crossings of the drawing it returns, and draws the same picture for the same data", async () => {
      const graph = dense(16);
      const options = { restarts: 4, refineSteps: 2000 };
      const first = await layoutGraph(graph, SIZE, options);
      const second = await layoutGraph(graph, SIZE, options);
      expect(first.crossings).toBe(countCrossings(first.positions, graph.links));
      expect([...first.positions]).toEqual([...second.positions]);
    });
  });

  describe("edges and nodes", () => {
    const radii = new Map([["a", 5], ["b", 5], ["c", 8]]);
    const link = [{ source: "a", target: "b" }];

    it("counts a node drawn on a link that is not its own", () => {
      const onIt = new Map([["a", at(0, 0)], ["b", at(100, 0)], ["c", at(50, 3)]]);
      expect(countEdgeHits(onIt, link, radii)).toBe(1);
    });

    it("does not count a node that keeps its radius and clearance from the link", () => {
      const clear = new Map([["a", at(0, 0)], ["b", at(100, 0)], ["c", at(50, 8 + EDGE_CLEARANCE)]]);
      expect(countEdgeHits(clear, link, radii)).toBe(0);
    });

    it("never counts a link's own ends, and counts a node past the end of the segment by its distance to the end", () => {
      const beyond = new Map([["a", at(0, 0)], ["b", at(100, 0)], ["c", at(100 + 8 + EDGE_CLEARANCE + 1, 0)]]);
      expect(countEdgeHits(beyond, link, radii)).toBe(0);
      expect(countEdgeHits(new Map([["a", at(0, 0)], ["b", at(100, 0)]]), link, radii)).toBe(0);
    });

    function dense(count: number, chords = 1): Graph {
      const ids = Array.from({ length: count }, (_, index) => `n${String(index)}`);
      const links: [string, string, number][] = [];
      ids.forEach((id, index) => {
        links.push([id, ids[(index + 1) % count] ?? id, 60 + ((index * 37) % 190)]);
        links.push([id, ids[(index * 7 + 3) % count] ?? id, 30 + ((index * 53) % 220)]);
        if (chords > 1) {
          links.push([id, ids[(index * 5 + 2) % count] ?? id, 90 + ((index * 29) % 150)]);
        }
      });
      return graphOf(ids, links.filter(([source, target]) => source !== target));
    }

    it("draws no link over a node that is not its end on a small network with the default search, and reports the count", async () => {
      const graph = dense(18);
      const placement = await layoutGraph(graph, SIZE);
      const radius = new Map(graph.nodes.map((node) => [node.id, NODE_RADIUS[node.role]]));
      expect(countEdgeHits(placement.positions, graph.links, radius)).toBe(placement.edgeHits);
      expect(placement.edgeHits).toBe(0);
    });

    it("draws fewer links over nodes than the force layout alone", async () => {
      const graph = dense(30, 2);
      const forceOnly = await layoutGraph(graph, SIZE, { restarts: 6, refineSteps: 0 });
      const annealed = await layoutGraph(graph, SIZE, { restarts: 6, refineSteps: 20000 });
      expect(forceOnly.edgeHits).toBeGreaterThan(0);
      expect(annealed.edgeHits).toBeLessThan(forceOnly.edgeHits);
    });
  });
});
