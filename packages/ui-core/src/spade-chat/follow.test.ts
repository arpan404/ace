import { ClientError } from "@ace/client";
import type { SpadeLiveSink } from "@ace/client/spade-live";
import { expect, test } from "vitest";
import { SpadeConversationFollow, SpadeRequestError, type SpadeFollowLink } from "./index.ts";

/** A Spade whose history is empty and whose one live stream the test plays. */
function following() {
  let live: SpadeLiveSink | undefined;
  const link: SpadeFollowLink = {
    canOpen: () => true,
    onOpenable: () => () => {},
    open: (_path, sink) => {
      live = sink;
      return () => {};
    },
    read: async () => "[]",
  };
  const follow = new SpadeConversationFollow(link, "c1", {
    frame: (callback) => callback(),
    later: () => () => {},
  });
  follow.start();
  follow.setReady(true);
  let seq = 0;
  const frame = (event: string, data: unknown) => live?.frame(event, JSON.stringify(data));
  return {
    follow,
    opened: () => live !== undefined,
    caughtUp: () => frame("caught_up", { seq }),
    stored: (text: string) =>
      frame("stored", { seq: ++seq, at: 0, event: { type: "user_message", text } }),
    users: () =>
      follow
        .get()
        .view.entries.flatMap((entry) =>
          entry.kind === "user" ? [`${entry.text}${entry.pending ? " (sending)" : ""}`] : [],
        ),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test.each([
  [
    "the daemon heard nothing back",
    new SpadeRequestError("No answer came back.", undefined, "failed"),
  ],
  ["the connection dropped", new ClientError("offline", "offline")],
  ["the request timed out", new ClientError("timeout", "timeout")],
])("a message whose answer was lost (%s) stays once Spade's copy arrives", async (_why, lost) => {
  const spade = following();
  await settle();
  expect(spade.opened()).toBe(true);
  spade.caughtUp();
  const sent = spade.follow.send({ key: "local-1", text: "Remember milk" }, async () => {
    spade.stored("Remember milk");
    throw lost;
  });
  await expect(sent).resolves.toBeUndefined();
  expect(spade.users()).toEqual(["Remember milk"]);
});

test("a message Spade refused leaves the conversation, and the refusal comes back", async () => {
  const spade = following();
  await settle();
  spade.caughtUp();
  const sent = spade.follow.send({ key: "local-1", text: "Too long" }, async () => {
    expect(spade.users()).toEqual(["Too long (sending)"]);
    throw new SpadeRequestError("That message is too long.", 400);
  });
  await expect(sent).rejects.toThrow("That message is too long.");
  expect(spade.users()).toEqual([]);
});
