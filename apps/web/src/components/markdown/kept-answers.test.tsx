import { readFileSync } from "node:fs";
import { act, render } from "@testing-library/react";
import { markitWasmFile } from "@ace/markit-web/assets";
import { preloadMarkit } from "@ace/markit-web/react";
import { beforeAll, describe, expect, it } from "vitest";
import { KeptAnswers, createKeptAnswer } from "./kept-answers.ts";
import { MarkitProse } from "./markit-prose.tsx";

/*
 * A finished answer whose row mounts again (a thread switch, a row scrolled back into the
 * virtualised transcript) must not redraw: its first frame is the rendered markdown, never its
 * raw text, so the row keeps its height and the rows under it stay put.
 */
beforeAll(() => {
  // jsdom has no Worker: markit runs its Wasm in-process, given the bytes.
  preloadMarkit({ worker: "inline", wasm: readFileSync(markitWasmFile()) });
});

const rawText = (container: HTMLElement) => container.querySelector("p.whitespace-pre-wrap");

/** Waits for markit's drawing, whose bold text is `bold`. */
async function drawn(container: HTMLElement, bold = "14") {
  for (let tries = 0; tries < 200 && !container.querySelector("strong"); tries++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(container.querySelector("strong")?.textContent).toBe(bold);
}

describe("a finished answer mounting again", () => {
  it("shows its rendered markdown in its first frame", async () => {
    const text = "Deleted **14** merged branches.";
    const first = render(<MarkitProse text={text} stream="item-kept-1" />);
    await drawn(first.container);
    first.unmount();

    const again = render(<MarkitProse text={text} stream="item-kept-1" />);
    // Synchronously after mounting: no wait for markit, no plain text.
    expect(rawText(again.container)).toBeNull();
    expect(again.container.querySelector("strong")?.textContent).toBe("14");
    again.unmount();
  });

  it("draws again when its text changed while it was away", async () => {
    const first = render(<MarkitProse text={"Deleted **14** branches."} stream="item-kept-2" />);
    await drawn(first.container);
    first.unmount();

    const edited = render(<MarkitProse text={"Deleted **15** branches."} stream="item-kept-2" />);
    expect(edited.container.querySelector("strong")).toBeNull();
    expect(rawText(edited.container)?.textContent).toBe("Deleted **15** branches.");
    edited.unmount();
  });

  it("is not kept while it was still streaming", async () => {
    const text = "Deleted **14** merged";
    const first = render(<MarkitProse text={text} stream="item-kept-3" streaming />);
    await drawn(first.container);
    first.unmount();

    const again = render(<MarkitProse text={text} stream="item-kept-3" streaming />);
    expect(again.container.querySelector("strong")).toBeNull();
    expect(rawText(again.container)?.textContent).toBe(text);
    again.unmount();
  });

  it("shows in one place at a time: a second copy draws its own", async () => {
    const text = "Pruned **3** remotes.";
    const first = render(<MarkitProse text={text} stream="item-kept-4" />);
    await drawn(first.container, "3");
    first.unmount();
    const one = render(<MarkitProse text={text} stream="item-kept-4" />);
    const two = render(<MarkitProse text={text} stream="item-kept-4" />);
    expect(one.container.querySelector("strong")?.textContent).toBe("3");
    expect(rawText(two.container)?.textContent).toBe(text);
    await drawn(two.container, "3");
    one.unmount();
    two.unmount();
  });
});

describe("the kept answers", () => {
  it("stay within their count and bytes, freeing the renderers they drop", () => {
    const kept = new KeptAnswers({ entries: 2, bytes: 8 * 20 });
    const answers = ["first answer", "second one", "third one"].map((text) => {
      const answer = createKeptAnswer({ worker: "inline" }, {});
      answer.text = text;
      return answer;
    });
    answers.forEach((answer, index) => kept.keep(`item-${index}`, answer, 40));
    expect(kept.size).toBe(2);
    expect(kept.bytes).toBeLessThanOrEqual(8 * 20);
    expect(kept.has("item-0", "first answer")).toBe(false);
    // The dropped renderer was destroyed: it renders nothing more.
    return expect(answers[0]?.renderer.render("again")).rejects.toThrow("Renderer disposed");
  });

  it("refuse an answer heavier than the whole budget", () => {
    const kept = new KeptAnswers({ entries: 10, bytes: 8 * 4 });
    const answer = createKeptAnswer({ worker: "inline" }, {});
    answer.text = "longer than four";
    kept.keep("item-huge", answer, 40);
    expect(kept.size).toBe(0);
    expect(kept.has("item-huge", "longer than four")).toBe(false);
  });
});
