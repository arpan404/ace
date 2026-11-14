import { readFileSync } from "node:fs";
import { FakeDaemon } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { markitWasmFile } from "@ace/markit-web/assets";
import { preloadMarkit } from "@ace/markit-web/react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import {
  answerContext,
  createKeptAnswer,
  keptAnswersFor,
  KeptAnswers,
  rendererOverhead,
  sweepKeptAnswers,
  type KeptAnswer,
} from "./kept-answers.ts";
import { MarkitView, type KeepTarget, type MarkitCallbacks } from "./markit-view.tsx";

/*
 * A finished thread answer whose row mounts again (a thread switch, a row scrolled back into
 * the virtualised transcript) must not redraw: its first frame is the rendered markdown, never
 * its raw text. And a drawing may only ever come back where it was drawn: the same client, the
 * same thread and item, the same context.
 */
beforeAll(() => {
  // jsdom has no Worker: markit runs its Wasm in-process, given the bytes.
  preloadMarkit({ worker: "inline", wasm: readFileSync(markitWasmFile()) });
});
afterEach(() => {
  delete document.documentElement.dataset.scheme;
});

const rawText = (container: HTMLElement) => container.querySelector("p.whitespace-pre-wrap");
const drawing = (container: HTMLElement) => container.querySelector(".markit");

/** Waits until markit's drawing is in: its placeholder gone. */
async function drawn(container: HTMLElement) {
  for (
    let tries = 0;
    tries < 200 && (rawText(container) || !drawing(container)?.firstChild);
    tries++
  )
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(rawText(container)).toBeNull();
}

const callbacks = (drawnSpy?: MarkitCallbacks["drawn"]): MarkitCallbacks => ({
  onLink: () => {},
  onSystemLink: () => {},
  onReference: () => {},
  resolveImage: async () => null,
  drawn: drawnSpy,
});

function answerView(props: {
  text: string;
  answers: KeptAnswers;
  threadId: string;
  itemId?: string;
  streaming?: boolean;
  root?: string;
  drawn?: MarkitCallbacks["drawn"];
}) {
  const keep: KeepTarget = {
    answers: props.answers,
    scope: { threadId: props.threadId, itemId: props.itemId ?? "item-1" },
    cwd: undefined,
    root: props.root,
  };
  return (
    <MarkitView
      markdown={props.text}
      finalized={!props.streaming}
      stream={`${props.threadId}/${props.itemId ?? "item-1"}`}
      callbacks={callbacks(props.drawn)}
      flavor="agent"
      keep={keep}
    />
  );
}

const everyThread = () => new KeptAnswers(() => true);

describe("a finished answer mounting again", () => {
  it("shows its rendered markdown in its first frame", async () => {
    const answers = everyThread();
    const text = "Deleted **14** merged branches.";
    const first = render(answerView({ text, answers, threadId: "thread-a" }));
    await drawn(first.container);
    first.unmount();

    const again = render(answerView({ text, answers, threadId: "thread-a" }));
    // Synchronously after mounting: no wait for markit, no plain text.
    expect(rawText(again.container)).toBeNull();
    expect(again.container.querySelector("strong")?.textContent).toBe("14");
  });

  it("never comes back in another thread, even with the same item and text", async () => {
    const answers = everyThread();
    const text = "Deleted **14** merged branches.";
    const first = render(answerView({ text, answers, threadId: "thread-a" }));
    await drawn(first.container);
    const theirs = drawing(first.container);
    first.unmount();

    const other = render(answerView({ text, answers, threadId: "thread-b" }));
    expect(rawText(other.container)?.textContent).toBe(text);
    expect(theirs && other.container.contains(theirs)).toBe(false);
    other.unmount();
    // Thread A's own drawing is still kept for it.
    const back = render(answerView({ text, answers, threadId: "thread-a" }));
    expect(rawText(back.container)).toBeNull();
  });

  it("never shows another thread's image: answers with images are drawn again, not kept", async () => {
    const answers = everyThread();
    const text = "Here it is: ![capture](screenshot.png)";
    const first = render(answerView({ text, answers, threadId: "thread-a" }));
    await drawn(first.container);
    expect(first.container.querySelector("img")).not.toBeNull();
    first.unmount();
    expect(answers.size).toBe(0);

    for (const threadId of ["thread-b", "thread-a"]) {
      const view = render(answerView({ text, answers, threadId }));
      // Not even for a frame: the first frame is its text, with no image in it.
      expect(view.container.querySelector("img")).toBeNull();
      expect(rawText(view.container)?.textContent).toBe(text);
      view.unmount();
    }
  });

  it("draws again when the checkout it resolves against changed", async () => {
    const answers = everyThread();
    const text = "See `src/app.ts` for **the** entry.";
    const first = render(answerView({ text, answers, threadId: "thread-a", root: "/repo" }));
    await drawn(first.container);
    first.unmount();

    const moved = render(answerView({ text, answers, threadId: "thread-a", root: "/elsewhere" }));
    expect(rawText(moved.container)?.textContent).toBe(text);
    moved.unmount();
    // The stale drawing was dropped, not kept beside the new one.
    const old = render(answerView({ text, answers, threadId: "thread-a", root: "/repo" }));
    expect(rawText(old.container)).not.toBeNull();
  });

  it("is kept under the colour scheme that drew it, not the one current when it left", async () => {
    const answers = everyThread();
    const text = "Deleted **14** branches.";
    const first = render(answerView({ text, answers, threadId: "thread-a" }));
    await drawn(first.container);
    document.documentElement.dataset.scheme = "dark";
    first.rerender(answerView({ text, answers, threadId: "thread-a" }));
    first.unmount();

    const dark = render(answerView({ text, answers, threadId: "thread-a" }));
    expect(rawText(dark.container)?.textContent).toBe(text);
    dark.unmount();
  });

  it("finishes the view's file-link work when it comes back", async () => {
    const answers = everyThread();
    const text = "Changed `src/app.ts`.";
    const first = render(answerView({ text, answers, threadId: "thread-a" }));
    await drawn(first.container);
    first.unmount();

    const linking = vi.fn();
    const again = render(answerView({ text, answers, threadId: "thread-a", drawn: linking }));
    expect(rawText(again.container)).toBeNull();
    expect(linking).toHaveBeenCalledWith(drawing(again.container), true);
  });

  it("draws again when its text changed while it was away", async () => {
    const answers = everyThread();
    const first = render(answerView({ text: "Deleted **14**.", answers, threadId: "thread-a" }));
    await drawn(first.container);
    first.unmount();

    const edited = render(answerView({ text: "Deleted **15**.", answers, threadId: "thread-a" }));
    expect(rawText(edited.container)?.textContent).toBe("Deleted **15**.");
  });

  it("is not kept while it was still streaming", async () => {
    const answers = everyThread();
    const text = "Deleted **14** merged";
    const first = render(answerView({ text, answers, threadId: "thread-a", streaming: true }));
    await drawn(first.container);
    first.unmount();
    expect(answers.size).toBe(0);
  });

  it("shows in one place at a time: a second copy draws its own", async () => {
    const answers = everyThread();
    const text = "Pruned **3** remotes.";
    const first = render(answerView({ text, answers, threadId: "thread-a" }));
    await drawn(first.container);
    first.unmount();
    const one = render(answerView({ text, answers, threadId: "thread-a" }));
    const two = render(answerView({ text, answers, threadId: "thread-a" }));
    expect(rawText(one.container)).toBeNull();
    expect(rawText(two.container)?.textContent).toBe(text);
    await drawn(two.container);
  });
});

/** A kept answer drawn from `text` by a real renderer. */
async function drawnAnswer(text: string, onLink = () => {}): Promise<KeptAnswer> {
  const answer = createKeptAnswer({ worker: "inline", flavor: "agent" }, { onLink });
  document.body.append(answer.element);
  await answer.renderer.render(text);
  return answer;
}
const context = (text: string) =>
  answerContext({ flavor: "agent", scheme: "light", cwd: undefined, root: undefined, text });

describe("the kept answers", () => {
  it("stay within their count and their weight, which counts DOM and renderer cost", async () => {
    const kept = new KeptAnswers(() => true, { entries: 2, bytes: 3 * rendererOverhead });
    const answers = await Promise.all(
      ["one **a**", "two **b**", "three **c**"].map((t) => drawnAnswer(t)),
    );
    answers.forEach((answer, index) =>
      kept.keep({ threadId: "t", itemId: `i${index}` }, context(`#${index}`), answer, 20),
    );
    expect(kept.size).toBe(2);
    expect(kept.bytes).toBeGreaterThan(2 * rendererOverhead);
    expect(kept.bytes).toBeLessThanOrEqual(3 * rendererOverhead);
    // The dropped renderer was destroyed: it renders nothing more.
    await expect(answers[0]?.renderer.render("again")).rejects.toThrow("Renderer disposed");
  });

  it("call no view while detached", async () => {
    const onLink = vi.fn();
    const answer = await drawnAnswer("[the docs](https://example.com/docs)", onLink);
    const kept = everyThread();
    kept.keep({ threadId: "t", itemId: "i" }, context("docs"), answer, 20);
    answer.element.querySelector("a")?.click();
    expect(onLink).not.toHaveBeenCalled();
  });

  it("go with their thread once the client no longer holds it", async () => {
    const held = new Set(["t1", "t2"]);
    const kept = new KeptAnswers((threadId) => held.has(threadId));
    const first = await drawnAnswer("one **a**");
    kept.keep({ threadId: "t1", itemId: "i" }, context("a"), first, 20);
    kept.keep({ threadId: "t2", itemId: "i" }, context("b"), await drawnAnswer("two **b**"), 20);
    held.delete("t1");
    kept.sweep();
    expect(kept.has({ threadId: "t1", itemId: "i" }, context("a"))).toBe(false);
    expect(kept.has({ threadId: "t2", itemId: "i" }, context("b"))).toBe(true);
    await expect(first.renderer.render("again")).rejects.toThrow("Renderer disposed");
  });
});

describe("a client's kept answers", () => {
  it("lose a thread's answers when it is deleted, and all of them when the client closes", async () => {
    const daemon = new FakeDaemon({ clock: () => Date.parse("2026-11-14T00:00:00Z") });
    daemon.createThread({ id: "thread-gone", workspaceId: "ws", title: "Gone", provider: "codex" });
    daemon.createThread({ id: "thread-kept", workspaceId: "ws", title: "Kept", provider: "codex" });
    const client = fakeClient(daemon);
    await client.start();
    const gone = client.thread("thread-gone");
    const stays = client.thread("thread-kept");
    await waitFor(() => expect(gone.store.thread).toBeDefined());
    await waitFor(() => expect(stays.store.thread).toBeDefined());
    const kept = keptAnswersFor(client);
    kept.keep(
      { threadId: "thread-gone", itemId: "i" },
      context("a"),
      await drawnAnswer("a **1**"),
      20,
    );
    kept.keep(
      { threadId: "thread-kept", itemId: "i" },
      context("b"),
      await drawnAnswer("b **2**"),
      20,
    );
    expect(kept.size).toBe(2);

    await client.command({ type: "thread.delete", threadId: ThreadId.parse("thread-gone") });
    await waitFor(() => expect(gone.store.thread?.deletedAt).toBeDefined());
    sweepKeptAnswers();
    expect(kept.has({ threadId: "thread-gone", itemId: "i" }, context("a"))).toBe(false);
    expect(kept.size).toBe(1);

    gone.release();
    stays.release();
    await client.close();
    sweepKeptAnswers();
    expect(kept.size).toBe(0);
  });
});
