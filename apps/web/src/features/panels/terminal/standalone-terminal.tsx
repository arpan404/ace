import { useState } from "react";
import type { TerminalSource } from "../sources.ts";
import { TerminalSessions } from "./sessions.ts";
import { TerminalView } from "./terminal-view.tsx";

/*
 * A terminal outside the thread workspace, over a source its owner supplies (a Spade bot's PTY):
 * the same view as a thread's terminal, xterm where WebGL runs, else the DOM screen. Typing goes
 * nowhere while `readOnly`.
 */

const noop = () => {};

export interface StandaloneTerminalProps {
  source: TerminalSource;
  /** The terminal's id in `source`. */
  id: string;
  /** Names its output and input for assistive tech: "Flights's terminal". */
  label: string;
  readOnly: boolean;
  autoFocus?: boolean;
}

export default function StandaloneTerminal(props: StandaloneTerminalProps) {
  // One screen per source: a new source (another bot) starts a fresh one.
  const [sessions] = useState(() => new TerminalSessions(props.source));
  return (
    <TerminalView
      sessions={sessions}
      id={props.id}
      name={props.label}
      onSurface={noop}
      readOnly={props.readOnly}
      autoFocus={props.autoFocus ?? false}
      onFind={noop}
    />
  );
}
