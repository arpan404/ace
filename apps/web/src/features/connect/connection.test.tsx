import { FakeDaemon, flakyCheckout, ScenarioPlayer } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App, AppFrame } from "@/app.tsx";
import { ConnectionGate } from "@/app/connection-gate.tsx";
import { fakeClient, memoryKeyValue } from "@/test/harness.tsx";

const token = "ab".repeat(32);
const url = "ws://127.0.0.1:4242/";

/** The real gate and app, with a fake daemon behind whatever address is entered. */
function boot(options: { fragment?: string; onDemand?: boolean; rememberedToken?: string } = {}) {
  const daemon = new FakeDaemon({ clock: () => 1, token });
  new ScenarioPlayer(daemon, flakyCheckout()).runThrough("explorer-spawned");
  const local = memoryKeyValue();
  const session = memoryKeyValue();
  // A person who connected before and asked to be remembered on this device.
  if (options.rememberedToken) {
    local.setItem("ace.daemon.url", url);
    local.setItem("ace.daemon.token", options.rememberedToken);
  }
  render(
    <AppFrame environment={{}}>
      <ConnectionGate
        stores={{ local, session }}
        defaultUrl={url}
        createClient={(target) =>
          // The in-page fallback client arrives later, after its chunk loads.
          options.onDemand
            ? Promise.resolve().then(() => fakeClient(daemon, target.token))
            : fakeClient(daemon, target.token)
        }
        {...(options.fragment ? { fragment: options.fragment } : {})}
      >
        {(client) => (
          <App client={client} history={createMemoryHistory({ initialEntries: ["/"] })} />
        )}
      </ConnectionGate>
    </AppFrame>,
  );
  return { local, session, daemon };
}

async function connectWith(value: string, options: { url?: string; flipRemember?: boolean } = {}) {
  if (options.url) {
    const address = await screen.findByLabelText("ace address");
    await userEvent.clear(address);
    await userEvent.type(address, options.url);
  }
  await userEvent.type(await screen.findByLabelText("Token"), value);
  if (options.flipRemember) await userEvent.click(screen.getByRole("switch"));
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
}

test("without a token the app asks for one and says how to get it", async () => {
  boot();
  await screen.findByRole("heading", { name: "Connect to ace" });
  expect(screen.getByLabelText("Token").getAttribute("aria-describedby")).toBeTruthy();
  const hint = document.getElementById(
    screen.getByLabelText("Token").getAttribute("aria-describedby") ?? "",
  );
  expect(hint?.textContent).toMatch(/run ace token and paste the result/);
  expect(screen.getByLabelText<HTMLInputElement>("ace address").value).toBe(url);

  await connectWith("not-a-token");
  expect((await screen.findByRole("alert")).textContent).toMatch(/64 hexadecimal characters/);
  expect(screen.getByLabelText("Token").getAttribute("aria-invalid")).toBe("true");
});

test("the token can be shown to check it, and the command copied", async () => {
  const user = userEvent.setup();
  boot();
  const field = await screen.findByLabelText<HTMLInputElement>("Token");
  expect(field.type).toBe("password");
  await user.click(screen.getByRole("button", { name: "Show token" }));
  expect(field.type).toBe("text");

  const hint = document.getElementById(field.getAttribute("aria-describedby") ?? "");
  if (!hint) throw new Error("The token has no hint");
  await user.click(within(hint).getByRole("button", { name: "Copy command" }));
  expect(await navigator.clipboard.readText()).toBe("ace token");
});

test("a token for this computer's daemon is remembered by default", async () => {
  const { local, session } = boot();
  await screen.findByText("Stays until you disconnect.");
  await connectWith(token);
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(await screen.findByRole("button", { name: /, account$/ })).toBeTruthy();
  expect(local.getItem("ace.daemon.token")).toBe(token);
  expect(session.getItem("ace.daemon.token")).toBeNull();
  expect(local.getItem("ace.daemon.url")).toBe(url);
});

test("a daemon on another machine is forgotten when the window closes unless asked", async () => {
  const { local, session } = boot();
  await connectWith(token, { url: "ws://192.168.1.5:4242/" });
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(session.getItem("ace.daemon.token")).toBe(token);
  expect(local.getItem("ace.daemon.token")).toBeNull();
});

test("pasting the link `ace start` opens fills in the token and the address", async () => {
  const user = userEvent.setup();
  boot();
  const field = await screen.findByLabelText<HTMLInputElement>("Token");
  await user.click(field);
  await user.paste(`http://127.0.0.1:4242/#token=${token}&daemon=ws://127.0.0.1:5151/`);
  expect(field.value).toBe(token);
  expect(screen.getByLabelText<HTMLInputElement>("ace address").value).toBe("ws://127.0.0.1:5151/");
});

test("a token the daemon rejects returns to the form, says why and selects the token", async () => {
  boot();
  await connectWith("cd".repeat(32));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/didn't accept this token/);
  const field = screen.getByLabelText<HTMLInputElement>("Token");
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe("cd".repeat(32));
  // Never the shell: nothing was ever connected.
  expect(screen.queryByRole("link", { name: /Fix flaky checkout test/ })).toBeNull();
});

test("the daemon's #token= hand-off connects straight away", async () => {
  const { local } = boot({ fragment: `#token=${token}` });
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(local.getItem("ace.daemon.token")).toBeNull();
});

test("a link to a daemon on another machine asks first, and declining keeps the remembered one", async () => {
  const attacker = "cd".repeat(32);
  const { local, session } = boot({
    rememberedToken: token,
    fragment: `#token=${attacker}&daemon=wss://evil.example/`,
  });
  await screen.findByRole("heading", { name: "Connect to ace on this machine?" });
  expect(screen.getByText("wss://evil.example/")).toBeTruthy();
  // The safe answer is the default, and says what it keeps.
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Don't connect" }));
  expect(screen.getByText("Keeps your current connection")).toBeTruthy();
  // Nothing is saved or forgotten while the question is open.
  expect(local.getItem("ace.daemon.url")).toBe(url);
  expect(local.getItem("ace.daemon.token")).toBe(token);
  expect(session.getItem("ace.daemon.token")).toBeNull();

  await userEvent.keyboard("{Escape}");
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(local.getItem("ace.daemon.url")).toBe(url);
  expect(local.getItem("ace.daemon.token")).toBe(token);
});

test("agreeing to a link for another machine connects to it", async () => {
  const { local, session } = boot({ fragment: `#token=${token}&daemon=wss://ace.example/` });
  await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(local.getItem("ace.daemon.url")).toBe("wss://ace.example/");
  expect(session.getItem("ace.daemon.token")).toBe(token);
});

test("a link for this computer never silently replaces the remembered token", async () => {
  const other = "cd".repeat(32);
  const { local } = boot({ rememberedToken: token, fragment: `#token=${other}` });
  await screen.findByText(/replaces the token remembered on this device/);
  expect(local.getItem("ace.daemon.token")).toBe(token);
});

test("disconnecting forgets the token and returns to the connection screen", async () => {
  const { local, session } = boot();
  await connectWith(token);
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(local.getItem("ace.daemon.token")).toBe(token);
  // Disconnect is in the daemon's menu, the sidebar's "ace ▾".
  await userEvent.click(await screen.findByRole("button", { name: "ace menu" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
  await screen.findByRole("heading", { name: "Connect to ace" });
  expect(local.getItem("ace.daemon.token")).toBeNull();
  expect(session.getItem("ace.daemon.token")).toBeNull();
});

test("a client that loads on demand connects once it arrives, and disconnecting still works", async () => {
  const { local } = boot({ onDemand: true });
  await connectWith(token);
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  expect(await screen.findByRole("button", { name: /, account$/ })).toBeTruthy();
  // Disconnect is in the daemon's menu, the sidebar's "ace ▾".
  await userEvent.click(await screen.findByRole("button", { name: "ace menu" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
  await screen.findByRole("heading", { name: "Connect to ace" });
  expect(local.getItem("ace.daemon.token")).toBeNull();
});

test("a daemon that later rejects the token sends the window back to the form with the address", async () => {
  const { daemon } = boot({ rememberedToken: token });
  await screen.findByRole("link", { name: /Fix flaky checkout test/ });
  // 4001: the daemon no longer accepts this token (its home was reset).
  daemon.disconnectAll(4001);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/didn't accept this token/);
  expect(screen.getByLabelText<HTMLInputElement>("ace address").value).toBe(url);
  expect(screen.queryByRole("link", { name: /Fix flaky checkout test/ })).toBeNull();
  within(alert).getByText(/copy it again/);
});
