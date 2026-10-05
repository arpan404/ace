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
  const { daemon, asked } = desktop();
  render(
    <AppFrame environment={{}}>
      <DesktopFailureScreen reason="Legacy ace data in ~/.ace" daemon={daemon} />
    </AppFrame>,
  );
  expect(screen.getByRole("heading", { name: "ace's daemon didn't start" })).toBeTruthy();
  expect(screen.getByText("Legacy ace data in ~/.ace")).toBeTruthy();
  // The desktop runs its own daemon: nothing here asks the person to start one by hand.
  expect(document.body.textContent).not.toMatch(/ace start/);

  await user.click(screen.getByRole("button", { name: "Run diagnostics" }));
  const report = await screen.findByRole("region", { name: "Diagnostics" });
  expect(report.textContent).toMatch(/Problem: home: ~\/\.ace-next is not writable/);
  expect(report.textContent).toMatch(/chmod u\+w/);

  await user.click(screen.getByRole("button", { name: "Restart daemon" }));
  expect(await screen.findByText("Restarting the daemon…")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show logs" }));
  await user.click(screen.getByRole("button", { name: "Quit ace" }));
  expect(asked).toEqual(["restart", "logs", "quit"]);
});

test("a long desktop start explains itself after 10s and offers a way out after a minute", async () => {
  const { daemon, emit } = desktop();
  const timers: { delay: number; run: () => void }[] = [];
  render(
    <AppFrame environment={{}}>
      <StartingScreen
        daemon={daemon}
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
  expect(screen.getByRole("status").textContent).toBe("Starting ace…");
  expect(screen.queryByText(/scans your provider history/)).toBeNull();

  elapse(startingNoteMs);
  expect(screen.getByText(/scans your provider history/)).toBeTruthy();
  emit({ state: "unreachable" });
  expect(screen.getByText("Waiting for the daemon to answer…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Restart daemon" })).toBeNull();

  elapse(startingHelpMs);
  for (const name of ["Show logs", "Restart daemon", "Connect manually…", "Quit ace"])
    expect(screen.getByRole("button", { name })).toBeTruthy();
});
