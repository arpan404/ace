import { expect, test } from "vitest";
import { chooseProfileScope } from "./browser-profile-scope.ts";

test("without any choice, browsers share the global profile", () => {
  expect(chooseProfileScope({ value: "global", provenance: "defaults" }, undefined)).toBe("global");
  expect(chooseProfileScope(undefined, undefined)).toBe("global");
});

test("the daemon's setting applies to a project that made no choice of its own", () => {
  expect(chooseProfileScope({ value: "thread", provenance: "global" }, undefined)).toBe("thread");
  expect(chooseProfileScope({ value: "project", provenance: "workspace" }, undefined)).toBe(
    "project",
  );
});

test("a project's choice in Edit project comes before the daemon's and the repository's settings", () => {
  expect(chooseProfileScope({ value: "thread", provenance: "global" }, "project")).toBe("project");
  expect(chooseProfileScope({ value: "thread", provenance: "workspace" }, "global")).toBe("global");
});

test("a thread's own setting, or an environment override, comes before its project's choice", () => {
  expect(chooseProfileScope({ value: "thread", provenance: "thread" }, "project")).toBe("thread");
  expect(chooseProfileScope({ value: "global", provenance: "environment" }, "project")).toBe(
    "global",
  );
});

test("an unreadable setting value falls back to the project's choice, else global", () => {
  expect(chooseProfileScope({ value: "shared", provenance: "thread" }, "project")).toBe("project");
  expect(chooseProfileScope({ value: 7, provenance: "global" }, undefined)).toBe("global");
});
