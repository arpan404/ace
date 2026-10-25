import { expect, test } from "vitest";
import { genericInstallFailure, installFailureMessage } from "./failure.ts";

const update = { action: "update", method: "script", installedVersion: "0.163.0" } as const;

test("an unreachable installer script names the network problem on a fresh install", () => {
  expect(
    installFailureMessage({ action: "install", method: "script" }, [
      "curl: (6) Could not resolve host: chatgpt.com",
    ]),
  ).toBe(
    "Couldn't download the official installer (the server name could not be resolved). The download server may be unavailable; try again later.",
  );
});

test("a curl error after the script started blames the installer's own downloads", () => {
  expect(
    installFailureMessage(update, [
      "Downloading Codex 0.164.0",
      "curl: (22) The requested URL returned error: 503",
    ]),
  ).toBe(
    "The official installer couldn't download its files (HTTP 503). Version 0.163.0 is still installed. The download server may be unavailable; try again later.",
  );
});

test("package manager failures and script failures without a download error stay generic", () => {
  expect(
    installFailureMessage({ action: "update", method: "npm" }, [
      "curl: (22) The requested URL returned error: 404",
    ]),
  ).toBe(genericInstallFailure);
  expect(installFailureMessage(update, ["unsupported platform"])).toBe(genericInstallFailure);
});
