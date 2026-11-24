// SPDX-License-Identifier: Apache-2.0
/*
 * The column vectors that exercise the shape walk: every field, nulls, unknown keys, defaults,
 * unstorable values, key order, discriminated unions, numbers and strings.
 */

import {
  type Case,
  type Family,
  type Field,
  type Path,
  addUnknown,
  candidates,
  clone,
  deletePath,
  dotted,
  fieldsOf,
  makeCase,
  mutated,
  nodeAt,
  pristine,
  removed,
  roots,
  setPath,
  thread,
  wantedAll,
} from "./column-vector-support.ts";

const cases: Case[] = [];

// Every field of the three shapes: absent to present, present to absent, and a second legal
// value. A field whose sample change doesn't parse is skipped (Web URL formats and the like).
for (const family of ["client", "details", "acp"] as const) {
  const fields: Field[] = [];
  fieldsOf(roots[family], pristine()[family], [], fields);
  for (const field of fields) {
    const prefix = `field-${family}-${dotted(field.path)}`;
    if (field.optional) {
      const absent = removed(family, field.path);
      try {
        roots[family].parse(absent[family]);
        cases.push(
          makeCase(`${prefix}-absent-to-present`, thread(absent), thread(pristine()), wantedAll),
        );
        cases.push(
          makeCase(`${prefix}-present-to-absent`, thread(pristine()), thread(absent), wantedAll),
        );
      } catch {
        // The sibling fields make the absent sample invalid; no case.
      }
    }
    const current = nodeAt(pristine()[family], field.path);
    for (const candidate of candidates(field.schema)) {
      if (JSON.stringify(candidate) === JSON.stringify(current)) continue;
      const after = mutated(family, field.path, candidate);
      try {
        roots[family].parse(after[family]);
      } catch {
        continue;
      }
      cases.push(makeCase(`${prefix}-changed`, thread(pristine()), thread(after), wantedAll));
      break;
    }
  }
}

// Null at every nullable path in the three shapes.
const nullable: [Family, Path][] = [
  ["details", ["branch"]],
  ["details", ["head"]],
  ["details", ["upstream"]],
  ["details", ["linkedPr"]],
  ["details", ["workspace", "icon"]],
  ["details", ["workspace", "defaultIcon"]],
  ["details", ["pullRequestWorkspace", "headRepository"]],
  ["client", ["live", "rootRunId"]],
  ["client", ["live", "contextMeter", "limit"]],
  ["client", ["movedFrom", "links", "linkedPr"]],
];
for (const [family, path] of nullable)
  cases.push(
    makeCase(
      `null-${family}-${dotted(path)}`,
      thread(pristine()),
      thread(mutated(family, path, null)),
      wantedAll,
    ),
  );

// Null on one optional field of each schema that isn't nullable: the TypeScript rejects.
const nonNullable: [Family, Path, string][] = [
  ["client", ["pinOrder"], "client"],
  ["details", ["mode"], "details"],
  ["acp", ["acpAgentId"], "acp"],
];
for (const [family, path, column] of nonNullable) {
  const recorded = makeCase(
    `null-${family}-${dotted(path)}-rejected`,
    thread(pristine()),
    thread(mutated(family, path, null)),
    wantedAll,
  );
  cases.push(recorded);
  if (JSON.stringify(recorded.values.find(([name]) => name === column)?.[1]) !== '["rejected"]')
    throw new Error(`null ${family}.${dotted(path)} was not rejected`);
}

// Unknown keys, among them `__proto__` and an array-index key, at each object level.
const unknownAt: [Family, Path][] = [
  ["client", []],
  ["details", ["workspaceChange"]],
  ["details", ["pullRequestWorkspace", "ref", "repository"]],
  ["client", ["live", "turnStart"]],
  ["client", ["snoozeWake", "prs", 0]],
  ["acp", ["acpSupport", "raw"]],
  ["acp", ["effectiveCapabilities", "permissions"]],
];
for (const [family, path] of unknownAt) {
  const parts = pristine();
  if (nodeAt(parts[family], path) === undefined)
    setPath(parts[family], path, { modes: ["default"], nativeAutoReview: false, toolGate: true });
  addUnknown(nodeAt(parts[family], path));
  cases.push(
    makeCase(
      `unknown-keys-${family}-${dotted(path) || "thread"}`,
      thread(pristine()),
      thread(parts),
      wantedAll,
    ),
  );
}

// Defaults: `workspaceChange.lossy` and `acpSupport.subagentSessions`.
const noLossy = pristine();
deletePath(noLossy.details, ["workspaceChange", "lossy"]);
cases.push(makeCase("default-lossy-absent", thread(pristine()), thread(noLossy), wantedAll));
cases.push(
  makeCase(
    "default-lossy-false",
    thread(pristine()),
    thread(mutated("details", ["workspaceChange", "lossy"], false)),
    wantedAll,
  ),
);
const noSessions = pristine();
deletePath(noSessions.acp, ["acpSupport", "subagentSessions"]);
cases.push(
  makeCase("default-subagentSessions-absent", thread(pristine()), thread(noSessions), wantedAll),
);
cases.push(
  makeCase(
    "default-subagentSessions-true",
    thread(pristine()),
    thread(mutated("acp", ["acpSupport", "subagentSessions"], true)),
    wantedAll,
  ),
);
for (const [name, family, path, column] of [
  ["default-lossy-null", "details", ["workspaceChange", "lossy"], "details"],
  ["default-subagentSessions-null", "acp", ["acpSupport", "subagentSessions"], "acp"],
  ["default-both-null", "details", ["workspaceChange", "lossy"], "details"],
] as const) {
  let parts: ReturnType<typeof pristine>;
  if (name === "default-both-null") {
    parts = mutated("details", ["workspaceChange", "lossy"], null);
    setPath(parts.acp, ["acpSupport", "subagentSessions"], null);
  } else parts = mutated(family, path, null);
  const recorded = makeCase(name, thread(pristine()), thread(parts), wantedAll);
  cases.push(recorded);
  const rejected = (key: string) =>
    JSON.stringify(recorded.values.find(([field]) => field === key)?.[1]) === '["rejected"]';
  if (!rejected(column) || (name === "default-both-null" && !rejected("acp")))
    throw new Error(`${name}: the default did not reject null`);
}

// Unstorable values, judged by the bind oracle: title and created_at absent, a boolean, an
// object and an array; status absent.
for (const field of ["title", "createdAt"] as const) {
  for (const [label, value] of [
    ["absent", undefined],
    ["boolean", true],
    ["object", { a: 1 }],
    ["array", [1]],
  ] as const) {
    const next = thread(pristine());
    delete next[field];
    if (value !== undefined) next[field] = value;
    cases.push(makeCase(`unstorable-${field}-${label}`, null, next, wantedAll));
  }
}
{
  const next = thread(pristine());
  delete next.status;
  cases.push(makeCase("unstorable-status-absent", null, next, wantedAll));
}

// Key order: every Zod object reversed, and a record with keys out of order.
function reverseObjects(value: unknown, key?: string): unknown {
  if (key === "options" || Array.isArray(value) || value === null || typeof value !== "object")
    return Array.isArray(value) ? value.map((item) => reverseObjects(item)) : value;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(value as Record<string, unknown>).toReversed())
    out[name] = reverseObjects((value as Record<string, unknown>)[name], name);
  return out;
}
{
  const parts = pristine();
  const reversed = {
    client: reverseObjects(parts.client),
    details: reverseObjects(parts.details),
    acp: reverseObjects(parts.acp),
  };
  cases.push(makeCase("key-order-reversed", thread(pristine()), thread(reversed), wantedAll));
}
{
  const options = { "0": "zero", "1": "one", stream: true, effort: 3, model: "gpt-5" };
  const previous = mutated("client", ["live", "options"], options);
  const next = clone(options) as Record<string, unknown>;
  Object.defineProperty(next, "__proto__", {
    value: "pwned",
    enumerable: true,
    configurable: true,
    writable: true,
  });
  next.zero = "zero";
  delete next["0"];
  cases.push(
    makeCase(
      "key-order-options-unknown",
      thread(previous),
      thread(mutated("client", ["live", "options"], next)),
      wantedAll,
    ),
  );
}

// Discriminated unions: every option, each with an unknown key, and an unknown discriminator.
const wakeOptions = [
  { on: "needs_you" },
  { on: "pr", prs: [{ pr: "github.com/owner/repo#7", state: "open", updatedAt: 1 }] },
];
for (const [index, option] of wakeOptions.entries()) {
  const withUnknown = clone(option) as Record<string, unknown>;
  withUnknown.mystery = 1;
  cases.push(
    makeCase(
      `union-snoozeWake-${index}`,
      thread(pristine()),
      thread(mutated("client", ["snoozeWake"], withUnknown)),
      wantedAll,
    ),
  );
}
const wokeOptions = [
  { on: "time", at: 1 },
  { on: "needs_you", at: 1, outcome: "finished" },
  { on: "pr", at: 1, number: 1, change: "merged" },
];
for (const [index, option] of wokeOptions.entries()) {
  const withUnknown = clone(option) as Record<string, unknown>;
  withUnknown.mystery = 1;
  cases.push(
    makeCase(
      `union-snoozeWoke-${index}`,
      thread(pristine()),
      thread(mutated("client", ["snoozeWoke"], withUnknown)),
      wantedAll,
    ),
  );
}
cases.push(
  makeCase(
    "union-unknown-discriminator",
    thread(pristine()),
    thread(mutated("client", ["snoozeWake"], { on: "mystery" })),
    wantedAll,
  ),
);

// Numbers, including -0 in the number columns.
for (const [label, value] of [
  ["1e21", 1e21],
  ["1.5e-7", 1.5e-7],
  ["neg-zero", -0],
  ["max-safe", 2 ** 53 - 1],
] as const) {
  cases.push(
    makeCase(
      `number-pinOrder-${label}`,
      thread(pristine()),
      thread(mutated("client", ["pinOrder"], value)),
      wantedAll,
    ),
  );
  cases.push(
    makeCase(
      `number-listOrder-${label}`,
      thread(pristine()),
      thread(mutated("client", ["listOrder"], value)),
      wantedAll,
    ),
  );
  const created = thread(pristine());
  created.createdAt = value;
  cases.push(makeCase(`number-createdAt-${label}`, thread(pristine()), created, wantedAll));
  const updated = thread(pristine());
  updated.updatedAt = value;
  cases.push(makeCase(`number-updatedAt-${label}`, thread(pristine()), updated, wantedAll));
}
{
  const previous = thread(pristine());
  previous.updatedAt = 0;
  const previousText = JSON.stringify(previous);
  const nextText = previousText.replace('"updatedAt":0', '"updatedAt":-0');
  cases.push(
    makeCase("number-updatedAt-zero-to-neg-zero", JSON.parse(previousText), null, wantedAll, {
      previous: previousText,
      next: nextText,
    }),
  );
}

// Strings: lone surrogates and split pairs, including an options key and an unknown key.
const lone = "\ud800";
const split = "\ud83dX\ude00";
for (const [label, value] of [
  ["lone", lone],
  ["split", split],
] as const) {
  const titled = thread(pristine());
  titled.title = `hi ${value}`;
  cases.push(makeCase(`string-title-${label}`, thread(pristine()), titled, wantedAll));
  cases.push(
    makeCase(
      `string-details-branch-${label}`,
      thread(pristine()),
      thread(mutated("details", ["branch"], value)),
      wantedAll,
    ),
  );
  cases.push(
    makeCase(
      `string-live-model-${label}`,
      thread(pristine()),
      thread(mutated("client", ["live", "model"], value)),
      wantedAll,
    ),
  );
  cases.push(
    makeCase(
      `string-acpAgentId-${label}`,
      thread(pristine()),
      thread(mutated("acp", ["acpAgentId"], value)),
      wantedAll,
    ),
  );
  cases.push(
    makeCase(
      `string-options-key-${label}`,
      thread(pristine()),
      thread(mutated("client", ["live", "options"], { [value]: 1 })),
      wantedAll,
    ),
  );
  const withUnknown = thread(pristine());
  withUnknown[value] = "stripped";
  cases.push(makeCase(`string-unknown-key-${label}`, thread(pristine()), withUnknown, wantedAll));
}

export const shapeCases: Case[] = cases;
