import { createContext, createElement, useContext, type ComponentType } from "react";

export interface InteractiveTerminalProps {
  terminalId: string;
  /** "Codex sign-in": names the terminal's output and input for assistive tech. */
  label: string;
  /** The CLI exited, with its exit code. */
  onExit(code: number): void;
}

const InteractiveTerminalContext = createContext<
  ComponentType<InteractiveTerminalProps> | undefined
>(undefined);

/**
 * The app supplies one terminal implementation for sign-in and support CLI sessions.
 * A foundation slot avoids dependencies back into the panel feature. It may suspend.
 */
export const InteractiveTerminalProvider = InteractiveTerminalContext.Provider;

/** The terminal the app provides, or why an interactive terminal can't show here. */
export function InteractiveTerminal(props: InteractiveTerminalProps) {
  const Terminal = useContext(InteractiveTerminalContext);
  if (!Terminal)
    return (
      <p role="alert" className="text-sm text-status-failed">
        A terminal can't open here. Run the command yourself on the computer running ace.
      </p>
    );
  return createElement(Terminal, props);
}
