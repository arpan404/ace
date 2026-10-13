import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import {
  chooseAccount,
  chooseModel,
  closeModelControl,
  openModelControl,
} from "@/test/model-control.ts";

configure({ asyncUtilTimeout: 10000 });

test.each(["Manual", "Provider default"])(
  "an account without the selected restrictive mode blocks a new thread until explicitly choosing %s",
  async (replacement) => {
    const made = harness();
    for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
    made.daemon.services.settings.seed({
      "permissions.providerModes": { claude: "bypassPermissions" },
    });
    const handle = made.daemon.services.handle.bind(made.daemon.services);
    vi.spyOn(made.daemon.services, "handle").mockImplementation((message, push, device) => {
      if (message.type === "permissions.capabilities" && message.instanceId === "claude-work") {
        push({
          type: "permissions.capabilities.result",
          requestId: message.requestId,
          ok: true,
          permissions: {
            modes: replacement === "Provider default" ? [] : ["default", "bypassPermissions"],
            permissionModes:
              replacement === "Provider default"
                ? []
                : [
                    {
                      id: "default",
                      label: "Manual",
                      description: "Ask before actions",
                      risk: "low",
                    },
                    {
                      id: "bypassPermissions",
                      label: "Full access",
                      description: "No prompts",
                      risk: "high",
                    },
                  ],
            nativeAutoReview: false,
            toolGate: true,
          },
        });
        return true;
      }
      return handle(message, push, device);
    });
    await made.open("/new?project=relay");
    await userEvent.click(await screen.findByRole("button", { name: "Approvals: Full access" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Plan" }));
    const input = await screen.findByRole("combobox", { name: "Message" });
    await userEvent.type(input, "Keep this restrictive draft");
    await chooseAccount(await openModelControl(/^Model: Opus 5\.5, Personal/), "Work");
    await closeModelControl();
    const unavailable = await screen.findByRole("button", {
      name: "Approvals: Unavailable mode: plan",
    });
    expect(unavailable.getAttribute("aria-description")).toBe(
      "Claude Code doesn't offer this mode",
    );
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(send);
    await userEvent.click(input);
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "New thread", level: 1 })).toBeTruthy();
    expect(input.textContent).toBe("Keep this restrictive draft");
    const created = () => {
      const view = made.daemon.snapshot({ kind: "threads" });
      return view?.kind === "threads"
        ? Object.values(view.threads).find(
            (thread) => thread.title === "Keep this restrictive draft",
          )
        : undefined;
    };
    expect(created()).toBeUndefined();
    await userEvent.click(unavailable);
    await userEvent.click(await screen.findByRole("menuitemradio", { name: replacement }));
    await waitFor(() => expect(send.getAttribute("aria-disabled")).not.toBe("true"));
    await userEvent.click(send);
    await waitFor(() => expect(created()?.live?.account).toBe("claude-work"));
    expect(created()?.permission).toMatchObject(
      replacement === "Manual"
        ? { override: "default", effective: "default" }
        : { override: null, effective: "bypassPermissions" },
    );
  },
);

test("switching provider keeps an unavailable native selection until an explicit supported replacement", async () => {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  await made.open("/new?project=relay");
  await userEvent.click(await screen.findByRole("button", { name: "Approvals: Provider default" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Plan" }));
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 5.5/);
  await closeModelControl();
  const input = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(input, "Review before changing providers{Enter}");
  const unavailable = await screen.findByRole("button", {
    name: "Approvals: Unavailable mode: plan",
  });
  expect(unavailable.getAttribute("aria-description")).toBe("Codex doesn't offer this mode");
  expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("heading", { name: "New thread", level: 1 })).toBeTruthy();
  await userEvent.click(unavailable);
  expect(screen.queryByRole("menuitemradio", { name: "Plan" })).toBeNull();
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Read only" }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    const view = made.daemon.snapshot({ kind: "threads" });
    const created =
      view?.kind === "threads"
        ? Object.values(view.threads).find(
            (thread) => thread.title === "Review before changing providers",
          )
        : undefined;
    expect(created).toMatchObject({
      provider: "codex",
      permission: { override: ":read-only", effective: ":read-only" },
    });
  });
});

test("a native ACP read-only ID cannot become Cursor workspace access on a provider switch", async () => {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  const template = made.daemon.services.models.find((model) => model.provider === "acp");
  if (!template) throw new Error("fixture has an ACP model");
  made.daemon.services.models = [
    ...made.daemon.services.models.filter((model) => model.provider !== "acp"),
    {
      ...template,
      id: "bridge-codex",
      displayName: "Bridge Codex",
      nativeModelId: "gpt-6",
      acpAgentId: "official:codex-acp",
    },
  ];
  made.daemon.services.accounts = made.daemon.services.accounts.map((account) =>
    account.provider === "acp"
      ? { ...account, acpAgentId: "official:codex-acp", label: "Codex bridge" }
      : account,
  );
  const handle = made.daemon.services.handle.bind(made.daemon.services);
  vi.spyOn(made.daemon.services, "handle").mockImplementation((message, push, device) => {
    if (message.type === "permissions.capabilities" && message.provider === "acp") {
      push({
        type: "permissions.capabilities.result",
        requestId: message.requestId,
        ok: true,
        permissions: {
          modes: ["read-only"],
          permissionModes: [
            {
              id: "read-only",
              label: "Read only",
              description: "Codex bridge reads files without workspace writes",
              risk: "low",
            },
          ],
          nativeAutoReview: false,
          toolGate: true,
        },
      });
      return true;
    }
    return handle(message, push, device);
  });
  await made.open("/new?project=relay");
  await chooseModel("Bridge Codex", "ACP agent", /^Model: Opus 5.5/);
  await closeModelControl();
  await userEvent.click(await screen.findByRole("button", { name: "Approvals: Provider default" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Read only" }));
  expect(await screen.findByRole("button", { name: "Approvals: Read only" })).toBeTruthy();
  const input = screen.getByRole("combobox", { name: "Message" });
  await userEvent.type(input, "Keep the bridge read-only choice");
  await chooseModel("Composer 2.5", "Cursor", /^Model: Bridge Codex/);
  await closeModelControl();
  const unavailable = await screen.findByRole("button", {
    name: "Approvals: Unavailable mode: read-only",
  });
  expect(unavailable.getAttribute("aria-description")).toBe("Cursor doesn't offer this mode");
  const send = screen.getByRole("button", { name: "Send" });
  expect(send.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(send);
  await userEvent.click(input);
  await userEvent.keyboard("{Enter}");
  expect(input.textContent).toBe("Keep the bridge read-only choice");
  expect(screen.getByRole("heading", { name: "New thread", level: 1 })).toBeTruthy();
  const created = () => {
    const view = made.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads"
      ? Object.values(view.threads).find(
          (thread) => thread.title === "Keep the bridge read-only choice",
        )
      : undefined;
  };
  expect(created()).toBeUndefined();
  await userEvent.click(unavailable);
  expect(screen.queryByRole("menuitemradio", { name: "Read only" })).toBeNull();
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Sandbox enabled" }));
  await waitFor(() => expect(send.getAttribute("aria-disabled")).not.toBe("true"));
  await userEvent.click(send);
  await waitFor(() => expect(created()?.provider).toBe("cursor"));
  expect(created()?.permission?.override).toBe(
    '{"sandboxOptions":{"enabled":true},"autoReview":false}',
  );
});
