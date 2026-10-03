// TODO(train-2): wire to protocol when merged. Models come from `models.list` once @ace/client
// has a request API for it, accounts from the accounts protocol (#25), and branches from the
// workspace service. Until then this file serves the fake daemon's projects; components depend
// only on `NewThreadSource`.
import type { ProviderKind } from "@ace/protocol";

export interface ModelOption {
  id: string;
  label: string;
  provider: ProviderKind;
  isDefault?: boolean;
}
export interface AccountOption {
  id: string;
  provider: ProviderKind;
  label: string;
  /** Quota used in the tightest window, in words ("38% of 5h used"). */
  usage: string;
  isDefault?: boolean;
}
export interface NewThreadOptions {
  models: ModelOption[];
  accounts: AccountOption[];
  /** Branches a worktree can start from, default branch first. */
  branches: string[];
}
export interface NewThreadSource {
  options(project: string, signal: AbortSignal): Promise<NewThreadOptions>;
}

const models: ModelOption[] = [
  { id: "claude-opus-4-6", label: "Opus 4.6", provider: "claude", isDefault: true },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", provider: "claude" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", provider: "claude" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", provider: "codex" },
  { id: "gpt-5.3-codex-mini", label: "GPT-5.3 Codex Mini", provider: "codex" },
  { id: "opencode-default", label: "OpenCode default", provider: "opencode" },
  { id: "cursor-composer", label: "Composer", provider: "cursor" },
];

const accounts: AccountOption[] = [
  {
    id: "claude-personal",
    provider: "claude",
    label: "personal",
    usage: "38% of 5h used",
    isDefault: true,
  },
  { id: "claude-work", provider: "claude", label: "work", usage: "71% of 5h used" },
  {
    id: "codex-work",
    provider: "codex",
    label: "work",
    usage: "12% of week used",
    isDefault: true,
  },
  {
    id: "opencode-local",
    provider: "opencode",
    label: "local",
    usage: "your config",
    isDefault: true,
  },
  {
    id: "cursor-personal",
    provider: "cursor",
    label: "personal",
    usage: "54% of month used",
    isDefault: true,
  },
];

const branches: Record<string, string[]> = {
  ace: ["main", "fix/replay-dedupe", "deck/resumable-streams", "release/0.9"],
  "ace-mobile": ["main", "feat/haptics", "fix/sheet-rotate"],
  relay: ["main", "fix/restart-retry", "perf/fanout"],
  "billing-api": ["main", "fix/refund-tax", "fix/pdf-locale"],
  "docs-site": ["main", "docs/install-daemon"],
};

export const newThreadSource: NewThreadSource = {
  options: async (project) => ({ models, accounts, branches: branches[project] ?? ["main"] }),
};
