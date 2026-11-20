import { describe, expect, it } from "vitest";
import { attribute, type Author, type EditCall } from "./attribution.ts";

const change = { path: "src/store.ts", at: 100_000, threadId: "this", checkout: "/repo" };

const call = (overrides: Partial<EditCall>): EditCall => ({
  threadId: "this",
  threadTitle: "Editor buffers",
  agent: "Claude Code",
  path: "src/store.ts",
  at: 97_000,
  ...overrides,
});

const here: Author = { kind: "agent", agent: "Claude Code", threadId: "this" };
const unknown: Author = { kind: "unknown" };

describe("who changed a file on disk", () => {
  const table: [string, EditCall[], Author][] = [
    ["an edit call in this thread 3 s before is this thread's agent", [call({})], here],
    ["a call exactly 10 s before still counts", [call({ at: 90_000 })], here],
    ["a call 10.001 s before is too old", [call({ at: 89_999 })], unknown],
    ["a call after the change did not cause it", [call({ at: 100_001 })], unknown],
    ["a call on another path says nothing", [call({ path: "src/other.ts" })], unknown],
    ["no calls at all is unknown", [], unknown],
    [
      "another thread's call names that thread",
      [call({ threadId: "fix", threadTitle: "Fix relay loop", agent: "Codex" })],
      { kind: "thread", threadId: "fix", title: "Fix relay loop", agent: "Codex" },
    ],
    [
      "the latest call in the window wins",
      [
        call({ at: 92_000 }),
        call({ threadId: "fix", threadTitle: "Fix relay loop", agent: "Codex", at: 99_000 }),
      ],
      { kind: "thread", threadId: "fix", title: "Fix relay loop", agent: "Codex" },
    ],
    [
      "a tie goes to this thread",
      [call({ threadId: "fix", threadTitle: "Fix relay loop", at: 97_000 }), call({})],
      here,
    ],
    ["an absolute path inside the checkout matches", [call({ path: "/repo/src/store.ts" })], here],
    ["a ./ prefix and doubled slashes match", [call({ path: "./src//store.ts" })], here],
    [
      "an absolute path in another checkout does not match",
      [call({ path: "/elsewhere/src/store.ts" })],
      unknown,
    ],
  ];

  for (const [name, calls, author] of table)
    it(name, () => {
      expect(attribute(change, calls)).toEqual(author);
    });
});
