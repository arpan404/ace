import { expect, it, vi } from "vitest";
import { z } from "zod";
import { annotationFixture, executablePath } from "./annotation-test-support.ts";

const test = it.skipIf(!executablePath);
const overlayPresent = "document.querySelector('ace-annotation-layer') !== null";

test("navigating ends annotate mode and the next document has no overlay", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  await f.pin(person, "p.lead", "Keep");
  await person.execute({ action: "navigate", url: `${f.origin}/next` });
  expect(await person.event("ended")).toMatchObject({ reason: "navigated" });
  expect(f.service.state("thread").annotation).toBeUndefined();
  expect(await person.evaluate(overlayPresent)).toBe(false);
  const heading = await person.box("h2");
  await person.click(heading.x + 10, heading.y + 10);
  await vi.waitFor(async () => expect(await person.evaluate("window.pageClicks")).toBe(1));
  await expect(
    person.execute({ action: "annotate", operation: "command", command: { op: "clear" } }),
  ).rejects.toThrow("not active");
}, 60_000);

test("the page cannot reach the overlay's binding, and its synthetic clicks are ignored", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  expect(
    await person.evaluate(
      "[typeof __aceAnnotateEmit, typeof aceAnnotate, typeof aceAnnotateInstall, document.querySelector('ace-annotation-layer').shadowRoot].join(',')",
    ),
  ).toBe("undefined,undefined,undefined,");
  await person.evaluate(
    "(() => { const lead = document.querySelector('p.lead'); lead.click(); lead.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 60, clientY: 50 })); })()",
  );
  // Synthetic clicks are the page's own business: they reach it and pin nothing.
  expect(await person.evaluate("window.pageClicks")).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(person.events().map((event) => event.kind)).toEqual(["ready"]);
}, 60_000);

test("only the person holding the lease can annotate, and handing back ends it for them alone", async () => {
  const f = await annotationFixture();
  await expect(
    f.service.execute("thread", { action: "annotate", operation: "start" }),
  ).rejects.toThrow();
  const viewer = f.connect("viewer");
  await viewer.subscribe();
  await expect(viewer.execute({ action: "annotate", operation: "start" })).rejects.toThrow();
  const person = await f.annotating("person");
  await expect(
    viewer.execute({ action: "annotate", operation: "command", command: { op: "clear" } }),
  ).rejects.toThrow();
  await expect(
    viewer.execute({ action: "annotate_capture", target: { kind: "page" } }),
  ).rejects.toThrow();
  await person.handback();
  expect(await person.event("ended")).toMatchObject({ reason: "lease" });
  expect(viewer.events()).toEqual([]);
  expect(f.service.state("thread").annotation).toBeUndefined();
  await vi.waitFor(async () =>
    expect(
      await f.service.execute("thread", { action: "evaluate", expression: overlayPresent }),
    ).toBe(false),
  );
}, 60_000);

const Snapshot = z.object({ nodes: z.array(z.object({ name: z.string(), role: z.string() })) });

test("agent snapshots describe the page without the annotate overlay", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  await f.pin(person, "p.lead", "Shorter");
  // Leave an editor open as well, so every overlay surface is on screen.
  const second = await person.box("p.lead:nth-of-type(2)");
  await person.click(second.x + 20, second.y + 5);
  const names = Snapshot.parse(await f.service.execute("thread", { action: "snapshot" })).nodes.map(
    (node) => node.name,
  );
  expect(names).toContain("Next page");
  for (const overlay of ["Send", "Annotating · 1", "Take a screenshot", "Annotation 1", "Comment"])
    expect(names).not.toContain(overlay);
}, 60_000);

test("a disconnected or stopping person leaves no overlay behind", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  await person.execute({ action: "annotate", operation: "stop" });
  expect(await person.event("ended")).toMatchObject({ reason: "stopped" });
  expect(await person.evaluate(overlayPresent)).toBe(false);
  // Stopping again is not an error.
  await person.execute({ action: "annotate", operation: "stop" });
  await person.execute({ action: "annotate", operation: "start" });
  await vi.waitFor(() => expect(person.events().filter((e) => e.kind === "ready")).toHaveLength(2));
  expect(await person.evaluate(overlayPresent)).toBe(true);
  person.bridge.close();
  expect(f.service.state("thread").annotation).toBeUndefined();
  await vi.waitFor(async () =>
    expect(
      await f.service.execute("thread", { action: "evaluate", expression: overlayPresent }),
    ).toBe(false),
  );
}, 60_000);
