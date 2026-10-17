import { expect, test } from "vitest";
import { installRefusal } from "./admission.ts";

const install = (provider: "opencode" | "pi" | "codex") => ({
  provider,
  action: "install" as const,
});

test("installing an OpenCode or Pi release ace starts reports no refusal", () => {
  expect(installRefusal(install("opencode"), "2.0.28")).toBeUndefined();
  expect(installRefusal(install("opencode"), "2.0.22")).toBeUndefined();
  expect(installRefusal(install("pi"), "1.2.0")).toBeUndefined();
  expect(installRefusal(install("codex"), "0.200.0")).toBeUndefined();
});

test("an installer that lands on a release ace would refuse says so, naming the version", () => {
  expect(installRefusal(install("opencode"), "2.1.0")).toBe(
    "Installed, but ace can't use this version yet. OpenCode 2.1.0 is newer than ace has checked; ace supports OpenCode 2.0.x, 2.0.22 or newer.",
  );
  expect(installRefusal(install("pi"), "0.84.4")).toBe(
    "Installed, but ace can't use this version. Pi 0.84.4 is older than 0.85.1, the oldest version ace supports.",
  );
});

test("an installer that lands below a provider's minimum never reports success", () => {
  expect(installRefusal(install("codex"), "0.158.0")).toBe(
    "Installed, but ace can't use this version. Codex 0.158.0 is older than 0.159.1, the oldest version ace supports.",
  );
  expect(installRefusal(install("opencode"), "2.0.21")).toContain(
    "OpenCode 2.0.21 is older than 2.0.22",
  );
  expect(installRefusal(install("codex"), "0.159.1")).toBeUndefined();
  expect(installRefusal({ provider: "codex", action: "uninstall" }, "0.1.0")).toBeUndefined();
});
