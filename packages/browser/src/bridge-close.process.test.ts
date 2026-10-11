import { expect, it } from "vitest";
import type { BrowserServerMessage } from "@ace/protocol";
import { connectBrowser } from "./index.ts";
import { backendFixture } from "./backend-test-support.ts";

it.each(["shared", "private"] as const)(
  "only the controller can close its %s browser through the authenticated bridge",
  async (mode) => {
    const f = await backendFixture();
    await f.open();
    f.service.takeover("thread", "owner", mode);
    const messages: BrowserServerMessage[] = [];
    const connect = (connectionId: string) =>
      connectBrowser(f.service, {
        connectionId,
        authorize: () => true,
        send: (message) => {
          messages.push(message);
          return true;
        },
      });
    const other = connect("other");
    await other.handle({ type: "browser.close", threadId: "thread", requestId: "other-close" });
    expect(messages.at(-1)).toMatchObject({
      type: "browser.result",
      ok: false,
      error: "Browser controller mismatch",
    });
    expect(f.service.state("thread")).toMatchObject({
      closed: false,
      owner: "owner",
      takeoverMode: mode,
    });
    const owner = connect("owner");
    await owner.handle({ type: "browser.close", threadId: "thread", requestId: "owner-close" });
    expect(messages.at(-1)).toMatchObject({
      type: "browser.result",
      ok: true,
      requestId: "owner-close",
    });
    expect(() => f.service.state("thread")).toThrow();
    other.close();
    owner.close();
    await f.open();
    await f.service.closeThread("thread");
    expect(() => f.service.state("thread")).toThrow();
  },
);
