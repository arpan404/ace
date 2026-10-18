import { afterEach, expect, it } from "vitest";
import { annotationFixture, executablePath } from "./annotation-test-support.ts";
import { chromeDesktop } from "./relay-chrome-test-support.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

it.skipIf(!executablePath)(
  "through the desktop relay the overlay binds, takes input and comes back after a renderer restart",
  async () => {
    if (!executablePath) return;
    const desktop = await chromeDesktop(executablePath);
    closers.push(desktop.close);
    const f = await annotationFixture(desktop);
    expect(f.service.state("thread").backend).toBe("embedded");
    const person = await f.annotating();
    const first = await person.event("ready");
    expect(await f.pin(person, "p.lead", "Over the relay")).toMatchObject({
      number: 1,
      comment: "Over the relay",
      documentId: first.documentId,
    });
    expect(await person.evaluate("typeof __aceAnnotateEmit")).toBe("undefined");
    expect(await person.evaluate("window.pageClicks")).toBe(0);
    const before = person.events().length;
    await desktop.crashAndRestart();
    const again = await person.event("ready", before);
    expect(again.documentId).not.toBe(first.documentId);
    expect(f.service.state("thread").annotation).toEqual({ owner: "person" });
    expect((await f.pin(person, "p.lead", "After restart")).comment).toBe("After restart");
  },
  90_000,
);
