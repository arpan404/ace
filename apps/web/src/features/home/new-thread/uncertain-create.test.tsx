import { ClientHost, RemoteClient } from "@ace/client-worker";
import { WorkerMessage } from "@ace/client-worker/wire";
import { FakeDaemon, workbench } from "@ace/fake-daemon";
import { CommandPayload } from "@ace/protocol";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness, fakeClient, memoryKeyValue } from "@/test/harness.tsx";
import { memoryStorage } from "@/boot/client.ts";
import { loadDismissed, resetDismissed } from "@/lib/dismissed-sends.ts";

const timers = {
  set(ms: number, run: () => void) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
const noop = () => {};
afterEach(() => {
  cleanup();
  resetDismissed();
});

test.each(["same", "replacement"] as const)(
  "uncertain new-thread recovery on the %s daemon keeps ownership and the original ID",
  async (target) => {
    const storage = memoryKeyValue();
    const outbox = memoryStorage();
    let lose = noop;
    let lostCommand: string | undefined;
    const first = harness({
      storage,
      client(daemon) {
        const host = new ClientHost({
          target: () => ({ key: "primary", create: () => fakeClient(daemon, daemon.token, outbox) }),
          scheduler: timers,
          now: () => 0,
          frameMs: 1,
          lingerMs: 1,
        });
        const { port1, port2 } = new MessageChannel();
        host.attach({
          postMessage(value) {
            const parsed = WorkerMessage.safeParse(value);
            if (parsed.success && parsed.data.t === "reply") {
              const reply = parsed.data.value;
              if (
                typeof reply === "object" &&
                reply !== null &&
                "id" in reply &&
                "pending" in reply &&
                "intent" in reply
              ) {
                const intent = reply.intent;
                if (typeof intent === "object" && intent !== null && "command" in intent) {
                  const command = intent.command;
                  if (typeof command === "object" && command !== null && "payload" in command) {
                    const payload = CommandPayload.safeParse(command.payload);
                    if (
                      payload.success &&
                      payload.data.type === "thread.create" &&
                      typeof reply.id === "string"
                    ) {
                      lostCommand = reply.id;
                      lose();
                      return;
                    }
                  }
                }
              }
            }
            // oxlint-disable-next-line unicorn/require-post-message-target-origin
            port1.postMessage(value);
          },
          addEventListener: (type, listener) => port1.addEventListener(type, listener),
          removeEventListener: (type, listener) => port1.removeEventListener(type, listener),
          start: () => port1.start(),
          close: () => port1.close(),
        });
        return new RemoteClient(
          port2,
          {},
          {
            scheduler: timers,
            workerFailure: {
              watch(lost) {
                lose = lost;
                return noop;
              },
            },
          },
        );
      },
    });
    for (const scenario of workbench()) first.play(scenario).runUntilBlocked();
    const before = first.daemon.snapshot({ kind: "threads" });
    if (before?.kind !== "threads") throw new Error("Expected sidebar");
    const initial = new Set(Object.keys(before.threads));
    const created = () => {
      const view = first.daemon.snapshot({ kind: "threads" });
      return view?.kind === "threads"
        ? Object.values(view.threads).filter((thread) => !initial.has(thread.id))
        : [];
    };
    await first.open("/new?project=relay");
    await userEvent.type(
      await screen.findByRole("combobox", { name: "Message" }),
      "Recover this uncertain start",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
        "true",
      ),
    );
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(first.client.state).toBe("fatal"));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
        "Recover this uncertain start",
      ),
    );
    await waitFor(() => expect(created()).toHaveLength(1));
    if (!lostCommand) throw new Error("Expected the lost enqueue reply");
    expect(loadDismissed(storage).has(lostCommand)).toBe(false);
    cleanup();
    await act(async () => {
      await first.client.close();
    });
    const daemon =
      target === "same" ? first.daemon : new FakeDaemon({ hostId: "replacement", clock: () => 1 });
    const again = harness({ storage, outbox: target === "same" ? outbox : memoryStorage(), daemon });
    if (target === "replacement")
      for (const scenario of workbench()) again.play(scenario).runUntilBlocked();
    await again.open("/new?project=relay");
    expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
      "Recover this uncertain start",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
        "true",
      ),
    );
    await userEvent.keyboard("{Enter}");
    if (target === "same") {
      await screen.findByRole("heading", { level: 1, name: "Recover this uncertain start" });
    } else {
      await screen.findByText(
        "The previous thread belongs to another daemon. Reconnect to that daemon to recover it.",
      );
      const view = daemon.snapshot({ kind: "threads" });
      if (view?.kind !== "threads") throw new Error("Expected replacement sidebar");
      expect(Object.keys(view.threads).filter((id) => !initial.has(id))).toEqual([]);
    }
    expect(created()).toHaveLength(1);
    expect(created()[0]?.id).toBe(`thread-${lostCommand}`);
  },
);
