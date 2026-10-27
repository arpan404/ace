/* Snapshot composition: where do the bytes go? Run: bun run output/bench-e2e/compose.ts */
import { FakeDaemon } from "../../packages/fake-daemon/src/daemon.ts";
import { ScenarioPlayer } from "../../packages/fake-daemon/src/scenario.ts";
import { workbench } from "../../packages/fake-daemon/src/scenarios/workbench.ts";
import { longHistory } from "../../packages/fake-daemon/src/scenarios/long-history.ts";
import { LongThreadSoak } from "../../packages/fake-daemon/src/long-thread-soak.ts";
import { ThreadId } from "../../packages/protocol/src/ids.ts";

const enc = new TextEncoder();
const bytes = (v: unknown) => enc.encode(JSON.stringify(v)).length;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

const daemon = new FakeDaemon({ clock: () => Date.UTC(2026, 9, 27) });
for (const s of workbench()) new ScenarioPlayer(daemon, s as never).runUntilBlocked();
new ScenarioPlayer(daemon, longHistory(60)).runUntilBlocked();
const soak = new LongThreadSoak({
  clock: () => Date.UTC(2026, 9, 27),
  shape: { items: 8_000, turns: 40, subagents: 4 },
});

const views: Record<string, any> = {
  small: daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-bump-codex") }),
  medium: daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router") }),
  large: soak.snapshot({ kind: "thread", threadId: "thread-multi-day" as never }),
};

for (const [name, view] of Object.entries(views)) {
  if (view?.kind !== "thread") throw new Error(`missing ${name}`);
  console.log(`\n=== ${name} (total ${kb(bytes(view))}, ${view.itemOrder.length} items) ===`);
  // top-level sections
  const sections: [string, number][] = [];
  for (const [k, v] of Object.entries(view)) {
    if (k === "items" || k === "itemOrder") continue;
    sections.push([k, bytes(v)]);
  }
  sections.sort((a, b) => b[1] - a[1]);
  for (const [k, n] of sections) console.log(`  section ${k}: ${kb(n)}`);
  console.log(`  section itemOrder: ${kb(bytes(view.itemOrder))} (${view.itemOrder.length} ids)`);
  // items by type
  const byType = new Map<string, { n: number; b: number; textLen: number }>();
  let rawEmpty = 0;
  let rawEmptyBytes = 0;
  let completeTrue = 0;
  let syntheticFalse = 0;
  for (const id of view.itemOrder) {
    const item = view.items[id];
    const e = byType.get(item.type) ?? { n: 0, b: 0, textLen: 0 };
    const b = bytes(item);
    e.n++;
    e.b += b;
    let text = "";
    if (item.type === "message")
      text = item.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("") ?? "";
    else if (typeof item.text === "string") text = item.text;
    e.textLen += text.length;
    byType.set(item.type, e);
    if (Array.isArray((item as any).raw) && (item as any).raw.length === 0) {
      rawEmpty++;
      rawEmptyBytes += enc.encode(`"raw":[]`).length;
    }
    if ((item as any).complete === true) completeTrue++;
    if ((item as any).synthetic === false) syntheticFalse++;
  }
  for (const [t, e] of [...byType.entries()].sort((a, b) => b[1].b - a[1].b))
    console.log(
      `  item[${t}]: n=${e.n} bytes=${kb(e.b)} avg=${Math.round(e.b / e.n)}B avgText=${Math.round(e.textLen / e.n)} chars`,
    );
  console.log(
    `  flags: raw:[] empty x${rawEmpty} (~${kb(rawEmptyBytes)} just the key), complete:true x${completeTrue}, synthetic:false x${syntheticFalse}`,
  );
  // key-name overhead estimate: top 10 keys across items
  const keyCounts = new Map<string, number>();
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) {
      keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
      walk(val);
    }
  };
  view.itemOrder.forEach((id: string) => walk(view.items[id]));
  const top = [...keyCounts.entries()].sort((a, b) => b[1] * b[0].length - a[1] * a[0].length).slice(0, 12);
  let keyBytes = 0;
  for (const [k, c] of top) {
    const b = (k.length + 3) * c; // "key":
    keyBytes += b;
    console.log(`  key "${k}" x${c} ~= ${kb(b)}`);
  }
  console.log(`  top-12 keys subtotal ~= ${kb(keyBytes)}`);
}
