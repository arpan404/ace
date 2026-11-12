import type { CommandPayload } from "@ace/protocol";
import { waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { componentClient } from "@/test/component-client.tsx";
import { overlayOf } from "./overlay.ts";
import { threadActionsOn, type ThreadActionsDeps } from "./use-thread-actions.ts";

// The actions' code arrives only when the test lets it; the first try fails, as a dropped
// connection would.
const load = vi.hoisted(() => ({
  tries: 0,
  gates: [Promise.withResolvers<void>(), Promise.withResolvers<void>()],
}));
vi.mock("./thread-actions-impl.ts", async (importOriginal) => {
  const attempt = load.tries++;
  await load.gates[attempt]?.promise;
  if (attempt === 0) throw new TypeError("Failed to fetch dynamically imported module");
  return importOriginal();
});

async function organize() {
  const app = await componentClient({
    thread: { id: "organize", workspaceId: "relay", provider: "claude", title: "Organize" },
    steps: [],
  });
  const sent: CommandPayload["type"][] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    sent.push(command.payload.type);
    return receive(command);
  };
  const said: string[] = [];
  const toast = {
    add: (shown: { title: string }) => (said.push(shown.title), "toast"),
    error: (shown: { title: string }) => (said.push(shown.title), "toast"),
    close: () => {},
  };
  const actions = threadActionsOn({
    overlay: overlayOf(app.client),
    client: app.client,
    toast: toast as unknown as ThreadActionsDeps["toast"],
    confirmation: { open: () => {} } as unknown as ThreadActionsDeps["confirmation"],
    archiving: { open: () => {} } as unknown as ThreadActionsDeps["archiving"],
    navigate: (async () => {}) as unknown as ThreadActionsDeps["navigate"],
    router: {} as ThreadActionsDeps["router"],
    machine: {},
  });
  return { actions, sent, said };
}

const thread = { id: "organize", title: "Organize", workspaceId: "relay" };

test("actions taken while their code loads say so if it fails, and run in order once it arrives", async () => {
  const { actions, sent, said } = await organize();
  actions.setPinned(thread, true);
  // Asked before an action: answered at once, without the code.
  expect(actions.leftRunning([thread])).toEqual([{ title: "Organize", leftRunning: 0 }]);
  load.gates[0]?.resolve();
  await waitFor(() => expect(said).toEqual(["Couldn't do that"]));
  expect(sent).toEqual([]);

  // The next actions load it again; they wait for it, then go out in the order they were made.
  actions.setPinned(thread, true);
  actions.setUnread(thread, true);
  actions.rename(thread, "Renamed");
  expect(sent).toEqual([]);
  load.gates[1]?.resolve();
  await waitFor(() => expect(sent).toEqual(["thread.pin", "thread.read", "thread.rename"]));

  // Loaded, an action goes out at once.
  actions.setUnread(thread, false);
  await waitFor(() => expect(sent).toHaveLength(4));
  expect(sent[3]).toBe("thread.read");
});
