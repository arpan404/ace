// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `wire-trim.json`, the byte fixtures T3's Rust `WireTrimmer`/`WireRestorer` are proved
 * against.
 *
 *   bun native/daemon/crates/ace-fanout/vectors/make-trim-vectors.ts
 *
 * Each step's `frames` are the exact bytes the daemon sends that connection: an `events` frame
 * through `WireEncoder`, every other message through `JSON.stringify` (what `encode` does for
 * them). The cases follow `packages/projection/src/wire-trim.test.ts` and
 * `raw-on-demand.test.ts`, plus the `storage-hold` and `moved-status` messages those tests name.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Capabilities,
  Item,
  Thread,
  ThreadId,
  type ServerMessage,
} from "@ace/protocol";
import {
  createThreadListView,
  createThreadView,
} from "../../../../../packages/projection/src/index.ts";
import {
  supportedWireTrims,
  WireRestorer,
  WireTrimmer,
  wireTrims,
} from "../../../../../packages/projection/src/wire-trim.ts";
import { WireEncoder } from "../../../../../apps/daemon/src/wire-encoder.ts";

type Message = ServerMessage;

const encoder = new WireEncoder();

/** The bytes the daemon sends: an events frame through the encoder, any other through JSON. */
const bytesOf = (message: Message): string => encoder.encode(message);

const MOVED = {
  state: "moved" as const,
  to: { hostId: "machine-2", name: "Machine 2", threadId: "t" },
};

const capabilities = (steer: boolean) =>
  Capabilities.parse({
    steer,
    interruptCascades: true,
    resume: true,
    fork: true,
    subagentTranscripts: true,
    backgroundTaskControl: true,
    backgroundVisibility: "full",
    planMode: true,
    tokenUsage: true,
    imageInput: true,
    rewindFiles: false,
    launchOptions: ["effort", "serviceTier"],
  });

const thread = (id: string, caps: Capabilities | undefined, status = { state: "new" as const }) =>
  Thread.parse({
    id,
    workspaceId: "w",
    title: id,
    provider: "codex",
    status,
    createdAt: 1,
    updatedAt: 1,
    ...(caps ? { capabilities: caps } : {}),
  });

const messageItem = (id: string, complete: boolean): Item =>
  Item.parse({
    id,
    agentId: "a",
    type: "message",
    role: "assistant",
    complete,
    createdAt: 1,
    parts: [{ type: "text", text: id }],
  });

const delegationItem = (): Item =>
  Item.parse({
    id: "delegation",
    agentId: "a",
    type: "delegation.started",
    origin: "ace",
    childThreadId: "child",
    provider: "codex",
    title: "child",
    role: "worker",
    phase: "running",
    status: MOVED,
    createdAt: 1,
    updatedAt: 1,
    generation: 0,
    raw: [],
  });

const threadSnapshot = (caps: Capabilities | undefined, status = { state: "new" as const }) => {
  const view = createThreadView(thread("t", caps, status), 4);
  view.items = {
    m1: messageItem("m1", true),
    m2: messageItem("m2", false),
    delegation: delegationItem(),
  };
  view.itemOrder = ["m1", "m2", "delegation"];
  view.itemSeqs = { m1: 1, m2: 2, delegation: 3 };
  return { type: "snapshot" as const, subscriptionId: "s", seq: 4, view } satisfies Message;
};

const icon = `data:image/png;base64,${"A".repeat(4096)}`;
const otherIcon = `data:image/png;base64,${"B".repeat(4096)}`;
const project = (id: string, mark: string | undefined) =>
  Thread.parse({
    id,
    workspaceId: "w",
    title: id,
    provider: "codex",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
    capabilities: capabilities(true),
    effectiveCapabilities: capabilities(false),
    details: {
      workspace: {
        id: "w",
        name: "ace",
        path: "/ace",
        ...(mark ? { defaultIcon: mark, icon: otherIcon } : {}),
      },
    },
  });
const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
const sidebarSnapshot = (): Message => ({
  type: "snapshot",
  subscriptionId: "s",
  seq: 1,
  view: createThreadListView(
    ids.map((id, i) => project(id, i === 39 ? undefined : icon)),
    1,
  ),
});

const patch = (entry: Thread): Message => ({
  type: "threads.patch",
  subscriptionId: "s",
  seq: 2,
  threads: { [entry.id]: entry },
  removed: [],
  window: { before: null, total: 3, counts: [] },
});

type Step = { message: Message; frames: string[] };
type Case = { name: string; trims: string[] | null; steps: Step[] };

function runTrimmer(name: string, trims: string[] | null, messages: Message[]): Case {
  const trimmer = new WireTrimmer(trims ?? undefined);
  return {
    name,
    trims,
    steps: messages.map((message) => ({
      message: JSON.stringify(message),
      frames: trimmer.outgoing(structuredClone(message)).map(bytesOf),
    })),
  };
}

const every = [...supportedWireTrims];

const trimmer: Case[] = [
  runTrimmer("capabilities keyed once, then reused by a patch", every, [
    threadSnapshot(capabilities(true)),
    patch(Thread.parse(thread("a", capabilities(true)))),
    threadSnapshot(capabilities(false)),
  ]),
  runTrimmer("items trimmed, an incomplete item stays marked incomplete", every, [
    threadSnapshot(undefined),
    {
      type: "items.page",
      requestId: "r",
      seq: 2,
      threadId: ThreadId.parse("t"),
      items: [messageItem("m1", true)],
      itemSeqs: { m1: 1 },
      itemsBefore: null,
    } satisfies Message,
  ]),
  runTrimmer("sidebar shares a repeated workspace icon once", every, [sidebarSnapshot()]),
  runTrimmer("sidebar keeps icons whole without the trim", [wireTrims.itemDefaults], [
    sidebarSnapshot(),
  ]),
  runTrimmer("a client that asked for nothing gets no trims, only statuses it predates", null, [
    threadSnapshot(capabilities(true)),
  ]),
  runTrimmer("an unknown trim changes nothing", ["unknown-trim"], [
    threadSnapshot(capabilities(true)),
  ]),
  runTrimmer("the hidden Spade code reads unavailable", null, [
    {
      type: "spade.http.result",
      requestId: "h",
      result: { kind: "error", code: "hidden", message: "Spade is hidden." },
    } satisfies Message,
    { type: "spade.live.ended", requestId: "l", reason: "hidden" } satisfies Message,
  ]),
  runTrimmer("a client with the spade trim reads hidden", [wireTrims.spadeHidden], [
    {
      type: "spade.http.result",
      requestId: "h",
      result: { kind: "error", code: "hidden", message: "Spade is hidden." },
    } satisfies Message,
    { type: "spade.live.ended", requestId: "l", reason: "hidden" } satisfies Message,
  ]),
  runTrimmer("the storage hold reads as the person's own pause", null, [
    {
      type: "admission.changed",
      admission: { holds: ["storage", "user", "storage"] },
    } satisfies Message,
    {
      type: "admission.result",
      requestId: "r",
      admission: { holds: ["storage"] },
      accepted: false,
    } satisfies Message,
    { type: "admission.result", requestId: "r2", accepted: true } satisfies Message,
  ]),
  runTrimmer("a client with the storage trim reads storage", [wireTrims.storageHold], [
    {
      type: "admission.changed",
      admission: { holds: ["storage", "user", "storage"] },
    } satisfies Message,
  ]),
  runTrimmer("a moved status reads waiting for a reader that predates it", null, [
    movedEvents(),
    movedPatch(),
    threadSnapshot(undefined, MOVED),
    {
      type: "snapshot",
      subscriptionId: "s",
      seq: 1,
      view: createThreadListView([thread("a", undefined, MOVED)], 1),
    } satisfies Message,
    {
      type: "items.page",
      requestId: "r",
      seq: 2,
      threadId: ThreadId.parse("t"),
      items: [delegationItem()],
      itemsBefore: null,
    } satisfies Message,
    {
      type: "turn.steps",
      subscriptionId: "s",
      seq: 3,
      threadId: ThreadId.parse("t"),
      turnId: "turn",
      steps: [{ item: delegationItem() }],
    } as unknown as Message,
    {
      type: "turns.page",
      requestId: "r",
      seq: 4,
      threadId: ThreadId.parse("t"),
      turns: [
        {
          id: "turn",
          threadId: "t",
          status: MOVED,
          subagents: [thread("a", undefined, MOVED)],
          startedAt: 1,
        },
      ],
      before: null,
    } as unknown as Message,
    {
      type: "thread.catchUp",
      subscriptionId: "s",
      seq: 5,
      threadId: ThreadId.parse("t"),
      status: MOVED,
    } as unknown as Message,
    {
      type: "search.results",
      requestId: "r",
      seq: 6,
      hits: [{ threadId: "t", title: "t", status: "moved" }],
    } as unknown as Message,
  ]),
  runTrimmer("a client with the moved trim reads moved", [wireTrims.movedStatus], [
    movedEvents(),
    movedPatch(),
    threadSnapshot(undefined, MOVED),
  ]),
];

function movedEvents(): Message {
  return {
    type: "events",
    subscriptionId: "s",
    afterSeq: 0,
    throughSeq: 3,
    events: [
      {
        seq: 1,
        id: "e1",
        at: 1,
        threadId: "t",
        payload: {
          type: "thread.updated",
          status: MOVED,
        },
      },
      {
        seq: 2,
        id: "e2",
        at: 2,
        threadId: "t",
        payload: {
          type: "item.created",
          item: delegationItem(),
        },
      },
      {
        seq: 3,
        id: "e3",
        at: 3,
        threadId: "t",
        payload: {
          type: "thread.created",
          thread: thread("t", undefined, MOVED),
        },
      },
    ],
  } as unknown as Message;
}

function movedPatch(): Message {
  return {
    type: "threads.patch",
    subscriptionId: "s",
    seq: 2,
    threads: {
      t: thread("t", undefined, MOVED),
    },
    removed: [],
    window: { before: null, total: 1, counts: [] },
  } as unknown as Message;
}

/** The restorer over the frames one connection received, in order. */
const restorerCases: { name: string; frames: string[]; restored: string[] }[] = [];

function runRestorer(name: string, frames: string[], learned = true): void {
  const restorer = new WireRestorer();
  const restored: string[] = [];
  const feed = learned ? frames : frames.slice(1);
  for (const frame of feed) {
    const message = restorer.restore(JSON.parse(frame) as Message);
    if (message !== undefined) restored.push(bytesOf(message));
  }
  restorerCases.push({ name, frames: feed, restored });
}

const capabilityCase = trimmer[0];
if (capabilityCase) runRestorer("capabilities restored from the key", capabilityCase.steps.flatMap((step) => step.frames));
const sidebarCase = trimmer[2];
if (sidebarCase) runRestorer("every shared icon restored", sidebarCase.steps.flatMap((step) => step.frames));
const itemCase = trimmer[1];
if (itemCase) runRestorer("trimmed items restored by the schema", itemCase.steps.flatMap((step) => step.frames));
const untaught = capabilityCase?.steps[0]?.frames ?? [];
runRestorer("a key that was never taught leaves the thread without capabilities", untaught, false);

const out = { trimmer, restorer: restorerCases };
const path = join(import.meta.dir, "wire-trim.json");
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${path}`);
