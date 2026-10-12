import { facts, fixtureImage, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { componentClient } from "@/test/component-client.tsx";
import { FailedTurn } from "./failed-turn.tsx";

function scenario(): Scenario {
  return {
    thread: {
      id: "retry-file",
      workspaceId: "relay",
      provider: "claude",
      title: "Read the screenshot",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          {
            type: "item.upsert",
            agent: "root",
            item: "ask",
            draft: {
              type: "message",
              role: "user",
              complete: true,
              parts: [{ type: "text", text: "Read the screenshot" }],
              attachments: [
                {
                  name: "screen.png",
                  sha256: fixtureImage.sha256,
                  mimeType: "image/png",
                  bytes: 8,
                },
              ],
            },
          },
          facts.endTurn("root", "failed", { kind: "provider", message: "Turn interrupted" }),
        ],
      },
    ],
  };
}

test("retrying an admitted failed ask includes its original attachment in the new daemon input", async () => {
  const app = await componentClient(scenario());
  app.daemon.seedServices({ attachmentImages: [{ threadId: "retry-file", name: "screen.png" }] });
  const askId = app.daemon.itemId("retry-file", "ask");
  app.render(
    <FailedTurn
      threadId="retry-file"
      askId={askId}
      errorId={undefined}
      error={{ kind: "provider", message: "Turn interrupted" }}
      latest
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => {
    const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("retry-file") });
    const retried =
      view?.kind === "thread"
        ? Object.values(view.items).find(
            (item) => item.type === "message" && item.role === "user" && item.id !== askId,
          )
        : undefined;
    expect(retried).toMatchObject({
      parts: [{ type: "text", text: "Read the screenshot" }],
      attachments: [{ sha256: fixtureImage.sha256 }],
    });
  });
});

test("an unavailable original attachment refuses retry instead of sending only the text", async () => {
  const app = await componentClient(scenario());
  const askId = app.daemon.itemId("retry-file", "ask");
  app.render(
    <FailedTurn
      threadId="retry-file"
      askId={askId}
      errorId={undefined}
      error={{ kind: "provider", message: "Turn interrupted" }}
      latest
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(app.client.pendingSends().getSnapshot()).toMatchObject([
      {
        state: "failed",
        error: "not_found",
        payload: { context: { attachments: [{ sha256: fixtureImage.sha256 }] } },
      },
    ]),
  );
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("retry-file") });
  expect(
    view?.kind === "thread"
      ? Object.values(view.items)
          .filter((item) => item.type === "message" && item.role === "user")
          .map((item) => item.id)
      : [],
  ).toEqual([askId]);
});
