import { facts, type Step } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { preloadStepLabels } from "./items/step-labels.ts";
import { DeferredSearchBar, DeferredTurnRail } from "./deferred.ts";

type Fact = Extract<Step, { kind: "facts" }>["facts"][number];

beforeEach(async () => {
  localStorage.clear();
  await preloadStepLabels();
  await DeferredTurnRail.preload();
  await DeferredSearchBar.preload();
});

async function open(extra: Fact[], after: Fact[] = []) {
  const app = harness();
  app.daemon.createThread({
    id: "failing",
    workspaceId: "ace",
    title: "Greeting",
    provider: "cursor",
    execution: { provider: "cursor", model: "composer-2.5", options: {} },
  });
  app.daemon.apply("failing", [
    facts.rootAgent("cursor"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "yo"),
    ...extra,
    facts.endTurn("root", "failed"),
    ...after,
  ]);
  await app.open("/t/failing");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("yo");
  return feed;
}

const runFailed: Fact = {
  type: "item.upsert",
  agent: "root",
  item: "run-failed",
  draft: {
    type: "notice",
    level: "error",
    diagnostic: true,
    code: "cursor.run-failed",
    text: "Increase limits for faster responses",
    complete: true,
  },
};

test("a failed turn is one error row even when a model switch fails after it", async () => {
  const switchFailed: Fact = {
    type: "item.upsert",
    agent: "root",
    item: "switch-failed",
    draft: {
      type: "notice",
      level: "error",
      code: "delivery_failed",
      title: "Couldn't switch the model",
      text: "Account migration was refused",
      detail: "Account migration was refused",
      complete: true,
      raw: [
        {
          type: "delivery_error",
          data: { operation: "thread.switch", message: "Account migration was refused" },
        },
      ],
    },
  };
  const feed = await open([runFailed], [switchFailed]);
  const turn = await within(feed).findByRole("group", { name: /^Turn failed/ });
  expect(turn.textContent).toContain("Composer 2.5 · Cursor couldn't finish the request");
  expect(turn.textContent).not.toContain("migration");
  // The turn's own failure is not drawn a second time beside its ending.
  expect(within(feed).getAllByText(/Cursor couldn't finish the request/)).toHaveLength(1);
  // The switch is its own failure, said once.
  const failedSwitch = within(feed).getByRole("group", { name: /^Couldn't switch the model/ });
  expect(failedSwitch.textContent).toContain("Account migration was refused");
});

test("Details on a failed turn never repeats the summary", async () => {
  const feed = await open([
    {
      type: "item.upsert",
      agent: "root",
      item: "plain",
      draft: {
        type: "notice",
        level: "error",
        text: "The workspace folder is missing",
        detail: "The workspace folder is missing",
        complete: true,
      },
    },
  ]);
  const turn = await within(feed).findByRole("group", { name: /^Turn failed/ });
  expect(turn.textContent).toContain("Composer 2.5 · The workspace folder is missing");
  expect(within(turn).queryByRole("button", { name: "Details" })).toBeNull();
});

test("Details on a failed turn keeps the provider's own words when the summary is reviewed copy", async () => {
  const feed = await open([runFailed]);
  const turn = await within(feed).findByRole("group", { name: /^Turn failed/ });
  await userEvent.click(within(turn).getByRole("button", { name: "Details" }));
  expect(within(turn).getByText("Increase limits for faster responses")).toBeTruthy();
});
