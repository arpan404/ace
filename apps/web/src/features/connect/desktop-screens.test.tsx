import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { AppFrame } from "@/app.tsx";
import type { DesktopDaemon, DesktopDaemonStatus } from "@/boot/desktop.ts";
import { DesktopFailureScreen } from "./desktop-failure-screen.tsx";
import { startingHelpMs, startingNoteMs, StartingScreen } from "./starting-screen.tsx";

/** The desktop bridge's daemon controls, recording what the screen asked for. */
function desktop() {
  const asked: string[] = [];
  let emit: ((status: DesktopDaemonStatus) => void) | undefined;
  const daemon: DesktopDaemon = {
    status: async () => ({ state: "failed" }),
    onStatus(listener) {
      emit = listener;
      return () => {};
    },
    restart: async () => {
      asked.push("restart");
      return { state: "restarting" };
    },
    diagnose: async () => [
      { id: "node", status: "ok", message: "Node 24.1" },
      { id: "home", status: "fail", message: "~/.ace-next is not writable", fix: "chmod u+w" },
    ],
    showLogs: async () => {
      asked.push("logs");
      return true;
    },
    quit: async () => {
      asked.push("quit");
    },
  };
  return { daemon, asked, emit: (status: DesktopDaemonStatus) => act(() => emit?.(status)) };
}

test("a desktop daemon that failed says why and offers restart, diagnostics, logs and quit", async () => {
  const user = userEvent.setup();
  const { daemon, asked, emit } = desktop();
  render(
    <AppFrame environment={{}}>
      <DesktopFailureScreen reason="Legacy ace data in ~/.ace" daemon={daemon} />
    </AppFrame>,
  );
  expect(screen.getByRole("heading", { name: "ace didn't start" })).toBeTruthy();
  expect(screen.getByText(/ace found data from an older installation/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("Legacy ace data in ~/.ace");
  // The desktop runs its own daemon: nothing here asks the person to start one by hand.
  expect(document.body.textContent).not.toMatch(/ace start/);

  await user.click(screen.getByRole("button", { name: "Run diagnostics" }));
  const report = await screen.findByRole("region", { name: "Diagnostics" });
  expect(report.textContent).toContain("Data folder");
  expect(report.textContent).toContain("Needs attention");
  expect(report.textContent).toContain("Check that you can read and write the ace data folder.");
  expect(report.textContent).not.toContain("chmod");

  await user.click(screen.getByRole("button", { name: "Restart ace" }));
  expect(await screen.findByText("Restarting ace…")).toBeTruthy();
  emit({ state: "failed", message: 'daemon_internal_302: {"bad": true}' });
  expect(screen.getByText(/Restart ace to try again/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("daemon_internal_302");
  await user.click(screen.getByRole("button", { name: "Show logs" }));
  await user.click(screen.getByRole("button", { name: "Quit ace" }));
  expect(asked).toEqual(["restart", "logs", "quit"]);
});

test("a long desktop start shows its installed version and offers bounded service recovery", async () => {
  const { daemon, emit } = desktop();
  const timers: { delay: number; run: () => void }[] = [];
  render(
    <AppFrame environment={{}}>
      <StartingScreen
        daemon={daemon}
        version="1.2.3"
        onConnectManually={() => {}}
        schedule={(delay, run) => {
          timers.push({ delay, run });
          return () => {};
        }}
      />
    </AppFrame>,
  );
  const elapse = (delay: number) =>
    act(() => {
      for (const timer of timers) if (timer.delay === delay) timer.run();
    });
  expect(screen.getByRole("status").textContent).toBe("Loading your workspace…");
  expect(screen.getByText("v1.2.3")).toBeTruthy();
  expect(screen.queryByText(/Preparing local services/)).toBeNull();

  elapse(startingNoteMs);
  expect(screen.getByText(/Preparing local services/)).toBeTruthy();
  emit({ state: "unreachable" });
  expect(screen.getByText("Waiting for ace to answer…")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restart ace" })).toBeTruthy();

  elapse(startingHelpMs);
  for (const name of ["Show logs", "Restart ace", "Connect manually…", "Quit ace"])
    expect(screen.getByRole("button", { name })).toBeTruthy();
});
