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
    "Installed, but ace can't use this version yet. Pi 0.84.4 is not supported; ace supports Pi 0.85.1 or newer.",
  );
});
