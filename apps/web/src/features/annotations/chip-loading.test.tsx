import { BrowserAnnotation } from "@ace/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

/**
 * The chip's list is its own chunk. Each load of it waits here until the test lets it arrive or
 * fail, as a slow or broken network would.
 */
const loads = vi.hoisted(() => {
  const waiting: { resolve(): void; reject(error: Error): void }[] = [];
  let started = 0;
  const next = async () => {
    await vi.waitFor(() => {
      if (!waiting.length) throw new Error("No load of the list is waiting");
    });
    const load = waiting.shift();
    if (!load) throw new Error("No load of the list is waiting");
    return load;
  };
  return {
    started: () => started,
    begin: () => {
      started += 1;
      return new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    arrive: async () => (await next()).resolve(),
    fail: async () =>
      (await next()).reject(new Error("Failed to fetch dynamically imported module")),
  };
});

const annotation = BrowserAnnotation.parse({
  id: "annotation-1",
  number: 1,
  documentId: "document-1",
  url: "https://example.test/pair",
  title: "Pair a device",
  point: { x: 0.5, y: 0.5 },
  comment: "Make this bolder",
  element: {
    tag: "h1",
    selector: "h1",
    xpath: "/html/body/h1",
    text: "Pair a device",
    box: { x: 0, y: 0, width: 200, height: 40 },
  },
  viewport: { width: 1280, height: 800, devicePixelRatio: 2, scrollX: 0, scrollY: 0 },
});

// Each test starts as a fresh page: no chunk of the list has arrived yet.
beforeEach(() => {
  vi.resetModules();
  vi.doMock("./annotation-popover.tsx", async (original) => {
    await loads.begin();
    return original();
  });
});

/** A composer whose draft was restored with one annotation: the chip shows before its list. */
async function showComposer() {
  const [{ ToastProvider }, { AnnotationChip }, { useDraftAnnotations }] = await Promise.all([
    import("@/components/ui/toast.tsx"),
    import("./annotation-chip.tsx"),
    import("./draft-annotations.ts"),
  ]);
  function Composer() {
    const annotations = useDraftAnnotations({
      restored: { items: [{ annotation }], pages: [] },
      upload: async () => ({ sha256: "0".repeat(64) }),
      release: async () => {},
    });
    return (
      <div>
        <textarea aria-label="Message" />
        <AnnotationChip threadId={undefined} annotations={annotations} />
      </div>
    );
  }
  render(
    <ToastProvider>
      <Composer />
    </ToastProvider>,
  );
}
const count = () => screen.getByRole("button", { name: "Show 1 annotation" });
const list = () => screen.queryByRole("list", { name: "Annotations" });
/** Long enough for an arrived chunk to render, were anything to draw from it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a press on the chip's count while its list loads opens the list once it arrives", async () => {
  await showComposer();
  await userEvent.click(count());
  expect(count().getAttribute("aria-expanded")).toBe("true");
  expect(list()).toBeNull();
  await loads.arrive();
  expect(await screen.findByRole("list", { name: "Annotations" })).toBeTruthy();
});

test("the chip's buttons stay the same, focused, while its list loads, and Escape cancels the open", async () => {
  await showComposer();
  const button = count();
  const clear = screen.getByRole("button", { name: "Remove all annotations" });
  expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  button.focus();
  await userEvent.keyboard("{Enter}");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  await userEvent.keyboard("{Escape}");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await loads.arrive();
  await settle();
  expect(list()).toBeNull();
  expect(count()).toBe(button);
  expect(screen.getByRole("button", { name: "Remove all annotations" })).toBe(clear);
  expect(document.activeElement).toBe(button);
});

test("a press elsewhere while the chip's list loads cancels the open", async () => {
  await showComposer();
  await userEvent.click(count());
  await userEvent.click(screen.getByRole("textbox", { name: "Message" }));
  expect(count().getAttribute("aria-expanded")).toBe("false");
  await loads.arrive();
  await settle();
  expect(list()).toBeNull();
});

test("a list that fails to load stays inside the chip, and the next press loads it again", async () => {
  await showComposer();
  await userEvent.click(count());
  await loads.fail();
  await waitFor(() => expect(count().getAttribute("aria-expanded")).toBe("false"));
  const message = screen.getByRole("textbox", { name: "Message" });
  await userEvent.type(message, "Still writing");
  expect((message as HTMLTextAreaElement).value).toBe("Still writing");
  expect(list()).toBeNull();
  const before = loads.started();
  await userEvent.click(count());
  await loads.arrive();
  expect(await screen.findByRole("list", { name: "Annotations" })).toBeTruthy();
  expect(loads.started()).toBe(before + 1);
});
