import { afterEach, expect, it, vi } from "vitest";
import { annotationFixture, executablePath } from "./annotation-test-support.ts";
import { chromeDesktop } from "./relay-chrome-test-support.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const overlays = "document.querySelectorAll('ace-annotation-layer').length";

it.skipIf(!executablePath)(
  "a desktop that re-adopts its view after a link blip keeps the page: nothing is reported lost and no overlay is left behind",
  async () => {
    if (!executablePath) return;
    const desktop = await chromeDesktop(executablePath);
    closers.push(desktop.close);
    const f = await annotationFixture(desktop);
    const person = await f.annotating();
    await person.evaluate("window.kept = 42");
    expect(await person.evaluate(overlays)).toBe(1);

    await desktop.relink(() => f.service.registerEmbedded(desktop.transport));
    await vi.waitFor(() => expect(f.service.state("thread").status).toBe("ready"), {
      timeout: 10_000,
    });
    const state = f.service.state("thread");
    expect(state.pageStateLost).toBeUndefined();
    expect(state.reason).toBeUndefined();
    expect(person.messages.some((message) => message.type === "browser.backend.lost")).toBe(false);
    // The same document: no reload, and the overlay of the lost link is gone with its listeners.
    expect(await person.evaluate("window.kept")).toBe(42);
    expect(await person.evaluate(overlays)).toBe(0);

    const before = person.events().length;
    await person.execute({ action: "annotate", operation: "start", config: { theme: "dark" } });
    await person.event("ready", before);
    expect(await person.evaluate(overlays)).toBe(1);
    expect((await f.pin(person, "p.lead", "After the blip")).comment).toBe("After the blip");
    expect(await person.evaluate("window.pageClicks")).toBe(0);
  },
  90_000,
);
