import { expect, test } from "vitest";
import { browserInstallId } from "./install-id.ts";

test("a browser whose storage refuses writes names one install for every caller in the run", () => {
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {},
  };
  // The worker client, the page client and the machine pool each ask for it.
  const first = browserInstallId(refusing);
  expect(browserInstallId(refusing)).toBe(first);
  expect(browserInstallId(refusing)).toBe(first);
});
