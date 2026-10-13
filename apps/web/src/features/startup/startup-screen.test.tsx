import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import { AppFrame } from "@/app.tsx";
import type { DesktopDaemon, DesktopDaemonStatus } from "@/boot/desktop.ts";
import { useDismissBootSplash } from "@/lib/boot-splash.ts";
import { createStartup, useStartupHold, useStartupShell } from "@/lib/startup/startup.tsx";
import { startupSlowMs } from "@/lib/startup/startup-state.ts";
import { StartupPending } from "./startup-pending.tsx";

/** Timers and frames the test runs by hand. */
function clock() {
  const timers: { delay: number; run: () => void; live: boolean }[] = [];
  const frames: (() => void)[] = [];
  const startup = createStartup({
    schedule(delay, run) {
      const timer = { delay, run, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    frame(run) {
      frames.push(run);
      return () => frames.splice(frames.indexOf(run), 1);
    },
  });
  return {
    startup,
    elapse: (delay: number) =>
      act(() => {
        for (const timer of timers.filter((entry) => entry.delay === delay && entry.live)) {
          timer.live = false;
          timer.run();
        }
      }),
    paint: () => act(() => frames.splice(0).forEach((run) => run())),
  };
}

const covering = () => document.querySelector('[data-slot="startup-screen"]:not([data-leaving])');

/** The app shell: mounted once connected; its thread view loads until told otherwise. */
function Shell(props: { onLoaded: (done: () => void) => void }) {
  const [loading, setLoading] = useState(true);
  props.onLoaded(() => setLoading(false));
  useStartupShell(true);
  return <main>{loading ? <ThreadLoading /> : <p>Fix flaky checkout test</p>}</main>;
}
/** What the connection form and failure screens do when they take over. */
function TakeOver() {
  useDismissBootSplash();
  return <h1>Connect to ace</h1>;
}
function ThreadLoading() {
  useStartupHold();
  return <p>Loading messages…</p>;
}

test("boot shows the mark, never the app's skeleton, and cross-fades once the first data is in", () => {
  const { startup, elapse, paint } = clock();
  let finishLoading: (() => void) | undefined;
  const view = render(
    <AppFrame environment={{}} startup={startup}>
      <StartupPending />
    </AppFrame>,
  );
  expect(covering()).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("");
  elapse(startupSlowMs);
  expect(screen.getByRole("status").textContent).toBe("Starting ace…");

  // Connected: the app mounts underneath while its thread is still loading.
  view.rerender(
    <AppFrame environment={{}} startup={startup}>
      <Shell onLoaded={(done) => (finishLoading = done)} />
    </AppFrame>,
  );
  paint();
  expect(covering()).toBeTruthy();

  act(() => finishLoading?.());
  paint();
  expect(covering()).toBeNull();
  expect(document.querySelector('[data-slot="startup-screen"][data-leaving]')).toBeTruthy();
  elapse(450);
  expect(document.querySelector('[data-slot="startup-screen"]')).toBeNull();
  expect(screen.getByText("Fix flaky checkout test")).toBeTruthy();
});

test("a desktop daemon that fails to start says so, with Try again and View logs", async () => {
  const user = userEvent.setup();
  const { startup } = clock();
  const asked: string[] = [];
  let emit: ((status: DesktopDaemonStatus) => void) | undefined;
  const daemon: DesktopDaemon = {
    status: async () => ({ state: "starting" }),
    onStatus(listener) {
      emit = listener;
      return () => {};
    },
    restart: async () => {
      asked.push("restart");
      return { state: "restarting" };
    },
    diagnose: async () => [],
    showLogs: async () => {
      asked.push("logs");
      return true;
    },
  };
  render(
    <AppFrame environment={{}} startup={startup} daemon={daemon}>
      <StartupPending />
    </AppFrame>,
  );
  act(() => emit?.({ state: "failed", message: "EACCES: permission denied, open ~/.ace-next" }));
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("ace couldn't start");
  expect(alert.textContent).toContain("Check that you can read and write it");
  expect(alert.textContent).not.toContain("EACCES");

  await user.click(screen.getByRole("button", { name: "View logs" }));
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(asked).toEqual(["logs", "restart"]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Starting ace…");
});

test("a screen that takes over at boot is not hidden behind the startup screen", () => {
  const { startup, elapse } = clock();
  render(
    <AppFrame environment={{}} startup={startup}>
      <TakeOver />
    </AppFrame>,
  );
  expect(covering()).toBeNull();
  elapse(450);
  expect(document.querySelector('[data-slot="startup-screen"]')).toBeNull();
  expect(screen.getByRole("heading", { name: "Connect to ace" })).toBeTruthy();
});
