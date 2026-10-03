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
  availability: "available" | "near_limit" | "exhausted" | "logged_out" | "unknown";
  windows: FakeQuotaWindow[];
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
      cliVersion: "2.1.4",
      label: "Personal",
      availability: "available",
      windows: [
        { id: "five-hour", label: "5-hour", usedPercent: 62, resetsAt: now + 2 * hour },
        { id: "weekly", label: "Weekly", usedPercent: 41, resetsAt: now + 4 * day },
      ],
    },
    {
      id: "claude-work",
      provider: "claude",
      providerLabel: "Claude Code",
      cliVersion: "2.1.4",
      label: "Work",
      availability: "available",
      windows: [
        { id: "five-hour", label: "5-hour", usedPercent: 23, resetsAt: now + 3 * hour },
        { id: "weekly", label: "Weekly", usedPercent: 57, resetsAt: now + 2 * day },
      ],
    },
    {
      id: "codex-personal",
      provider: "codex",
      providerLabel: "Codex",
      cliVersion: "0.48",
      label: "Personal",
      availability: "available",
      windows: [
        { id: "five-hour", label: "5-hour", usedPercent: 38, resetsAt: now + 3 * hour },
        { id: "weekly", label: "Weekly", usedPercent: 22, resetsAt: now + 5 * day },
      ],
    },
    {
      id: "codex-team",
      provider: "codex",
      providerLabel: "Codex",
      cliVersion: "0.48",
      label: "Team",
      availability: "exhausted",
      windows: [
        { id: "five-hour", label: "5-hour", usedPercent: 100, resetsAt: now + 87 * minute },
        { id: "weekly", label: "Weekly", usedPercent: 88, resetsAt: now + 6 * day },
      ],
    },
    {
      id: "gemini-google",
      provider: "acp",
      providerLabel: "Gemini CLI",
      cliVersion: "0.21",
      label: "Google",
      availability: "available",
      windows: [{ id: "daily", label: "Daily", usedPercent: 71, resetsAt: now + 9 * hour }],
    },
  ];
}
