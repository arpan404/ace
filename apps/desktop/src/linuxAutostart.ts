export interface LinuxDaemonAutostartEntryInput {
  readonly appName: string;
  readonly executablePath: string;
  readonly args: ReadonlyArray<string>;
}

function sanitizeDesktopEntryValue(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim();
}

export function quoteDesktopEntryExecArgument(value: string): string {
  const sanitized = sanitizeDesktopEntryValue(value);
  return `"${sanitized.replace(/(["\\`$])/g, "\\$1")}"`;
}

export function buildLinuxDaemonAutostartEntry(input: LinuxDaemonAutostartEntryInput): string {
  const appName = sanitizeDesktopEntryValue(input.appName) || "ace";
  const execCommand = [input.executablePath, ...input.args]
    .map(quoteDesktopEntryExecArgument)
    .join(" ");

  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    `Name=${appName} daemon`,
    `Comment=Start the ${appName} background daemon at login`,
    `Exec=${execCommand}`,
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}
