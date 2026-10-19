import { lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { deferredComponent } from "./deferred-component.tsx";

test("a failed prefetch leaves the view loadable on first use", async () => {
  let online = false;
  const view = deferredComponent(async () => {
    if (!online) throw new Error("Chunk unavailable");
    return () => <h2>Loaded view</h2>;
  });
  await expect(view.preload()).rejects.toThrow("Chunk unavailable");
  online = true;
  render(
    <Suspense fallback={null}>
      <view.Component />
    </Suspense>,
  );
  expect(await screen.findByRole("heading", { name: "Loaded view" })).toBeTruthy();
});

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
const wasActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
afterEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
});

/** A foldable section of a side panel view, folded until the person opens it. */
function Section(props: { state: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" aria-expanded={open} onClick={() => setOpen(true)}>
      {`Checks (${props.state})`}
    </button>
  );
}

test("a view keeps what the person changed when its props change after its code arrived", async () => {
  // React's own scheduler, as in the app: act() renders differently around suspended code.
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  // The code is already in memory, as when another view loaded the same chunk.
  const code = Promise.resolve(Section);
  await code;
  const view = deferredComponent(() => code);
  // A side panel tab: its kind's view loads lazily too, inside the tab's own boundary.
  const Tab = lazy(async () => ({ default: view.Component }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    root.render(
      <Suspense fallback={<p>Loading</p>}>
        <Tab state="unknown" />
      </Suspense>,
    );
    const section = await vi.waitFor(() => {
      const button = host.querySelector("button");
      if (!button) throw new Error("The view hasn't drawn yet");
      return button;
    });
    section.click();
    await vi.waitFor(() => expect(section.getAttribute("aria-expanded")).toBe("true"));
    // The tab learns the PR's state and draws again.
    root.render(
      <Suspense fallback={<p>Loading</p>}>
        <Tab state="open" />
      </Suspense>,
    );
    await vi.waitFor(() => expect(host.textContent).toBe("Checks (open)"));
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  } finally {
    root.unmount();
    host.remove();
  }
});
