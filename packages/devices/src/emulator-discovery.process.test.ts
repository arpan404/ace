import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { emulatorConsolePort, emulatorGrpc } from "./emulator-discovery.ts";
import { emulatorBootArgs } from "./emulator-args.ts";

async function running(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "ace-avd-running-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text);
  return directory;
}

it("an emulator's gRPC endpoint is read from the discovery file of its console port", async () => {
  const directory = await running({
    "pid_100.ini": "port.serial=5554\ngrpc.port=8554\ngrpc.token=one\n",
    "pid_200.ini": "port.serial=5556\ngrpc.port=8556\ngrpc.token=two\n",
    "notes.txt": "port.serial=5558\n",
  });
  expect(await emulatorGrpc(directory, emulatorConsolePort("emulator-5556") ?? 0)).toEqual({
    port: 8556,
    token: "two",
  });
});

it("an emulator without a token (Android Studio's JWT default) or without gRPC has no endpoint ace uses", async () => {
  const directory = await running({
    "pid_100.ini": "port.serial=5554\ngrpc.port=8554\ngrpc.jwks=/tmp/jwks\n",
    "pid_200.ini": "port.serial=5556\n",
  });
  expect(await emulatorGrpc(directory, 5554)).toBeUndefined();
  expect(await emulatorGrpc(directory, 5556)).toBeUndefined();
  expect(await emulatorGrpc(directory, 5560)).toBeUndefined();
  expect(await emulatorGrpc(join(directory, "missing"), 5554)).toBeUndefined();
  expect(emulatorConsolePort("R5CT1234")).toBeUndefined();
});

it("on a Mac ace boots emulators with token-protected gRPC on console port + 3000, elsewhere without", () => {
  const mac = emulatorBootArgs({ avd: "Pixel", port: 5560, window: false, platform: "darwin" });
  expect(mac.join(" ")).toContain("-grpc 8560 -grpc-use-token");
  const linux = emulatorBootArgs({ avd: "Pixel", port: 5560, window: false, platform: "linux" });
  expect(linux).not.toContain("-grpc");
});

it("emulators describe themselves where each OS keeps them", async () => {
  const { emulatorRunningDirectory } = await import("./emulator-discovery.ts");
  expect(emulatorRunningDirectory({ platform: "darwin", home: "/Users/a", env: {} })).toBe(
    join("/Users/a", "Library", "Caches", "TemporaryItems", "avd", "running"),
  );
  expect(
    emulatorRunningDirectory({
      platform: "linux",
      home: "/home/a",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    }),
  ).toBe(join("/run/user/1000", "avd", "running"));
  expect(
    emulatorRunningDirectory({
      platform: "win32",
      home: "C:/Users/a",
      env: { LOCALAPPDATA: "C:/Users/a/AppData/Local" },
    }),
  ).toBe(join("C:/Users/a/AppData/Local", "Temp", "avd", "running"));
});
