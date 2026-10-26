import { expect, test } from "vitest";
import { graphicalSessionEnvironment, parseManagerEnvironment } from "./linux-session.ts";

const managerOutput = [
  "HOME=/home/ada",
  "DISPLAY=:0",
  "WAYLAND_DISPLAY=wayland-0",
  "XDG_RUNTIME_DIR=/run/user/1000",
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
  "XDG_SESSION_TYPE=wayland",
  "XDG_CURRENT_DESKTOP=$'ubuntu:GNOME'",
  "XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.ABC123",
  "MOTD=$'line one\\nline \\'two\\''",
  "not an assignment",
  "",
].join("\n");

test("a service started before login reaches the desktop session the user manager holds", async () => {
  const asked: string[][] = [];
  const env = await graphicalSessionEnvironment({
    env: { HOME: "/home/ada", PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
    run: async (command, args) => {
      asked.push([command, ...args]);
      return managerOutput;
    },
  })();
  expect(asked).toEqual([["systemctl", "--user", "show-environment"]]);
  expect(env).toMatchObject({
    PATH: "/usr/bin",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_SESSION_TYPE: "wayland",
    XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
    XAUTHORITY: "/run/user/1000/.mutter-Xwaylandauth.ABC123",
  });
  // Only the session's variables are taken from the manager.
  expect(env["MOTD"]).toBeUndefined();
});

test("each helper start reads the session again, so a later login is picked up", async () => {
  let loggedIn = false;
  const session = graphicalSessionEnvironment({
    env: {},
    run: async () => (loggedIn ? "DISPLAY=:1\n" : "XDG_RUNTIME_DIR=/run/user/1000\n"),
  });
  expect((await session())["DISPLAY"]).toBeUndefined();
  loggedIn = true;
  expect((await session())["DISPLAY"]).toBe(":1");
});

test("a daemon that already has a display never asks the user manager", async () => {
  const env = { DISPLAY: ":0", XAUTHORITY: "/home/ada/.Xauthority" };
  const session = graphicalSessionEnvironment({
    env,
    run: async () => {
      throw new Error("must not run");
    },
  });
  expect(await session()).toEqual(env);
});

test("a missing or failing systemctl leaves the daemon's environment as it is", async () => {
  const env = { HOME: "/home/ada" };
  const session = graphicalSessionEnvironment({
    env,
    run: async () => {
      throw new Error("spawn systemctl ENOENT");
    },
  });
  expect(await session()).toEqual(env);
});

test("manager values in shell quoting are decoded and malformed lines are skipped", () => {
  expect(parseManagerEnvironment(managerOutput)).toMatchObject({
    XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
    MOTD: "line one\nline 'two'",
  });
  expect(Object.keys(parseManagerEnvironment("garbage\n=x\n1A=b\n"))).toEqual([]);
});
