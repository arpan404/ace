import { mkdtemp, mkdir, chmod, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { detectToolchains } from "./index.ts";

it("toolchain hints reflect the supplied Git and Android SDK installations", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-toolchains-"));
  try {
    const sdk = join(root, "sdk");
    await mkdir(join(sdk, "platform-tools"), { recursive: true });
    for (const path of [join(root, "git"), join(sdk, "platform-tools", "adb")]) {
      await writeFile(path, "#!/bin/sh\necho 'fixture tool version 1.0'\n");
      await chmod(path, 0o700);
    }
    const tools = await detectToolchains({ PATH: root, ANDROID_HOME: sdk }, "linux");
    expect(tools).toMatchObject([
      { id: "git", available: true },
      { id: "android", available: true },
    ]);
    await writeFile(join(root, "git"), "#!/bin/sh\nexit 1\n");
    await rm(join(sdk, "platform-tools", "adb"));
    const missing = await detectToolchains({ PATH: root, ANDROID_HOME: sdk }, "linux");
    expect(missing).toMatchObject([
      { id: "git", available: false, hint: "Install git with your package manager." },
      { id: "android", available: false },
    ]);
    expect(missing[1]?.hint).toContain("Android Studio");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("an Android Studio SDK in ~/Android/Sdk is found without ANDROID_HOME, as emulators find it", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-toolchains-home-"));
  try {
    const tools = join(home, "Android", "Sdk", "platform-tools");
    await mkdir(tools, { recursive: true });
    await writeFile(join(tools, "adb"), "#!/bin/sh\necho 'Version 36.0.0-13206524'\n");
    await chmod(join(tools, "adb"), 0o700);
    const found = await detectToolchains({ PATH: "", HOME: home }, "linux");
    expect(found.find((tool) => tool.id === "android")).toMatchObject({
      available: true,
      version: "36.0.0",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("a Mac without Simulator tools receives an Xcode setup hint", async () => {
  const tools = await detectToolchains({ PATH: "" }, "darwin", async (command) =>
    command.endsWith("git") ? "git version 2.50" : undefined,
  );
  expect(tools.find((tool) => tool.id === "xcode")).toMatchObject({
    available: false,
    hint: expect.stringContaining("Install Xcode from the App Store"),
  });
  expect(tools.find((tool) => tool.id === "xcode")).not.toHaveProperty("version");
});

it("a Mac with Xcode reports its version, and the Android SDK its platform-tools release", async () => {
  const outputs: Record<string, string> = {
    "xcrun simctl help": "usage: simctl [--set <path>] <subcommand> ...",
    "xcode-select -p": "/Applications/Xcode.app/Contents/Developer",
    "xcodebuild -version": "Xcode 26.0\nBuild version 17A324",
    "adb version": "Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458\nInstalled as /x",
  };
  const tools = await detectToolchains({ PATH: "" }, "darwin", async (command, args) =>
    Promise.resolve(outputs[[command, ...args].join(" ")]),
  );
  expect(tools.find((tool) => tool.id === "xcode")).toMatchObject({
    available: true,
    version: "26.0",
    detail: "Xcode at /Applications/Xcode.app/Contents/Developer",
  });
  expect(tools.find((tool) => tool.id === "android")).toMatchObject({
    available: true,
    version: "35.0.2",
  });
});
