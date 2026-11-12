import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";

/**
 * A tooltip's popup is its own chunk. Each load of it waits here until the test lets it arrive
 * or fail, as a slow or broken network would.
 */
const loads = vi.hoisted(() => {
  const waiting: { resolve(): void; reject(error: Error): void }[] = [];
  let started = 0;
  const next = async () => {
    await vi.waitFor(() => {
      if (!waiting.length) throw new Error("No load of the tooltip's popup is waiting");
    });
    const load = waiting.shift();
    if (!load) throw new Error("No load of the tooltip's popup is waiting");
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

// Each test starts as a fresh page: no chunk of the popup has arrived yet.
beforeEach(() => {
  vi.resetModules();
  loads.reset();
  // The idle warm-up is the browser's to time; here only a tooltip's own request loads the popup.
  vi.doMock("@/lib/idle.ts", () => ({ whenIdle: () => () => {} }));
  vi.doMock("./tooltip-popup.tsx", async (original) => {
    await loads.begin();
    return original();
  });
});

/** A tooltip whose open state its owner keeps, as the composer's model control does. */
function Held(props: { ui: typeof import("./tooltip.tsx") }) {
  const { Tooltip, TooltipContent, TooltipTrigger } = props.ui;
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger render={<button type="button">Model</button>} />
      <TooltipContent>Pick a model</TooltipContent>
    </Tooltip>
  );
}

async function showTips() {
  // Imported after the reset, so each test's page loads the popup afresh.
  const ui = await import("./tooltip.tsx");
  const { Tip, TooltipProvider } = ui;
  const pressed = vi.fn();
  render(
    <TooltipProvider delay={0}>
      <Tip label="Attach files">
        <button type="button" onClick={pressed}>
          Attach
        </button>
      </Tip>
      <Held ui={ui} />
    </TooltipProvider>,
  );
  return { pressed, attach: () => screen.getByRole("button", { name: "Attach" }) };
}

const tooltip = () => screen.queryByRole("tooltip");
/** Long enough for an arrived chunk to render, were anything to draw from it. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

test("a tooltip asked for while its popup loads opens once the popup arrives", async () => {
  const { attach } = await showTips();
  await userEvent.hover(attach());
  await settle();
  expect(tooltip()).toBeNull();
  await loads.arrive();
  expect((await screen.findByRole("tooltip")).textContent).toBe("Attach files");
});

test("a pointer that leaves before the popup arrives never opens it", async () => {
  const { attach } = await showTips();
  await userEvent.hover(attach());
  await userEvent.unhover(attach());
  await loads.arrive();
  await settle();
  expect(tooltip()).toBeNull();
});

test("Escape while the popup loads cancels the open and leaves focus on the control", async () => {
  const { attach } = await showTips();
  await userEvent.tab();
  expect(document.activeElement).toBe(attach());
  await userEvent.keyboard("{Escape}");
  await loads.arrive();
  await settle();
  expect(tooltip()).toBeNull();
  expect(document.activeElement).toBe(attach());
});

test("a press while the popup loads still reaches the control, and no tooltip opens after it", async () => {
  const { attach, pressed } = await showTips();
  await userEvent.hover(attach());
  await userEvent.click(attach());
  expect(pressed).toHaveBeenCalledTimes(1);
  await loads.arrive();
  await settle();
  expect(tooltip()).toBeNull();
});

test("a failed load keeps the control working, and the next hover loads the popup again", async () => {
  const { attach, pressed } = await showTips();
  await userEvent.hover(attach());
  await loads.fail();
  await settle();
  expect(tooltip()).toBeNull();
  await userEvent.click(attach());
  expect(pressed).toHaveBeenCalledTimes(1);

  await userEvent.unhover(attach());
  await userEvent.hover(attach());
  await loads.arrive();
  expect((await screen.findByRole("tooltip")).textContent).toBe("Attach files");
  expect(loads.started()).toBe(2);
});

test("a tooltip whose open state its owner holds opens once the popup arrives", async () => {
  await showTips();
  await userEvent.hover(screen.getByRole("button", { name: "Model" }));
  await settle();
  expect(tooltip()).toBeNull();
  await loads.arrive();
  expect((await screen.findByRole("tooltip")).textContent).toBe("Pick a model");
});
