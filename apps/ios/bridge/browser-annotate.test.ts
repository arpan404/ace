import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { browserAnnotationsOpen } from "@ace/ui-core";
import { ThreadId, type ContentPart, type MessageContext } from "@ace/protocol";
import { closeBrowserFixtures, liveBrowser, viewport } from "./browser-fixture.ts";
import { until, type RecordingSink } from "./sheet-fixture.ts";
import { ThreadAnnotations, withAnnotations } from "./thread-annotations.ts";
import type { Picked } from "./thread-attachments.ts";

/*
 * Annotate mode from the phone (ADR 0082), over a real client and the fake daemon's scripted
 * overlay: pinned comments join the thread's next message with their crops, the page's
 * screenshot follows, removing one closes ranks on the page too, and the message carries the
 * block after the person's words with the images after the person's files, in the block's order.
 */

afterEach(closeBrowserFixtures);

const annotateView = (sink: RecordingSink) =>
  (
    sink.read("browser:view")?.state as {
      annotate: { mode: string; unavailable: string | null } | null;
    } | null
  )?.annotate;
const chips = (patches: Record<string, unknown>[]) =>
  (patches.at(-1)?.items ?? []) as { id: string; number: number; comment: string; state: string }[];

async function annotating() {
  const staged = new Map<string, Uint8Array>();
  const patches: Record<string, unknown>[] = [];
  let draft: ThreadAnnotations | undefined;
  const fixture = await liveBrowser({
    context: {
      // Swift stages each image and hashes it; here the bytes stay in memory.
      stage: async (name, mimeType, data): Promise<Picked> => {
        const bytes = Buffer.from(data, "base64");
        const localId = `00000000-0000-4000-8000-${String(staged.size + 1).padStart(12, "0")}`;
        staged.set(localId, bytes);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        return { localId, name, mimeType, bytes: bytes.length, sha256 };
      },
      annotations: (threadId) => (threadId === "web" ? draft : undefined),
    },
  });
  draft = new ThreadAnnotations(
    fixture.client,
    ThreadId.parse("web"),
    new AbortController().signal,
    (patch) => patches.push(patch),
    async (localId, offset, limit) =>
      Buffer.from(staged.get(localId)?.subarray(offset, offset + limit) ?? []).toString("base64"),
    (text) => text,
  );
  fixture.view.action({ kind: "open", threadId: "web", viewport });
  await until(() => annotateView(fixture.sink) != null, "annotate offered");
  fixture.view.action({ kind: "annotate", on: true, theme: "dark" });
  await until(() => annotateView(fixture.sink)?.mode === "on", "annotating");
  const settle = () => {
    for (const run of fixture.scheduled.splice(0)) run();
  };
  return { ...fixture, draft, patches, settle, staged };
}

describe("Annotating the thread's page from the phone", () => {
  test("pinned comments join the next message with their crops and the page's screenshot", async () => {
    const { daemon, draft, patches, settle } = await annotating();
    daemon.browser.annotations.pin("web", { comment: "Make this bigger", tag: "h1", text: "Cart" });
    daemon.browser.annotations.pin("web", { comment: "Wrong colour", tag: "button", text: "Pay" });
    await until(
      () => chips(patches).length === 2 && chips(patches).every((chip) => chip.state === "ready"),
      "crops",
    );
    settle();
    await until(() => {
      const handOff = draft.handOff();
      return handOff && !("refused" in handOff) && handOff.attachments.length === 3;
    }, "page screenshot");
    const handOff = draft.handOff();
    if (!handOff || "refused" in handOff) throw new Error("expected the annotations");
    const own: MessageContext = { mentions: [], attachments: [{ sha256: "a".repeat(64) }] };
    const message = withAnnotations([{ type: "text", text: "Fix these" }], own, handOff);
    const text = message.input
      .map((part: ContentPart) => (part.type === "text" ? part.text : ""))
      .join("");
    expect(text.startsWith("Fix these\n\n" + browserAnnotationsOpen)).toBe(true);
    expect(text).toContain("Make this bigger");
    expect(text).toContain("Images: the last 3 images of this message, in order:");
    // The person's file first, then the page screenshot, then the crops in marker order.
    expect(message.context?.attachments.map((file) => file.sha256)).toEqual([
      "a".repeat(64),
      ...handOff.attachments,
    ]);
    expect(message.context?.items).toEqual([
      expect.objectContaining({ type: "browser_annotations", url: "https://shop.test/cart" }),
    ]);
  });

  test("removing an annotation closes ranks and the page is told; sending empties the draft", async () => {
    const { daemon, draft, patches, requested } = await annotating();
    const first = daemon.browser.annotations.pin("web", { comment: "One" });
    daemon.browser.annotations.pin("web", { comment: "Two" });
    await until(() => chips(patches).length === 2, "two");
    draft.remove(first.id);
    expect(chips(patches).map((chip) => [chip.number, chip.comment])).toEqual([[1, "Two"]]);
    await until(
      () =>
        requested.some(
          (request) =>
            JSON.stringify(request).includes('"op":"renumber"') &&
            JSON.stringify(request).includes('"number":1'),
        ),
      "renumbered on the page",
    );
    draft.sent();
    expect(chips(patches)).toEqual([]);
    expect(draft.handOff()).toBeUndefined();
  });

  test("the page's Send ends annotating and takes the person to the message", async () => {
    const { daemon, sink } = await annotating();
    daemon.browser.annotations.pin("web", { comment: "Here" });
    daemon.browser.annotations.emit("web", { kind: "send" });
    await until(() => sink.read("browser:annotate-send") !== undefined, "send");
    await until(() => annotateView(sink)?.mode === "off", "ended");
  });

  test("another screen annotating ends this phone's mode, and the bar says the page is busy", async () => {
    const { daemon, sink } = await annotating();
    daemon.browser.annotations.end("web", "lease");
    await until(() => annotateView(sink)?.mode === "off", "ended");
  });
});
