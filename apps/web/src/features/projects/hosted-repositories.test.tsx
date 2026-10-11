import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { FakeDaemon } from "@ace/fake-daemon";
import { ServerMessage } from "@ace/protocol";

async function browse(app: ReturnType<typeof harness>) {
  await app.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: "Add a project" }));
  await userEvent.click(await screen.findByRole("option", { name: "GitHub repositories" }));
}
test("GitHub search filters results and selection reuses the existing clone destination and cancellation flow", async () => {
  const stages: (() => void)[] = [];
  const app = harness({
    throughWorker: true,
    projectScheduler: (callback) => void stages.push(callback),
  });
  app.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/code" }]);
  await browse(app);
  await screen.findByRole("button", { name: /ada\/engine/ });
  await userEvent.type(screen.getByRole("textbox", { name: "Search GitHub repositories" }), "docs");
  await screen.findByRole("button", { name: /ace-org\/docs/ });
  await waitFor(() => expect(screen.queryByRole("button", { name: /ada\/engine/ })).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: /ace-org\/docs/ }));
  const url = await screen.findByRole("textbox", { name: "Repository address" });
  expect(url).toHaveProperty("value", "https://github.com/ace-org/docs.git");
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveProperty("value", "docs");
  await userEvent.click(screen.getByRole("button", { name: "Clone" }));
  await screen.findByRole("progressbar", { name: "Clone progress" });
  await userEvent.click(screen.getByRole("button", { name: "Cancel clone" }));
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  expect(app.daemon.projects.list().workspaces).toEqual([]);
});
test("an explicitly changed account cannot reuse another account's selectable repository results", async () => {
  const app = harness({ throughWorker: true });
  await browse(app);
  await screen.findByRole("button", { name: /ada\/engine/ });
  const account = screen.getByRole("textbox", { name: "GitHub account" });
  await userEvent.clear(account);
  await userEvent.type(account, "other");
  await screen.findByText(/Repository access failed/);
  expect(screen.queryByRole("button", { name: /ada\/engine/ })).toBeNull();
});
async function openPublish() {
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "site" }));
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: await screen.findByRole("menuitemradio", { name: "site" }),
  });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Publish repository…" }));
  return screen.findByRole("dialog", { name: "Publish repository" });
}

test("publishing an empty project requires explicit submission and reopening shows its durable repository", async () => {
  const app = harness({ throughWorker: true });
  app.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/site", git: true }]);
  await app.client.start();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  const result = await app.client.projects.add({ path: "/home/dev/site" });
  await app.open("/new");

  const dialog = await openPublish();
  const publish = await within(dialog).findByRole("button", { name: "Publish repository" });
  await waitFor(() => expect(publish).toHaveProperty("disabled", false));
  expect(app.daemon.projects.publication(result.workspace?.id ?? "")).toBeNull();
  await userEvent.click(publish);
  expect(await screen.findByText(/This project has no commits/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "ada/site" }).getAttribute("href")).toBe(
    "https://github.com/ada/site",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  const reopened = await openPublish();
  expect(await within(reopened).findByText(/This project has no commits/)).toBeTruthy();
  expect(within(reopened).getByRole("button", { name: "Resume publication" })).toBeTruthy();
});

test("reopening a daemon-owned publication offers Stop and disables Resume until it settles", async () => {
  const stages: (() => void)[] = [];
  const app = harness({
    throughWorker: true,
    projectScheduler: (run) => {
      stages.push(run);
    },
  });
  app.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/site", git: true }]);
  await app.client.start();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  const added = await app.client.projects.add({ path: "/home/dev/site" });
  if (!added.workspace) throw new Error("Expected project");
  const workspaceId = added.workspace.id;
  await app.open("/new");
  const dialog = await openPublish();
  const submit = await within(dialog).findByRole("button", { name: "Publish repository" });
  await waitFor(() => expect(submit).toHaveProperty("disabled", false));
  await userEvent.click(submit);
  await waitFor(async () =>
    expect(
      await app.client.request({
        type: "repositories.request",
        operation: { op: "publication", workspaceId },
      }),
    ).toMatchObject({ result: { running: true, canStop: true } }),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Hide" }));
  const reopened = await openPublish();
  await within(reopened).findByRole("button", { name: "Stop publication" });
  expect(within(reopened).getByRole("button", { name: "Publishing…" })).toHaveProperty(
    "disabled",
    true,
  );
  await userEvent.click(within(reopened).getByRole("button", { name: "Stop publication" }));
  await within(reopened).findByText(/Publication stopped/);
  await waitFor(() =>
    expect(within(reopened).queryByRole("button", { name: "Stop publication" })).toBeNull(),
  );
  expect(app.daemon.projects.publication(added.workspace.id)?.remote).toBeNull();
  for (const run of stages) run();
});

/** Delay one real readiness frame while its correlated publication snapshot keeps flowing. */
class DelayedPublicationReadiness extends FakeDaemon {
  delayNextReadiness = false;
  private delayed: (() => void) | undefined;
  private runningSeen = false;
  private captured = Promise.withResolvers<void>();
  readonly runningSnapshot = this.captured.promise;
  releaseReadiness(): void {
    this.delayed?.();
    this.delayed = undefined;
  }
  override connect(wire: Parameters<FakeDaemon["connect"]>[0]) {
    return super.connect({
      ...wire,
      send: (text) => {
        const frame = ServerMessage.parse(JSON.parse(text));
        if (frame.type === "source-control.result" && this.delayNextReadiness) {
          this.delayNextReadiness = false;
          this.delayed = () => wire.send(text);
          if (this.runningSeen) this.captured.resolve();
          return;
        }
        if (
          (this.delayed || this.delayNextReadiness) &&
          frame.type === "repositories.result" &&
          frame.result.kind === "publication" &&
          frame.result.running
        ) {
          this.runningSeen = true;
          if (this.delayed) this.captured.resolve();
        }
        wire.send(text);
      },
    });
  }
}

test("a stale running snapshot waiting for readiness cannot overwrite the completion receipt after reopening", async () => {
  const stages: (() => void)[] = [];
  const daemon = new DelayedPublicationReadiness({
    clock: () => 1000,
    projectScheduler: (run) => {
      stages.push(run);
    },
  });
  const app = harness({ throughWorker: true, daemon });
  daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/site", git: true }]);
  await app.client.start();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  const added = await app.client.projects.add({ path: "/home/dev/site" });
  if (!added.workspace) throw new Error("Expected project");
  await app.open("/new");
  const dialog = await openPublish();
  const submit = await within(dialog).findByRole("button", { name: "Publish repository" });
  await waitFor(() => expect(submit).toHaveProperty("disabled", false));
  await userEvent.click(submit);
  await waitFor(() =>
    expect(
      daemon.projects.publicationActivity(added.workspace?.id ?? "", "test-device").running,
    ).toBe(true),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Hide" }));
  daemon.delayNextReadiness = true;
  const reopened = await openPublish();
  await daemon.runningSnapshot;
  await act(async () => {
    for (const run of stages.splice(0)) run();
  });
  await within(reopened).findByText(/This project has no commits/);
  await act(async () => {
    daemon.releaseReadiness();
    // A following wire response is a delivery barrier for the older delayed readiness frame.
    await app.client.request({ type: "source-control.request", operation: { op: "readiness" } });
  });
  expect(within(reopened).getByText(/This project has no commits/)).toBeTruthy();
  expect(within(reopened).queryByRole("button", { name: "Stop publication" })).toBeNull();
  expect(within(reopened).getByRole("button", { name: "Resume publication" })).toHaveProperty(
    "disabled",
    false,
  );
});
