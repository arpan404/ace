/** One quota window of an account (5-hour, weekly, daily). */
export interface FakeQuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: number;
}
export interface FakeAccount {
  id: string;
  provider: "claude" | "codex" | "opencode" | "cursor" | "acp";
  /** "Claude Code", and the CLI version it reported. */
  providerLabel: string;
  cliVersion: string;
  label: string;
  plan: string;
  isDefault: boolean;
  availability: "available" | "near_limit" | "exhausted" | "logged_out" | "unknown";
  windows: FakeQuotaWindow[];
  runningThreads: number;
  pausedThreads: number;
}
export interface FakeSchedulingPolicy {
  onExhausted: "switch" | "pause" | "ask";
  keepHeadroom: boolean;
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** The accounts in the approved design; one Codex account has hit its 5-hour limit. */
export function accountList(now: number): FakeAccount[] {
  return [
    {
      id: "claude-personal",
      provider: "claude",
      providerLabel: "Claude Code",
      cliVersion: "claude 2.1.4",
      label: "Personal",
      plan: "Max",
      isDefault: true,
      availability: "available",
      windows: [
        { id: "five-hour", label: "5-hour", usedPercent: 62, resetsAt: now + 2 * hour },
        { id: "weekly", label: "Weekly", usedPercent: 41, resetsAt: now + 4 * day },
      ],
      runningThreads: 4,
      pausedThreads: 0,
    },
    {
      id: "claude-work",
      provider: "claude",
      providerLabel: "Claude Code",
      cliVersion: "claude 2.1.4",
      label: "Work",
      plan: "Team",
      isDefault: false,
      availability: "available",
      windows: [
        { id: "five-hour", label: "5-hour", usedPercent: 23, resetsAt: now + 3 * hour },
        { id: "weekly", label: "Weekly", usedPercent: 57, resetsAt: now + 2 * day },
      ],
      runningThreads: 2,
      pausedThreads: 0,
    },
    {
      id: "codex-personal",
      provider: "codex",
      providerLabel: "Codex",
      cliVersion: "codex 0.48",
      label: "Personal",
      plan: "ChatGPT Pro",
      isDefault: false,
      availability: "available",
      windows: [
        { id: "five-hour", label: "5-hour", usedPercent: 38, resetsAt: now + 3 * hour },
        { id: "weekly", label: "Weekly", usedPercent: 22, resetsAt: now + 5 * day },
      ],
      runningThreads: 2,
      pausedThreads: 0,
    },
    {
      id: "codex-team",
      provider: "codex",
      providerLabel: "Codex",
      cliVersion: "codex 0.48",
      label: "Team",
      plan: "ChatGPT Plus",
      isDefault: false,
      availability: "exhausted",
      windows: [
        { id: "five-hour", label: "5-hour", usedPercent: 100, resetsAt: now + 87 * minute },
        { id: "weekly", label: "Weekly", usedPercent: 88, resetsAt: now + 6 * day },
      ],
      runningThreads: 0,
      pausedThreads: 3,
    },
    {
      id: "gemini-google",
      provider: "acp",
      providerLabel: "Gemini CLI",
      cliVersion: "via ACP",
      label: "Google",
      plan: "Code Assist",
      isDefault: false,
      availability: "available",
      windows: [{ id: "daily", label: "Daily", usedPercent: 71, resetsAt: now + 9 * hour }],
      runningThreads: 1,
      pausedThreads: 0,
    },
  ];
}

export function defaultSchedulingPolicy(): FakeSchedulingPolicy {
  return { onExhausted: "switch", keepHeadroom: true };
}

const headroom = (account: FakeAccount) =>
  100 - Math.max(...account.windows.map((window) => window.usedPercent));

/**
 * "Move running threads": the exhausted account's paused threads move to the same provider's
 * account with the most headroom. Returns the new list and where they went.
 */
export function moveThreads(
  accounts: readonly FakeAccount[],
  fromId: string,
): { accounts: FakeAccount[]; moved: number; to: FakeAccount } | { error: string } {
  const from = accounts.find((account) => account.id === fromId);
  if (!from) return { error: "not_found" };
  const moved = from.pausedThreads + from.runningThreads;
  if (!moved) return { error: "nothing_to_move" };
  const to = accounts
    .filter(
      (a) => a.provider === from.provider && a.id !== from.id && a.availability !== "exhausted",
    )
    .toSorted((a, b) => headroom(b) - headroom(a))[0];
  if (!to) return { error: "no_account_with_headroom" };
  return {
    moved,
    to,
    accounts: accounts.map((account) =>
      account.id === from.id
        ? { ...account, runningThreads: 0, pausedThreads: 0 }
        : account.id === to.id
          ? { ...account, runningThreads: account.runningThreads + moved }
          : account,
    ),
  };
}
