import { describe, expect, test } from "vitest";
import { AgentModelRoster, type AgentModelsProvider } from "@ace/protocol";
import { modelRoster, type RosterInput } from "./model-roster.ts";
import { account, codex346, realisticInstall, row } from "./model-roster.fixture.ts";
import { accountForName } from "./account-names.ts";

const caller = { access: "full-access", provider: "claude", model: "claude-opus-5-5" } as const;
const roster = (input: Partial<RosterInput> = {}) =>
  AgentModelRoster.parse(modelRoster({ ...realisticInstall(), caller, ...input }));
const provider = (result: AgentModelRoster, kind: string): AgentModelsProvider => {
  const found = result.providers.find((entry) => entry.provider === kind);
  if (!found) throw new Error(`No ${kind} in roster`);
  return found;
};
const ids = (group: AgentModelsProvider) => group.sets.flatMap((set) => set.ids);
const setOf = (group: AgentModelsProvider, id: string) =>
  group.sets.find((set) => set.ids.includes(id));

describe("default roster", () => {
  test("the whole current list of a realistic install fits in 1,500 characters", () => {
    expect(JSON.stringify(roster()).length).toBeLessThanOrEqual(1500);
  });

  test("superseded releases are left out and counted per provider", () => {
    const claude = provider(roster(), "claude");
    expect(ids(claude)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
    ]);
    expect(claude.omitted).toBe(8);
  });

  test("a model stays listed while any account that serves it still calls it current", () => {
    const codex = provider(roster(), "codex");
    // The CLI login's newest Terra; only the second login has a newer one.
    expect(ids(codex)).toContain("gpt-5.6-terra");
    expect(setOf(codex, "gpt-5.6-terra")?.legacy).toBeUndefined();
    expect(ids(codex)).not.toContain("gpt-6-sol");
  });

  test("a large catalogue keeps its default and one release per model line", () => {
    const openCode = provider(roster(), "opencode");
    const listed = ids(openCode);
    expect(listed[0]).toBe("opencode-go/muse-spark-1.3-contributor");
    expect(listed).toContain("opencode/claude-opus-5-5");
    expect(listed).not.toContain("opencode-go/claude-opus-5-5");
    expect(listed.length).toBeLessThanOrEqual(8);
    expect((openCode.omitted ?? 0) + listed.length).toBe(
      realisticInstall().rows.filter((entry) => entry.model.provider === "opencode").length,
    );
  });

  test("a favourite legacy model and the caller's own legacy model still show", () => {
    const install = realisticInstall();
    for (const entry of install.rows)
      if (entry.model.id === "claude-opus-4-8") entry.model.favourite = true;
    const result = roster({ ...install, caller: { ...caller, model: "claude-sonnet-5" } });
    const claude = provider(result, "claude");
    expect(setOf(claude, "claude-opus-4-8")?.legacy).toBe(true);
    expect(setOf(claude, "claude-sonnet-5")?.legacy).toBe(true);
    expect(claude.omitted).toBe(6);
    expect(result.caller.model).toBe("claude-sonnet-5");
  });

  test("a favourite in a large catalogue shows even when its line is already listed", () => {
    const install = realisticInstall();
    for (const entry of install.rows)
      if (entry.model.id === "openrouter/minimax-m3") entry.model.favourite = true;
    expect(ids(provider(roster(install), "opencode"))).toContain("openrouter/minimax-m3");
  });

  test("a pinned superseded release never hides its line's current release", () => {
    const install = realisticInstall();
    for (const entry of install.rows)
      if (entry.model.id === "opencode/gpt-6-sol") entry.model.favourite = true;
    const listed = ids(provider(roster(install), "opencode"));
    expect(listed).toContain("opencode/gpt-6-sol");
    expect(listed).toContain("opencode/gpt-6.1-sol");
  });

  test("a line's newest release shows even when an account with an older one sorts first", () => {
    const filler = Array.from({ length: 7 }, (_, index) =>
      row("codex", "codex-a", `line-${index}`, `Line ${index}`, { family: `line-${index}` }),
    );
    const result = modelRoster({
      rows: [
        row("codex", "codex-a", "sol-1", "Sol 1", { family: "sol", version: "1" }),
        ...filler,
        row("codex", "codex-b", "sol-2", "Sol 2", { family: "sol", version: "2" }),
      ],
      accounts: [account("codex", "codex-a"), account("codex", "codex-b")],
      caller,
    });
    const listed = ids(provider(result, "codex"));
    expect(listed).toContain("sol-2");
    expect(listed).not.toContain("sol-1");
  });

  test("pinned legacy models never crowd current model lines out of a large catalogue", () => {
    const lines = Array.from({ length: 10 }, (_, index) =>
      row("codex", "codex-a", `line-${index}`, `Line ${index}`, {
        family: `line-${index}`,
        isDefault: index === 0,
      }),
    );
    const favourites = Array.from({ length: 7 }, (_, index) =>
      row("codex", "codex-a", `old-${index}`, `Old ${index}`, {
        family: `old-${index}`,
        tier: "legacy",
        favourite: true,
      }),
    );
    const result = modelRoster({
      rows: [...favourites, ...lines],
      accounts: [account("codex", "codex-a")],
      caller,
    });
    const listed = ids(provider(result, "codex"));
    for (const entry of [...favourites, ...lines.slice(0, 8)])
      expect(listed).toContain(entry.model.id);
    expect(listed).not.toContain("line-8");
  });

  test("hidden models are neither listed nor counted", () => {
    const install = realisticInstall();
    for (const entry of install.rows)
      if (entry.model.id === "claude-fable-5-1") entry.model.hidden = true;
    const claude = provider(roster(install), "claude");
    expect(ids(claude)).not.toContain("claude-fable-5-1");
    expect(claude.omitted).toBe(8);
  });

  test("providers whose accounts serve no runnable model are named once", () => {
    expect(roster().noModels).toEqual(["cursor", "pi", "antigravity"]);
  });
});

describe("efforts", () => {
  test("efforts most models share are stated once and the differing ones on their own set", () => {
    const result = roster();
    expect(result.efforts).toBe("low,medium,high,xhigh,max");
    expect(setOf(provider(result, "claude"), "claude-opus-5-5")).toMatchObject({
      defaultEffort: "high",
    });
    expect(setOf(provider(result, "claude"), "claude-opus-5-5")).not.toHaveProperty("efforts");
    expect(setOf(provider(result, "codex"), "gpt-6.1-sol")).toMatchObject({
      efforts: "low,medium,high,xhigh,max,ultra",
      defaultEffort: "low",
    });
  });

  test("each account a shared model is listed on is offered only the efforts it accepts", () => {
    const accounts = [account("codex", "codex-a"), account("codex", "codex-b")];
    const result = modelRoster({
      rows: [
        row("codex", "codex-a", "gpt-6-luna", "GPT-6 Luna", { effortIds: ["high"] }),
        // The same id added by hand on the second login, with no efforts.
        row("codex", "codex-b", "gpt-6-luna", "GPT-6 Luna", { effortIds: [] }),
        row("codex", "codex-a", "gpt-6-sol", "GPT-6 Sol"),
        row("codex", "codex-b", "gpt-6-sol", "GPT-6 Sol"),
      ],
      accounts,
      caller,
    });
    const codex = provider(result, "codex");
    const offered = (id: string, accountId: string) =>
      codex.sets
        .filter(
          (set) => set.ids.includes(id) && (!set.accounts || set.accounts.includes(accountId)),
        )
        .map((set) => ({
          efforts: set.efforts ?? result.efforts,
          defaultEffort: set.defaultEffort,
        }));
    expect(offered("gpt-6-luna", "codex-a")).toEqual([{ efforts: "high", defaultEffort: "high" }]);
    expect(offered("gpt-6-luna", "codex-b")).toEqual([{ efforts: "", defaultEffort: undefined }]);
    // Accounts that agree stay in one set naming no account.
    expect(codex.sets.filter((set) => set.ids.includes("gpt-6-sol"))).toHaveLength(1);
  });

  test("a model that takes no effort says so", () => {
    const claude = provider(roster({ query: "haiku 4.5" }), "claude");
    expect(setOf(claude, "claude-haiku-4-5-20251001")?.efforts).toBe("");
  });
});

describe("accounts", () => {
  test("models only the second Codex login serves name it, and shared models name no account", () => {
    const codex = provider(roster(), "codex");
    expect(setOf(codex, "gpt-6.1-sol")?.accounts).toEqual(["346"]);
    expect(setOf(codex, "gpt-6-astra")?.accounts).toEqual(["346"]);
    expect(setOf(codex, "gpt-reserve")).not.toHaveProperty("accounts");
  });

  test("each account is listed once with its own default when the logins disagree", () => {
    const codex = provider(roster(), "codex");
    expect(codex.accounts).toEqual([
      { id: "codex-cli-default", auth: "unknown", default: "gpt-6-luna" },
      { id: codex346, label: "346", default: "gpt-6.1-sol" },
    ]);
    expect(codex).not.toHaveProperty("default");
    expect(provider(roster(), "claude").default).toBe("claude-opus-5-5");
  });

  test("access modes show only when an account allows less than the caller's", () => {
    const result = roster();
    expect(provider(result, "claude").accounts[0]).not.toHaveProperty("access");
    expect(provider(result, "opencode").accounts[0]?.access).toEqual([
      "read-only",
      "ask",
      "full-access",
    ]);
    const readOnly = roster({ caller: { ...caller, access: "read-only" } });
    expect(provider(readOnly, "claude").accounts[0]).toHaveProperty("access");
  });

  test("a serving account's name selects that account when passed to delegate", () => {
    const accounts = [
      account("claude", "claude-cli-default"),
      // A label that is another account's id: delegate takes the id first.
      account("claude", "claude-b", { accountLabel: "claude-cli-default" }),
      account("claude", "claude-c", { accountLabel: "Work" }),
    ];
    const result = modelRoster({
      rows: [
        row("claude", "claude-cli-default", "claude-opus-5-5", "Opus 5.5"),
        row("claude", "claude-b", "claude-sonnet-5-5", "Sonnet 5.5"),
        row("claude", "claude-c", "claude-haiku-5-5", "Haiku 5.5"),
      ],
      accounts,
      caller,
    });
    const claude = provider(result, "claude");
    const named = accounts.map((entry) => ({
      id: entry.accountId,
      label: entry.accountLabel ?? "",
      provider: entry.provider,
    }));
    const selected = (id: string) =>
      setOf(claude, id)?.accounts?.map((name) => accountForName(named, "claude", name)?.id);
    expect(selected("claude-sonnet-5-5")).toEqual(["claude-b"]);
    expect(selected("claude-haiku-5-5")).toEqual(["claude-c"]);
    expect(setOf(claude, "claude-haiku-5-5")?.accounts).toEqual(["Work"]);
  });

  test("an account label two accounts share is never used to name a serving account", () => {
    const result = modelRoster({
      rows: [
        row("claude", "claude-a", "claude-opus-5-5", "Opus 5.5"),
        row("claude", "claude-b", "claude-opus-5-5", "Opus 5.5"),
        row("claude", "claude-b", "claude-sonnet-5-5", "Sonnet 5.5"),
      ],
      accounts: [
        account("claude", "claude-a", { accountLabel: "Work" }),
        account("claude", "claude-b", { accountLabel: "Work" }),
      ],
      caller,
    });
    expect(setOf(provider(result, "claude"), "claude-sonnet-5-5")?.accounts).toEqual(["claude-b"]);
  });
});

describe("query", () => {
  test("a query finds superseded releases, nearest first", () => {
    const claude = provider(roster({ query: "opus 4.7" }), "claude");
    expect(ids(claude)[0]).toBe("claude-opus-4-7");
    expect(setOf(claude, "claude-opus-4-7")?.legacy).toBe(true);
  });

  test("a query lists only the providers it matched and counts nothing as omitted", () => {
    const result = roster({ query: "gpt 6.1 sol" });
    expect(result.providers.map((group) => group.provider).toSorted()).toEqual([
      "codex",
      "opencode",
    ]);
    expect(ids(provider(result, "codex"))[0]).toBe("gpt-6.1-sol");
    expect(result.providers.every((group) => group.omitted === undefined)).toBe(true);
    expect(result).not.toHaveProperty("noModels");
  });

  test("a query that finds one account's default keeps each account's own default", () => {
    const codex = provider(roster({ query: "gpt 6.1 sol" }), "codex");
    expect(codex).not.toHaveProperty("default");
    expect(codex.accounts.map((entry) => entry.default)).toEqual(["gpt-6-luna", "gpt-6.1-sol"]);
  });
});
