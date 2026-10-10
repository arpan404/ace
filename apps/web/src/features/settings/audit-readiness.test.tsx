import { workbench } from "@ace/fake-daemon";
import { act, screen, waitFor, configure } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { ClientMessage, ServerMessage } from "@ace/protocol";

configure({ asyncUtilTimeout: 5000 });
beforeEach(() => localStorage.clear());
function app() {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  return made;
}

test("Providers still lists installed CLIs when account reads fail", async () => {
  const made = app();
  made.daemon.refuseRequests("accounts_failed", "accounts.list");
  await made.open("/settings/providers");
  expect(await screen.findByRole("link", { name: "Claude Code" })).toBeTruthy();
  expect(screen.queryByText("Couldn't check providers. Try again.")).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("group", { name: "Claude Code" }).textContent).toContain("2.1.4"),
  );
});

test("a failed provider read offers Check again and recovers without reconnecting", async () => {
  const made = app();
  made.daemon.failRequests("providers.request");
  await made.open("/settings/providers");
  await screen.findByText("Couldn't check providers. Try again.");
  made.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("link", { name: "Claude Code" })).toBeTruthy();
});

test("General says providers could not be checked and retries the read", async () => {
  const made = app();
  made.daemon.failRequests("providers.request");
  await made.open("/settings/general");
  await screen.findByText("Couldn't check providers");
  expect(screen.queryByText("No provider CLI installed")).toBeNull();
  made.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("combobox", { name: "Default provider for new threads" }),
  ).toBeTruthy();
});

test("the model chip treats an ok false catalog reply as a failure and Retry loads models", async () => {
  const made = app();
  let refuse = true;
  const connect = made.daemon.connect.bind(made.daemon);
  made.daemon.connect = (wire) => {
    const connection = connect(wire);
    const receive = connection.receive.bind(connection);
    connection.receive = (text) => {
      const message = ClientMessage.parse(JSON.parse(text));
      if (message.type === "models.list" && refuse)
        wire.send(
          JSON.stringify(
            ServerMessage.parse({
              type: "models.result",
              requestId: message.requestId,
              result: { ok: false, reason: "Model catalog is not configured" },
            }),
          ),
        );
      else receive(text);
    };
    return connection;
  };
  await made.open("/new?project=relay");
  await screen.findByText("Couldn't load models");
  expect(screen.queryByText("No provider CLI installed")).toBeNull();
  refuse = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: /^Model: Opus/ })).toBeTruthy();
});

test("Usage leaves loading and shows accounts when readiness alone fails", async () => {
  const made = app();
  made.daemon.failRequests("providers.request");
  await made.open("/accounts");
  expect(await screen.findAllByRole("article")).toBeTruthy();
});

test("failed settings show a retry action and recover their saved value", async () => {
  const made = app();
  made.daemon.failRequests("settings.subscribe");
  await made.open("/settings/general");
  const errors = await screen.findAllByText("Couldn't load settings");
  expect(errors.length).toBeGreaterThan(0);
  act(() => made.daemon.restoreRequests());
  const retry = screen.getAllByRole("button", { name: "Retry" })[0];
  if (!retry) throw new Error("Missing retry");
  await userEvent.click(retry);
  await waitFor(() => expect(screen.queryByText("Couldn't load settings")).toBeNull());
});

test("a failed provider check keeps its loaded rows and reports the failed check", async () => {
  const made = app();
  await made.open("/settings/providers");
  await screen.findByRole("link", { name: "Claude Code" });
  await waitFor(() =>
    expect(screen.getByRole("group", { name: "Claude Code" }).textContent).toContain("2.1.4"),
  );
  made.daemon.failRequests("providers.request");
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  await screen.findByRole("heading", { name: "Couldn't check providers" });
  expect(screen.getByRole("link", { name: "Claude Code" })).toBeTruthy();
}, 10000);

test("New thread keeps approvals pending while its starting provider is unknown", async () => {
  const made = app();
  made.daemon.holdRequests("providers.request");
  await made.open("/new?project=relay");
  expect(await screen.findByRole("button", { name: "Approvals: Approvals…" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Permissions unavailable/ })).toBeNull();
});

test("Usage explains account read errors without exposing protocol codes", async () => {
  const made = app();
  made.daemon.refuseRequests("accounts_failed", "accounts.list");
  await made.open("/accounts");
  expect(
    await screen.findByText("Couldn't read that account. Check its folder and try again."),
  ).toBeTruthy();
  expect(screen.queryByText("accounts_failed")).toBeNull();
});

test("a failed live provider refetch preserves the discovered rows", async () => {
  const made = app();
  const connect = made.daemon.connect.bind(made.daemon);
  let push: ((message: ServerMessage) => void) | undefined;
  let failures = 0;
  const failed = Promise.withResolvers<void>();
  made.daemon.connect = (wire) => {
    push = (message) => wire.send(JSON.stringify(message));
    return connect({
      ...wire,
      send(text) {
        const message = ServerMessage.parse(JSON.parse(text));
        if (message.type === "error" && message.code === "unavailable" && ++failures === 2)
          failed.resolve();
        wire.send(text);
      },
    });
  };
  await made.open("/settings/providers");
  await screen.findByRole("link", { name: "Claude Code" });
  const readiness = await made.client.request({
    type: "providers.request",
    operation: "readiness",
  });
  if (!readiness.result.ok) throw new Error("Missing readiness fixture");
  const providers = readiness.result.providers;
  made.daemon.failRequests("providers.request");
  await act(async () => {
    push?.({ type: "providers.changed", providers });
    await failed.promise;
  });
  expect(screen.getByRole("link", { name: "Claude Code" })).toBeTruthy();
  expect(screen.queryByText("Couldn't check providers. Try again.")).toBeNull();
});

test("a committed account limit push updates Usage without reading its history again", async () => {
  const made = app();
  const requests: ClientMessage["type"][] = [];
  const connect = made.daemon.connect.bind(made.daemon);
  made.daemon.connect = (wire) => {
    const connection = connect(wire);
    const receive = connection.receive.bind(connection);
    connection.receive = (text) => {
      requests.push(ClientMessage.parse(JSON.parse(text)).type);
      receive(text);
    };
    return connection;
  };
  await made.open("/accounts");
  await screen.findAllByRole("article");
  await screen.findByText("Reported cost");
  requests.length = 0;
  const account = made.daemon.services.accounts[0];
  if (!account) throw new Error("Missing account fixture");
  await act(async () => {
    made.daemon.services.updateQuota(account.id, { ...account.quota, observedAt: Date.now() });
    await made.client.request({ type: "providers.request", operation: "list" });
  });
  expect(requests.filter((type) => type.startsWith("usage."))).toEqual([]);
});

test("General keeps its provider choice through a failed live refetch", async () => {
  const made = app();
  const connect = made.daemon.connect.bind(made.daemon);
  let publish: ((message: ServerMessage) => void) | undefined;
  made.daemon.connect = (wire) => {
    const connection = connect(wire);
    publish = (message) => connection.push(message);
    return connection;
  };
  await made.open("/settings/general");
  await screen.findByRole("combobox", { name: "Default provider for new threads" });
  const readiness = await made.client.request({
    type: "providers.request",
    operation: "readiness",
  });
  if (!readiness.result.ok) throw new Error("Missing readiness fixture");
  const providers = readiness.result.providers;
  let failures = 0;
  const failed = Promise.withResolvers<void>();
  const stop = made.client.onMessage((message) => {
    if (message.type === "error" && message.code === "unavailable" && ++failures === 2)
      failed.resolve();
  });
  made.daemon.failRequests("providers.request");
  await act(async () => {
    publish?.({ type: "providers.changed", providers });
    await failed.promise;
  });
  stop();
  expect(screen.getByRole("combobox", { name: "Default provider for new threads" })).toBeTruthy();
  expect(screen.queryByText("No provider CLI installed")).toBeNull();
});
