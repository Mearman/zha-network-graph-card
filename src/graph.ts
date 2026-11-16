import { z } from "zod";

const neighbourSchema = z.object({
  ieee: z.string(),
  lqi: z.coerce.number(),
});

const deviceSchema = z.object({
  ieee: z.string(),
  name: z.string(),
  device_type: z.string(),
  power_source: z.string().nullable().optional(),
  lqi: z.number().nullable().optional(),
  rssi: z.number().nullable().optional(),
  available: z.boolean().optional(),
  neighbors: z.array(neighbourSchema).optional(),
});

/** The `zha/devices` websocket response: one entry per device the ZHA network knows. */
export const deviceListSchema = z.array(deviceSchema);
export type ZhaDevice = z.infer<typeof deviceSchema>;

export type Role = "coordinator" | "router" | "end-device";

export interface GraphNode {
  id: string;
  name: string;
  role: Role;
  battery: boolean;
  available: boolean;
  lqi: number | null;
  rssi: number | null;
}

/** An undirected link. `lqi` is the mean of the values the two ends report for each other. */
export interface GraphLink {
  source: string;
  target: string;
  lqi: number;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
}

/** LQI is a one byte quality figure reported by the radio, 0 (unusable) to 255. */
export const MAX_LQI = 255;

/**
 * Every `device_type` the zha library reports: the zigpy `LogicalType` names, "GreenPower" for a Green Power device (batteryless, never routes) and "unknown" for a device with no node descriptor yet (not shown to route, so drawn as an end device).
 */
const ROLES: Readonly<Record<string, Role>> = {
  Coordinator: "coordinator",
  Router: "router",
  EndDevice: "end-device",
  GreenPower: "end-device",
  unknown: "end-device",
};

function roleOf(deviceType: string): Role {
  const role = ROLES[deviceType];
  if (role === undefined) {
    throw new Error(`Unknown ZHA device type: ${deviceType}`);
  }
  return role;
}

/**
 * Builds the node and link sets from ZHA's device list. Zigbee neighbour tables are directional and
 * a link may be reported by one end, both, or neither of two devices, so each unordered pair becomes
 * one link carrying the mean of the reported values. Neighbours that are not in the list are dropped.
 */
export function buildGraph(devices: readonly ZhaDevice[]): Graph {
  const known = new Set(devices.map((device) => device.ieee));
  const nodes: GraphNode[] = devices.map((device) => ({
    id: device.ieee,
    name: device.name,
    role: roleOf(device.device_type),
    battery: device.power_source === "Battery or Unknown",
    available: device.available ?? true,
    lqi: device.lqi ?? null,
    rssi: device.rssi ?? null,
  }));

  const reports = new Map<string, { source: string; target: string; values: number[] }>();
  for (const device of devices) {
    for (const neighbour of device.neighbors ?? []) {
      if (!known.has(neighbour.ieee) || neighbour.ieee === device.ieee) {
        continue;
      }
      const [source, target] = [device.ieee, neighbour.ieee].sort() as [string, string];
      const key = `${source}|${target}`;
      const entry = reports.get(key) ?? { source, target, values: [] };
      entry.values.push(neighbour.lqi);
      reports.set(key, entry);
    }
  }

  const links = [...reports.values()].map(({ source, target, values }) => ({
    source,
    target,
    lqi: values.reduce((sum, value) => sum + value, 0) / values.length,
  }));
  return { nodes, links };
}

/** Maps LQI onto a hue from red (0) to green (120), clamped to the valid range. */
export function lqiColour(lqi: number): string {
  const clamped = Math.min(Math.max(lqi, 0), MAX_LQI);
  const hue = (120 * clamped) / MAX_LQI;
  return `hsl(${hue.toFixed(0)} 75% 45%)`;
}
