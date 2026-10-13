import { workbench } from "@ace/fake-daemon";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { memoryStorage } from "@/boot/client.ts";
import { harness } from "@/test/harness.tsx";

afterEach(cleanup);

test("overlapping new-thread submissions while the first is still saving create one thread", async () => {
  const gate = Promise.withResolvers<void>();
  const outbox = memoryStorage();
  let holding = false;
  let saves = 0;
  const app = harness({
    outbox: {
      load: outbox.load,
      async save(value) {
        if (holding) {
          saves++;
          await gate.promise;
        }
        await outbox.save(value);
      },
    },
  });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const before = app.daemon.snapshot({ kind: "threads" });
  if (before?.kind !== "threads") throw new Error("Expected sidebar");
  const initial = new Set(Object.keys(before.threads));
  await app.open("/new?project=relay");
  const prompt = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(prompt, "Start only once");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  holding = true;
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(saves).toBeGreaterThan(0));
  await userEvent.type(prompt, "Start only once{Enter}");
  holding = false;
  gate.resolve();
  await screen.findByRole("heading", { level: 1, name: "Start only once" });
  await waitFor(() => {
    const after = app.daemon.snapshot({ kind: "threads" });
    if (after?.kind !== "threads") throw new Error("Expected sidebar after submission");
    expect(Object.values(after.threads).filter((thread) => !initial.has(thread.id))).toHaveLength(
      1,
    );
  });
});
