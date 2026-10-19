import { expect, it } from "vitest";
import { mayCompress } from "./compression-policy.ts";

it.each([
  // Git remote URLs can embed tokens, next to command output.
  "workspace.result",
  "source-control.result",
  "repositories.result",
  "projects.result",
  "devices.state",
  "devices.inventory",
  // A tab's URL can carry a token next to page-controlled titles.
  "browser.state",
  "browser.result",
  "browser.frame",
  // Sign-in codes and links, tickets and the connection's first message.
  "provider.login.progress",
  "provider.login.result",
  "cursor.auth.login",
  "preview.result",
  "welcome",
  "error",
])("%s, which can carry a secret beside attacker-influenced data, is never compressed", (type) => {
  expect(mayCompress(type)).toBe(false);
});

it("a message type nobody has judged safe yet is not compressed", () => {
  expect(mayCompress("some.future.result")).toBe(false);
});

it.each(["events", "snapshot", "items.page", "turns.page"])(
  "transcript bulk (%s) is compressed",
  (type) => {
    expect(mayCompress(type)).toBe(true);
  },
);
