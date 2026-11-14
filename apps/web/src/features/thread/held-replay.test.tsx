import { flakyCheckout } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { slowReplay } from "@/test/held-replay.ts";
import { harness } from "@/test/harness.tsx";

/*
 * The window after a reconnect's welcome and before its replay lands: connected, but every copy
 * still says what was true before the drop. Nothing may claim it as live or act on it.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

/** A harness whose daemon can hold the replay. */
function slowDaemon() {
  const app = harness();
  return { app, replay: slowReplay(app.daemon) };
}

const approval = "Run rm -rf node_modules/.cache/vitest?";

test("connected again but not caught up: the approval waits, the palette offers no approve, and both work once the replay lands", async () => {
  const { app, replay } = slowDaemon();
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/t/thread-checkout");
  const stack = await screen.findByRole("region", { name: "Waiting for you" });
  await within(stack).findByRole("article", { name: approval });

  await replay.hold(app.client);
  expect(await screen.findByText("Syncing… Answer once this request is confirmed.")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Allow once" }).disabled).toBe(true);
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search commands" }), "approve");
  expect(screen.queryByRole("option", { name: /^Allow once/ })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(app.daemon.isPending("thread-checkout", "approve-clear-cache")).toBe(true);

  replay.release(app.client);
  await waitFor(() =>
    expect(screen.queryByText("Syncing… Answer once this request is confirmed.")).toBeNull(),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(app.daemon.resolution("thread-checkout", "approve-clear-cache")).toEqual({
      kind: "approval",
      optionId: "allow",
    }),
  );
});
