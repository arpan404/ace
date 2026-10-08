import { useEffect, useEffectEvent, useState } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useLoadedServices } from "../services.ts";
import type { TerminalSessions } from "./sessions.ts";
import { TerminalView } from "./terminal-view.tsx";
import { useExitCode } from "./use-terminals.ts";

/*
 * A provider's own sign-in running in an ace terminal (`provider.login.terminal`): the CLI reads
 * what it needs (a key, a pasted code) itself, so ace never sees it. The terminal belongs to no
 * thread and to this connection only; it ends with the CLI.
 */

const noop = () => {};

export interface AuthTerminalProps {
  terminalId: string;
  /** "Codex sign-in": names the terminal's output and input for assistive tech. */
  label: string;
  /** The CLI exited, with its exit code. */
  onExit(code: number): void;
}

export default function AuthTerminal(props: AuthTerminalProps) {
  const services = useLoadedServices();
  if (!services)
    return (
      <div className="grid h-64 place-items-center">
        <Spinner label="Opening the terminal" />
      </div>
    );
  return <AuthTerminalScreen sessions={services.terminals} {...props} />;
}

function AuthTerminalScreen(props: AuthTerminalProps & { sessions: TerminalSessions }) {
  const { sessions, terminalId } = props;
  // Before the first attach: its requests name no thread. Adopting twice is harmless.
  useState(() => sessions.adopt(terminalId));
  const code = useExitCode(sessions, terminalId);
  const exited = useEffectEvent((status: number) => props.onExit(status));
  useEffect(() => {
    if (code !== null) exited(code);
  }, [code]);
  return (
    <div className="flex h-64 flex-col overflow-hidden rounded-card border bg-code p-2 font-mono">
      <TerminalView
        sessions={sessions}
        id={terminalId}
        name={props.label}
        onSurface={noop}
        readOnly={code !== null}
        autoFocus
        onFind={noop}
      />
    </div>
  );
}
