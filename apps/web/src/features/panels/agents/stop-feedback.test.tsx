import { coldStartReplay } from "@ace/fake-daemon";
import { Command } from "@ace/protocol";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as z from "zod/mini";
import { memoryStorage } from "@/boot/client.ts";
import { harness } from "@/test/harness.tsx";
import { openWorkPanel } from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());
const cases = [
  {
    target: "agent",
    command: "thread.interrupt",
    row: "resume-sweep: Working",
    button: "Stop resume-sweep",
  },
  {
    target: "command",
    command: "background_task.stop",
    row: "bun run relay:soak --clients 2: running",
    button: "Stop",
  },
] as const;
async function open(app: ReturnType<typeof harness>, target: (typeof cases)[number]) {
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  const work = await openWorkPanel();
  const item = await within(work).findByRole(target.target === "agent" ? "treeitem" : "listitem", {
    name: target.row,
  });
  const row = target.target === "agent" ? item.parentElement : item;
  if (!row) throw new Error("Missing Stop row");
  return { work, row, stop: within(row).getByRole("button", { name: target.button }) };
}
async function expectStopped(work: HTMLElement, target: (typeof cases)[number]) {
  if (target.target === "agent")
    await within(work).findByRole("treeitem", { name: "resume-sweep: Interrupted" });
  else
    await waitFor(() =>
      expect(within(work).queryByRole("listitem", { name: target.row })).toBeNull(),
    );
}

test.each(cases)(
  "a refused $target Stop shows friendly feedback and can be retried",
  async (target) => {
    const app = harness();
    const { work, row, stop } = await open(app, target);
    app.daemon.refuseCommands("private_interrupt_detail", target.command);
    await userEvent.click(stop);
    expect((await within(row).findByRole("alert")).textContent).toBe(
      `Couldn't stop this ${target.target}. Try again.`,
    );
    expect(row.textContent).not.toContain("private_interrupt_detail");
    expect(stop).toHaveProperty("disabled", false);
    app.daemon.restoreRequests();
    await userEvent.click(stop);
    await expectStopped(work, target);
  },
);

test.each(cases)(
  "a $target Stop persistence failure restores the control and supports retry",
  async (target) => {
    const storage = memoryStorage();
    let fail = false;
    const app = harness({
      outbox: {
        load: storage.load,
        save: async (value) => {
          if (fail) throw new Error("private_disk_detail");
          await storage.save(value);
        },
      },
    });
    const { work, row, stop } = await open(app, target);
    fail = true;
    await userEvent.click(stop);
    expect((await within(row).findByRole("alert")).textContent).toBe(
      `Couldn't stop this ${target.target}. Try again.`,
    );
    expect(row.textContent).not.toContain("private_disk_detail");
    expect(stop).toHaveProperty("disabled", false);
    fail = false;
    await userEvent.click(stop);
    await expectStopped(work, target);
  },
);

test.each(cases)(
  "repeated $target Stop clicks during persistence store one command",
  async (target) => {
    const storage = memoryStorage();
    const saving = Promise.withResolvers<void>();
    const commands = new Set<string>();
    let hold = false;
    const app = harness({
      outbox: {
        load: storage.load,
        save: async (value) => {
          for (const { command } of z
            .array(z.object({ command: Command }))
            .parse(JSON.parse(value)))
            if (command.payload.type === target.command) commands.add(command.id);
          if (hold) await saving.promise;
          await storage.save(value);
        },
      },
    });
    const { work, stop } = await open(app, target);
    hold = true;
    try {
      act(() => {
        fireEvent.click(stop);
        fireEvent.click(stop);
      });
      expect(stop).toHaveProperty("disabled", true);
      expect(stop.textContent).toContain("Stopping…");
      await userEvent.click(stop);
      await waitFor(() => expect(commands.size).toBe(1));
    } finally {
      hold = false;
      await act(async () => saving.resolve());
    }
    await expectStopped(work, target);
    expect(commands.size).toBe(1);
  },
);
