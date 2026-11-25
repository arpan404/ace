import { describe, expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { alertFromSpadeNotice } from "./notice-alert.ts";

const host = ThreadId.parse("spade-host");
const notice = (fields: Record<string, unknown>) =>
  JSON.stringify({
    id: "event:c1:7",
    kind: "event",
    agent: "a1",
    name: "Booker",
    conversation: "c1",
    seq: 7,
    text: "Asks: Window or aisle?",
    category: "needs_you",
    reach: "now",
    ...fields,
  });

describe("Spade notices as ace's alerts", () => {
  it("a bot's question alerts with its words and opens its request", () => {
    expect(alertFromSpadeNotice(notice({ request: "q2" }), host)).toEqual({
      id: "spade:event:c1:7",
      threadId: host,
      title: "Booker",
      status: "spade",
      message: "Asks: Window or aisle?",
      backgroundCount: 0,
      actions: [],
      spade: { agent: "a1", conversation: "c1", request: "q2", category: "needs_you" },
    });
  });

  it("only what Spade sends to reach the person now alerts", () => {
    expect(alertFromSpadeNotice(notice({ reach: "held", why: "dnd" }), host)).toBeUndefined();
    expect(alertFromSpadeNotice(notice({ reach: "none", why: "record" }), host)).toBeUndefined();
    // A notice from before reach was decided says nothing about it: nothing alerts.
    expect(alertFromSpadeNotice(notice({ reach: undefined }), host)).toBeUndefined();
  });

  it("each kind reads as what it is, and one that doesn't read alerts no one", () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ category: "brief", text: "2 finished" }, "Morning brief", "2 finished"],
      [
        { category: "summary", text: "While you were away: 3 updates" },
        "Spade",
        "While you were away: 3 updates",
      ],
      [{ category: "digest", text: "Booker: from 9:00" }, "Booker", "Digest: Booker: from 9:00"],
      [{ category: "something_new", text: "A new kind" }, "Booker", "A new kind"],
    ];
    for (const [fields, title, message] of cases) {
      const alert = alertFromSpadeNotice(notice(fields), host);
      expect([alert?.title, alert?.message]).toEqual([title, message]);
    }
    expect(alertFromSpadeNotice("not json", host)).toBeUndefined();
    expect(alertFromSpadeNotice(notice({ agent: "" }), host)).toBeUndefined();
    expect(alertFromSpadeNotice(notice({ text: "x".repeat(900) }), host)?.message).toHaveLength(
      300,
    );
  });

  it("deep-links a grouped alert to its single owning conversation or to the root with item targets", () => {
    const oneWorker = alertFromSpadeNotice(
      notice({
        id: "batch:a-scout:1:2:2",
        kind: "needs_you_batch",
        agent: "a-root",
        name: "Scout",
        conversation: "c-root",
        text: "2 approvals waiting.",
        items: [
          { agent: "a-scout", conversation: "c-scout", request: "c1" },
          { agent: "a-scout", conversation: "c-scout", request: "c2" },
        ],
      }),
      host,
    );
    expect(oneWorker?.spade).toEqual({
      agent: "a-scout",
      conversation: "c-scout",
      category: "needs_you",
      items: [
        { agent: "a-scout", conversation: "c-scout", request: "c1" },
        { agent: "a-scout", conversation: "c-scout", request: "c2" },
      ],
    });

    const multiBot = alertFromSpadeNotice(
      notice({
        id: "batch:a-root:1:2:2",
        kind: "needs_you_batch",
        agent: "a-root",
        name: "Builder",
        conversation: "c-root",
        text: "2 questions waiting (Scout and Runner).",
        items: [
          { agent: "a-scout", conversation: "c-scout", request: "q1" },
          { agent: "a-runner", conversation: "c-runner", request: "q2" },
        ],
      }),
      host,
    );
    expect(multiBot?.spade).toEqual({
      agent: "a-root",
      conversation: "c-root",
      category: "needs_you",
      items: [
        { agent: "a-scout", conversation: "c-scout", request: "q1" },
        { agent: "a-runner", conversation: "c-runner", request: "q2" },
      ],
    });
  });
  it("keeps the first 50 item targets and honors the root when a later item has another owner", () => {
    const items = Array.from({ length: 51 }, (_, index) => ({
      agent: index < 50 ? "a-worker" : "a-other",
      conversation: index < 50 ? "c-worker" : "c-other",
      request: `q${index}`,
    }));
    const alert = alertFromSpadeNotice(
      notice({ kind: "needs_you_batch", text: "51 questions waiting.", items }),
      host,
    );
    expect(alert?.message).toBe("51 questions waiting.");
    expect(alert?.spade).toEqual({
      agent: "a1",
      conversation: "c1",
      category: "needs_you",
      items: items.slice(0, 50),
    });
  });

});
