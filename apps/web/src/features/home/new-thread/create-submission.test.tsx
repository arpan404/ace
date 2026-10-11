import { Client } from "@ace/client";
import { fakeTransport, workbench } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { memoryStorage } from "@/boot/client.ts";
import { harness } from "@/test/harness.tsx";

const IdentityReply = z.object({ type: z.literal("host.identity.result") });
afterEach(cleanup);

test("overlapping new-thread submissions waiting for identity create one thread", async () => {
  const held: (() => void)[] = [];
  let delaying = true;
  const app = harness({
    client(daemon) {
      const transport = fakeTransport(daemon);
      let nextId = 0;
      return new Client({
        deviceId: DeviceId.parse("test-device"),
        credential: async () => daemon.token,
        storage: memoryStorage(),
        transport: () => ({
          ...transport,
          open(events) {
            transport.open({
              ...events,
              message(raw) {
                if (delaying && IdentityReply.safeParse(JSON.parse(raw)).success)
                  held.push(() => events.message(raw));
                else events.message(raw);
              },
            });
          },
        }),
        id: () => `identity-test-${++nextId}`,
        random: () => 0.5,
        scheduler: {
          set(ms, run) {
            const timer = setTimeout(run, ms);
            return () => clearTimeout(timer);
          },
        },
      });
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
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe("true"),
  );
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(held.length).toBeGreaterThan(1));
  await userEvent.type(prompt, "Start only once{Enter}");
  delaying = false;
  for (const release of held.splice(0)) release();
  await screen.findByRole("heading", { level: 1, name: "Start only once" });
  const after = app.daemon.snapshot({ kind: "threads" });
  if (after?.kind !== "threads") throw new Error("Expected sidebar after submission");
  expect(Object.values(after.threads).filter((thread) => !initial.has(thread.id))).toHaveLength(1);
});
