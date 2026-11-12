import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

/**
 * An agent row's details card is its own chunk. Each load of it waits here until the test lets
 * it arrive or fail, as a slow or broken network would.
 */
const loads = vi.hoisted(() => {
  const waiting: { resolve(): void; reject(error: Error): void }[] = [];
  let started = 0;
  const next = async () => {
    await vi.waitFor(() => {
      if (!waiting.length) throw new Error("No load of the details card is waiting");
    });
    const load = waiting.shift();
    if (!load) throw new Error("No load of the details card is waiting");
    return load;
  };
  return {
    reset: () => {
      waiting.length = 0;
      started = 0;
    },
    started: () => started,
    begin: () => {
      started += 1;
      return new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    arrive: async () => {
      const load = await next();
      await act(async () => load.resolve());
    },
    fail: async () => {
      const load = await next();
      await act(async () => load.reject(new Error("Failed to fetch dynamically imported module")));
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  loads.reset();
  // The idle warm-up is the browser's to time; here only a card's own request loads it.
  vi.doMock("@/lib/idle.ts", () => ({ whenIdle: () => () => {} }));
  // The card's body reads the machine's accounts; what is under test is the card around it, so
  // the body is the real popup holding the agent's name.
  vi.doMock("./agent-hover-popup.tsx", async () => {
    await loads.begin();
    const [{ createElement }, { HoverCardContent }] = await Promise.all([
      import("react"),
      import("@/components/ui/hover-card-content.tsx"),
    ]);
    return {
      AgentHoverPopup: (props: { parts: { name: string } }) =>
        createElement(
          HoverCardContent,
          { "aria-label": `Details for ${props.parts.name}` },
          `${props.parts.name} is reading the tests`,
        ),
    };
  });
});

async function showRow() {
  const [{ AgentHoverCard }, { ToastProvider }] = await Promise.all([
    import("./agent-hover-card.tsx"),
    import("@/components/ui/toast.tsx"),
  ]);
  const opened = vi.fn();
  render(
    <ToastProvider>
      <AgentHoverCard parts={{ mark: {}, name: "Explorer", state: "working", stale: false }}>
        <button type="button" onClick={opened}>
          Explorer
        </button>
      </AgentHoverCard>
      <textarea aria-label="Message" />
    </ToastProvider>,
  );
  return { opened, row: () => screen.getByRole("button", { name: "Explorer" }) };
}

const card = () => screen.queryByText("Explorer is reading the tests");
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
/** Past the row's 450 ms hover delay, so the card has asked to open. */
const rest = () => wait(500);
/** Long enough for an arrived chunk to render, were anything to draw from it. */
const settle = () => wait(50);

test("a card asked for while its code loads opens whole once the code arrives", async () => {
  const { row } = await showRow();
  await userEvent.hover(row());
  await rest();
  expect(card()).toBeNull();
  await loads.arrive();
  expect(await screen.findByText("Explorer is reading the tests")).toBeTruthy();
});

test("a pointer that leaves the row before the card's code arrives never opens it", async () => {
  const { row } = await showRow();
  await userEvent.hover(row());
  await rest();
  await userEvent.unhover(row());
  await loads.arrive();
  await settle();
  expect(card()).toBeNull();
});

test("a card that fails to load leaves the row and composer usable, and the next hover loads it", async () => {
  const { row, opened } = await showRow();
  await userEvent.hover(row());
  await rest();
  await loads.fail();
  await settle();
  expect(card()).toBeNull();
  await userEvent.click(row());
  expect(opened).toHaveBeenCalledTimes(1);
  const message = screen.getByRole("textbox", { name: "Message" });
  await userEvent.type(message, "Still writing");
  expect((message as HTMLTextAreaElement).value).toBe("Still writing");

  await userEvent.hover(row());
  await rest();
  await loads.arrive();
  expect(await screen.findByText("Explorer is reading the tests")).toBeTruthy();
  expect(loads.started()).toBe(2);
});
