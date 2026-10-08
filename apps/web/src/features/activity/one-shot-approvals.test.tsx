import type { Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const title = "Allow git push to main?";

/** A thread under `mode` whose agent asks to push, offering once, this-thread and deny. */
function pushRequest(mode: "auto" | "bypassPermissions"): Scenario {
  return {
    thread: {
      id: `thread-push-${mode}`,
      workspaceId: "relay",
      title: "Push",
      provider: "claude",
      permissionMode: mode,
    },
    steps: [
      {
        kind: "facts",
        facts: [
          {
            type: "agent.seen",
            agent: "root",
            origin: "root",
            fidelity: "full",
            native: { provider: "claude", nativeId: "root" },
            cwd: "/Users/dev/relay",
          },
          { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
          {
            type: "item.upsert",
            agent: "root",
            item: "push",
            draft: {
              type: "tool_call",
              complete: false,
              call: {
                kind: "shell",
                title: "git push",
                status: "awaiting_approval",
                raw: [],
                detail: { kind: "shell", command: "/bin/zsh -lc 'git push origin main'" },
              },
            },
          },
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "approve-push",
            blocking: true,
            item: "push",
            request: {
              kind: "approval",
              title,
              options: [
                {
                  id: "thread",
                  label: "Always allow git push in this thread",
                  kind: "allow_session",
                },
                { id: "once", label: "Allow once", kind: "allow_once" },
                { id: "deny", label: "Deny", kind: "deny" },
              ],
            },
          },
        ],
      },
      { kind: "await", interaction: "approve-push" },
    ],
  };
}

test("native auto mode preserves and returns the provider session grant", async () => {
  const app = harness();
  const scenario = pushRequest("auto");
  app.play(scenario).runUntilBlocked();
  await app.open("/activity");
  const card = await screen.findByRole("article", { name: title });
  expect(within(card).getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
  expect(within(card).getByText(/Always allow git push/)).toBeTruthy();
  expect(within(card).queryByText(/Always-allow isn't available/)).toBeNull();
  // The command reads as typed, not as the login shell that ran it.
  expect(within(card).getByText("git push origin main")).toBeTruthy();

  await userEvent.click(within(card).getByRole("checkbox"));
  await userEvent.click(within(card).getByRole("button", { name: /^Approve/ }));
  await waitFor(() =>
    expect(app.daemon.resolution(scenario.thread.id, "approve-push")).toEqual({
      kind: "approval",
      optionId: "thread",
    }),
  );
});

test("native bypass mode preserves the provider session grant", async () => {
  const app = harness();
  app.play(pushRequest("bypassPermissions")).runUntilBlocked();
  await app.open("/activity");
  const card = await screen.findByRole("article", { name: title });
  expect(within(card).getByText("Always allow git push in this thread")).toBeTruthy();
  expect(within(card).queryByText(/Always-allow isn't available/)).toBeNull();
});
