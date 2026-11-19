import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { copyBesideApp } from "../../scripts/beside-app.ts";
import { stageKoffi, stageMainProcessNatives } from "../../scripts/koffi.ts";
import { verifyNatives } from "../../scripts/verify-natives.ts";

async function temporary(onTestFinished: (cleanup: () => Promise<void>) => void) {
  const root = await mkdtemp(join(tmpdir(), "ace-native-staging-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function file(path: string, contents: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

/** A package folder whose dependencies hold koffi and, optionally, prebuilt packages. */
async function installed(root: string, prebuilts: readonly string[]): Promise<string> {
  const modules = join(root, "node_modules");
  await file(join(root, "package.json"), "{}");
  await file(join(modules, "koffi/package.json"), '{"name":"koffi","main":"index.cjs"}');
  await file(join(modules, "koffi/index.cjs"), "module.exports = {};");
  await file(join(modules, "koffi/LICENSE.txt"), "MIT");
  for (const target of prebuilts) {
    const prebuilt = join(modules, `@koromix/koffi-${target}`);
    await file(join(prebuilt, "package.json"), `{"name":"@koromix/koffi-${target}"}`);
    await file(join(prebuilt, "index.js"), "module.exports = {};");
    await file(join(prebuilt, target.replace("-", "_"), "koffi.node"), "binary");
  }
  return root;
}

test("a Windows build stages koffi with its architecture's binary and license", async ({
  onTestFinished,
}) => {
  const root = await temporary(onTestFinished);
  const from = await installed(join(root, "desktop"), ["win32-arm64"]);
  const dist = join(root, "dist");
  await stageMainProcessNatives(dist, "win32", "arm64", from);
  expect(
    existsSync(join(dist, "node_modules/@koromix/koffi-win32-arm64/win32_arm64/koffi.node")),
  ).toBe(true);
  expect(existsSync(join(dist, "node_modules/koffi/LICENSE.txt"))).toBe(true);
});

test.for(["darwin", "linux"] as const)(
  "a %s build stages no koffi",
  async (platform, { onTestFinished }) => {
    const root = await temporary(onTestFinished);
    const from = await installed(join(root, "desktop"), [`${platform}-arm64`]);
    await stageMainProcessNatives(join(root, "dist"), platform, "arm64", from);
    expect(existsSync(join(root, "dist/node_modules"))).toBe(false);
  },
);

test("staging koffi for an architecture whose prebuilt package is not installed fails", async ({
  onTestFinished,
}) => {
  const root = await temporary(onTestFinished);
  const from = await installed(join(root, "desktop"), ["win32-arm64"]);
  await expect(stageKoffi(join(root, "staged"), "win32", "x64", from)).rejects.toThrow(
    "@koromix/koffi-win32-x64 is not installed",
  );
});

test("native verification refuses a Windows build without koffi and never asks macOS for it", async ({
  onTestFinished,
}) => {
  const dist = await temporary(onTestFinished);
  await expect(verifyNatives("arm64", "win32", dist)).rejects.toThrow(
    /missing .*koffi-win32-arm64.*win32_arm64.*koffi\.node/,
  );
  const macOS = await verifyNatives("arm64", "darwin", dist).then(
    () => "",
    (error: unknown) => String(error),
  );
  expect(macOS).toMatch(/missing .*descriptor\.node/);
  expect(macOS).not.toMatch(/koffi/);
});

test("the package's afterPack refuses a Windows app that would find no koffi", async ({
  onTestFinished,
}) => {
  const root = await temporary(onTestFinished);
  const dist = join(root, "dist");
  await file(join(dist, "daemon/ace.mjs"), "");
  const packed = (electronPlatformName: string) => ({
    electronPlatformName,
    appOutDir: join(root, electronPlatformName),
    packager: { appInfo: { productFilename: "ace" } },
  });
  await expect(copyBesideApp(dist, "arm64")(packed("win32"))).rejects.toThrow(
    /no koffi: missing .*koffi\.node/,
  );
  await copyBesideApp(dist, "arm64")(packed("darwin"));
  expect(existsSync(join(root, "darwin/ace.app/Contents/Resources/daemon/ace.mjs"))).toBe(true);
});
