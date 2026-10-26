// Temporary: summarize .cpuprofile files by self time. Removed before the branch is finished.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "prof";
for (const name of readdirSync(dir).filter((file) => file.endsWith(".cpuprofile"))) {
  const profile = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
    nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
    samples: number[];
    timeDeltas: number[];
  };
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, index) => {
    const frame = byId.get(id)?.callFrame;
    const key = `${frame?.functionName || "(anon)"} ${(frame?.url ?? "").split("/").slice(-2).join("/")}:${frame?.lineNumber ?? 0}`;
    const delta = profile.timeDeltas[index] ?? 0;
    total += delta;
    self.set(key, (self.get(key) ?? 0) + delta);
  });
  console.log(`== ${name} total ${(total / 1000).toFixed(0)} ms`);
  for (const [key, us] of [...self].toSorted((a, b) => b[1] - a[1]).slice(0, 30))
    console.log(`${(us / 1000).toFixed(0).padStart(8)} ms  ${key}`);
}
