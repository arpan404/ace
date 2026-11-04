import { replayCursor } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * A thread's access chip changes that thread only. The default for new threads is set in
 * Settings › Agents and nowhere else.
 */

beforeEach(() => localStorage.clear());

const threadId = "thread-replay-cursor";

async function pressedDefault() {
  const group = await screen.findByRole("group", { name: "Access for new threads" });
  return within(group)
    .getAllByRole("button")
    .find((button) => button.getAttribute("aria-pressed") === "true")?.textContent;
}

test("changing a thread's access leaves the default for new threads as it was", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open(`/t/${threadId}`);
  await userEvent.click(await screen.findByRole("button", { name: "Access: Auto review" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Full access" }));
  await waitFor(() => {
    const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) });
    expect(view?.kind === "thread" ? view.thread.permission?.override : undefined).toBe(
      "full-access",
    );
  });

  cleanup();
  await app.open("/settings/agents");
  await waitFor(async () => expect(await pressedDefault()).toBe("Auto review"));
  expect(app.daemon.services.settings.get("access.defaultMode")).toBe("auto-review");

  const group = await screen.findByRole("group", { name: "Access for new threads" });
  await userEvent.click(within(group).getByRole("button", { name: "Ask" }));
  await waitFor(() => expect(app.daemon.services.settings.get("access.defaultMode")).toBe("ask"));
  expect(await pressedDefault()).toBe("Ask");
});
