import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { SandboxNotice } from "./sandbox-notice.tsx";

const offered = {
  state: "offer",
  sentence: "AppArmor keeps Chromium's sandbox off here, so web pages in ace run without it.",
};

/** The desktop preload's `window.ace.sandbox`, answering setup with `afterSetup`. */
function desktop(initial: unknown, afterSetup: unknown, busy = 0) {
  const calls: string[] = [];
  let report: ((value: unknown) => void) | undefined;
  const scope = {
    ace: {
      sandbox: {
        current: () => Promise.resolve(initial),
        setup: () => {
          calls.push("setup");
          return Promise.resolve(afterSetup);
        },
        hide: () => {
          calls.push("hide");
          return Promise.resolve({ state: "hidden" });
        },
        restart: () => {
          calls.push("restart");
          return Promise.resolve();
        },
        onStatus(listener: (value: unknown) => void) {
          report = listener;
          return () => {};
        },
      },
      updates: { busy: () => Promise.resolve(busy) },
    },
  };
  render(
    <ToastProvider>
      <SandboxNotice scope={scope} />
    </ToastProvider>,
  );
  return { calls, report: (value: unknown) => act(() => report?.(value)) };
}

test("outside the affected Linux installs nothing shows", async () => {
  desktop({ state: "hidden" }, { state: "hidden" });
  await act(() => Promise.resolve());
  expect(screen.queryByRole("status")).toBeNull();
});

test("the sandbox setup turns into a restart once the person has approved it", async () => {
  const app = desktop(offered, {
    state: "restart",
    sentence: "The sandbox is set up; restart ace to turn it on.",
  });
  expect(await screen.findByText(offered.sentence)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Set up sandbox" }));
  expect(await screen.findByText("The sandbox is set up; restart ace to turn it on.")).toBeTruthy();
  expect(app.calls).toEqual(["setup"]);
});

test("Restart says which agents it stops and restarts only once confirmed", async () => {
  const app = desktop(
    { state: "restart", sentence: "The sandbox is set up; restart ace to turn it on." },
    { state: "hidden" },
    2,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Restart" }));
  expect(
    await screen.findByText(
      "2 agents on this computer will stop. Their threads keep their progress.",
    ),
  ).toBeTruthy();
  expect(app.calls).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Restart anyway" }));
  expect(app.calls).toEqual(["restart"]);
});

test("without a password prompt the setup's commands are copied for a terminal", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  desktop({ state: "commands", sentence: "Copy the commands.", commands: "sudo tee x" }, {});
  await userEvent.click(await screen.findByRole("button", { name: "Copy commands" }));
  expect(writeText).toHaveBeenCalledWith("sudo tee x");
  expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
});

test("Hide removes the notice, and a later status from the app shows it again", async () => {
  const app = desktop(offered, {});
  await userEvent.click(await screen.findByRole("button", { name: "Hide" }));
  expect(screen.queryByRole("status")).toBeNull();
  app.report(offered);
  expect(screen.getByText(offered.sentence)).toBeTruthy();
});
