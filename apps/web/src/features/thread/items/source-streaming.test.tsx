import { facts } from "@ace/fake-daemon";
import { FakeDaemon } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** The actual output.read wire boundary, with independently growing UTF-16 text streams. */
class TextDaemon extends FakeDaemon {
  texts = new Map<string, string>();
  sentBytes = new Map<string, number>();
  override output(streamId: string, offset: number, limit: number) {
    const text = this.texts.get(streamId);
    if (text === undefined) return super.output(streamId, offset, limit);
    const all = Buffer.from(text, "utf16le");
    const bytes = all.subarray(offset, offset + limit);
    this.sentBytes.set(streamId, (this.sentBytes.get(streamId) ?? 0) + bytes.length);
    return { bytes, nextOffset: offset + bytes.length, eof: offset + bytes.length >= all.length };
  }
}

const source = (streamId: string, text: string) => ({
  streamId,
  bytes: text.length * 2,
  encoding: "utf-16le" as const,
});

test("source-backed thinking and answer text grow independently before either completes", async () => {
  localStorage.clear();
  const daemon = new TextDaemon({ clock: () => 1000 });
  const app = harness({ daemon, throughWorker: true });
  daemon.createThread({ id: "sources", workspaceId: "ace", provider: "codex", title: "Sources" });
  const thought = "Thinking preview\n\n" + "thought ".repeat(1000) + "Thought past preview";
  const answer = "Answer preview\n\n" + "answer ".repeat(24000) + "Answer past preview";
  daemon.texts.set("thought", thought);
  daemon.texts.set("answer", answer);

  daemon.apply("sources", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Stream thinking and answer together"),
  ]);
  await app.open("/t/sources");
  act(() =>
    daemon.apply("sources", [
      {
        type: "item.upsert",
        agent: "root",
        item: "thought",
        draft: {
          type: "reasoning",
          complete: false,
          text: thought.slice(0, 4096),
          source: source("thought", thought),
        },
      },
      {
        type: "item.upsert",
        agent: "root",
        item: "answer",
        draft: {
          type: "message",
          role: "assistant",
          complete: false,
          parts: [{ type: "text", text: answer.slice(-4096), source: source("answer", answer) }],
        },
      },
    ]),
  );
  const feed = await screen.findByRole("feed", { name: "Transcript" }, { timeout: 10000 });
  // A thought streams folded under its "Thinking…" header; opened, it shows as it grows.
  const header = await within(feed).findByRole("button", { name: "Thinking…" });
  expect(header.getAttribute("aria-expanded")).toBe("false");
  act(() => header.click());
  expect(await within(feed).findByText(/Thought past preview/)).toBeTruthy();
  expect(await within(feed).findByText(/Answer preview/)).toBeTruthy();
  expect(await within(feed).findByText(/Answer past preview/)).toBeTruthy();
  expect(within(feed).getByRole("status", { name: "Streaming" })).toBeTruthy();
  expect(within(feed).getByRole("group", { name: "Turn in progress" })).toBeTruthy();
  expect(within(feed).queryByRole("button", { name: "Show full answer" })).toBeNull();
  const suffix = "\n\nNew answer delta while still thinking 😀";
  daemon.texts.set("answer", answer + suffix);
  act(() => daemon.apply("sources", [facts.stream("root", "answer", suffix)]));
  expect(await within(feed).findByText(/New answer delta while still thinking/)).toBeTruthy();
  const thoughtSuffix = "\nNew reasoning delta while answer streams";
  daemon.texts.set("thought", thought + thoughtSuffix);
  act(() =>
    daemon.apply("sources", [
      {
        type: "item.delta",
        agent: "root",
        item: "thought",
        field: "reasoning",
        append: thoughtSuffix,
      },
    ]),
  );
  expect(await within(feed).findByText(/New reasoning delta while answer streams/)).toBeTruthy();
  // The full source crosses the worker port once, since an SDK preview can be a clipped
  // tail rather than a prefix. Growing the
  // descriptors must not reread the prefix on every delta.
  await waitFor(() =>
    expect(daemon.sentBytes.get("answer")).toBe((answer.length + suffix.length) * 2),
  );
  expect(daemon.sentBytes.get("thought")).toBe((thought.length + thoughtSuffix.length) * 2);
});

test("replacing a text source discards its old suffix and preserves a split surrogate", async () => {
  localStorage.clear();
  const daemon = new TextDaemon({ clock: () => 1000 });
  const app = harness({ daemon, throughWorker: true });
  daemon.createThread({
    id: "replacement",
    workspaceId: "ace",
    provider: "codex",
    title: "Replacement",
  });
  const old = "Old text ".repeat(1000) + "old source suffix";
  const next = "x".repeat(4095) + "😀 replacement suffix";
  daemon.texts.set("old", old);
  daemon.texts.set("next", next);
  daemon.apply("replacement", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      type: "item.upsert",
      agent: "root",
      item: "answer",
      draft: {
        type: "message",
        role: "assistant",
        complete: false,
        parts: [{ type: "text", text: old.slice(0, 4096), source: source("old", old) }],
      },
    },
  ]);
  await app.open("/t/replacement");
  const feed = await screen.findByRole("feed", { name: "Transcript" }, { timeout: 10000 });
  expect(await within(feed).findByText(/old source suffix/)).toBeTruthy();
  act(() =>
    daemon.apply("replacement", [
      {
        type: "item.upsert",
        agent: "root",
        item: "answer",
        draft: {
          type: "message",
          parts: [{ type: "text", text: next.slice(0, 4096), source: source("next", next) }],
        },
      },
    ]),
  );
  expect(await within(feed).findByText(/😀 replacement suffix/)).toBeTruthy();
  expect(within(feed).queryByText(/old source suffix/)).toBeNull();
});
