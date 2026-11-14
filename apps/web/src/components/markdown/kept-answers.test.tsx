import { readFileSync } from "node:fs";
import { act, render } from "@testing-library/react";
import { markitWasmFile } from "@ace/markit-web/assets";
import { preloadMarkit } from "@ace/markit-web/react";
import { beforeAll, describe, expect, it } from "vitest";
import { BoundedLru } from "./bounded-lru.ts";
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

describe("the kept-answer cache", () => {
  it("stays within its entry count, dropping the least recently used", () => {
    const disposed: string[] = [];
    const cache = new BoundedLru<string>({ entries: 2, bytes: 1_000 }, (value) =>
      disposed.push(value),
    );
    cache.put("a", "a", 10);
    cache.put("b", "b", 10);
    expect(cache.take("a")).toBe("a");
    cache.put("a", "a", 10);
    cache.put("c", "c", 10);
    expect(disposed).toEqual(["b"]);
    expect(cache.size).toBe(2);
    expect(cache.has("a") && cache.has("c")).toBe(true);
  });

  it("stays within its bytes, and never holds one entry larger than the whole budget", () => {
    const disposed: string[] = [];
    const cache = new BoundedLru<string>({ entries: 10, bytes: 100 }, (value) =>
      disposed.push(value),
    );
    cache.put("a", "a", 60);
    cache.put("b", "b", 60);
    expect(disposed).toEqual(["a"]);
    expect(cache.bytes).toBe(60);
    cache.put("huge", "huge", 101);
    expect(disposed).toEqual(["a", "huge"]);
    expect(cache.has("huge")).toBe(false);
    expect(cache.bytes).toBe(60);
  });
});
