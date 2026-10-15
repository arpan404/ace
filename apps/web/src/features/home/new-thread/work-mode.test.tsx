import { workbench } from "@ace/fake-daemon";
import { act, cleanup, configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { chooseModel } from "@/test/model-control.ts";

configure({ asyncUtilTimeout: 20000 });

/*
 * Where a new thread runs: Settings' worktree default until the person ticks the box, never a
 * worktree in a folder that can't have one, and never a worktree sent before its base is known.
 */

function app(options: Parameters<typeof harness>[0] = {}) {
  const made = harness(options);
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  return made;
}
const worktreeBox = () => screen.findByRole("checkbox", { name: "Worktree" });
const sendDisabled = () =>
  screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled") === "true";
function started(made: ReturnType<typeof app>, title: string) {
  const view = made.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads"
    ? Object.values(view.threads).find((thread) => thread.title === title)
    : undefined;
}

test("choosing a model doesn't pin the worktree setting: a later Settings change still applies", async () => {
  const storage = memoryKeyValue();
  const first = app({ storage });
  first.daemon.services.settings.seed({ "threads.useWorktree": false });
  await first.open("/new?project=relay");
  expect((await worktreeBox()).getAttribute("aria-checked")).toBe("false");
  await chooseModel("Sonnet 5.5", "Claude Code");
  cleanup();

  first.daemon.services.settings.seed({ "threads.useWorktree": true });
  const again = harness({ storage, daemon: first.daemon });
  await again.open("/new?project=relay");
  await screen.findByRole("button", { name: /^Model: Sonnet 5\.5/ });
  expect((await worktreeBox()).getAttribute("aria-checked")).toBe("true");
}, 60_000);

test("a folder that isn't a Git repository starts locally, its Worktree box disabled", async () => {
  const made = app();
  made.daemon.workspace.git.setRepository("relay", "none");
  await made.open("/new?project=relay");
  const box = await worktreeBox();
  await waitFor(() => expect(box.getAttribute("aria-checked")).toBe("false"));
  expect(box.getAttribute("aria-disabled") ?? box.getAttribute("data-disabled")).not.toBeNull();
  expect(box.getAttribute("aria-description")).toBe("Not a Git repository");
  expect(screen.queryByRole("button", { name: /^Start from:/ })).toBeNull();

  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "Plain folder");
  await waitFor(() => expect(sendDisabled()).toBe(false));
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(started(made, "Plain folder")?.details?.mode).toBe("local"));
}, 60_000);

test("a repository with no commits says so on the disabled Worktree box", async () => {
  const made = app();
  made.daemon.workspace.git.setRepository("relay", "empty");
  await made.open("/new?project=relay");
  const box = await worktreeBox();
  await waitFor(() => expect(box.getAttribute("aria-description")).toBe("No commits yet"));
  expect(box.getAttribute("aria-checked")).toBe("false");
}, 60_000);

test("a worktree start waits for the branches, then sends a remote base as the remote's", async () => {
  const made = app();
  const handle = made.daemon.services.handle.bind(made.daemon.services);
  let release: (() => void) | undefined;
  made.daemon.services.handle = (message, push, device) => {
    if (message.type !== "workspace.request" || message.operation.op !== "branches.list")
      return handle(message, push, device);
    const { requestId } = message;
    release = () =>
      push({
        type: "workspace.result",
        requestId,
        result: made.daemon.workspace.git.branches("relay"),
      });
    return true;
  };
  await made.open("/new?project=relay&base=origin/release/0.9");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Start from the release",
  );
  // The strip stays, so Worktree can still be turned off; sending waits for the branches.
  await screen.findByRole("region", { name: "Where this thread runs" });
  await waitFor(() => expect(release).toBeDefined());
  expect(sendDisabled()).toBe(true);
  await userEvent.keyboard("{Enter}");
  expect(started(made, "Start from the release")).toBeUndefined();

  await act(async () => release?.());
  await waitFor(() => expect(sendDisabled()).toBe(false));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("region", { name: "Creating a worktree" });
  await waitFor(() =>
    expect(started(made, "Start from the release")?.details?.base).toMatchObject({
      ref: "release/0.9",
      remote: "origin",
    }),
  );
}, 60_000);
