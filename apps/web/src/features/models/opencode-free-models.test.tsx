import { chooseSource } from "@/test/model-control.ts";
import { replayCursor } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openModelControl, openModelPicker } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

function freeModels(app: ReturnType<typeof harness>) {
  const sample = app.daemon.services.models.find(
    (model) => model.source?.service === "opencode_zen",
  );
  const status = app.daemon.services.providerStatuses.find((row) => row.provider === "opencode");
  if (!sample || !status || !sample.source) throw new Error("Missing OpenCode fixture");
  app.daemon.services.models = [
    ...app.daemon.services.models.filter((model) => model.provider !== "opencode"),
    ...["Big Pickle", "MiMo Free", "Ling Free"].map((name, index) =>
      Object.assign({}, sample, {
        id: `opencode/free-${index}`,
        nativeModelId: `opencode/free-${index}`,
        displayName: name,
        free: true,
        isDefault: index === 0,
        tier: "current" as const,
        legacy: false,
        deprecated: false,
        source: {
          ...sample.source,
          kind: "api_key" as const,
          id: "opencode",
          label: "OpenCode Zen",
          service: "opencode_zen" as const,
          requiresAuth: false,
        },
      }),
    ),
  ];
  Object.assign(status, {
    auth: "logged_out",
    modelsAvailable: true,
    state: undefined,
    actionId: undefined,
  });
}

test("signed-out OpenCode offers selectable Free rows from Zen", async () => {
  const app = harness();
  freeModels(app);
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const popover = await openModelControl(/^Model: Opus 5\.5, Personal/);
  const list = await openModelPicker(popover);
  await chooseSource(popover, "OpenCode");
  const model = within(list).getByRole("option", { name: /^Big Pickle, Free/ });
  expect(model.getAttribute("aria-label")).toContain("OpenCode Zen");
  expect(model.getAttribute("aria-label")).toContain("Free");
  expect(model.getAttribute("aria-disabled")).toBeNull();
  await userEvent.click(model);
  const dialog = await screen.findByRole("dialog", { name: "Switch to OpenCode?" });
  expect(within(dialog).getByText("Model: Big Pickle")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Switch to OpenCode" }));
  expect(await screen.findByRole("button", { name: /^Model: Big Pickle/ })).toBeTruthy();
  expect(screen.queryByText("OpenCode isn't signed in. Sign in to start this thread.")).toBeNull();
});

test("new and free metadata stays readable without crowding the model name and source", async () => {
  const app = harness();
  freeModels(app);
  app.daemon.services.models = app.daemon.services.models.map((model) =>
    model.displayName === "Big Pickle"
      ? { ...model, isNew: true, detail: "Preview snapshot with extended context" }
      : model,
  );
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const popover = await openModelControl(/^Model: Opus 5\.5, Personal/);
  const list = await openModelPicker(popover);
  await chooseSource(popover, "OpenCode");
  const model = within(list).getByRole("option", {
    name: /^Big Pickle, New, Free, Preview snapshot with extended context/,
  });
  expect(model.textContent).toContain("Big Pickle");
  expect(model.getAttribute("aria-label")).toContain("OpenCode · OpenCode Zen");
  expect(model.textContent).not.toMatch(/NEW|New|Free|Preview snapshot/);
  expect(model.getAttribute("aria-label")).toContain(
    "New, Free, Preview snapshot with extended context",
  );
  expect(model.getAttribute("aria-disabled")).toBeNull();
});

test("OpenCode with only free models is ready and offers connecting a service as an optional action", async () => {
  const app = harness();
  freeModels(app);
  await app.open("/settings/providers/opencode");
  const services = await screen.findByRole("list", { name: "OpenCode services" });
  expect(within(services).getByRole("img", { name: "OpenCode Zen" })).toBeTruthy();
  expect(within(services).queryByRole("button", { name: "Disconnect OpenCode Zen" })).toBeNull();
  expect(screen.queryByText("Sign in to use OpenCode")).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Manage" }));
  const models = await screen.findByRole("list", { name: "Models" });
  for (const name of ["Big Pickle", "MiMo Free", "Ling Free"])
    expect(within(models).getByText(name)).toBeTruthy();
  expect(
    app.daemon.services.models
      .filter((model) => model.provider === "opencode")
      .every((model) => model.free && model.source?.requiresAuth === false),
  ).toBe(true);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(within(services).getByRole("button", { name: "Connect a service" }));
  expect(await screen.findByRole("dialog", { name: "Sign in to OpenCode" })).toBeTruthy();
});
