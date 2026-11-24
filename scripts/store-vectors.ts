// SPDX-License-Identifier: Apache-2.0
/*
 * Builds `native/daemon/vectors/fold.json` for phase 5.1: every case first as JSON text,
 * then what crosses and what the TypeScript fold gives, byte for byte. The Rust vector test
 * replays the same texts through `ace-projection`.
 *
 *   bun scripts/store-vectors.ts [--check]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isSidebarEvent, updateThread } from "../packages/projection/src/index.ts";
import { foldInput } from "../apps/daemon/src/native-writer/fold.ts";
import { samples } from "../apps/daemon/src/canonical-event-samples.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "native/daemon/vectors/fold.json");

type Built = {
  name: string;
  thread: string;
  event: string;
  kind: string;
  payload: string | null;
  seq: number;
  at: number;
  sidebar: boolean;
  reaches: boolean;
  folded: string;
};

const workspace = "workspace-1";
function baseThread(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "thread-1",
    workspaceId: workspace,
    title: "Task",
    provider: "codex",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}
function envelope(
  payload: Record<string, unknown>,
  seq = 10,
  at = 1_700_000_000_000,
  threadId = "thread-1",
): Record<string, unknown> {
  return { seq, id: `event-${seq}`, at, threadId, payload };
}
function agent(id: string, origin: string): Record<string, unknown> {
  return { id, origin, parentId: null };
}

type Raw = { name: string; thread: Record<string, unknown>; event: Record<string, unknown> };
function build(): Built[] {
  const raws: Raw[] = [];
  const push = (name: string, thread: Record<string, unknown>, event: Record<string, unknown>) =>
    raws.push({ name, thread, event });
  let seq = 100;
  const nextAt = () => 1_700_000_000_000 + seq * 1000;
  // Every sample of the moved table: none reaches, the no-op check proves the skip.
  for (const [key, payload] of Object.entries(samples))
    push(`sample-${key}`, baseThread(), envelope(payload as Record<string, unknown>, seq++, nextAt()));
  // Every field of rule 3 alone.
  const alone: Array<[string, Record<string, unknown>]> = [
    ["workspaceId", { workspaceId: "workspace-2" }],
    ["permission", { permission: { pending: true } }],
    ["backend", { backend: "acp" }],
    ["capabilities", { capabilities: { steer: true } }],
    ["provider", { provider: "claude" }],
    ["lineage", { lineage: { depth: 2 } }],
    ["delegatedBy", { delegatedBy: "thread-parent" }],
    ["delegatedFrom", { delegatedFrom: { host: "h" } }],
    ["startedBy", { startedBy: "thread-starter" }],
    ["startedByClient", { startedByClient: { client: "c" } }],
    ["treeRootId", { treeRootId: "thread-root" }],
    ["queuedLaunch", { queuedLaunch: { state: "queued" } }],
    ["execution", { execution: { mode: "auto" } }],
    ["switch", { switch: { target: "x" } }],
    ["title", { title: "New title" }],
    ["titleSource", { titleSource: "provider" }],
    ["effectiveCapabilities", { effectiveCapabilities: { steer: false } }],
    ["acpSupport", { acpSupport: { supported: true } }],
    ["acp", { acp: { acpAgentId: "a1", installationId: "i1", instanceId: "s1" } }],
    ["status", { status: { state: "done" } }],
    ["archivedAt", { archivedAt: 1_700_000_000_001 }],
    ["goal", { goal: { text: "goal" } }],
  ];
  for (const [field, part] of alone)
    push(
      `updated-alone-${field}`,
      baseThread(),
      envelope({ type: "thread.updated", ...part }, seq++, nextAt()),
    );
  // All of them together on a thread that has none of them.
  push(
    "updated-all-together",
    baseThread(),
    envelope(
      {
        type: "thread.updated",
        workspaceId: "workspace-9",
        permission: { pending: false },
        backend: "acp",
        capabilities: { steer: true },
        provider: "opencode",
        lineage: { depth: 1 },
        delegatedBy: "thread-p",
        delegatedFrom: { host: "h2" },
        startedBy: "thread-s",
        startedByClient: { client: "d" },
        treeRootId: "thread-r",
        queuedLaunch: { state: "q" },
        execution: { mode: "m" },
        switch: { target: "y" },
        title: "Every field",
        titleSource: "person",
        effectiveCapabilities: { steer: true },
        acpSupport: { supported: false },
        acp: { acpAgentId: "a9", installationId: "i9", instanceId: "s9" },
        status: { state: "working", agents: 1 },
        archivedAt: 1_700_000_000_009,
        goal: { text: "all" },
      },
      seq++,
      nextAt(),
    ),
  );
  // Each null removal.
  const withRemovables = () =>
    baseThread({ queuedLaunch: { state: "q" }, archivedAt: 5, goal: { text: "g" } });
  push(
    "updated-null-queuedLaunch",
    withRemovables(),
    envelope({ type: "thread.updated", queuedLaunch: null }, seq++, nextAt()),
  );
  push(
    "updated-null-archivedAt",
    withRemovables(),
    envelope({ type: "thread.updated", archivedAt: null }, seq++, nextAt()),
  );
  push(
    "updated-null-goal",
    withRemovables(),
    envelope({ type: "thread.updated", goal: null }, seq++, nextAt()),
  );
  // cursor-sdk with and without a continuation.
  push(
    "backend-cursor-with-continuation",
    baseThread({ continuation: { state: "read_only", reason: "cursor_cli_retired", actionId: "thread.continue_new" }, backend: "acp" }),
    envelope({ type: "thread.updated", backend: "cursor-sdk" }, seq++, nextAt()),
  );
  push(
    "backend-cursor-without-continuation",
    baseThread(),
    envelope({ type: "thread.updated", backend: "cursor-sdk" }, seq++, nextAt()),
  );
  push(
    "backend-acp-keeps-continuation",
    baseThread({ continuation: { state: "read_only", reason: "cursor_cli_retired", actionId: "thread.continue_new" }, backend: "acp" }),
    envelope({ type: "thread.updated", backend: "acp" }, seq++, nextAt()),
  );
  // acp whole, and acp without instanceId dropping the old one.
  push(
    "acp-whole",
    baseThread(),
    envelope(
      { type: "thread.updated", acp: { acpAgentId: "a1", installationId: "i1", instanceId: "s1" } },
      seq++,
      nextAt(),
    ),
  );
  push(
    "acp-without-instanceId",
    baseThread({ acpAgentId: "old-a", installationId: "old-i", instanceId: "old-s" }),
    envelope({ type: "thread.updated", acp: { acpAgentId: "a2", installationId: "i2" } }, seq++, nextAt()),
  );
  // changes with null, __proto__, array-index key, and different order.
  push(
    "changes-null-removes",
    baseThread({ pinned: true, listOrder: 3 } as Record<string, unknown>),
    envelope({ type: "thread.client.updated", changes: { pinned: null } }, seq++, nextAt()),
  );
  push(
    "changes-proto",
    baseThread(),
    envelope(
      { type: "thread.client.updated", changes: JSON.parse('{"__proto__":"pwned"}') },
      seq++,
      nextAt(),
    ),
  );
  push(
    "changes-array-index",
    baseThread(),
    envelope(
      { type: "thread.client.updated", changes: JSON.parse('{"0":"zero","2":"two"}') },
      seq++,
      nextAt(),
    ),
  );
  push(
    "changes-different-order",
    { ...baseThread(), b: 1, a: 2 } as Record<string, unknown>,
    envelope({ type: "thread.client.updated", changes: { a: 20, c: 3, b: 10 } }, seq++, nextAt()),
  );
  // queue.updated with and without a queue.
  push(
    "queue-without-queue",
    baseThread(),
    envelope({ type: "queue.updated", revision: 4, paused: false }, seq++, nextAt()),
  );
  push(
    "queue-with-queue",
    baseThread({ queue: { revision: 1, paused: true } }),
    envelope({ type: "queue.updated", revision: 2, paused: false, reason: "manual" }, seq++, nextAt()),
  );
  // thread.created.
  const createdThread = baseThread({ id: "thread-2", title: "Born" });
  push(
    "thread-created",
    createdThread,
    { seq: seq++, id: `event-${seq}`, at: nextAt(), threadId: "thread-2", payload: { type: "thread.created", thread: createdThread } },
  );
  // agent.created root and non-root.
  push(
    "agent-root",
    baseThread(),
    envelope({ type: "agent.created", agent: agent("agent-root", "root") }, seq++, nextAt()),
  );
  push(
    "agent-non-root",
    baseThread({ rootAgentId: "agent-root" }),
    envelope({ type: "agent.created", agent: agent("agent-leaf", "branch") }, seq++, nextAt()),
  );
  // item.created and item.updated with large bodies (not reaching).
  const big = "x".repeat(20_000);
  push(
    "item-created-large",
    baseThread(),
    envelope({ type: "item.created", item: { id: "item-big", type: "message", text: big } }, seq++, nextAt()),
  );
  push(
    "item-updated-large",
    baseThread(),
    envelope({ type: "item.updated", item: { id: "item-big", type: "message", text: big } }, seq++, nextAt()),
  );
  // unknown payload type.
  push(
    "unknown-type",
    baseThread(),
    envelope({ type: "mystery.event", data: 1 } as unknown as Record<string, unknown>, seq++, nextAt()),
  );
  // lone surrogates and split pairs in a title, a change and an agent id.
  const lone = "\ud800";
  push("title-lone", baseThread(), envelope({ type: "thread.updated", title: `hi ${lone}` }, seq++, nextAt()));
  push("title-pair", baseThread(), envelope({ type: "thread.updated", title: "hi 😀" }, seq++, nextAt()));
  push(
    "changes-lone",
    baseThread(),
    envelope({ type: "thread.client.updated", changes: { note: `n${lone}` } }, seq++, nextAt()),
  );
  push(
    "changes-pair",
    baseThread(),
    envelope({ type: "thread.client.updated", changes: { note: "n😀" } }, seq++, nextAt()),
  );
  push(
    "agent-lone",
    baseThread(),
    envelope({ type: "agent.created", agent: agent(`agent-${lone}`, "root") }, seq++, nextAt()),
  );
  push(
    "agent-pair",
    baseThread(),
    envelope({ type: "agent.created", agent: agent("agent-😀", "root") }, seq++, nextAt()),
  );
  // numbers in seq and at.
  for (const [label, value] of [
    ["1e21", 1e21],
    ["1.5e-7", 1.5e-7],
    ["neg-zero", -0],
    ["max-safe", 2 ** 53 - 1],
  ] as const)
    push(
      `numbers-${label}`,
      baseThread(),
      envelope({ type: "thread.updated", title: `n-${label}` }, value, value),
    );
  // a thread whose keys include an array-index key.
  push(
    "thread-array-keys",
    JSON.parse('{"id":"thread-1","workspaceId":"workspace-1","title":"Task","provider":"codex","status":{"state":"new"},"createdAt":1,"updatedAt":1,"2":"two","0":"zero","a":"A"}'),
    envelope({ type: "thread.updated", title: "Reordered" }, seq++, nextAt()),
  );
  return raws.map(({ name, thread, event }) => {
    const threadText = JSON.stringify(thread);
    const eventText = JSON.stringify(event);
    const sidebar = isSidebarEvent(JSON.parse(eventText) as never);
    const kind = (JSON.parse(eventText) as { payload: { type: string } }).payload.type;
    const input = foldInput(JSON.parse(eventText) as never);
    const payload = input?.payload ?? null;
    const reaches = input !== undefined;
    const parsed = JSON.parse(eventText) as { seq: number; at: number; payload: { thread?: unknown } };
    let folded: string;
    if (!reaches) {
      const copy = JSON.parse(threadText) as Record<string, unknown>;
      updateThread(copy as never, JSON.parse(eventText) as never);
      folded = JSON.stringify(copy);
      const expected = JSON.stringify(JSON.parse(threadText));
      if (folded !== expected) throw new Error(`no-op check failed for ${name}`);
    } else if (kind === "thread.created") {
      const copy = JSON.parse(eventText) as { payload: { thread: Record<string, unknown> } };
      updateThread(copy.payload.thread as never, copy as never);
      folded = JSON.stringify(copy.payload.thread);
    } else {
      const threadCopy = JSON.parse(threadText) as never;
      updateThread(threadCopy, JSON.parse(eventText) as never);
      folded = JSON.stringify(threadCopy);
    }
    return {
      name,
      thread: threadText,
      event: eventText,
      kind,
      payload,
      seq: parsed.seq,
      at: parsed.at,
      sidebar,
      reaches,
      folded,
    };
  });
}

const cases = build();
const text = `${JSON.stringify(cases, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = readFileSync(out, "utf8");
  if (current !== text) {
    console.error(`vectors differ: ${out} (run without --check to regenerate)`);
    process.exit(1);
  }
  console.log(`fold vectors ok: ${cases.length} cases`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${cases.length} cases`);
}
