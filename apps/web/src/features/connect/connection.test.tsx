import { FakeDaemon, flakyCheckout, ScenarioPlayer } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App, AppFrame } from "@/app.tsx";
import { ConnectionGate } from "@/boot/connection-gate.tsx";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";

const token = "ab".repeat(32);
const url = "ws://127.0.0.1:4242/";

/** The real gate and app, with a fake daemon behind whatever address is entered. */
function boot(options: { fragment?: string } = {}) {
  const daemon = new FakeDaemon({ clock: () => 1, token });
  new ScenarioPlayer(daemon, flakyCheckout()).runThrough("explorer-spawned");
  const local = memoryKeyValue();
  const session = memoryKeyValue();
  render(
    <AppFrame environment={{}}>
      <ConnectionGate
        stores={{ local, session }}
        defaultUrl={url}
        createClient={(target) => fakeClient(daemon, target.token)}
        {...(options.fragment ? { fragment: options.fragment } : {})}
      >
        {(client) => (
          <App client={client} history={createMemoryHistory({ initialEntries: ["/"] })} />
        )}
      </ConnectionGate>
    </AppFrame>,
  );
  return { local, session };
}

async function connectWith(value: string, remember = false) {
  await userEvent.type(await screen.findByLabelText("Token"), value);
  if (remember) await userEvent.click(screen.getByRole("switch"));
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
}

test("without a token the app asks for one and explains where it lives", async () => {
  boot();
  await screen.findByRole("heading", { name: "Connect to your daemon" });
  expect(screen.getByText(/cat ~\/\.ace\/daemon-token/)).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>("Daemon address").value).toBe(url);

  await connectWith("not-a-token");
  expect((await screen.findByRole("alert")).textContent).toMatch(/64 hexadecimal characters/);
});

test("a valid token connects and the token stays in this session unless remembered", async () => {
  const { local, session } = boot();
  await connectWith(token);
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(await screen.findByRole("status", { name: "Daemon: Connected" })).toBeTruthy();
  expect(session.getItem("ace.daemon.token")).toBe(token);
  expect(local.getItem("ace.daemon.token")).toBeNull();
  expect(local.getItem("ace.daemon.url")).toBe(url);
});

test("a token the daemon rejects says so calmly and links to the connection settings", async () => {
  boot();
  await connectWith("cd".repeat(32), true);
  const notice = await screen.findByText(/Can't connect: the daemon didn't accept this token/);
  expect(within(notice).getByRole("link", { name: "Connection settings" })).toBeTruthy();
});

test("the daemon's #token= hand-off connects straight away", async () => {
  const { local } = boot({ fragment: `#token=${token}` });
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(local.getItem("ace.daemon.token")).toBeNull();
});

test("disconnecting forgets the token and returns to the connection screen", async () => {
  const { local, session } = boot();
  await connectWith(token, true);
  expect(local.getItem("ace.daemon.token")).toBe(token);
  await userEvent.click(await screen.findByRole("button", { name: "Account and connection" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
  await screen.findByRole("heading", { name: "Connect to your daemon" });
  expect(local.getItem("ace.daemon.token")).toBeNull();
  expect(session.getItem("ace.daemon.token")).toBeNull();
});
