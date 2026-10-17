import { expect, it } from "vitest";
import type { BrowserServerMessage } from "@ace/protocol";
import { connectBrowser } from "./index.ts";
import { backendFixture } from "./backend-test-support.ts";
import { keepAgentsOut } from "./collaboration-test-support.ts";

it.each([false, true])(
  "any of the person's connections closes the browser through the bridge (private: %s)",
  async (privately) => {
    const f = await backendFixture();
    await f.open();
    if (privately) keepAgentsOut(f.service);
    const messages: BrowserServerMessage[] = [];
    const other = connectBrowser(f.service, {
      connectionId: "other",
      authorize: () => true,
      send: (message) => {
        messages.push(message);
        return true;
      },
    });
    await other.handle({ type: "browser.close", threadId: "thread", requestId: "other-close" });
    expect(messages.at(-1)).toMatchObject({
      type: "browser.result",
      ok: true,
      requestId: "other-close",
    });
    expect(() => f.service.state("thread")).toThrow();
    other.close();
  },
);
