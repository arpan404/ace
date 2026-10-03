import { expect, test } from "vitest";
import { connectBrowser } from "./index.ts";
import { fixture, executablePath } from "./test-support.ts";
import type { BrowserServerMessage } from "@ace/protocol";

test.skipIf(!executablePath)(
  "subscriber IDs retain browser delivery until the final subscriber leaves",
  async () => {
    const f = await fixture();
    const messages: BrowserServerMessage[] = [];
    const connection = connectBrowser(f.service, {
      connectionId: "tabs",
      authorize: () => true,
      send(message) {
        messages.push(message);
        return true;
      },
    });
    const subscribe = (id: string, type: "browser.subscribe" | "browser.unsubscribe") =>
      connection.handle({ type, threadId: "thread", requestId: `${type}-${id}`, subscriberId: id });
    try {
      await subscribe("first", "browser.subscribe");
      await subscribe("second", "browser.subscribe");
      await subscribe("second", "browser.subscribe");
      await subscribe("first", "browser.unsubscribe");
      const before = messages.length;
      await f.service.takeover("thread", "tabs");
      expect(messages.slice(before)).toContainEqual(
        expect.objectContaining({
          type: "browser.state",
          state: expect.objectContaining({ controller: "human" }),
        }),
      );
      await subscribe("second", "browser.unsubscribe");
      const after = messages.length;
      f.service.handback("thread", "tabs");
      expect(messages.slice(after).some((message) => message.type === "browser.state")).toBe(false);
    } finally {
      connection.close();
    }
  },
);
