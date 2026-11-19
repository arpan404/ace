import { workCardScenario } from "@ace/fake-daemon";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

/**
 * The details icon's popover is its own chunk. Each load of it waits here until the test lets
 * it arrive or fail, as a slow or broken network would.
 */
const loads = vi.hoisted(() => {
  const waiting: { resolve(): void; reject(error: Error): void }[] = [];
  let started = 0;
  const next = async () => {
    await vi.waitFor(() => {
      if (!waiting.length) throw new Error("No load of the popover is waiting");
    });
    const load = waiting.shift();
    if (!load) throw new Error("No load of the popover is waiting");
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

// Each test starts as a fresh page: no chunk of the popover has arrived yet.
beforeEach(() => {
  vi.resetModules();
  vi.doMock("./work-popover.tsx", async (original) => {
    await loads.begin();
    return original();
  });
  // The card's own groups need the whole workspace (panels, sources, git); what is under test
  // here is the popover around them, so the card is one button.
  vi.doMock("./work-card.tsx", async () => {
    const { createElement } = await import("react");
    return { WorkCard: () => createElement("button", { type: "button" }, "Card action") };
  });
});

/** The thread's header icon in a narrow thread area, where the card opens as its popover. */
async function showHeader() {
  // Imported after the reset, so the client's context and the icon's are the same module.
  const [{ componentClient }, { WorkButton }, { WorkCardContext, createWorkCardStore }] =
    await Promise.all([
      import("@/test/component-client.tsx"),
      import("./work-button.tsx"),
      import("./work-card-store.ts"),
    ]);
  const fixture = workCardScenario("changes");
  const component = await componentClient(fixture);
  const store = createWorkCardStore();
  component.render(
    <WorkCardContext.Provider value={store}>
      <textarea aria-label="Message" />
      <WorkButton threadId={fixture.thread.id} />
    </WorkCardContext.Provider>,
  );
  return { store };
}

const icon = () => screen.getByRole("button", { name: /^Thread details/ });
const card = () => screen.queryByRole("dialog", { name: "Thread details" });
/** Long enough for an arrived chunk to render, were anything to draw from it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("opening the details while the popover loads opens it once it arrives", async () => {
  await showHeader();
  await userEvent.click(icon());
  expect(icon().getAttribute("aria-expanded")).toBe("true");
  await loads.arrive();
  expect(await screen.findByRole("dialog", { name: "Thread details" })).toBeTruthy();
});

test("Escape while the details popover loads cancels the open, and it doesn't open on arrival", async () => {
  const { store } = await showHeader();
  const button = icon();
  await userEvent.click(button);
  await userEvent.keyboard("{Escape}");
  expect(store.get().open).toBe(false);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await loads.arrive();
  await settle();
  expect(card()).toBeNull();
  expect(icon()).toBe(button);
  expect(document.activeElement).toBe(button);
});

test("a press elsewhere while the details popover loads cancels the open", async () => {
  const { store } = await showHeader();
  await userEvent.click(icon());
  const message = screen.getByRole("textbox", { name: "Message" });
  await userEvent.click(message);
  expect(store.get().open).toBe(false);
  await loads.arrive();
  await settle();
  expect(card()).toBeNull();
  expect(document.activeElement).toBe(message);
});

test("a details popover that fails to load leaves the header and composer usable, and the next open loads it", async () => {
  const { store } = await showHeader();
  await userEvent.click(icon());
  await loads.fail();
  await waitFor(() => expect(store.get().open).toBe(false));
  const message = screen.getByRole("textbox", { name: "Message" });
  await userEvent.type(message, "Still writing");
  expect((message as HTMLTextAreaElement).value).toBe("Still writing");
  const before = loads.started();
  await userEvent.click(icon());
  await loads.arrive();
  expect(await screen.findByRole("dialog", { name: "Thread details" })).toBeTruthy();
  expect(loads.started()).toBe(before + 1);
});
