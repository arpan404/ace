import { webcrypto } from "node:crypto";
import { FakeSpadeApi } from "@ace/fake-daemon";
import { ClientMessage, ServerMessage } from "@ace/protocol";
import { accountSessionKey } from "@/boot/account-config.ts";
import { fakeHostIds, fakeOrigin, fakePerson } from "@/boot/fake-account.ts";
import { proveFromWindow } from "@/boot/window-prover.ts";
import { windowSessionStorage } from "@/boot/window-session.ts";
import { fakeClient, harness } from "@/test/harness.tsx";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint, openSettingsPage } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  spade.addAgent({ id: "scout", name: "Scout" });
}

/** Scout's How it decides page, and its segmented "How it decides" control. */
async function scoutsChoice() {
  await userEvent.click(await botRow("Scout"));
  await openProfile("Scout");
  const profile = within(await screen.findByRole("region", { name: "Scout's profile" }));
  await openSettingsPage("How it decides");
  const section = (await profile.findByRole("heading", { name: "Decision mode" })).closest(
    "section",
  );
  if (!section) throw new Error("no Decision mode section");
  const decision = within(section);
  return {
    profile,
    decision,
    picker: await decision.findByRole("group", { name: "How it decides" }),
  };
}

async function chooseSegment(picker: HTMLElement, option: string) {
  await userEvent.click(within(picker).getByRole("button", { name: option }));
}

async function choose(picker: HTMLElement, option: string) {
  await userEvent.click(picker);
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("a bot starts on Auto-review, and Full access asks first, then says what still asks and shows in its conversation", async () => {
  const { spade } = await spadeApp("/spade", seed);
  const { profile, decision, picker } = await scoutsChoice();
  expect(
    within(picker).getByRole("button", { name: "Auto-review" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    decision.getByText(
      "A reviewer checks each step that changes something and decides for you. You're asked only if it refuses the same step twice, or for the three below.",
    ),
  ).toBeTruthy();
  expect(decision.queryByText(/Runs every step itself/)).toBeNull();
  // The "Always asks you" group lists the three boundaries that always ask.
  const alwaysSection = (await profile.findByRole("heading", { name: "Always asks you" })).closest(
    "section",
  );
  if (!alwaysSection) throw new Error("no Always asks you section");
  expect(within(alwaysSection).getByText("Pay")).toBeTruthy();
  expect(within(alwaysSection).getByText("Send as you")).toBeTruthy();
  expect(within(alwaysSection).getByText("Change access")).toBeTruthy();
  expect(
    within(alwaysSection).getByText("These always need your approval, even in Full access."),
  ).toBeTruthy();

  // Cancelling the confirmation changes nothing.
  await chooseSegment(picker, "Full access");
  let dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByRole("heading").textContent).toBe("Turn on Full access for Scout?");
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(spade.sent("PUT", "/v1/agents/scout/security/autonomy")).toEqual([]);

  await chooseSegment(picker, "Full access");
  dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText(/still asks before it pays, sends anything in your name/)).toBeTruthy();
  await userEvent.click(dialog.getByRole("button", { name: "Turn on Full access" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/scout/security/autonomy")).toEqual([
      { autonomy: "full_access" },
    ]),
  );
  expect(spade.security.autonomy("scout")).toBe("full_access");
  await waitFor(() =>
    expect(
      within(picker).getByRole("button", { name: "Full access" }).getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(
    decision.getByText(
      "Runs every step itself, inside or outside the sandbox, with nothing reviewed. Only the three below come to you.",
    ),
  ).toBeTruthy();
  expect(decision.queryByText(/A reviewer checks each step/)).toBeNull();
  // The conversation's pill says so, quietly.
  expect(
    await screen.findByRole("button", { name: "Open Scout's profile, Full access" }),
  ).toBeTruthy();
});

test("once the person confirmed Full access for a bot, turning it back on doesn't ask again, and Auto-review never asks", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.security.bot("scout").full_access_confirmed = true;
  });
  const { picker } = await scoutsChoice();
  await chooseSegment(picker, "Full access");
  await waitFor(() => expect(spade.security.autonomy("scout")).toBe("full_access"));
  expect(screen.queryByRole("dialog")).toBeNull();
  await chooseSegment(picker, "Auto-review");
  await waitFor(() => expect(spade.security.autonomy("scout")).toBe("auto_review"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(spade.sent("PUT", "/v1/agents/scout/security/autonomy")).toEqual([
    { autonomy: "full_access" },
    { autonomy: "auto_review" },
  ]);
});

test("Settings › Spade › Security sets how every bot without its own decides, after a confirmation", async () => {
  const { spade } = await spadeApp("/settings/spade/security", seed);
  const picker = await screen.findByRole("combobox", { name: "How they decide" });
  expect(picker.textContent).toContain("Auto-review");
  await choose(picker, "Full access");
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByRole("heading").textContent).toBe(
    "Turn on Full access for every bot that doesn't set its own?",
  );
  await userEvent.click(dialog.getByRole("button", { name: "Turn on Full access" }));
  await waitFor(() => expect(spade.security.botDefaults.autonomy).toBe("full_access"));
  expect(spade.security.autonomy("scout")).toBe("full_access");
});

afterEach(() => {
  windowSessionStorage().removeItem?.(accountSessionKey(fakeOrigin));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([false, true])(
  "Full access recovers when this window has a session already: %s",
  async (hasSession) => {
    const token = "t".repeat(43);
    const login = "i".repeat(43);
    const session = { token, account: fakePerson, expiresAt: Date.now() + 60_000 };
    let opened = false;
    vi.stubEnv("VITE_ACE_ACCOUNT_URL", fakeOrigin);
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("ace", {
      shell: {
        openExternal: async () => {
          opened = true;
        },
      },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/account/login")
        return Response.json({
          id: login,
          secret: "s".repeat(43),
          loginUrl: `${fakeOrigin}/v1/account/login?id=${login}`,
          expiresAt: session.expiresAt,
        });
      if (path === `/v1/account/login/${login}` && opened)
        return Response.json({ status: "complete", session });
      if (
        path === "/v1/grants" &&
        new Headers(init?.headers).get("authorization") === `Bearer ${token}`
      )
        return Response.json({ token: "device", standing: "person", expiresAt: session.expiresAt });
      return Response.json({ error: "unavailable" }, { status: 503 });
    });
    const app = harness({
      client: (daemon) => {
        const connect = daemon.connect.bind(daemon);
        vi.spyOn(daemon, "connect").mockImplementation((wire) => {
          const connection = connect({
            ...wire,
            send(text) {
              const message = ServerMessage.parse(JSON.parse(text));
              wire.send(
                message.type === "welcome"
                  ? JSON.stringify({
                      ...message,
                      standingHost: fakeHostIds.thisMac,
                      standingNonce: "n".repeat(22),
                    })
                  : text,
              );
            },
          });
          const receive = connection.receive.bind(connection);
          let proven = false;
          connection.receive = (text) => {
            const message = ClientMessage.parse(JSON.parse(text));
            if (message.type === "account.standing") {
              proven = message.grant === "person" && message.proof.length > 0;
              wire.send(
                JSON.stringify({
                  type: "account.standing.result",
                  requestId: message.requestId,
                  result: proven
                    ? { ok: true, until: session.expiresAt }
                    : { ok: false, code: "refused", message: "Refused" },
                }),
              );
              return;
            }
            if (message.type === "machine.code.status") {
              wire.send(
                JSON.stringify({
                  type: "machine.code.result",
                  requestId: message.requestId,
                  result: {
                    ok: true,
                    status: { signedIn: true, owner: null, machineCode: { set: false } },
                  },
                }),
              );
              return;
            }
            if (
              !proven &&
              message.type === "spade.http" &&
              message.path === "/v1/security/autonomy"
            ) {
              wire.send(
                JSON.stringify({
                  type: "spade.http.result",
                  requestId: message.requestId,
                  result: {
                    kind: "error",
                    code: "forbidden",
                    message: "Confirm your identity to continue.",
                  },
                }),
              );
              return;
            }
            receive(text);
          };
          return connection;
        });
        return proveFromWindow(fakeClient(daemon));
      },
    });
    app.daemon.spade.status = { state: "ready", version: "0.6.0" };
    const spade = new FakeSpadeApi(app.daemon.spade, Date.now);
    seed(spade);
    await app.open("/settings/spade/security");
    await waitFor(() => expect(app.client.state).toBe("ready"));
    await app.client.request({
      type: "settings.set",
      key: "spade.enabled",
      value: true,
      layer: { kind: "global" },
    });
    const picker = await screen.findByRole("combobox", { name: "How they decide" });
    // A session that arrived after the socket's initial proof gets another chance.
    if (hasSession)
      windowSessionStorage().setItem(accountSessionKey(fakeOrigin), JSON.stringify(session));
    await choose(picker, "Full access");
    await userEvent.click(await screen.findByRole("button", { name: "Turn on Full access" }));
    if (!hasSession) {
      const confirm = await screen.findByRole("button", { name: "Confirm it's you" });
      expect(await screen.findByText(/This Mac will be yours/)).toBeTruthy();
      expect(spade.security.botDefaults.autonomy).toBe("auto_review");
      await userEvent.click(confirm);
    }
    await waitFor(() => expect(picker.textContent).toContain("Full access"));
    expect(spade.sent("PUT", "/v1/security/autonomy")).toEqual([{ autonomy: "full_access" }]);
    expect(opened).toBe(!hasSession);
    expect(screen.queryByRole("button", { name: "Confirm it's you" })).toBeNull();
  },
);
