import { apply, createThreadState, deriveThreadStatus } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { expect, test } from "vitest";
import { createCursorAdapter, type CursorEnvelope } from "./index.ts";

/** A Cursor thread fed host frames as the daemon commits them; `kind` frames go in order. */
function thread() {
  const threadId = ThreadId.parse("cursor-recovery");
  const translator = createCursorAdapter().createTranslator({ threadId, rootKey: "root" });
  const state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } });
  let seq = 0;
  let id = 0;
  const frame = (
    kind: string,
    body: unknown,
    extra: Partial<CursorEnvelope> & { generation?: string } = {},
  ) => {
    const input: Frame = {
      seq: ++seq,
      t: seq,
      channel: "sdk",
      dir: kind === "send" ? "send" : "recv",
      data: {
        schemaVersion: 1,
        generation: "host1",
        operationId: "op",
        segment: 0,
        agentId: "agent",
        kind,
        body,
        ...extra,
      },
    };
    for (const fact of translator.translate(input, seq))
      apply(state, fact, { now: seq, ids: { next: (entity) => `${entity}-${++id}` } });
  };
  const items = () => Object.values(state.items);
  const text = (role: "user" | "assistant") =>
    items().flatMap((item) =>
      item.type === "message" && item.role === role
        ? [item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")]
        : [],
    );
  const notices = () =>
    items().flatMap((item) => (item.type === "notice" ? [item.text ?? ""] : []));
  const status = () => deriveThreadStatus(state).state;
  const runs = () => Object.values(state.runs);
  return { frame, text, notices, status, runs };
}
const said = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

test("a send Cursor has not admitted yet shows working but starts no turn and shows no input", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "hello" }], attemptedAt: 1 });
  expect(t.runs()).toEqual([]);
  expect(t.text("user")).toEqual([]);
  expect(t.status()).toBe("working");
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  expect(t.runs()).toHaveLength(1);
  expect(t.text("user")).toEqual(["hello"]);
});

test("a send Cursor's store has no run for leaves the thread idle and claims nothing of its fate", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "hello" }], attemptedAt: 1 });
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame(
    "admission",
    { operationId: "op", segment: 0, admitted: false },
    { generation: "host2", operationId: "open" },
  );
  expect(t.runs()).toEqual([]);
  expect(t.status()).not.toBe("working");
  // Whether it was sent is the daemon's to say, once it knows the read was final.
  expect(t.notices().join(" ")).not.toMatch(/not sent/i);
});

test("a run that finished just before the daemon crashed shows as finished after restart", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, result: "the whole answer" },
    { generation: "host2", operationId: "open", runId: "run" },
  );
  expect(t.runs().map((run) => run.state)).toEqual(["completed"]);
  expect(t.text("assistant")).toEqual(["the whole answer"]);
  expect(t.status()).toBe("done");
  expect(t.notices().join(" ")).toContain("finished this run while ace was restarting");
});

test("a cut-off run's missing tail is recovered and marked as recovered, and the turn is not done", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  t.frame("delta", { type: "text-delta", text: "live part " }, { runId: "run", eventSeq: 1 });
  const after = { generation: "host2", operationId: "open", runId: "run" };
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame("recovered", said("missed "), after);
  t.frame("recovered", said("tail"), after);
  t.frame(
    "recovered",
    {
      type: "tool_call",
      call_id: "x",
      name: "shell",
      status: "completed",
      args: { command: "ls" },
      result: { status: "success", value: { exitCode: 0, stdout: "a", stderr: "" } },
      truncated: { result: true },
    },
    after,
  );
  t.frame("recovery", { nativeStatus: "running", interrupted: true }, after);
  // The answer the live stream started continues: one message, not a second copy.
  expect(t.text("assistant")).toEqual(["live part missed tail"]);
  const notice = t.notices().join(" ");
  expect(notice).toContain("recovered from Cursor's saved session");
  // The one thing the store can't give back is named, once.
  expect(t.notices().filter((text) => text.includes("shortened copy"))).toHaveLength(1);
  expect(t.runs().map((run) => run.state)).toEqual(["failed"]);
  expect(t.status()).not.toBe("done");
});

test("a finished turn whose last words never reached ace shows its whole answer from Cursor's result", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  t.frame("delta", { type: "text-delta", text: "The fix is " }, { runId: "run", eventSeq: 1 });
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  // The SDK lost the rest of the stream's writes; its stored result has the whole answer.
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, result: "The fix is in parser.ts." },
    { generation: "host2", operationId: "open", runId: "run" },
  );
  expect(t.text("assistant")).toEqual(["The fix is in parser.ts."]);
  expect(t.notices().join(" ")).toContain("Cursor's saved result");
  expect(t.status()).toBe("done");
});

test("a finished turn whose shown answer and stored result differ shows the result whole, said once", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  t.frame("delta", { type: "text-delta", text: "Draft" }, { runId: "run", eventSeq: 1 });
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, result: "Final answer." },
    { generation: "host2", operationId: "open", runId: "run" },
  );
  expect(t.text("assistant")).toEqual(["Draft", "Final answer."]);
  expect(t.notices().filter((text) => text.includes("Cursor's saved result"))).toHaveLength(1);
  expect(t.status()).toBe("done");
});

test("a finished turn whose answer ace showed whole repeats nothing from Cursor's result", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  t.frame("delta", { type: "text-delta", text: "All done." }, { runId: "run", eventSeq: 1 });
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, result: "All done." },
    { generation: "host2", operationId: "open", runId: "run" },
  );
  expect(t.text("assistant")).toEqual(["All done."]);
  expect(t.notices().join(" ")).not.toContain("Cursor's saved result");
  expect(t.status()).toBe("done");
});

test("a saved answer past the cap says once that it is cut, and the turn still ends done", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  const after = { generation: "host2", operationId: "open", runId: "run" };
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame("recovered-result", { text: "first part " }, after);
  t.frame("recovered-result", { text: "second part" }, after);
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, resultParts: 2, resultCut: true },
    after,
  );
  expect(t.text("assistant")).toEqual(["first part second part"]);
  expect(t.notices().filter((text) => text.includes("it is cut"))).toHaveLength(1);
  expect(t.status()).toBe("done");
});

test("a 3 MiB saved answer after 2 MiB of it streamed adds only the rest, never the streamed part again", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  // Committed before the crash: 2 MiB in 64 KiB deltas, some of it multibyte.
  const chunk = `${"é".repeat(16 * 1024)}${"x".repeat(32 * 1024)}`;
  const streamed = chunk.repeat(32);
  for (let at = 0; at < streamed.length; at += chunk.length)
    t.frame("delta", { type: "text-delta", text: streamed.slice(at, at + chunk.length) });
  const rest = "y".repeat(1024 * 1024);
  const saved = streamed + rest;
  const after = { generation: "host2", operationId: "open", runId: "run" };
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  let parts = 0;
  for (let at = 0; at < saved.length; at += 8_000, parts++)
    t.frame("recovered-result", { text: saved.slice(at, at + 8_000) }, after);
  t.frame("recovery", { nativeStatus: "finished", interrupted: false, resultParts: parts }, after);
  const shown = t.text("assistant").join("");
  expect(shown.length).toBe(saved.length);
  expect(shown).toBe(saved);
  expect(t.notices().join(" ")).toContain("The end of this answer is from Cursor's saved result");
  expect(t.status()).toBe("done");
});

test("a cut saved answer shorter than what streamed but different from its first character is shown whole, with notes", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  // 3 MiB of ASCII streamed before the crash.
  const streamed = "a".repeat(3 * 1024 * 1024);
  for (let at = 0; at < streamed.length; at += 64 * 1024)
    t.frame("delta", { type: "text-delta", text: streamed.slice(at, at + 64 * 1024) });
  // Cursor saved something else: over 4 MiB of "é", cut at 4 MiB, fewer code units than streamed.
  const saved = "é".repeat(2 * 1024 * 1024);
  const after = { generation: "host2", operationId: "open", runId: "run" };
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  let parts = 0;
  for (let at = 0; at < saved.length; at += 8_000, parts++)
    t.frame("recovered-result", { text: saved.slice(at, at + 8_000) }, after);
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, resultParts: parts, resultCut: true },
    after,
  );
  expect(t.text("assistant")).toEqual([streamed, saved]);
  const notes = t.notices().join(" | ");
  expect(notes).toContain(
    "The answer above is Cursor's saved result for this turn; what ace showed of it as it streamed differs.",
  );
  expect(notes).toContain("it is cut after the first 4 MiB");
  expect(t.status()).toBe("done");
});

test("a cut saved answer that is the start of what streamed adds nothing", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  const streamed = "é".repeat(2 * 1024 * 1024 + 5000);
  for (let at = 0; at < streamed.length; at += 64 * 1024)
    t.frame("delta", { type: "text-delta", text: streamed.slice(at, at + 64 * 1024) });
  const saved = streamed.slice(0, 2 * 1024 * 1024);
  const after = { generation: "host2", operationId: "open", runId: "run" };
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  let parts = 0;
  for (let at = 0; at < saved.length; at += 8_000, parts++)
    t.frame("recovered-result", { text: saved.slice(at, at + 8_000) }, after);
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, resultParts: parts, resultCut: true },
    after,
  );
  expect(t.text("assistant")).toEqual([streamed]);
  expect(t.notices().join(" | ")).not.toContain("differs");
  expect(t.status()).toBe("done");
});

/**
 * A turn that streamed `streamed` in deltas of about 64 KiB, split also at `alsoAt`, then read
 * back `saved`, cut at 4 MiB.
 */
function streamedThenCut(streamed: string, saved: string, alsoAt?: number) {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  for (let at = 0; at < streamed.length;) {
    let end = Math.min(streamed.length, at + 65_537);
    if (alsoAt !== undefined && at < alsoAt && end > alsoAt) end = alsoAt;
    t.frame("delta", { type: "text-delta", text: streamed.slice(at, end) });
    at = end;
  }
  const after = { generation: "host2", operationId: "open", runId: "run" };
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  let parts = 0;
  for (let at = 0; at < saved.length; at += 8_000, parts++)
    t.frame("recovered-result", { text: saved.slice(at, at + 8_000) }, after);
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, resultParts: parts, resultCut: true },
    after,
  );
  return t;
}
/** What recovery keeps of a saved answer: its first 4 MiB of UTF-8, between whole characters. */
const cut4MiB = (text: string) =>
  text.slice(0, new TextEncoder().encodeInto(text, new Uint8Array(4 * 1024 * 1024)).read);
const differs =
  "The answer above is Cursor's saved result for this turn; what ace showed of it as it streamed differs.";

/** Another character of the same UTF-8 width, so a cut lands where it did. */
const swap = (char: string) => ({ a: "b", é: "è", "🌊": "🌀" })[char] ?? "x";

test.each([
  ["ends on a two-byte character", `${"a".repeat(4 * 1024 * 1024 - 1000)}`, "é".repeat(2000)],
  ["ends on a four-byte character", `${"a".repeat(4 * 1024 * 1024 - 6)}🌊`, "🌊tail"],
  ["two-byte characters, odd length", `${"é".repeat(2 * 1024 * 1024 - 1)}ab`, "é".repeat(999)],
] as const)(
  "a cut saved answer that differs from what streamed only at its last character is shown whole (%s)",
  (_name, head, rest) => {
    const streamed = head + rest;
    const kept = cut4MiB(streamed);
    // Never on a 4,096-unit boundary: the overlap ends between any two checkpoints.
    expect(kept.length % 4096).not.toBe(0);
    const last = Array.from(kept).at(-1) ?? "";
    // Cursor's answer matches ace's stream up to its very last kept character.
    const saved = cut4MiB(
      `${kept.slice(0, -last.length)}${swap(last)}${streamed.slice(kept.length)}`,
    );
    expect(saved.length).toBe(kept.length);
    const t = streamedThenCut(streamed, saved);
    expect(t.text("assistant")).toEqual([streamed, saved]);
    expect(t.notices().join(" | ")).toContain(differs);
    expect(t.status()).toBe("done");
  },
);

test.each([
  ["ASCII, not on a 4,096 boundary", `${"a".repeat(4 * 1024 * 1024 + 1237)}`],
  [
    "a four-byte character astride the cut, split between deltas",
    `${"a".repeat(4 * 1024 * 1024 - 2)}🌊tail`,
  ],
  ["6 MiB streamed, far past the cut", "é".repeat(3 * 1024 * 1024 + 5)],
] as const)(
  "a cut saved answer that is exactly the start of what streamed adds nothing (%s)",
  (_name, streamed) => {
    // A delta ends between the halves of the four-byte character at the cut (second case).
    const t = streamedThenCut(streamed, cut4MiB(streamed), 4 * 1024 * 1024 - 1);
    expect(t.text("assistant")).toEqual([streamed]);
    expect(t.notices().join(" | ")).not.toContain("differs");
    expect(t.status()).toBe("done");
  },
);
