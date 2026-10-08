import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AppFrame } from "@/app.tsx";
import { ConnectionGate } from "@/app/connection-gate.tsx";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";
import { FakeDaemon } from "@ace/fake-daemon";
import { AccessClient } from "@ace/client/access";
import { loadTarget } from "@/boot/connection-settings.ts";

afterEach(() => vi.unstubAllGlobals());

async function setup(linkRoute: boolean, rejectedConnection = false) {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  // Native browser fetch rejects a receiver other than the browser global.
  vi.stubGlobal("fetch", function (this: unknown, input: string, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Invalid fetch receiver");
    return daemon.access.fetch(input, init);
  });
  const access = new AccessClient({
    origin: "http://127.0.0.1:4242/",
    fetch: daemon.access.fetch,
    token: async () => daemon.access.token,
  });
  const pairing = await access.pairing(["read", "projects"]);
  const stores = { local: memoryKeyValue(), session: memoryKeyValue() };
  render(
    <AppFrame environment={{}}>
      <ConnectionGate
        stores={stores}
        defaultUrl="ws://127.0.0.1:4242/"
        pairingLink={linkRoute ? pairing.url : undefined}
        createClient={() => fakeClient(daemon, rejectedConnection ? "c".repeat(64) : daemon.token)}
      >
        {() => <p>Connected to Office Mac</p>}
      </ConnectionGate>
    </AppFrame>,
  );
  return { stores, pairing };
}

test("opening a pairing link asks for a name, stores only the issued credential and connects", async () => {
  const { stores, pairing } = await setup(true);
  expect(await screen.findByRole("form", { name: "Pair this device" })).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox", { name: "This device's name" }), "My phone");
  await userEvent.click(screen.getByRole("button", { name: "Pair and connect" }));
  expect(await screen.findByText("Connected to Office Mac")).toBeTruthy();
  const target = loadTarget(stores).target;
  expect(target?.pairedDeviceId).toBeTruthy();
  expect(target?.token).toBe("b".repeat(64));
  expect(stores.local.getItem("ace.daemon.token")).toBeNull();
  expect([...stores.session.data.values()].join("")).not.toContain(
    new URLSearchParams(new URL(pairing.url).hash.slice(1)).get("code"),
  );
});

test("the connect screen accepts a pasted pairing link and can remember this device", async () => {
  const { stores, pairing } = await setup(false);
  await userEvent.click(await screen.findByRole("button", { name: "Have a pairing code?" }));
  await userEvent.type(screen.getByLabelText("Pairing link or code"), pairing.url);
  await userEvent.type(
    screen.getByRole("textbox", { name: "This device's name" }),
    "Office browser",
  );
  await userEvent.click(screen.getByRole("switch", { name: "Remember on this device" }));
  await userEvent.click(screen.getByRole("button", { name: "Pair and connect" }));
  expect(await screen.findByText("Connected to Office Mac")).toBeTruthy();
  expect(loadTarget(stores).remembered).toBe(true);
  expect(loadTarget(stores).target?.pairedDeviceId).toBeTruthy();
});

test("an expired or used pairing link tells the person to create another and saves no token", async () => {
  const { stores } = await setup(true);
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
  await userEvent.type(
    await screen.findByRole("textbox", { name: "This device's name" }),
    "My phone",
  );
  await userEvent.click(screen.getByRole("button", { name: "Pair and connect" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Create a new one on the host computer",
    ),
  );
  expect(loadTarget(stores).target).toBeUndefined();
});

test("a redeemed link that cannot connect returns to an editable connection screen", async () => {
  await setup(true, true);
  await userEvent.type(
    await screen.findByRole("textbox", { name: "This device's name" }),
    "My phone",
  );
  await userEvent.click(screen.getByRole("button", { name: "Pair and connect" }));
  expect((await screen.findByRole("alert")).textContent).toContain("didn't accept");
  expect(screen.getByRole("button", { name: "Have a pairing code?" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(false);
});
