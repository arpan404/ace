import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** Spade with a model, and a bot whose chat holds one reply that took `calls`. */
const withReply =
  (calls: { id: string; name: string; arguments: unknown; effect?: string }[]) =>
  (api: FakeSpadeApi) => {
    withEndpoint(api);
    api.addAgent({
      id: "main",
      kind: "main",
      name: "Spade",
      avatar: { kind: "spade" },
      model: "openrouter/anthropic/sonnet",
    });
    const travel = api.addAgent({
      id: "travel",
      name: "Travel",
      model: "openrouter/anthropic/sonnet",
    });
    const c = travel.conversation;
    api.store(c, { type: "user_message", text: "Draft the plan and send it" });
    api.store(c, { type: "reply_started", reply: "r1" });
    api.store(c, {
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
    });
    for (const call of calls) {
      api.store(c, {
        type: "tool_started",
        reply: "r1",
        call_id: call.id,
        name: call.name,
        ...(call.effect ? { effect: call.effect } : {}),
      });
      api.store(c, {
        type: "tool_finished",
        reply: "r1",
        call_id: call.id,
        name: call.name,
        content: "ok",
        is_error: false,
      });
    }
    api.store(c, { type: "step_finished", reply: "r1", text: "Done." });
    api.store(c, { type: "reply_finished", reply: "r1", text: "Done.", cost_micros: 0 });
  };

test("undoing a turn lists the files it changed first, then puts them back", async () => {
  const { spade } = await spadeApp(
    "/spade/travel",
    withReply([
      { id: "c1", name: "workspace_write", arguments: { path: "plan.md", content: "x" } },
      {
        id: "c2",
        name: "send_email",
        arguments: { subject: "The plan" },
        effect: "send_as_person",
      },
    ]),
  );
  const at = Date.now() - 60_000;
  spade.security.checkpoints.set("travel", [{ id: "cp_before", at, reason: "auto" }]);
  // The first file-changing step's `tool_started` is the bot conversation's fourth event.
  spade.security.undoPreviews.set(
    "travel",
    new Map([
      [
        4,
        {
          checkpoint: { id: "cp_before", at },
          changes: { changed: ["plan.md"], added: ["notes/draft.md"], deleted: [], more: 0 },
        },
      ],
    ]),
  );
  await screen.findByRole("feed", { name: "Conversation with Travel" });
  await userEvent.click(await screen.findByRole("button", { name: "Undo these changes" }));
  const dialog = within(await screen.findByRole("dialog", { name: /^Undo this reply/ }));
  // What goes back, and what can't, before anything changes.
  await dialog.findByText("plan.md");
  expect(dialog.getByText("notes/draft.md")).toBeTruthy();
  expect(dialog.getByText("Sent an email")).toBeTruthy();
  expect(spade.security.restored.get("travel")).toBeUndefined();
  await userEvent.click(dialog.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(spade.security.restored.get("travel")).toEqual(["cp_before"]));
  await dialog.findByText(/Undone\./);
});

test("a send folds into the summary without an undo action", async () => {
  await spadeApp(
    "/spade/travel",
    withReply([
      { id: "c1", name: "send_email", arguments: { subject: "Hi" }, effect: "send_as_person" },
    ]),
  );
  await screen.findByRole("feed", { name: "Conversation with Travel" });
  await userEvent.click(await screen.findByText("Sent an email"));
  const detail = within(await screen.findByRole("list", { name: "Steps" }));
  expect(detail.getByText("Sent an email")).toBeTruthy();
  expect(detail.queryByText(/Can't be undone/)).toBeNull();
  // Nothing in this turn changed its files, so nothing offers to undo.
  expect(screen.queryByRole("button", { name: "Undo these changes" })).toBeNull();
});
