// The native host stand-in loads before any bridge module reads it (the upload tray does).
import "./test-host.ts";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserAnnotation, ThreadId } from "@ace/protocol";
import { sheetFixture, until } from "./sheet-fixture.ts";
import { ThreadAnnotations } from "./thread-annotations.ts";
import type { Picked } from "./thread-attachments.ts";

/*
 * The next message's browser annotations, over a real client and the fake daemon's uploads: an
 * annotation removed while another's image is still being captured never strands that image.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A real 1×1 PNG: the daemon checks an image is one before it keeps it. */
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
  "base64",
);
const pinned = (id: string, number: number) =>
  BrowserAnnotation.parse({
    id,
    number,
    documentId: "doc",
    url: "https://shop.test/cart",
    title: "Cart",
    point: { x: 0.5, y: 0.5 },
    comment: `Comment ${number}`,
    element: {
      tag: "p",
      selector: "p",
      xpath: "/p",
      text: "Text",
      box: { x: 0, y: 0, width: 10, height: 10 },
    },
    viewport: { width: 390, height: 700, devicePixelRatio: 3, scrollX: 0, scrollY: 0 },
    styles: [],
  });

async function draft() {
  const { daemon, client } = sheetFixture();
  daemon.createThread({ id: "web", workspaceId: "ace", title: "Checkout", provider: "codex" });
  await client.start();
  await until(() => client.state === "ready", "connected");
  const staged = new Map<string, Uint8Array>();
  const stage = (name: string, bytes: Uint8Array): Picked => {
    const localId = `00000000-0000-4000-8000-${String(staged.size + 1).padStart(12, "0")}`;
    staged.set(localId, bytes);
    return {
      localId,
      name,
      mimeType: "image/png",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const annotations = new ThreadAnnotations(
    client,
    ThreadId.parse("web"),
    new AbortController().signal,
    () => {},
    async (localId, offset, limit) =>
      Buffer.from(staged.get(localId)?.subarray(offset, offset + limit) ?? []).toString("base64"),
    (text) => text,
  );
  closers.push(
    () => annotations.dispose(),
    () => client.close(),
  );
  return { annotations, stage };
}

describe("The next message's browser annotations", () => {
  test("removing one while another's image is captured still sends that image", async () => {
    const { annotations, stage } = await draft();
    annotations.save(pinned("one", 1));
    let finish: ((picked: Picked) => void) | undefined;
    annotations.save(pinned("two", 2), new Promise<Picked>((resolve) => (finish = resolve)));
    // The first goes while the second's crop is still being captured; the second becomes 1.
    annotations.remove("one");
    expect(annotations.annotations().map((each) => [each.id, each.number])).toEqual([["two", 1]]);
    const crop = stage("annotation-2.png", png);
    finish?.(crop);
    await until(() => {
      const value = annotations.handOff();
      return !!value && !("refused" in value);
    }, "the message can go");
    const handOff = annotations.handOff();
    if (!handOff || "refused" in handOff) throw new Error("the annotations should go");
    expect(handOff.attachments).toContain(crop.sha256);
    expect(handOff.part.type === "text" && handOff.part.text).toContain("[1]");
  });
});
