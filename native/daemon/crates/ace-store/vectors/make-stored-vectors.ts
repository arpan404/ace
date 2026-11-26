// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `stored.json`, the byte fixtures T4a's Rust stored-row decoder is proved against.
 *
 *   bun native/daemon/crates/ace-store/vectors/make-stored-vectors.ts
 *
 * Each case is a legacy row the trust tests describe: an item whose defaults an older build left
 * out, an item or event kind this build doesn't know, a field Zod strips, the pre-rename switch
 * recommendation. The expected text is what `stored-decode.ts` gives, so the Rust decoder must
 * keep the same fields, defaults, order and bytes.
 */

import { join } from "node:path";
import {
  decodeStoredEntity,
  decodeStoredItem,
  decodeStoredPayload,
  isTrusted,
  storedEntitySchemas,
  storedEvent,
  trustedFrom,
  untrusted,
} from "../../../../../apps/daemon/src/stored-decode.ts";
import { stable, writeVectors } from "../../../vectors/vectors-io.ts";

const json = (value: unknown): string => JSON.stringify(value);

/** A message item as an older build may have stored it: no `complete`, `synthetic` or `raw`. */
const legacyMessage = {
  id: "m0",
  agentId: "root",
  type: "message",
  role: "assistant",
  parts: [{ type: "text", text: "hello" }],
  createdAt: 1,
};

const shellItem = {
  id: "t0",
  agentId: "root",
  type: "tool_call",
  createdAt: 1,
  call: {
    id: "t0",
    agentId: "root",
    kind: "shell",
    title: "ls",
    status: "succeeded",
    detail: { kind: "shell", command: "ls", retired: true },
    startedAt: 1,
    raw: [{ type: "message_stop", data: { blob: "A" } }],
    unknownField: "dropped",
  },
};

const items = [
  { name: "a message missing its defaults", input: legacyMessage },
  {
    name: "a message with a field this build strips",
    input: { ...legacyMessage, complete: false, later: true },
  },
  {
    name: "a tool call with stripped inner fields",
    input: shellItem,
  },
  {
    name: "an item kind this build does not know",
    input: { id: "x0", agentId: "root", createdAt: 2, type: "future.item", detail: { a: 1 } },
  },
].map(({ name, input }) => ({
  name,
  input: json(input),
  expected: json(decodeStoredItem(input)),
}));

const payloads = [
  {
    name: "a created item carries the decoded item",
    input: { type: "item.created", item: legacyMessage },
  },
  {
    name: "an updated unknown item kind",
    input: {
      type: "item.updated",
      item: { id: "x0", agentId: "root", createdAt: 2, type: "future.item", detail: { a: 1 } },
    },
  },
  {
    name: "a thread update with a legacy switch recommendation",
    input: {
      type: "thread.updated",
      title: "renamed",
      switch: {
        selection: { provider: "codex" },
        state: "applied",
        lossy: false,
        recommendation: "delegate_task",
        at: 5,
        later: "stripped",
      },
      extra: true,
    },
  },
  {
    // The switch keeps the place the schema gives it: `status` follows it, as `EventPayload`
    // orders them, so a decode that moved the field to the end would show here.
    name: "a switch keeps its place before the fields that follow it",
    input: {
      type: "thread.updated",
      switch: {
        selection: { provider: "codex" },
        state: "applied",
        lossy: false,
        recommendation: "delegate_task",
        at: 5,
      },
      execution: { provider: "codex" },
      status: { state: "idle" },
      archivedAt: 9,
    },
  },
  {
    name: "a thread update with a title only",
    input: { type: "thread.updated", title: "plain", extra: 1 },
  },
  {
    // `idle` is a legacy state this build's `ThreadStatus` does not know: it reads as
    // `unknown`, the whole object kept in `raw`.
    name: "a created thread with a state this build does not know",
    input: {
      type: "thread.created",
      thread: {
        id: "t1",
        workspaceId: "w1",
        title: "Legacy",
        provider: "codex",
        status: { state: "idle", since: 3 },
        createdAt: 1,
        updatedAt: 2,
      },
    },
  },
  {
    // An agent's `idle` is an `AgentStatus` state, not a thread state: it stays as stored.
    name: "an agent status keeps its own states",
    input: { type: "agent.status", agentId: "a1", status: { state: "idle" }, completionRelevant: true },
  },
  {
    name: "an event kind this build does not know",
    input: { type: "future.event", threadId: "t", payload: { deep: [1, 2, 3] } },
  },
].map(({ name, input }) => ({
  name,
  input: json(input),
  expected: json(decodeStoredPayload(input)),
}));

const rows = [
  {
    name: "a trusted row is its payload text in the envelope",
    row: {
      seq: 10,
      id: "e10",
      thread_id: "t1",
      at: 1731600000010,
      payload: json({ type: "thread.updated", title: "trusted" }),
    },
    trust: trustedFrom(5),
  },
  {
    name: "an untrusted row is decoded",
    row: {
      seq: 3,
      id: "e3",
      thread_id: "t1",
      at: 1731600000003,
      payload: json({ type: "thread.updated", title: "decoded", extra: 1 }),
    },
    trust: trustedFrom(5),
  },
  {
    name: "a rejected sequence in the trusted range is decoded",
    row: {
      seq: 7,
      id: "e7",
      thread_id: "t1",
      at: 1731600000007,
      payload: json({ type: "item.created", item: legacyMessage }),
    },
    trust: { from: 5, rejected: new Set([7]) },
  },
].map(({ name, row, trust }) => {
  const { event, bytes } = storedEvent(row, trust);
  return {
    name,
    row: {
      seq: row.seq,
      id: row.id,
      thread_id: row.thread_id,
      at: row.at,
      payload: row.payload,
    },
    trust: {
      from: Number.isFinite(trust.from) ? trust.from : null,
      rejected: [...trust.rejected],
    },
    event: json(event),
    bytes,
  };
});

// Entity rows: the collection's schema parse, defaults filled and unknown keys stripped, for
// every collection `storedEntitySchemas` names. The values are legacy shapes too — fields the
// schema defaults (`background`, `ambient`) are absent.
const entities = [
  {
    name: "an agent gets its defaults and keeps the schema's order",
    collection: "agents",
    input: {
      id: "a1",
      threadId: "t1",
      parentId: null,
      origin: "root",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: "/repo",
      status: { state: "idle" },
      createdAt: 1,
      future: "dropped",
    },
  },
  {
    name: "a run drops the fields this build does not know",
    collection: "runs",
    input: {
      id: "r1",
      threadId: "t1",
      agentId: "a1",
      trigger: "user",
      state: "active",
      startedAt: 1,
      future: "dropped",
    },
  },
  {
    name: "an interaction keeps its request as the schema parses it",
    collection: "interactions",
    input: {
      id: "i1",
      threadId: "t1",
      agentId: "a1",
      blocking: true,
      request: { kind: "plan_review", markdown: "# plan", future: "dropped" },
      state: "pending",
      createdAt: 1,
      future: "dropped",
    },
  },
  {
    name: "a background task gets its defaults",
    collection: "backgroundTasks",
    input: {
      id: "b1",
      agentId: "a1",
      kind: "shell",
      title: "build",
      status: "running",
      stoppable: true,
      startedAt: 1,
      future: "dropped",
    },
  },
  {
    name: "a usage row is its counters",
    collection: "usage",
    input: {
      type: "usage.updated",
      agentId: "a1",
      inputTokens: 10,
      outputTokens: 5,
      future: "dropped",
    },
  },
  {
    name: "a usage snapshot is the same row under its other collection",
    collection: "usageSnapshots",
    input: {
      type: "usage.updated",
      agentId: "a1",
      inputTokens: 10,
      outputTokens: 5,
      future: "dropped",
    },
  },
  {
    name: "a context meter keeps its optional fields out",
    collection: "contextMeters",
    input: { agentId: "a1", epoch: 1, usedTokens: 100, windowTokens: 200, source: "provider" },
  },
  {
    name: "a queue's nested state is parsed",
    collection: "queue",
    input: {
      revision: 2,
      paused: false,
      reason: null,
      resumeAt: null,
      lastFailure: { title: "stopped", code: "stopped" },
      future: "dropped",
    },
  },
].map(({ name, collection, input }) => ({
  name,
  collection,
  input: json(input),
  expected: json(
    decodeStoredEntity(collection as keyof typeof storedEntitySchemas, input as never),
  ),
}));

// Entity rows are `strip` over the same generated table the column vectors prove; the stored
// decode adds only the trusted-row shortcut, which the trust cases below cover, and the
// collection's root, which the entity cases above cover.

// Entity rows are `strip` over the same generated table the column vectors prove; the stored
// decode adds only the trusted-row shortcut, which the trust cases below cover. Their wire
// proof belongs to the snapshot read (T4), where the values reach the socket.

const trustCases = [
  { name: "nothing until open", trust: { from: null, rejected: [] }, seqs: [0, 1] },
  { name: "every row from the mark", trust: { from: 5, rejected: [] }, seqs: [4, 5, 9] },
  { name: "a rejected sequence is decoded", trust: { from: 5, rejected: [7] }, seqs: [6, 7, 8] },
].map(({ name, trust, seqs }) => {
  const value =
    trust.from === null
      ? untrusted()
      : trustedFrom(trust.from as number);
  for (const seq of trust.rejected) value.rejected.add(seq);
  return {
    name,
    trust: { from: trust.from, rejected: trust.rejected },
    seqs: seqs.map((seq) => ({ seq, trusted: isTrusted(value, seq) })),
  };
});

writeVectors(
  join(import.meta.dir, "stored.json"),
  stable({ items, payloads, rows, entities, trustCases }),
);
