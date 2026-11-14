import { describe, expect, it } from "vitest";
import { buildGraph, deviceListSchema, lqiColour } from "./graph";

const coordinator = {
  ieee: "00:00:00:00:00:00:00:01",
  name: "Coordinator",
  device_type: "Coordinator",
  neighbors: [{ ieee: "00:00:00:00:00:00:00:02", lqi: "200" }],
};
const router = {
  ieee: "00:00:00:00:00:00:00:02",
  name: "Router",
  device_type: "Router",
  neighbors: [
    { ieee: "00:00:00:00:00:00:00:01", lqi: "100" },
    { ieee: "00:00:00:00:00:00:00:99", lqi: "255" },
  ],
};
const sensor = {
  ieee: "00:00:00:00:00:00:00:03",
  name: "Sensor",
  device_type: "EndDevice",
  power_source: "Battery or Unknown",
  lqi: 90,
  rssi: -70,
};

describe("buildGraph", () => {
  const graph = buildGraph(deviceListSchema.parse([coordinator, router, sensor]));

  it("merges both directions of a link into the mean of the reported values", () => {
    expect(graph.links).toEqual([
      { source: coordinator.ieee, target: router.ieee, lqi: 150 },
    ]);
  });

  it("drops links to devices that are not in the list", () => {
    expect(graph.links.some((link) => link.target.endsWith(":99"))).toBe(false);
  });

  it("keeps a device nobody lists as a neighbour, with its role and power source", () => {
    expect(graph.nodes.find((node) => node.id === sensor.ieee)).toMatchObject({
      role: "end-device",
      battery: true,
      lqi: 90,
      rssi: -70,
    });
  });

  it("rejects an unknown device type instead of guessing a role", () => {
    const unknown = deviceListSchema.parse([{ ...sensor, device_type: "Mystery" }]);
    expect(() => buildGraph(unknown)).toThrow("Mystery");
  });
});

describe("deviceListSchema", () => {
  it("rejects a device with no ieee", () => {
    expect(deviceListSchema.safeParse([{ name: "x", device_type: "Router" }]).success).toBe(false);
  });
});

describe("lqiColour", () => {
  it("runs from red at 0 to green at 255 and clamps outside that range", () => {
    expect(lqiColour(0)).toBe("hsl(0 75% 45%)");
    expect(lqiColour(255)).toBe("hsl(120 75% 45%)");
    expect(lqiColour(-40)).toBe(lqiColour(0));
    expect(lqiColour(999)).toBe(lqiColour(255));
  });
});
