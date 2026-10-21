import { expect, test } from "vitest";
import {
  clearRunIntent,
  ensureRunIntent,
  getRunIntent,
  shouldKeepRunIntentOnError,
} from "./run-intents.ts";
import { memoryKeyValue } from "@/test/harness.tsx";
import { ClientError } from "@ace/client";

test("one intent per daemon per automation survives reloads and clears once answered", () => {
  const storage = memoryKeyValue();
  const daemon = "memory://fake-daemon";
  const first = ensureRunIntent(
    storage,
    daemon,
    "auto-a",
    () => 1000,
    () => "req-1",
  );
  expect(first.requestId).toBe("req-1");
  const again = ensureRunIntent(
    storage,
    daemon,
    "auto-a",
    () => 2000,
    () => "req-2",
  );
  expect(again.requestId).toBe("req-1");
  expect(getRunIntent(storage, daemon, "auto-a")?.requestId).toBe("req-1");
  expect(getRunIntent(storage, "other://daemon", "auto-a")).toBeUndefined();
  const other = ensureRunIntent(
    storage,
    "other://daemon",
    "auto-a",
    () => 3000,
    () => "req-3",
  );
  expect(other.requestId).toBe("req-3");
  clearRunIntent(storage, daemon, "auto-a");
  expect(getRunIntent(storage, daemon, "auto-a")).toBeUndefined();
  expect(getRunIntent(storage, "other://daemon", "auto-a")?.requestId).toBe("req-3");
});

test("uncertain sends keep the intent while definitive refusals clear it", () => {
  expect(shouldKeepRunIntentOnError(new ClientError("offline"))).toBe(true);
  expect(shouldKeepRunIntentOnError(new ClientError("timeout"))).toBe(true);
  expect(shouldKeepRunIntentOnError(new ClientError("aborted"))).toBe(true);
  expect(shouldKeepRunIntentOnError(new ClientError("not_dispatched"))).toBe(true);
  expect(shouldKeepRunIntentOnError(new Error("Automation revision conflict"))).toBe(false);
  expect(shouldKeepRunIntentOnError(new Error("disabled_or_missing"))).toBe(false);
});

test("run intents stay bounded and never hold credentials", () => {
  const storage = memoryKeyValue();
  for (let index = 0; index < 40; index++)
    ensureRunIntent(
      storage,
      "memory://fake-daemon",
      `auto-${index}`,
      () => index,
      () => `req-${index}`,
    );
  const raw = storage.data.get("ace.automation.runIntents") ?? "";
  expect(raw).not.toContain("token");
  expect(JSON.parse(raw)).toHaveLength(32);
});
