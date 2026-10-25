import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * What the transfer tests share: this Mac linked to other fake machines, with transfer steps
 * that run when the test says so, and the steps through the chooser.
 */

export const workspace = { id: "weather", name: "weather", path: "/Users/dev/weather" };

const settledPhases = new Set(["completed", "failed", "cancelled"]);

/**
 * This Mac with a thread in its weather project, linked to a build server (which takes
 * transfers), a studio that is offline, a laptop that doesn't allow projects and a desk that
 * takes transfers but not agents. Each transfer step runs when the test says so.
 */
export function linkedMachines(options: { links?: boolean } = {}) {
  const steps: (() => void)[] = [];
  const app = harness({
    machines: [
      { hostId: "build", name: "Build server" },
      { hostId: "studio", name: "Studio" },
      { hostId: "laptop", name: "Old laptop" },
      { hostId: "desk", name: "Desk" },
    ],
    projectScheduler: (callback) => void steps.push(callback),
  });
  const machine = (id: string) => {
    const found = app.machines.get(id);
    if (!found) throw new Error(`no ${id}`);
    return found;
  };
  if (options.links !== false) {
    app.daemon.linkTo(machine("build"));
    app.daemon.linkTo(machine("studio"), { status: "offline" });
    app.daemon.linkTo(machine("laptop"), { projects: false });
    // Agents from other machines aren't let in there, but the person's transfers are.
    app.daemon.linkTo(machine("desk"), { status: "refused", access: undefined, projects: true });
  }
  app.daemon.createThread({
    id: "thread-forecast",
    workspaceId: workspace.id,
    title: "Fix the forecast cache",
    provider: "claude",
    hasSentMessage: true,
    details: { workspace },
  });
  const settled = () =>
    [...app.machines.values(), app.daemon].every((daemon) =>
      daemon.transfers.list().every((each) => settledPhases.has(each.phase)),
    );
  /** Run every transfer step queued so far, and those they queue, until all have settled. */
  const finish = async () => {
    while (!settled()) {
      await waitFor(() => expect(steps.length > 0 || settled()).toBe(true));
      while (steps.length) steps.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  /** Run every step queued so far and those they queue, settled or not, until none is left. */
  const drain = async () => {
    for (let quiet = 0; quiet < 3; quiet++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (steps.length) quiet = -1;
      while (steps.length) steps.shift()?.();
    }
  };
  /** Run one step. */
  const step = async () => {
    await waitFor(() => expect(steps.length).toBeGreaterThan(0));
    steps.shift()?.();
  };
  return { app, build: machine("build"), desk: machine("desk"), machine, finish, drain, step };
}

/** "Continue on…" from the open thread's ⋯ menu. */
export async function continueOn() {
  await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Continue on…" }));
  return screen.findByRole("dialog", { name: "Continue on another machine" });
}

/** The options step for continuing the thread on `machine`. */
export async function optionsFor(machine: string) {
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: machine }));
  return dialog;
}

/** The composer strip's sentence. */
export const strip = (words: string) =>
  screen.findByText((_, element) => element?.getAttribute("title") === words);
