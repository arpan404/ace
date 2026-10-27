import { describe, expect, test } from "vitest";
import { AgentModelRoster, type AgentModelsProvider } from "@ace/protocol";
import { modelRoster, type RosterInput } from "./model-roster.ts";
import { account, codex346, realisticInstall, row } from "./model-roster.fixture.ts";

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
});
