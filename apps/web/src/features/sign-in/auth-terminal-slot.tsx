import { createContext, createElement, useContext, type ComponentType } from "react";

export interface AuthTerminalProps {
  terminalId: string;
  /** "Codex sign-in": names the terminal's output and input for assistive tech. */
  label: string;
  /** The CLI exited, with its exit code. */
  onExit(code: number): void;
}

const AuthTerminalContext = createContext<ComponentType<AuthTerminalProps> | undefined>(undefined);

/**
 * The panels' terminal, handed down by the app for a provider CLI's own sign-in: the panels
 * reach the model picker, which signs in, so sign-in can't import the panels back. It may
 * suspend while its code loads.
 */
export const AuthTerminalProvider = AuthTerminalContext.Provider;

/** The terminal the app provides, or why a sign-in terminal can't show here. */
export function AuthTerminal(props: AuthTerminalProps) {
  const Terminal = useContext(AuthTerminalContext);
  if (!Terminal)
    return (
      <p role="alert" className="text-sm text-status-failed">
        A terminal can't open here. Run the command yourself on the computer running ace.
      </p>
    );
  return createElement(Terminal, props);
}
