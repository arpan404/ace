import { gzipSync } from "node:zlib";
import { FakeDaemon } from "../packages/fake-daemon/src/daemon.ts";
import { ScenarioPlayer } from "../packages/fake-daemon/src/scenario.ts";
import { workbench } from "../packages/fake-daemon/src/scenarios/workbench.ts";
import { longHistory } from "../packages/fake-daemon/src/scenarios/long-history.ts";
import { LongThreadSoak } from "../packages/fake-daemon/src/long-thread-soak.ts";
import { ThreadId } from "../packages/protocol/src/ids.ts";

const enc = new TextEncoder();
const bytes = (v: unknown) => enc.encode(JSON.stringify(v)).length;
const gz = (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v))).length;
const fmtKB = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;

function seed(scenarios: ReturnType<typeof workbench>[number][] | { thread: { id: string; workspaceId: string; title: string; provider: string }; steps: never[] }[]) {
  const daemon = new FakeDaemon({ clock: () => Date.UTC(2026, 9, 27) });
  const players = scenarios.map((s) => new ScenarioPlayer(daemon, s as never));
  for (const p of players) p.runUntilBlocked();
  return daemon;
}

// 1. Small threads: each workbench thread snapshot
const scenarios = workbench();
const daemon = seed(scenarios as never[]);
const rows: { id: string; items: number; json: number; gzip: number }[] = [];
for (const s of scenarios) {
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(s.thread.id) });
  if (view?.kind !== "thread") throw new Error(`missing ${s.thread.id}`);
  rows.push({
    id: s.thread.id,
    items: view.itemOrder.length,
    json: bytes(view),
    gzip: gz(view),
  });
}

// 2. Thread list (shell/home list)
const list = daemon.snapshot({ kind: "threads" });
const listJson = bytes(list);
const listGzip = gz(list);

// 3. Medium thread: 60 exchanges router thread
const daemonMed = new FakeDaemon({ clock: () => Date.UTC(2026, 9, 27) });
new ScenarioPlayer(daemonMed, longHistory(60)).runUntilBlocked();
const medView = daemonMed.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router") });
if (medView?.kind !== "thread") throw new Error("missing medium");
const med = { items: medView.itemOrder.length, json: bytes(medView), gzip: gz(medView) };

// 4. Larger-but-realistic: 200 exchanges
const daemonMed2 = new FakeDaemon({ clock: () => Date.UTC(2026, 9, 27) });
new ScenarioPlayer(daemonMed2, longHistory(200, "thread-router-200")).runUntilBlocked();
const med2View = daemonMed2.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-router-200") });
if (med2View?.kind !== "thread") throw new Error("missing med2");
const med2 = { items: med2View.itemOrder.length, json: bytes(med2View), gzip: gz(med2View) };

// 5. Large: synthetic soak window (200 newest of 8000 items)
const soak = new LongThreadSoak({
  clock: () => Date.UTC(2026, 9, 27),
  shape: { items: 8_000, turns: 40, subagents: 4 },
});
const big = soak.snapshot({ kind: "thread", threadId: "thread-multi-day" as never });
if (!big || big.kind !== "thread") throw new Error("missing big");
const bigRow = { items: big.itemOrder.length, json: bytes(big), gzip: gz(big) };
const soakList = soak.snapshot({ kind: "threads" });

// 6. Wire framing: subscribe snapshot frame = {"type":"snapshot",...}? measure server message size
// FakeDaemon Connection wraps snapshot in {type:"snapshot", subscriptionId, view, throughSeq}? approximate with view + 100 bytes envelope.
const envelope = 120;

const avgSmall = rows.reduce((a, r) => a + r.json, 0) / rows.length;
const avgSmallGz = rows.reduce((a, r) => a + r.gzip, 0) / rows.length;

console.log(JSON.stringify({
  smallThreads: rows.map((r) => ({ ...r, jsonHuman: fmtKB(r.json), gzipHuman: fmtKB(r.gzip) })),
  avgSmall: { json: Math.round(avgSmall), gzip: Math.round(avgSmallGz), jsonHuman: fmtKB(avgSmall), gzipHuman: fmtKB(avgSmallGz) },
  threadList: { json: listJson, gzip: listGzip, jsonHuman: fmtKB(listJson), gzipHuman: fmtKB(listGzip) },
  medium60: { ...med, jsonHuman: fmtKB(med.json), gzipHuman: fmtKB(med.gzip) },
  medium200: { ...med2, jsonHuman: fmtKB(med2.json), gzipHuman: fmtKB(med2.gzip) },
  largeSoakWindow200of8000: { ...bigRow, jsonHuman: fmtKB(bigRow.json), gzipHuman: fmtKB(bigRow.gzip) },
  envelope,
  note: "json = UTF-8 bytes of JSON.stringify(snapshot view). gzip = gzipSync of same. snapshot window = 200 items max.",
}, null, 2));
