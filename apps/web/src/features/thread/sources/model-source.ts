// TODO(train-2): wire to protocol when merged. The model catalog (`models.list`) is in
// @ace/protocol but @ace/client cannot request it yet; accounts and usage windows are PR #25.
import type { ProviderKind } from "@ace/protocol";

/** One model on one of the user's logged-in accounts, as the composer's picker lists it. */
export interface ModelChoice {
  id: string;
  provider: ProviderKind;
  model: string;
  account: string;
  /** Plan or a short note, e.g. "Max plan" or "Faster, same account". */
  note: string;
  /** Share of the current usage window spent, 0..1, when the provider reports it. */
  used?: number | undefined;
  /** Set when the account's window is exhausted; the choice is disabled. */
  resetsAt?: string | undefined;
}

export interface ModelSource {
  choices(): Promise<readonly ModelChoice[]>;
}

export { providerNames } from "@/components/ui/provider-glyph.tsx";

const catalog: readonly ModelChoice[] = [
  {
    id: "claude-opus-personal",
    provider: "claude",
    model: "Opus 4.6",
    account: "personal",
    note: "Max plan · 62% of 5-hour window used",
    used: 0.62,
  },
  {
    id: "claude-opus-work",
    provider: "claude",
    model: "Opus 4.6",
    account: "work",
    note: "Team plan · 23% used",
    used: 0.23,
  },
  {
    id: "claude-sonnet-personal",
    provider: "claude",
    model: "Sonnet 4.6",
    account: "personal",
    note: "Faster, same account",
  },
  {
    id: "codex-personal",
    provider: "codex",
    model: "GPT-5.3 Codex",
    account: "personal",
    note: "Pro · 38% used",
    used: 0.38,
  },
  {
    id: "codex-team",
    provider: "codex",
    model: "GPT-5.3 Codex",
    account: "team",
    note: "Limit reached",
    used: 1,
    resetsAt: "16:47",
  },
  {
    id: "opencode-local",
    provider: "opencode",
    model: "Kimi K2",
    account: "local",
    note: "OpenCode · local config",
  },
  {
    id: "cursor-personal",
    provider: "cursor",
    model: "Composer 1",
    account: "personal",
    note: "Pro · 12% used",
    used: 0.12,
  },
];

export function fakeModelSource(): ModelSource {
  return { choices: () => Promise.resolve(catalog) };
}
