import { PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";

type Cli = "claude" | "codex" | "opencode";
const clis: readonly { value: Cli; label: string; command: string; folder: string }[] = [
  {
    value: "claude",
    label: "Claude Code",
    command: "CLAUDE_CONFIG_DIR=~/.claude-work claude /login",
    folder: "CLAUDE_CONFIG_DIR",
  },
  {
    value: "codex",
    label: "Codex",
    command: "CODEX_HOME=~/.codex-team codex login",
    folder: "CODEX_HOME",
  },
  {
    value: "opencode",
    label: "OpenCode",
    command: "XDG_DATA_HOME=~/.opencode-work opencode auth login",
    folder: "XDG_DATA_HOME",
  },
];

/**
 * ace never asks for credentials: a second account is the CLI signed in with its own config
 * folder. The dialog shows the command for each CLI.
 */
export function AddAccount() {
  const [cli, setCli] = useState<Cli>("claude");
  const current = clis.find((entry) => entry.value === cli) ?? clis[0];
  return (
    <Dialog>
      <DialogTrigger render={<Button className="mt-1" />}>
        <Icon icon={PlusIcon} size={14} />
        Add account
      </DialogTrigger>
      <DialogContent className="w-[min(520px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Add an account</DialogTitle>
          <DialogDescription>
            Sign in to the CLI with a separate config folder. ace finds the account on the next
            refresh and never sees your credentials.
          </DialogDescription>
        </DialogHeader>
        <SegmentedControl
          label="CLI"
          value={cli}
          options={clis}
          onValueChange={(value) => setCli(value)}
        />
        <div>
          <pre
            aria-label="Sign-in command"
            className="rounded-card bg-code px-3.5 py-3 font-mono text-sm whitespace-pre-wrap"
          >
            {current?.command}
          </pre>
          <p className="mt-2 text-sm text-muted-foreground">
            Pick any folder for <code>{current?.folder}</code>; each folder is one account.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
