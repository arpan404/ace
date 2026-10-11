import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { setup, deferred } from "./testing/v2-session.ts";

it("covered queued permissions retain every opaque native receipt without reopening approvals", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  let failed = false;
  const h = await setup({
    runtime: {
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === "/api/session/opaque-child" && !failed) {
          failed = true;
          entered.resolve();
          await release.promise;
          throw new Error("temporary ancestry lookup failure");
        }
        return fetch(input, init);
      },
    },
  });
  try {
    await h.control("/test/state", {
      sessions: [
        {
          id: "opaque-child",
          parentID: h.session.nativeSessionId,
          projectID: "project-one",
          location: { directory: "/one" },
          time: { updated: 100, idle: 100 },
        },
      ],
      permissions: [],
    });
    await h.control("/test/events", [
      {
        type: "permission.asked",
        directory: "/one",
        data: { sessionID: "opaque-child", id: "first-ask", action: "edit", resources: ["first"] },
      },
    ]);
    await entered.promise;
    await h.control("/test/events", [
      {
        type: "permission.asked",
        directory: "/one",
        data: {
          sessionID: "opaque-child",
          id: "second-ask",
          action: "edit",
          resources: ["second"],
          vendor: { opaque: "second-opaque", future: { nested: "retained" } },
        },
        extra: { vendorEnvelope: "must also survive" },
      },
    ]);
    await h.publish("future.queue-barrier");
    const recovered = h.recovered();
    release.resolve();
    await recovered;
    expect(h.projection.view.thread.status.state).toBe("done");
    expect(
      Object.values(h.projection.view.interactions).some((value) => value.state === "pending"),
    ).toBe(false);
    const translator = h.adapter.createTranslator({
      threadId: ThreadId.parse("opaque-receipts"),
      rootKey: "root",
    });
    const diagnostics = h.frames.flatMap((frame) => {
      translator.translate(frame, frame.t);
      return translator.takeDiagnostics?.() ?? [];
    });
    const receipts = JSON.stringify(diagnostics);
    expect(receipts).toContain('"id":"second-ask"');
    expect(receipts).toContain('"resources":["second"]');
    expect(receipts).toContain(
      '"vendor":{"opaque":"second-opaque","future":{"nested":"retained"}}',
    );
    expect(receipts).toContain('"vendorEnvelope":"must also survive"');
  } finally {
    release.resolve();
  }
});
