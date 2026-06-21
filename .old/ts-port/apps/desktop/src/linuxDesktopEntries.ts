function sanitizeDesktopEntryValue(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim();
}

export function quoteDesktopEntryExecArgument(value: string): string {
  const sanitized = sanitizeDesktopEntryValue(value);
  return `"${sanitized.replace(/(["\\`$])/g, "\\$1")}"`;
}

interface DesktopEntryInput {
  readonly appName: string;
  readonly executablePath: string;
  readonly args?: ReadonlyArray<string>;
  readonly comment?: string;
  readonly desktopFileId?: string;
  readonly iconPath?: string;
  readonly terminal?: boolean;
  readonly noDisplay?: boolean;
  readonly startupNotify?: boolean;
  readonly startupWmClass?: string;
  readonly categories?: ReadonlyArray<string>;
  readonly extraEntries?: ReadonlyArray<string>;
}

function buildDesktopEntry(input: DesktopEntryInput): string {
  const appName = sanitizeDesktopEntryValue(input.appName) || "ace";
  const execCommand = [input.executablePath, ...(input.args ?? [])]
    .map(quoteDesktopEntryExecArgument)
    .join(" ");

  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    `Name=${appName}`,
    ...(input.comment ? [`Comment=${sanitizeDesktopEntryValue(input.comment)}`] : []),
    `Exec=${execCommand}`,
    `Terminal=${input.terminal === true ? "true" : "false"}`,
    `NoDisplay=${input.noDisplay === true ? "true" : "false"}`,
    `StartupNotify=${input.startupNotify === false ? "false" : "true"}`,
  ];
  if (input.desktopFileId) {
    lines.push(`DesktopFileName=${sanitizeDesktopEntryValue(input.desktopFileId)}`);
  }
  if (input.iconPath) {
    lines.push(`Icon=${sanitizeDesktopEntryValue(input.iconPath)}`);
  }
  if (input.startupWmClass) {
    lines.push(`StartupWMClass=${sanitizeDesktopEntryValue(input.startupWmClass)}`);
  }
  if (input.categories && input.categories.length > 0) {
    lines.push(`Categories=${input.categories.map(sanitizeDesktopEntryValue).join(";")};`);
  }
  if (input.extraEntries) {
    lines.push(...input.extraEntries.map(sanitizeDesktopEntryValue));
  }

  lines.push("");
  return lines.join("\n");
}

export interface LinuxDaemonAutostartEntryInput {
  readonly appName: string;
  readonly executablePath: string;
  readonly args: ReadonlyArray<string>;
}

export function buildLinuxDaemonAutostartEntry(input: LinuxDaemonAutostartEntryInput): string {
  return buildDesktopEntry({
    appName: `${input.appName} daemon`,
    executablePath: input.executablePath,
    args: input.args,
    comment: `Start the ${input.appName} background daemon at login`,
    noDisplay: true,
    startupNotify: false,
    extraEntries: ["X-GNOME-Autostart-enabled=true"],
  });
}

export interface LinuxDesktopApplicationEntryInput {
  readonly appName: string;
  readonly executablePath: string;
  readonly iconPath?: string;
  readonly desktopFileId?: string;
  readonly startupWmClass?: string;
}

export function buildLinuxDesktopApplicationEntry(
  input: LinuxDesktopApplicationEntryInput,
): string {
  return buildDesktopEntry({
    appName: input.appName,
    executablePath: input.executablePath,
    comment: "Local multi-provider coding workspace",
    ...(input.desktopFileId ? { desktopFileId: input.desktopFileId } : {}),
    ...(input.iconPath ? { iconPath: input.iconPath } : {}),
    ...(input.startupWmClass ? { startupWmClass: input.startupWmClass } : {}),
    categories: ["Development"],
  });
}
