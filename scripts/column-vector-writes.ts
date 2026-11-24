// SPDX-License-Identifier: Apache-2.0
/*
 * The column vectors about what a write records: the compares, the cold rows, `imported`,
 * `writtenColumns` and every fold pair.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventPayload } from "@ace/protocol";
import { capabilities, fieldSamples } from "../apps/daemon/src/thread-column-samples.ts";
import { writtenColumns } from "../apps/daemon/src/thread-columns.ts";
import {
  type Case,
  baseThread,
  clone,
  makeCase,
  pristine,
  thread,
  wantedAll,
} from "./column-vector-support.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cases: Case[] = [];

function reverseObjects(value: unknown): unknown {
  if (Array.isArray(value) || value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(value as Record<string, unknown>).toReversed())
    out[name] = reverseObjects((value as Record<string, unknown>)[name]);
  return out;
}

// Compares: content in another key order, a nested key-order change, cold rows, imported.
{
  const next = thread(pristine());
  next.details = reverseObjects(next.details) as Record<string, unknown>;
  cases.push(makeCase("compare-details-key-order", thread(pristine()), next, wantedAll));
}
{
  const previous = thread(pristine());
  previous.execution = { options: { a: 1, b: 2 } };
  const next = thread(pristine());
  next.execution = { options: { b: 2, a: 1 } };
  cases.push(makeCase("compare-transitions-key-order", previous, next, wantedAll));
}
{
  const next = thread(pristine());
  next.unused = "not a column";
  cases.push(makeCase("compare-unread-key", thread(pristine()), next, wantedAll));
}
cases.push(makeCase("cold-new-thread-none", null, baseThread(), wantedAll));
{
  const next = baseThread();
  next.details = clone(fieldSamples.details);
  cases.push(makeCase("cold-new-thread-details", null, next, wantedAll));
}
{
  const next = baseThread();
  next.capabilities = null;
  cases.push(makeCase("cold-new-thread-capabilities-null", null, next, wantedAll));
}
{
  const previous = thread(pristine());
  previous.capabilities = fieldSamples.acp.effectiveCapabilities;
  const next = thread(pristine());
  next.capabilities = capabilities(0);
  cases.push(makeCase("cold-capabilities-only", previous, next, wantedAll));
}
for (const [label, value, text] of [
  ["absent", undefined, undefined],
  ["object", { source: "import" }, undefined],
  ["false", false, undefined],
  ["zero", 0, undefined],
  ["neg-zero", -0, '"imported":-0'],
  ["empty-string", "", undefined],
  ["null", null, undefined],
] as const) {
  const next = thread(pristine());
  delete next.imported;
  if (value !== undefined) next.imported = value;
  const nextText =
    text === undefined ? undefined : JSON.stringify(next).replace('"imported":0', text);
  cases.push(
    makeCase(`imported-${label}`, thread(pristine()), next, ["imported"], { next: nextText }),
  );
}

// writtenColumns: acp only when the event carries acp fields, and never for a delta.
function renamed(): Record<string, unknown> {
  const next = thread(pristine());
  next.title = "Renamed";
  return next;
}
cases.push(
  makeCase(
    "written-updated-effectiveCapabilities",
    thread(pristine()),
    renamed(),
    writtenColumns({
      type: "thread.updated",
      effectiveCapabilities: fieldSamples.acp.effectiveCapabilities,
    } as unknown as EventPayload),
  ),
);
cases.push(
  makeCase(
    "written-updated-plain",
    thread(pristine()),
    renamed(),
    writtenColumns({ type: "thread.updated" } as unknown as EventPayload),
  ),
);
cases.push(
  makeCase(
    "written-updated-acpSupport",
    thread(pristine()),
    renamed(),
    writtenColumns({
      type: "thread.updated",
      acpSupport: fieldSamples.acp.acpSupport,
    } as unknown as EventPayload),
  ),
);
cases.push(
  makeCase(
    "written-updated-acp",
    thread(pristine()),
    renamed(),
    writtenColumns({ type: "thread.updated", acp: fieldSamples.acp } as unknown as EventPayload),
  ),
);
cases.push(
  makeCase(
    "written-item-delta",
    thread(pristine()),
    thread(pristine()),
    writtenColumns({
      type: "item.delta",
      itemId: "item-1",
      delta: "text",
    } as unknown as EventPayload),
  ),
);

// Every fold pair: the writer's previous thread (none on creation) and its folded thread.
{
  const { fold: folds } = JSON.parse(
    readFileSync(join(root, "native/daemon/vectors/fold.json"), "utf8"),
  ) as {
    fold: {
      name: string;
      thread: string;
      event: string;
      folded: string;
      kind: string;
    }[];
  };
  for (const item of folds) {
    const payload = (JSON.parse(item.event) as { payload: EventPayload }).payload;
    cases.push(
      makeCase(
        `fold-${item.name}`,
        item.kind === "thread.created" ? null : JSON.parse(item.thread),
        null,
        writtenColumns(payload),
        { previous: item.kind === "thread.created" ? undefined : item.thread, next: item.folded },
      ),
    );
  }
}

export const writeCases: Case[] = cases;
