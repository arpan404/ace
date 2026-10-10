import { useBrowserMachinePool } from "@/boot/machine-pool-boot.ts";
import { App, AppFrame } from "@/app.tsx";
import { createMemoryHistory } from "@tanstack/react-router";
import { FakeDaemon } from "@ace/fake-daemon";
import { AccessClient } from "@ace/client/access";
import type { ClientApi } from "@ace/client";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

let pairedClient: ClientApi | undefined;
vi.mock("@/boot/page-client.ts", () => ({
  createPageClient: () => {
    if (!pairedClient) throw new Error("No paired computer");
    return pairedClient;
  },
}));
afterEach(() => vi.unstubAllGlobals());

test.each([false, true])(
  "Settings pairs on demand and cancelling identity verification leaves no machine (cancel: %s)",
  async (cancel) => {
    const remote = new FakeDaemon({
      hostId: "office",
      displayName: "Office computer",
      clock: () => 1000,
    });
    const primary = fakeClient(new FakeDaemon({ clock: () => 1000 }));
    pairedClient = fakeClient(remote);
    let release: (() => void) | undefined;
    let verifying: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      verifying = resolve;
    });
    if (cancel) {
      const request = pairedClient.request.bind(pairedClient);
      vi.spyOn(pairedClient, "request").mockImplementation(async (input) => {
        if (input.type === "host.identity") {
          verifying?.();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return request(input);
      });
    }
    await primary.start();
    vi.stubGlobal("fetch", (input: string, init: RequestInit) => remote.access.fetch(input, init));
    const access = new AccessClient({
      origin: "http://127.0.0.1:4242/",
      fetch: remote.access.fetch,
      token: async () => remote.access.token,
    });
    const link = await access.pairing(["read", "operate", "projects"]);
    const local = memoryKeyValue();
    const session = memoryKeyValue();
    function Connected() {
      const { pool, ensure } = useBrowserMachinePool(local, session);
      return (
        <App
          client={primary}
          storage={local}
          machines={pool}
          ensureMachines={ensure}
          history={createMemoryHistory({ initialEntries: ["/settings/remote"] })}
        />
      );
    }
    render(
      <AppFrame environment={{}}>
        <Connected />
      </AppFrame>,
    );
    expect(local.getItem("ace.machines")).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Add machine" }));
    const dialog = await screen.findByRole("dialog", { name: "Add machine" });
    await userEvent.type(within(dialog).getByLabelText("Pairing link or code"), link.url);
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "This device's name" }),
      "My laptop",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Add machine" }));
    if (cancel) {
      await entered;
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      release?.();
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add machine" })).toBeNull());
      expect(screen.queryByText("Office computer added")).toBeNull();
      expect(local.getItem("ace.machines")).toBeNull();
      return;
    }
    expect(await screen.findByText("Office computer added")).toBeTruthy();
    expect(
      await within(screen.getByRole("region", { name: "Machines" })).findByText("Office computer"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add machine" })).toBeNull());
    expect(local.getItem("ace.machines")).toContain("Office computer");
    expect([...local.data.values()].join("")).not.toContain("b".repeat(64));
    expect([...session.data.values()].join("")).toContain("b".repeat(64));
  },
);
