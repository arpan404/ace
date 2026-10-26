import { afterEach, expect, it } from "vitest";
import { graphicalSessionEnvironment } from "../linux-session.ts";
import { linuxComputerEnvironment } from "./session.ts";
import { computerWorld, type WorldOptions } from "./testing/world.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function world(options: WorldOptions = {}) {
  const made = await computerWorld({
    ...options,
    toolkit: { platform: "linux", ...options.toolkit },
  });
  cleanups.push(made.close);
  return made;
}

/** A user manager that holds a logged-in session, or none. */
const manager = (output: string) =>
  linuxComputerEnvironment(graphicalSessionEnvironment({ env: {}, run: async () => output }));

it("an agent drives a Linux app by its desktop-file id", async () => {
  const { call } = await world({ client: { environment: manager("WAYLAND_DISPLAY=wayland-0\n") } });
  const look = await call("screen_state", { app: "org.gnome.TextEditor" });
  expect(look.result.isError).toBeFalsy();
  expect(look.text).toContain("Text Editor (org.gnome.TextEditor)");
  const acted = await call("screen_act", {
    app: "Text Editor",
    actions: [{ type: "type", text: "hi" }],
  });
  expect(acted.result.isError).toBeFalsy();
  expect(acted.text).toContain("1. typed 2 characters");
});

it("the computer helper starts inside the desktop session the user manager reports", async () => {
  const { call, ops } = await world({
    env: { FAKE_LOG_SESSION: "1" },
    client: { environment: manager("WAYLAND_DISPLAY=wayland-7\nXDG_SESSION_TYPE=wayland\n") },
  });
  await call("screen_apps", {});
  expect((await ops())[0]).toBe("session WAYLAND_DISPLAY=wayland-7");
});

it("in an X11 session the tools ask for a Wayland login and no helper starts", async () => {
  const { call, ops, children } = await world({
    client: { environment: manager("DISPLAY=:0\nXDG_SESSION_TYPE=x11\n") },
  });
  const look = await call("screen_state", { app: "Text Editor" });
  expect(look.result.isError).toBe(true);
  expect(look.text).toContain("X11 session");
  expect(look.text).toContain("Wayland");
  expect(children).toEqual([]);
  expect(await ops()).toEqual([]);
});

it("the helper keeps screen-sharing approvals in the data directory it is given", async () => {
  const { call, ops } = await world({
    env: { FAKE_LOG_ARGS: "1" },
    client: {
      environment: manager("WAYLAND_DISPLAY=wayland-0\n"),
      helperArgs: ["--data-dir", "/home/me/.ace/screen"],
    },
  });
  await call("screen_apps", {});
  expect((await ops())[0]).toBe("args --computer --data-dir /home/me/.ace/screen");
});

it("without a desktop session the tools say so and no helper starts", async () => {
  const { call, ops, children } = await world({
    client: { environment: manager("XDG_RUNTIME_DIR=/run/user/1000\n") },
  });
  const look = await call("screen_state", { app: "Text Editor" });
  expect(look.result.isError).toBe(true);
  expect(look.text).toContain("No graphical session");
  expect(look.text).toContain("log in");
  expect(children).toEqual([]);
  expect(await ops()).toEqual([]);
});

it.each([
  ["a Linux terminal", "Ptyxis", "commands"],
  ["a terminal known by its executable name", "kitty", "commands"],
  ["a password manager", "KeePassXC", "passwords"],
  ["a polkit authentication agent", "Polkit Agent", "authentication"],
  ["ace's own desktop app", "ace-desktop", "ace itself"],
  ["ace's desktop app by its Linux app id", "dev.ace.app", "ace itself"],
  ["ace's desktop app from the tar.gz", "ace-desktop-bin", "ace itself"],
])("%s is refused before any look or action reaches it", async (_label, app, reason) => {
  const { call, ops } = await world({
    client: { environment: manager("WAYLAND_DISPLAY=wayland-0\n") },
  });
  const refused = await call("screen_act", { app, actions: [{ type: "type", text: "ls" }] });
  expect(refused.result.isError).toBe(true);
  expect(refused.text).toContain(reason);
  expect((await ops()).filter((op) => !op.startsWith("resolve"))).toEqual([]);
});

it("refused Linux apps are left out of the app list", async () => {
  const { call } = await world({ client: { environment: manager("WAYLAND_DISPLAY=wayland-0\n") } });
  const listed = await call("screen_apps", {});
  expect(listed.text).toContain("org.gnome.TextEditor");
  expect(listed.text).not.toContain("org.gnome.Ptyxis");
  expect(listed.text).not.toContain("KeePassXC");
});

it("on KDE an agent sees KCalc but never Konsole or the wallet's password prompt", async () => {
  const { call, ops } = await world({
    client: { environment: manager("WAYLAND_DISPLAY=wayland-0\n") },
  });
  const listed = await call("screen_apps", {});
  expect(listed.text).toContain("org.kde.kcalc");
  expect(listed.text).not.toContain("Konsole");
  expect(listed.text).not.toContain("Secret Prompter");
  for (const app of ["konsole", "Secret Prompter"]) {
    const refused = await call("screen_act", { app, actions: [{ type: "type", text: "ls" }] });
    expect(refused.result.isError, app).toBe(true);
    expect(refused.text, app).toContain("does not operate this app");
  }
  expect((await ops()).filter((op) => !op.startsWith("resolve") && op !== "apps")).toEqual([]);
});
