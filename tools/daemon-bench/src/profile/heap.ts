/**
 * Summarizes V8 heap snapshots: self size by node type and by constructor, and with two
 * snapshots, what grew and which parents (constructor and property) hold the growth.
 *
 * node --max-old-space-size=8192 tools/daemon-bench/src/profile/heap.ts START [END]
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const Snapshot = z.object({
  snapshot: z.object({
    meta: z.object({
      node_fields: z.array(z.string()),
      node_types: z.array(z.unknown()),
      edge_fields: z.array(z.string()),
      edge_types: z.array(z.unknown()),
    }),
  }),
  nodes: z.array(z.number()),
  edges: z.array(z.number()),
  strings: z.array(z.string()),
});

interface Group {
  count: number;
  bytes: number;
}

function load(path: string) {
  const parsed = Snapshot.parse(JSON.parse(readFileSync(path, "utf8")));
  const { meta } = parsed.snapshot;
  const nodeTypes = z.array(z.string()).parse(meta.node_types[0]);
  const edgeTypes = z.array(z.string()).parse(meta.edge_types[0]);
  const width = meta.node_fields.length;
  const edgeWidth = meta.edge_fields.length;
  const at = (field: string) => meta.node_fields.indexOf(field);
  const [typeAt, nameAt, sizeAt, edgesAt] = [
    at("type"),
    at("name"),
    at("self_size"),
    at("edge_count"),
  ];
  const { nodes, edges, strings } = parsed;
  const count = nodes.length / width;
  const key = (node: number) => {
    const type = nodeTypes[nodes[node * width + typeAt] ?? 0] ?? "?";
    const name = strings[nodes[node * width + nameAt] ?? 0] ?? "?";
    // Strings and code are grouped by type; their names are contents or source.
    if (type === "string" || type === "concatenated string" || type === "sliced string")
      return "(string)";
    if (type === "code") return `(code) ${name.slice(0, 40)}`;
    if (type === "closure") return "(closure)";
    if (type === "number" || type === "hidden" || type === "array" || type === "native")
      return `(${type}) ${name.slice(0, 50)}`;
    return name.slice(0, 80);
  };
  const byType = new Map<string, Group>();
  const byName = new Map<string, Group>();
  let total = 0;
  for (let node = 0; node < count; node++) {
    const size = nodes[node * width + sizeAt] ?? 0;
    total += size;
    const type = nodeTypes[nodes[node * width + typeAt] ?? 0] ?? "?";
    for (const [map, name] of [
      [byType, type],
      [byName, key(node)],
    ] as const) {
      const group = map.get(name) ?? { count: 0, bytes: 0 };
      group.count++;
      group.bytes += size;
      map.set(name, group);
    }
  }
  /** Who points at instances of `name`: parent key and edge name, by target bytes. */
  const retainers = (names: ReadonlySet<string>) => {
    const result = new Map<string, Map<string, Group>>();
    let edge = 0;
    for (let node = 0; node < count; node++) {
      const edgeCount = nodes[node * width + edgesAt] ?? 0;
      const parentKey = key(node);
      for (let index = 0; index < edgeCount; index++, edge++) {
        const base = edge * edgeWidth;
        const edgeType = edgeTypes[edges[base] ?? 0] ?? "?";
        if (edgeType === "weak") continue;
        const target = (edges[base + 2] ?? 0) / width;
        const targetKey = key(target);
        if (!names.has(targetKey)) continue;
        const label =
          edgeType === "element" || edgeType === "hidden"
            ? `[${edgeType}]`
            : (strings[edges[base + 1] ?? 0] ?? "?").slice(0, 40);
        const groups = result.get(targetKey) ?? new Map<string, Group>();
        result.set(targetKey, groups);
        const group = groups.get(`${parentKey} .${label}`) ?? { count: 0, bytes: 0 };
        group.count++;
        group.bytes += nodes[target * width + sizeAt] ?? 0;
        groups.set(`${parentKey} .${label}`, group);
      }
    }
    return result;
  };
  return { total, byType, byName, retainers };
}

const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
const top = (map: Map<string, Group>, limit: number) =>
  [...map]
    .toSorted((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, limit)
    .map(([name, group]) => ({ name, count: group.count, mb: mb(group.bytes) }));

const [startPath, endPath] = process.argv.slice(2);
if (!startPath) throw new Error("Pass one or two .heapsnapshot files");
const start = load(startPath);
const report: Record<string, unknown> = {
  start: { totalMb: mb(start.total), byType: top(start.byType, 20), byName: top(start.byName, 40) },
};
if (endPath) {
  const end = load(endPath);
  const growth = new Map<string, Group>();
  for (const [name, group] of end.byName) {
    const before = start.byName.get(name) ?? { count: 0, bytes: 0 };
    growth.set(name, { count: group.count - before.count, bytes: group.bytes - before.bytes });
  }
  const growing = top(growth, 30);
  const held = end.retainers(new Set(growing.slice(0, 8).map((row) => row.name)));
  report["end"] = {
    totalMb: mb(end.total),
    byType: top(end.byType, 20),
    byName: top(end.byName, 40),
  };
  report["growth"] = growing;
  report["heldBy"] = Object.fromEntries([...held].map(([name, groups]) => [name, top(groups, 6)]));
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
