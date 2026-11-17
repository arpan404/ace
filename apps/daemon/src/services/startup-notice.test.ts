import { expect, test } from "vitest";
import { startupNotice } from "./startup-notice.ts";

test("a safe-mode start names what it left off, and a retrying service is named apart", () => {
  expect(
    startupNotice([
      { name: "settings", state: "ready" },
      { name: "commands", state: "degraded", error: "off", skipped: true },
      { name: "agentControl", state: "degraded", error: "failed" },
    ]),
  ).toEqual({ without: ["Commands"], failing: ["Agent control"] });
});

test("nothing is said while every service runs or is still starting", () => {
  expect(
    startupNotice([
      { name: "settings", state: "ready" },
      { name: "commands", state: "starting" },
    ]),
  ).toBeUndefined();
});
