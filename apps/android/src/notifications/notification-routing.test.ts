import { Notification as DaemonNotification } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  alertDisplay,
  decodeNotificationLink,
  encodeNotificationLink,
  notificationActionId,
  notificationActionPayload,
  notificationRequestId,
  retractionRequestIds,
  tapRoute,
} from "./notification-routing.ts";

function alert(overrides: Record<string, unknown> = {}): DaemonNotification {
  return DaemonNotification.parse({
    id: "n-1",
    threadId: "thread-1",
    title: "Fix flaky checkout test",
    status: "needs_you",
    interactionId: "interaction-1",
    backgroundCount: 0,
    actions: [
      { action: "approve", optionId: "allow_once" },
      { action: "deny", optionId: "deny" },
    ],
    preview: "Run `pnpm test --filter checkout`?",
    ...overrides,
  });
}

test("the request id is namespaced per machine so repeats replace", () => {
  expect(notificationRequestId("n-1", "host-a")).toBe("host-a|n-1");
  expect(notificationRequestId("n-1", "host-b")).toBe("host-b|n-1");
  expect(notificationRequestId("n-1")).toBe("n-1");
});

test("retraction withdraws the namespaced id and the bare id posted before namespacing", () => {
  expect(retractionRequestIds("n-1", "host-a")).toEqual(["host-a|n-1", "n-1"]);
  expect(retractionRequestIds("n-1")).toEqual(["n-1"]);
});

test("an approval renders actionable with its exact options", () => {
  const display = alertDisplay(alert());
  expect(display).toMatchObject({
    title: "Fix flaky checkout test",
    body: "Needs you: Run `pnpm test --filter checkout`?",
    category: "approval",
    level: "timeSensitive",
    threadId: "thread-1",
    interactionId: "interaction-1",
    approveOption: "allow_once",
    denyOption: "deny",
  });
});

test("wording matches the iOS phrases and never claims done for unknown statuses", () => {
  expect(alertDisplay(alert({ status: "done", interactionId: undefined, actions: [] })).body).toBe(
    "Done: Run `pnpm test --filter checkout`?",
  );
  expect(
    alertDisplay(alert({ status: "failed", interactionId: undefined, actions: [] })).body,
  ).toBe("Failed: Run `pnpm test --filter checkout`?");
  expect(alertDisplay(alert({ status: "unresponsive", preview: undefined })).body).toBe(
    "Not responding",
  );
  expect(
    alertDisplay(alert({ status: "background_done", backgroundCount: 1, preview: undefined })).body,
  ).toBe("1 background task done");
  expect(
    alertDisplay(alert({ status: "background_done", backgroundCount: 3, preview: undefined })).body,
  ).toBe("3 background tasks done");
  expect(alertDisplay(alert({ status: "agent_says", message: "The preview is ready." })).body).toBe(
    "Agent says: The preview is ready.",
  );
  expect(alertDisplay(alert({ status: "catch_up", preview: undefined })).body).toBe("New activity");
  expect(alertDisplay(alert({ title: "" })).title).toBe("ace");
});

test("a tap routes to the exact host and thread; unreadable links read as no route", () => {
  expect(tapRoute({ threadId: "thread-1", hostId: "host-a" })).toEqual({
    hostId: "host-a",
    threadId: "thread-1",
  });
  expect(tapRoute({ threadId: "" })).toBeUndefined();
  expect(tapRoute({ threadId: "thread-1", hostId: "" })).toBeUndefined();
});

test("the tap link survives process death and rejects forgeries", () => {
  const encoded = encodeNotificationLink({ hostId: "host-a", threadId: "thread-1" });
  expect(typeof encoded).toBe("string");
  expect(decodeNotificationLink(encoded ?? "")).toEqual({
    hostId: "host-a",
    threadId: "thread-1",
  });
  expect(decodeNotificationLink("not json")).toBeUndefined();
  expect(decodeNotificationLink(JSON.stringify({ hostId: "host-a" }))).toBeUndefined();
  expect(encodeNotificationLink({ hostId: undefined, threadId: "thread-1" })).toBeUndefined();
});

test("each alert action keeps a stable command id so duplicate taps replay", () => {
  expect(notificationActionId("n-1", "approve")).toBe("notification-n-1-approve");
  expect(notificationActionId("n-1", "deny")).toBe("notification-n-1-deny");
});

test("Allow and Deny admit only the exact offered pair", () => {
  expect(notificationActionPayload(alert(), "approve")).toEqual({
    type: "interaction.resolve",
    interactionId: "interaction-1",
    resolution: { kind: "approval", optionId: "allow_once" },
  });
  expect(notificationActionPayload(alert(), "deny")).toEqual({
    type: "interaction.resolve",
    interactionId: "interaction-1",
    resolution: { kind: "approval", optionId: "deny" },
  });
  // No pending interaction, or anything but the daemon's fixed pair, admits nothing.
  expect(notificationActionPayload(alert({ interactionId: undefined }), "approve")).toBeUndefined();
  expect(notificationActionPayload(alert({ actions: [] }), "approve")).toBeUndefined();
  expect(
    notificationActionPayload(
      alert({ actions: [{ action: "approve", optionId: "allow_once" }] }),
      "approve",
    ),
  ).toBeUndefined();
});
