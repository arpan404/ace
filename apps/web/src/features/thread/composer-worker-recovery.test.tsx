import type { ClientApi } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { ClientHost, RemoteClient } from "@ace/client-worker";
import { fixtureImage, longHistory, type FakeDaemon } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ToastProvider } from "@/components/ui/toast.tsx";
import { fakeClient, harness } from "@/test/harness.tsx";
import type { ThreadRef } from "./sources/index.ts";
import { draftScopes } from "./sources/context-source.ts";
import { AttachmentChips, useAttachments } from "./composer/attachments.tsx";

configure({ asyncUtilTimeout: 10000 });

/*
 * The composer's attachments across a client worker being replaced (ADR 0056, 2026-10-19): a
 * file attached while the client recovers waits as uploading, never a red error, and uploads on
 * its own once the client is ready; Retry works on the new worker.
 */

const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  URL.createObjectURL = () => "blob:test/1";
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
});

const png = Uint8Array.from(atob(fixtureImage.data), (char) => char.charCodeAt(0));
const screenshot = () => new File([png], "screen.png", { type: "image/png" });
const noop = () => {};
const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** A tab's client whose worker can die; a fresh one comes up once `revive()` allows it. */
function replaceableWorker() {
  let kill = noop;
  let paused = false;
  let client: RemoteClient | undefined;
  const worker = (daemon: FakeDaemon) => {
    const host = new ClientHost({
      target: () => ({ key: "fake", create: () => fakeClient(daemon) }),
      scheduler: timers,
      now: () => Date.now(),
      frameMs: 4,
      lingerMs: 1,
    });
    const { port1, port2 } = new MessageChannel();
    host.attach(port1);
    return {
      port: port2,
      failure: {
        watch(lost: () => void) {
          kill = lost;
          return () => {};
        },
      },
    };
  };
  return {
    create(daemon: FakeDaemon): ClientApi {
      const first = worker(daemon);
      client = new RemoteClient(
        first.port,
        {},
        {
          scheduler: timers,
          workerFailure: first.failure,
          respawn: () => (paused ? undefined : worker(daemon)),
        },
      );
      return client;
    },
    /** The worker dies, and no fresh one comes up until `revive`. */
    die() {
      paused = true;
      kill();
    },
    revive() {
      paused = false;
    },
  };
}

function Chips(props: { thread: ThreadRef }) {
  const attachments = useAttachments(props.thread);
  return (
    <>
      <button type="button" onClick={() => attachments.add([screenshot()])}>
        Attach
      </button>
      <AttachmentChips
        items={attachments.items}
        onRemove={attachments.remove}
        onRetry={attachments.retry}
      />
    </>
  );
}

async function setup() {
  const worker = replaceableWorker();
  const app = harness({ client: (daemon) => worker.create(daemon) });
  app.play(longHistory(2)).runUntilBlocked();
  await app.client.start();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  const mount = (thread: ThreadRef) => (
    <ClientProvider client={app.client}>
      <ToastProvider>
        <Chips thread={thread} />
      </ToastProvider>
    </ClientProvider>
  );
  return { app, worker, mount };
}

const thread: ThreadRef = { id: "thread-router", workspaceId: "docs-site", title: "Router" };

async function heldByDaemon(client: ClientApi): Promise<string[]> {
  const reply = await client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId: ThreadId.parse(thread.id) },
  });
  return reply.result.kind === "attachments"
    ? reply.result.attachments.map((file) => file.name)
    : [];
}

test("an image attached while the client worker is being replaced uploads once the client is ready", async () => {
  const user = userEvent.setup();
  const { app, worker, mount } = await setup();
  render(mount(thread));
  worker.die();
  expect(app.client.state).toBe("reconnecting");

  await user.click(screen.getByRole("button", { name: "Attach" }));
  const chips = await screen.findByRole("list", { name: "Attachments" });
  // Waiting for the client: still uploading, no red error and no Retry to press.
  expect(within(chips).getByRole("progressbar")).toBeTruthy();
  expect(within(chips).queryByText(/Couldn't upload/)).toBeNull();

  worker.revive();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  expect(within(chips).queryByText(/Couldn't upload/)).toBeNull();
  expect(await heldByDaemon(app.client)).toEqual(["screen.png"]);
});

test("Retry on a failed upload works once the client worker has been replaced", async () => {
  const user = userEvent.setup();
  const { app, worker, mount } = await setup();
  render(mount(thread));
  app.daemon.failRequests("context.request");
  await user.click(screen.getByRole("button", { name: "Attach" }));
  const chips = await screen.findByRole("list", { name: "Attachments" });
  const retry = await within(chips).findByRole("button", { name: "Retry screen.png" });

  worker.die();
  worker.revive();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  app.daemon.restoreRequests();
  await user.click(retry);
  await waitFor(() => expect(within(chips).queryByText(/Couldn't upload/)).toBeNull());
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  expect(await heldByDaemon(app.client)).toEqual(["screen.png"]);
});

test("a New thread image attached before its draft scope is granted waits, then uploads into it", async () => {
  const user = userEvent.setup();
  const { app, mount } = await setup();
  const draft: ThreadRef = { id: "", workspaceId: "docs-site", title: "", draft: true };
  const view = render(mount(draft));
  await user.click(screen.getByRole("button", { name: "Attach" }));
  const chips = await screen.findByRole("list", { name: "Attachments" });
  expect(within(chips).getByRole("progressbar")).toBeTruthy();
  expect(within(chips).queryByText(/isn't ready for files/)).toBeNull();

  const draftId = await draftScopes(app.client).create("docs-site");
  view.rerender(mount({ ...draft, id: draftId }));
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  expect(within(chips).queryByText(/Couldn't upload/)).toBeNull();
});
