/** Batch entrypoints cannot spawn directly (CVE-2024-27980); route them through cmd.exe. */
export type WindowsCommand = { command: string; args: string[]; verbatim: boolean };

/** Quote for the target argv parser: always wrap, escape `"` and edge backslashes. */
function msvcrtQuote(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    if (char === '"') quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    else quoted += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/** Hide one cmd.exe parse behind `^`; a second pass survives the shim's `%*` reparse. */
function caretEscape(text: string): string {
  return text.replace(/([()%!^"<>&|])/g, "^$1");
}

function escapeCommand(value: string): string {
  return caretEscape(msvcrtQuote(value));
}

function escapeArgument(value: string): string {
  return caretEscape(caretEscape(msvcrtQuote(value)));
}

/** Wrap a batch entrypoint as `cmd.exe /d /s /c "..."`; other commands pass through. */
export function toWindowsCommand(command: string, args: readonly string[]): WindowsCommand {
  const base = command.split(/[\\/]/).pop() ?? command;
  if (!/\.(?:cmd|bat)$/i.test(base)) return { command, args: [...args], verbatim: false };
  const line = [escapeCommand(command), ...args.map(escapeArgument)].join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}
