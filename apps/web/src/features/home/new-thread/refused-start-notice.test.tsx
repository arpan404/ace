import { workbench } from "@ace/fake-daemon";
import { WorkspaceId } from "@ace/protocol";
import { act, cleanup, configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import {
  createAttemptsKey,
  readCreateAttempts,
  saveCreateAttempt,
  type CreateAttempt,
} from "./create-attempt.ts";

configure({ asyncUtilTimeout: 30000 });
afterEach(() => cleanup());

const refusedNote =
  "The previous thread start was refused. You can edit this message and try again.";
// The harness's connection: an in-memory daemon with no device id of its own.
const attemptsKey = createAttemptsKey("memory://fake-daemon", "fake");

function savedStart(hostId: string, text: string): CreateAttempt {
  return {
    hostId,
    commandId: crypto.randomUUID(),
    payload: {
      type: "thread.create",
      workspaceId: WorkspaceId.parse("relay"),
      provider: "claude",
      mode: "local",
      input: [{ type: "text", text }],
    },
  };
}

function refusingDaemon() {
  const storage = memoryKeyValue();
  const made = harness({ storage });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  made.daemon.refuseCommands("model_unavailable", "thread.create");
  return { made, storage };
}

test("clearing the message removes the note that its earlier start was refused", async () => {
  const { made, storage } = refusingDaemon();
  await made.open("/new?project=relay");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "Try me again");
  cleanup();
  saveCreateAttempt(storage, attemptsKey, savedStart(made.daemon.hostId, "Try me again"));

  await made.open("/new?project=relay");
  await screen.findByText(refusedNote);
  await userEvent.clear(screen.getByRole("combobox", { name: "Message" }));

  await waitFor(() => expect(screen.queryByText(refusedNote)).toBeNull());
});

test("a refused start found with an empty composer settles without a note", async () => {
  const { made, storage } = refusingDaemon();
  saveCreateAttempt(storage, attemptsKey, savedStart(made.daemon.hostId, "Gone already"));

  await made.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });

  await waitFor(() => expect(readCreateAttempts(storage, attemptsKey)).toEqual([]));
  // The note would follow the settlement, so give it the chance to appear.
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(screen.queryByText(refusedNote)).toBeNull();
});
