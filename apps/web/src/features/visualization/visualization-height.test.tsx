import { facts, type Scenario } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const page = {
  threadId: "thread-chart",
  title: "Latency by shard",
  html: "<!doctype html><html><head><title>Latency by shard</title></head><body><p>Chart</p></body></html>",
  sha256: "a".repeat(64),
};

/** An agent published one page and answered under it. */
function published(): Scenario {
  return {
    thread: { id: page.threadId, workspaceId: "acme", title: "Chart latency", provider: "claude" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          facts.message("root", "ask", "user", "Chart latency by shard."),
          {
            type: "item.upsert",
            agent: "root",
            item: "page",
            draft: {
              type: "html",
              complete: true,
              visualization: {
                title: page.title,
                mode: "static",
                document: {
                  sha256: page.sha256,
                  bytes: page.html.length,
                  name: "visualization.html",
                  mimeType: "text/plain",
                },
              },
            },
          },
          facts.message("root", "done", "assistant", "Shard 3 is the slow one."),
          facts.endTurn("root"),
        ],
      },
    ],
  };
}

// jsdom's frames have no sandbox, which the app requires before it runs a page at all.
beforeEach(() => {
  Object.defineProperty(HTMLIFrameElement.prototype, "sandbox", {
    configurable: true,
    get(this: HTMLIFrameElement) {
      return this.getAttribute("sandbox") ?? "";
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLIFrameElement.prototype, "sandbox");
});

/** The page in the frame reports its content height, as its bridge script does. */
function report(frame: HTMLIFrameElement, height: number) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "ace.html.height", height },
        source: frame.contentWindow,
        origin: "null",
      }),
    );
  });
}

test("a visualization that leaves the transcript comes back at the height it measured", async () => {
  const history = createMemoryHistory({ initialEntries: [`/t/${page.threadId}`] });
  const app = harness({ history });
  app.play(published()).runUntilBlocked();
  app.daemon.seedServices({
    attachmentTexts: [
      { threadId: page.threadId, sha256: page.sha256, text: page.html, name: "visualization.html" },
    ],
  });
  await app.open(`/t/${page.threadId}`);
  const frame = await screen.findByTitle<HTMLIFrameElement>(page.title);
  report(frame, 520);
  await waitFor(() => expect(frame.style.height).toBe("520px"));

  // Away and back: the transcript, and the page in it, mount again.
  act(() => history.push("/"));
  await waitFor(() => expect(screen.queryByTitle(page.title)).toBeNull());
  act(() => history.push(`/t/${page.threadId}`));
  const again = await screen.findByTitle<HTMLIFrameElement>(page.title);
  expect(again).not.toBe(frame);
  // Before its page has said anything, it already stands at its own height.
  expect(again.style.height).toBe("520px");
});
