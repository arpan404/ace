import { Notification } from "@ace/protocol";
import type { z } from "zod";
import { describe, expect, it } from "vitest";
import { DesktopSettings } from "../../shared/contract.ts";
import { actionCommand } from "./actions.ts";
import { alertFromDaemon, NotificationRouter, type Alert } from "./router.ts";

const defaults = DesktopSettings.parse({}).notifications;

function router(settings: Partial<typeof defaults> = {}, clock = { now: 0, minute: 12 * 60 }) {
  return {
    clock,
    router: new NotificationRouter(
      { ...defaults, ...settings },
      { now: () => clock.now, minuteOfDay: () => clock.minute },
    ),
  };
}

function daemonAlert(overrides: Partial<z.input<typeof Notification>> = {}): Alert {
  return alertFromDaemon(
    Notification.parse({
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
    }),
  );
}

describe("notification routing", () => {
  it("shows an approval as an actionable notification that opens its thread", () => {
    const decision = router().router.route(daemonAlert());
    expect(decision).toMatchObject({
      kind: "show",
      notification: {
        title: "Fix flaky checkout test",
        body: "Run `pnpm test --filter checkout`?",
        actions: [
          { action: "approve", label: "Approve" },
          { action: "deny", label: "Deny" },
        ],
        reply: true,
        link: { kind: "thread", threadId: "thread-1", itemId: "interaction-1" },
      },
    });
  });

  it("files finished and failed threads under their own categories", () => {
    const { router: r } = router({ categories: { finished: false } });
    expect(r.route(daemonAlert({ id: "a", status: "done" }))).toEqual({
      kind: "drop",
      reason: "category",
    });
    expect(
      r.route(daemonAlert({ id: "b", status: "unresponsive", preview: undefined })),
    ).toMatchObject({
      kind: "show",
      notification: { body: "Stopped responding", actions: [] },
    });
  });

  it("shows agent messages under Agent says and respects that category's toggle", () => {
    const notice = daemonAlert({ status: "agent_says", message: "The preview is ready." });
    expect(router().router.route(notice)).toMatchObject({
      kind: "show",
      notification: { body: "The preview is ready.", actions: [], link: { threadId: "thread-1" } },
    });
    expect(router({ categories: { agentSays: false } }).router.route(notice)).toEqual({
      kind: "drop",
      reason: "category",
    });
  });

  it("drops everything when notifications are turned off", () => {
    expect(router({ enabled: false }).router.route(daemonAlert())).toEqual({
      kind: "drop",
      reason: "disabled",
    });
  });

  it("stays silent during quiet hours, including ones that wrap past midnight", () => {
    const night = router(
      { quietHours: { start: 22 * 60, end: 7 * 60 } },
      { now: 0, minute: 23 * 60 },
    );
    expect(night.router.route(daemonAlert({ id: "a" }))).toEqual({ kind: "drop", reason: "quiet" });
    night.clock.minute = 6 * 60 + 59;
    expect(night.router.route(daemonAlert({ id: "b" }))).toEqual({ kind: "drop", reason: "quiet" });
    night.clock.minute = 7 * 60;
    expect(night.router.route(daemonAlert({ id: "c" })).kind).toBe("show");
  });

  it("leaves a focused window to its in-app toasts and notifies only when ace is behind", () => {
    const { router: r } = router();
    r.setFocus({ windowFocused: true, threadId: "thread-1" });
    expect(r.route(daemonAlert({ id: "a" }))).toEqual({ kind: "drop", reason: "focused" });
    expect(r.route(daemonAlert({ id: "b", threadId: "thread-2" }))).toEqual({
      kind: "drop",
      reason: "focused",
    });
    r.setFocus({ windowFocused: false, threadId: "thread-1" });
    expect(r.route(daemonAlert({ id: "c" })).kind).toBe("show");
  });

  it("groups by thread so a newer alert replaces the thread's earlier one", () => {
    const { router: r } = router();
    const first = r.route(daemonAlert({ id: "a" }));
    const second = r.route(daemonAlert({ id: "b", status: "done" }));
    const other = r.route(daemonAlert({ id: "c", threadId: "thread-2" }));
    if (first.kind !== "show" || second.kind !== "show" || other.kind !== "show")
      throw new Error("expected notifications");
    expect(second.notification.tag).toBe(first.notification.tag);
    expect(other.notification.tag).not.toBe(first.notification.tag);
  });

  it("collapses a burst across threads into one summary", () => {
    const { router: r, clock } = router();
    const decisions = ["a", "b", "c", "d", "e"].map((id, index) =>
      r.route(daemonAlert({ id, threadId: `thread-${index}` })),
    );
    const tags = decisions.map((decision) =>
      decision.kind === "show" ? decision.notification.tag : decision.reason,
    );
    expect(tags.slice(0, 3)).toEqual(["thread:thread-0", "thread:thread-1", "thread:thread-2"]);
    expect(tags.slice(3)).toEqual(["summary", "summary"]);
    clock.now += 10_000;
    expect(r.route(daemonAlert({ id: "f", threadId: "thread-9" }))).toMatchObject({
      notification: { tag: "thread:thread-9" },
    });
  });

  it("ignores a redelivered alert", () => {
    const { router: r } = router();
    expect(r.route(daemonAlert()).kind).toBe("show");
    expect(r.route(daemonAlert())).toEqual({ kind: "drop", reason: "duplicate" });
  });
});

describe("notification actions", () => {
  it("approves with the option the daemon offered, under a stable command id", () => {
    const alert = daemonAlert();
    const first = actionCommand(alert, "approve");
    expect(first).toEqual({
      id: "notification-n-1-approve",
      payload: {
        type: "interaction.resolve",
        interactionId: "interaction-1",
        resolution: { kind: "approval", optionId: "allow_once" },
      },
    });
    expect(actionCommand(alert, "approve")?.id).toBe(first?.id);
  });

  it("declines an approval with the inline reply as the reason", () => {
    expect(actionCommand(daemonAlert(), "reply", "  use the staging db  ")?.payload).toEqual({
      type: "interaction.resolve",
      interactionId: "interaction-1",
      resolution: { kind: "approval", optionId: "deny", message: "use the staging db" },
    });
  });

  it("queues a reply to a thread without a pending approval as a message", () => {
    const alert = daemonAlert({ status: "done", interactionId: undefined, actions: [] });
    expect(actionCommand(alert, "reply", "ship it")?.payload).toEqual({
      type: "thread.send",
      threadId: "thread-1",
      input: [{ type: "text", text: "ship it" }],
      delivery: "queue",
    });
  });

  it("sends nothing for an empty reply or an action the daemon did not offer", () => {
    expect(actionCommand(daemonAlert(), "reply", "   ")).toBeUndefined();
    expect(actionCommand(daemonAlert({ actions: [] }), "approve")).toBeUndefined();
  });
});
