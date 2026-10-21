import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { UpdateButton } from "./update-button.tsx";

const releaseUrl = "https://github.com/arpan404/ace/releases/tag/v1.1.0";
const notes = [{ version: "1.1.0", items: ["Persist views across restarts (#985)"], total: 3 }];

/** The desktop preload's update status, with anything a case changes. */
function status(overrides: Record<string, unknown> = {}) {
  return {
    state: "idle",
    currentVersion: "1.0.0",
    version: null,
    releaseUrl: null,
    inPlace: true,
    percent: null,
    waiting: 0,
    notes: [],
    olderReleases: 0,
    error: null,
    ...overrides,
  };
}
const offer = (overrides: Record<string, unknown> = {}) =>
  status({ state: "available", version: "1.1.0", releaseUrl, notes, ...overrides });

/** The desktop preload's `window.ace.updates` and `shell`, steered by the test. */
function desktop(initial: unknown = status()) {
  let report: ((value: unknown) => void) | undefined;
  const scope = {
    ace: {
      updates: {
        current: () => Promise.resolve(initial),
        onStatus(listener: (value: unknown) => void) {
          report = listener;
          return () => {};
        },
      },
      shell: { openExternal: () => Promise.resolve() },
    },
  };
  render(
    <ToastProvider>
      <UpdateButton scope={scope} />
    </ToastProvider>,
  );
  return { report: (value: unknown) => act(() => report?.(value)) };
}

test("the update button stays visible while its card loads", async () => {
  const app = desktop();
  await screen.findByRole("button", { name: "Check for updates" });
  app.report(offer());
  expect(screen.getByRole("button", { name: "Update 1.1.0 ready to download" })).toBeTruthy();
});

test("a focused button keeps focus when release notes arrive", async () => {
  const app = desktop();
  const button = await screen.findByRole("button", { name: "Check for updates" });
  act(() => {
    button.focus();
  });
  expect(document.activeElement).toBe(button);
  app.report(offer());
  // Wait for the handoff to the lazy trigger, then open its card the way a person does: the
  // card appearing proves the overlay loaded, and focus must still be on the update button.
  await waitFor(() => {
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Update 1.1.0 ready to download",
    );
  });
  await userEvent.hover(
    screen.getByRole("button", { name: "Update 1.1.0 ready to download" }),
  );
  expect(await screen.findByText("What's changed")).toBeTruthy();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Update 1.1.0 ready to download",
  );
});
