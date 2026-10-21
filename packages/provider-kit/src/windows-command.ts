/** Batch entrypoints cannot spawn directly (CVE-2024-27980); route them through cmd.exe. */
export type WindowsCommand = { command: string; args: string[] };

/** Quote one argument so cmd.exe passes it through literally. */
function quoteArgument(value: string): string {
  if (value !== "" && !/[\s"%^&|<>=,;]/.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    // A literal % still expands inside quotes, so double it; " and trailing
    // backslashes follow MSVCRT rules so the callee sees the intended text.
    if (char === '"') quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    else if (char === "%") quoted += "\\".repeat(backslashes) + "%%";
    else quoted += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/** Wrap a batch entrypoint as `cmd.exe /d /s /c "..."`; other commands pass through. */
export function toWindowsCommand(command: string, args: readonly string[]): WindowsCommand {
  const base = command.split(/[\\/]/).pop() ?? command;
  if (!/\.(?:cmd|bat)$/i.test(base)) return { command, args: [...args] };
  const line = [command, ...args].map(quoteArgument).join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`] };
}
