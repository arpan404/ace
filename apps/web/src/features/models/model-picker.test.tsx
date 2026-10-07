import { replayCursor } from "@ace/fake-daemon";
import type { CatalogModel } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { closeModelControl, openModelControl, openModelPicker } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

type Harness = ReturnType<typeof harness>;

async function openThread(app: Harness) {
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
}

/** A Claude Code thread mid-turn, on its personal account's default, with the picker open. */
async function openPicker(app = harness()) {
  await openThread(app);
  const popover = await openModelControl(/^Model: Opus 5\.5, personal/);
  const list = await openModelPicker(popover);
  return { app, popover, list };
}

const names = (within_: HTMLElement) =>
  within(within_)
    .getAllByRole("option")
    .map((option) => option.getAttribute("aria-label"));
const group = (list: HTMLElement, name: string) => within(list).getByRole("group", { name });
const groupNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole("group")
    .filter((element) => element.parentElement === list)
    .map((element) => element.getAttribute("aria-label"));

test("models read by name with their snapshot as a quiet detail, each account apart, and the default chosen", async () => {
  const { popover, list } = await openPicker();
  expect(within(popover).getByRole("tab", { name: "Claude Code" }).ariaSelected).toBe("true");
  expect(groupNames(list)).toEqual(["Personal", "Work"]);
  const personal = group(list, "Personal");
  expect(names(personal)).toEqual([
    "Opus 5.5, default, Claude Code",
    "Sonnet 5.5, Claude Code",
    "Haiku 4.5, 20251001, Claude Code",
    "Legacy models, 6",
  ]);
  // The concrete default is chosen; there is no stand-in "default" entry and no raw id.
  expect(within(personal).getByRole("option", { name: /^Opus 5\.5/ }).ariaSelected).toBe("true");
  expect(within(group(list, "Work")).getByRole("option", { name: /^Opus 5\.5/ }).ariaSelected).toBe(
    "false",
  );
  const shown = names(list).join("\n");
  expect(shown).not.toMatch(/^Default|Claude Code · Default|recommended/im);
  expect(list.textContent).not.toMatch(/claude-|Haiku 4\.5\.20251001/);
  expect(within(personal).getByText("20251001")).toBeTruthy();
});

test("Legacy models open in place; an older model picked there stays checked when the picker opens again", async () => {
  const { popover, list } = await openPicker();
  const personal = group(list, "Personal");
  const toggle = within(personal).getByRole("option", { name: "Legacy models, 6" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(within(personal).queryByRole("option", { name: /^Opus 4\.8/ })).toBeNull();

  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const legacy = within(personal).getByRole("group", { name: "Legacy models" });
  expect(names(legacy)).toEqual([
    "Opus 5, Claude Code",
    "Opus 4.8, Claude Code",
    "Opus 4.6, Claude Code",
    "Opus 4.1, Claude Code",
    "Opus 4, Claude Code",
    "Sonnet 4.5, Claude Code",
  ]);
  await userEvent.click(within(legacy).getByRole("option", { name: /^Opus 4\.8/ }));
  expect(await screen.findByRole("button", { name: /^Model: Opus 4\.8, personal/ })).toBeTruthy();
  expect(
    await within(popover).findByRole("button", { name: "Change model: Opus 4.8" }),
  ).toBeTruthy();

  await closeModelControl();
  const again = await openModelPicker(await openModelControl(/^Model: Opus 4\.8/));
  const reopened = within(group(again, "Personal")).getByRole("group", { name: "Legacy models" });
  expect(within(reopened).getByRole("option", { name: /^Opus 4\.8/ }).ariaSelected).toBe("true");
});

test("the keyboard reaches Legacy models: → opens them, ← closes them, Enter picks an older model", async () => {
  const { popover } = await openPicker();
  const search = within(popover).getByRole("combobox", { name: "Search models" });
  const active = () => document.getElementById(search.getAttribute("aria-activedescendant") ?? "");
  expect(document.activeElement).toBe(search);
  expect(active()?.getAttribute("aria-label")).toBe("Opus 5.5, default, Claude Code");

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  expect(active()?.getAttribute("aria-label")).toBe("Legacy models, 6");
  await userEvent.keyboard("{ArrowRight}");
  expect(active()?.getAttribute("aria-label")).toBe("Opus 5, Claude Code");
  expect(
    within(popover).getAllByRole("option", { name: "Legacy models, 6" })[0]?.ariaExpanded,
  ).toBe("true");

  await userEvent.keyboard("{ArrowLeft}");
  expect(active()?.getAttribute("aria-label")).toBe("Legacy models, 6");
  expect(active()?.getAttribute("aria-expanded")).toBe("false");

  await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Model: Opus 4\.8, personal/ })).toBeTruthy(),
  );
});

test("a row under another account moves the thread to that account", async () => {
  const { list } = await openPicker();
  await userEvent.click(within(group(list, "Work")).getByRole("option", { name: /^Sonnet 5\.5/ }));
  expect(await screen.findByRole("button", { name: /^Model: Sonnet 5\.5, work/ })).toBeTruthy();
});

test("OpenCode lists its models by source, and a failing source says why beside its last models", async () => {
  const { popover, list } = await openPicker();
  await userEvent.click(within(popover).getByRole("tab", { name: "OpenCode" }));
  expect(groupNames(list)).toEqual([
    "Local",
    "OpenCode Go",
    "OpenCode Zen",
    "Anthropic",
    "OpenAI",
    "OpenRouter",
  ]);
  // Two local runtimes serve the same model: each row says which.
  expect(names(group(list, "Local"))).toEqual([
    "Qwen3 235B A22B, LM Studio, OpenCode",
    "Qwen3 235B A22B, Ollama, OpenCode",
    "Qwen2 72B, LM Studio, OpenCode",
    "Qwen2 72B, Ollama, OpenCode",
  ]);
  const openRouter = group(list, "OpenRouter");
  expect(within(openRouter).getByText("OpenRouter could not be reached.")).toBeTruthy();
  expect(within(openRouter).getByText(/Check your network and refresh models\./)).toBeTruthy();
  expect(openRouter.getAttribute("aria-describedby")).toBeTruthy();
  expect(names(openRouter)).toEqual([
    "Opus 5.5, OpenCode",
    "Sonnet 4.5, OpenCode",
    "Legacy models, 1",
  ]);
  expect(within(group(list, "Anthropic")).queryByText(/could not be reached/)).toBeNull();
});

test("Pi groups its models by the provider it is signed in to", async () => {
  const { popover, list } = await openPicker();
  await userEvent.click(within(popover).getByRole("tab", { name: "Pi" }));
  expect(groupNames(list)).toEqual(["GitHub Copilot", "Anthropic"]);
  expect(names(group(list, "GitHub Copilot"))).toEqual([
    "Opus 5.5, Pi",
    "Haiku 4.5, Pi",
    "Legacy models, 1",
  ]);
  // A provider that isn't installed has nothing to pick.
  const antigravity = within(popover).getByRole("tab", { name: "Antigravity" });
  expect(antigravity.getAttribute("aria-disabled")).toBe("true");
});

test("a provider whose sign-in expired says so and how to fix it, and Refresh models discovers again", async () => {
  const app = harness();
  const { popover, list } = await openPicker(app);
  await userEvent.click(within(popover).getByRole("tab", { name: "Cursor" }));
  expect(within(list).getByText("Cursor sign-in has expired.")).toBeTruthy();
  expect(within(list).getByText(/Sign in using Cursor, then refresh models\./)).toBeTruthy();
  expect(within(list).getByRole("option", { name: /^Composer 2\.5/ })).toBeTruthy();

  // The CLI now lists a model it didn't before; a refresh finds it.
  const composer = app.daemon.services.models.find((model) => model.id === "composer-2.5");
  if (!composer) throw new Error("no Composer 2.5 in the fixture");
  app.daemon.services.models.push({
    ...composer,
    id: "composer-3",
    nativeModelId: "composer-3",
    displayName: "Composer 3",
    isDefault: false,
  });
  await userEvent.click(within(popover).getByRole("button", { name: "Refresh models" }));
  expect(await within(list).findByRole("option", { name: /^Composer 3/ })).toBeTruthy();
});

test("a provider whose discovery failed with no models left still opens, to say why", async () => {
  const app = harness();
  const services = app.daemon.services;
  const handle = services.handle.bind(services);
  services.handle = (message, push) =>
    message.type !== "models.list"
      ? handle(message, push)
      : handle(message, (reply) =>
          reply.type === "models.result" && "models" in reply.result
            ? push({
                ...reply,
                result: {
                  ...reply.result,
                  models: reply.result.models.filter((model) => model.provider !== "cursor"),
                },
              })
            : push(reply),
        );
  const { popover, list } = await openPicker(app);
  const cursor = within(popover).getByRole("tab", { name: "Cursor" });
  expect(cursor.getAttribute("aria-disabled")).toBeNull();
  await userEvent.click(cursor);
  expect(within(list).getByText("Cursor sign-in has expired.")).toBeTruthy();
  expect(within(list).queryByRole("option")).toBeNull();
  expect(within(list).queryByText("No models")).toBeNull();
});

test("while a refresh runs the picker says so and Refresh models waits for it", async () => {
  const app = harness();
  app.daemon.holdRequests("models.refresh");
  const { popover } = await openPicker(app);
  const refresh = within(popover).getByRole("button", { name: "Refresh models" });
  await userEvent.click(refresh);
  expect(await within(popover).findByRole("status", { name: "Refreshing models" })).toBeTruthy();
  expect(refresh.ariaDisabled === "true" || refresh.hasAttribute("disabled")).toBe(true);
});

test("a device that may only read is told it can't refresh models", async () => {
  const app = harness();
  app.daemon.refuseRequests("forbidden", "models.refresh");
  const { popover } = await openPicker(app);
  const refresh = within(popover).getByRole("button", { name: "Refresh models" });
  await userEvent.click(refresh);
  await waitFor(() =>
    expect(refresh.ariaDisabled === "true" || refresh.hasAttribute("disabled")).toBe(true),
  );
  await userEvent.unhover(refresh);
  await userEvent.hover(refresh);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "This device can view models but not refresh them",
  );
});

/** A model the Claude Code CLI starts listing on the personal account. */
function discoverOpus6(app: Harness) {
  const opus = app.daemon.services.models.find(
    (model) => model.instance === "claude-personal" && model.id === "claude-opus-5-5",
  );
  if (!opus) throw new Error("no Opus 5.5 in the fixture");
  const row: CatalogModel = {
    ...opus,
    id: "claude-opus-6",
    nativeModelId: "claude-opus-6",
    displayName: "Opus 6",
    version: "6",
    sortKey: "0:000:0:claude-opus:000000",
    isDefault: false,
  };
  app.daemon.services.models.push(row);
}

test("a catalog change the daemon announces shows in the open picker without reopening it", async () => {
  const app = harness();
  const { list } = await openPicker(app);
  discoverOpus6(app);
  // The daemon revalidates on its own (another device, a CLI update) and announces the change.
  app.daemon.services.handle(
    {
      type: "models.refresh",
      requestId: "background",
      filter: { provider: "claude", instance: "claude-personal" },
    },
    () => {},
  );
  expect(
    await within(group(list, "Personal")).findByRole("option", { name: /^Opus 6\b/ }),
  ).toBeTruthy();
  expect(within(group(list, "Work")).queryByRole("option", { name: /^Opus 6/ })).toBeNull();
});

test("after a reconnect the catalog is read again, so a change missed meanwhile shows", async () => {
  const app = harness();
  const { list } = await openPicker(app);
  discoverOpus6(app);
  app.daemon.disconnectAll();
  expect(
    await within(group(list, "Personal")).findByRole(
      "option",
      { name: /^Opus 6\b/ },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
}, 15_000);

test("search finds models across every provider, older ones last and marked", async () => {
  const { popover, list } = await openPicker();
  const search = within(popover).getByRole("combobox", { name: "Search models" });
  await userEvent.type(search, "sonnet");
  expect(names(list)).toEqual([
    "Sonnet 5.5, Claude Code",
    "Sonnet 4.5, OpenCode · Anthropic",
    "Sonnet 4.5, OpenCode · OpenCode Zen",
    "Sonnet 4.5, OpenCode · OpenRouter",
    "Sonnet 4.5, Claude Code · Legacy",
  ]);
  await userEvent.type(search, "zzz");
  expect(within(popover).getByText("No models match “sonnetzzz”")).toBeTruthy();
});

test("a starred model is kept under Favorites, also the next time the picker opens", async () => {
  const { popover, list } = await openPicker();
  await userEvent.click(
    within(group(list, "Personal")).getByRole("button", { name: "Add Haiku 4.5 to favorites" }),
  );
  await userEvent.click(within(popover).getByRole("tab", { name: "Codex" }));
  await userEvent.click(
    within(group(list, "Personal")).getByRole("button", { name: "Add GPT-6 Luna to favorites" }),
  );
  await closeModelControl();

  const again = await openModelPicker(await openModelControl(/^Model: Opus 5\.5/));
  await userEvent.click(screen.getByRole("tab", { name: "Favorites" }));
  expect(names(again)).toEqual(["Haiku 4.5, 20251001, Claude Code", "GPT-6 Luna, Codex"]);
  await userEvent.click(
    within(again).getByRole("button", { name: "Remove Haiku 4.5 from favorites" }),
  );
  expect(names(again)).toEqual(["GPT-6 Luna, Codex"]);
});

test("⌘ and a number pick that row, and the popover comes back to its effort", async () => {
  const { popover } = await openPicker();
  await userEvent.keyboard("{Meta>}2{/Meta}");
  expect(await screen.findByRole("button", { name: /^Model: Sonnet 5\.5, personal/ })).toBeTruthy();
  expect(
    await within(popover).findByRole("button", { name: "Change model: Sonnet 5.5" }),
  ).toBeTruthy();
});

test("the provider column moves with the arrow keys", async () => {
  const { popover, list } = await openPicker();
  within(popover).getByRole("tab", { name: "Claude Code" }).focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(within(popover).getByRole("tab", { name: "Codex" }));
  expect(names(group(list, "Personal"))).toEqual([
    "GPT-6.1 Sol, default, Codex",
    "GPT-5 Codex, Codex",
    "GPT-6, Codex",
    "GPT-6 Luna, Codex",
    "Legacy models, 4",
  ]);
});

test("Escape clears a search first, then closes the popover", async () => {
  const { popover, list } = await openPicker();
  const search = within(popover).getByRole("combobox", { name: "Search models" });
  await userEvent.type(search, "gpt");
  await userEvent.keyboard("{Escape}");
  expect((search as HTMLInputElement).value).toBe("");
  expect(names(list)).toContain("Opus 5.5, default, Claude Code");
  expect(screen.getByRole("dialog", { name: "Model and effort" })).toBe(popover);
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Model and effort" })).toBeNull(),
  );
});

test("Escape clears a search even with focus on a row's star, and the next one closes", async () => {
  const { popover, list } = await openPicker();
  const search = within(popover).getByRole("combobox", { name: "Search models" });
  await userEvent.type(search, "sonnet 5");
  // Past Refresh models to the highlighted row's star.
  await userEvent.tab();
  await userEvent.tab();
  expect(document.activeElement).toBe(
    within(list).getByRole("button", { name: "Add Sonnet 5.5 to favorites" }),
  );
  await userEvent.keyboard("{Escape}");
  expect((search as HTMLInputElement).value).toBe("");
  expect(document.activeElement).toBe(search);
  expect(screen.getByRole("dialog", { name: "Model and effort" })).toBe(popover);
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Model and effort" })).toBeNull(),
  );
});

/**
 * Holds every `models.list` reply until `release`, then answers with ten more Claude models
 * than the fixture has, as a long catalog would.
 */
function holdCatalog(app: Harness) {
  const services = app.daemon.services;
  const handle = services.handle.bind(services);
  const held: (() => void)[] = [];
  let settled = false;
  services.handle = (message, push) => {
    if (message.type !== "models.list" || settled) return handle(message, push);
    held.push(() =>
      handle(message, (reply) => {
        if (reply.type !== "models.result" || !("models" in reply.result)) return push(reply);
        const first = reply.result.models[0];
        const more = first
          ? Array.from({ length: 10 }, (_, at) => ({
              ...first,
              id: `${first.id}-extra-${at}`,
              nativeModelId: `${first.nativeModelId}-extra-${at}`,
              displayName: `Extra ${at}`,
              isDefault: false,
            }))
          : [];
        push({ ...reply, result: { ...reply.result, models: [...reply.result.models, ...more] } });
      }),
    );
    return true;
  };
  return () => {
    settled = true;
    for (const release of held.splice(0)) release();
  };
}

/** The picker panel's reserved height, as laid out. */
const panelHeight = (popover: HTMLElement) =>
  popover.querySelector<HTMLElement>("[data-slot=model-picker]")?.style.height;

test("while the catalog is still arriving the picker shows it is loading, then the models, at one size", async () => {
  const app = harness();
  const release = holdCatalog(app);
  await openThread(app);
  // Until the catalog arrives the chip shows what the thread recorded.
  const popover = await openModelControl(/^Model: /);
  const list = await openModelPicker(popover);
  expect(within(list).getByRole("status", { name: "Loading models" })).toBeTruthy();
  expect(within(list).queryByText("No models")).toBeNull();
  const loadingHeight = panelHeight(popover);
  expect(loadingHeight).toBeTruthy();

  release();
  const personal = await within(list).findByRole("group", { name: "Personal" });
  expect(within(personal).getByRole("option", { name: /^Opus 5\.5, default/ })).toBeTruthy();
  expect(within(personal).getByRole("option", { name: "Extra 9, Claude Code" })).toBeTruthy();
  expect(within(list).queryByRole("status", { name: "Loading models" })).toBeNull();
  expect(panelHeight(popover)).toBe(loadingHeight);
});

/**
 * Answers `models.list` as a daemon still rediscovering Claude Code's personal account would:
 * without Haiku 4.5 and that account refreshing, until `settle`.
 */
function rediscovering(app: Harness) {
  const services = app.daemon.services;
  const handle = services.handle.bind(services);
  let settled = false;
  services.handle = (message, push) => {
    if (message.type !== "models.list" || settled) return handle(message, push);
    return handle(message, (reply) => {
      if (reply.type !== "models.result" || !("models" in reply.result)) return push(reply);
      const models = reply.result.models.filter((model) => model.displayName !== "Haiku 4.5");
      const instances = reply.result.instances.map((status) =>
        status.instance === "claude-personal"
          ? { ...status, status: "refreshing" as const, refreshing: true }
          : status,
      );
      push({ ...reply, result: { ...reply.result, models, instances } });
    });
  };
  return () => {
    settled = true;
    // Discovery ends: the daemon announces it, and readers read the account again.
    services.handle(
      {
        type: "models.refresh",
        requestId: "settled",
        filter: { provider: "claude", instance: "claude-personal" },
      },
      () => {},
    );
  };
}

test("while the daemon rediscovers models the picker shows the last list, then the new one when told", async () => {
  const app = harness();
  const settle = rediscovering(app);
  await openThread(app);
  const popover = await openModelControl(/^Model: Opus 5\.5/);
  const list = await openModelPicker(popover);
  const personal = group(list, "Personal");
  expect(within(personal).getByRole("option", { name: /^Opus 5\.5/ })).toBeTruthy();
  expect(within(personal).queryByRole("option", { name: /^Haiku 4\.5/ })).toBeNull();
  expect(within(popover).getByRole("status", { name: "Refreshing models" })).toBeTruthy();
  expect(personal.getAttribute("aria-busy")).toBe("true");
  const refreshingHeight = panelHeight(popover);

  settle();
  expect(
    await within(group(list, "Personal")).findByRole("option", { name: /^Haiku 4\.5/ }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(within(popover).queryByRole("status", { name: "Refreshing models" })).toBeNull(),
  );
  expect(panelHeight(popover)).toBe(refreshingHeight);
});
