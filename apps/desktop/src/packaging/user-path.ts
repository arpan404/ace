import { execFile } from "node:child_process";

/**
 * The per-user PATH on Windows (`HKCU\Environment\Path`), where the `ace` command's folder goes
 * so new terminals find it. Pure list edits plus a thin PowerShell shell around the registry.
 * The value keeps its registry type: entries such as `%USERPROFILE%\AppData\...` only work
 * while it stays `REG_EXPAND_SZ`.
 */

export interface UserPath {
  /** The raw value, variables unexpanded; empty when there is none. */
  value: string;
  kind: "ExpandString" | "String";
}

/** What the registry shell does, replaced in tests. */
export interface UserPathRegistry {
  read(): Promise<UserPath>;
  /** Writes the value and tells running programs (Explorer) the environment changed. */
  write(path: UserPath): Promise<void>;
}

/** An entry as Windows compares it: variables expanded, case and trailing slashes ignored. */
function normalise(entry: string, env: Readonly<Record<string, string | undefined>>): string {
  const expanded = entry.trim().replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return key === undefined ? whole : (env[key] ?? whole);
  });
  return expanded.replace(/[\\/]+$/, "").toLowerCase();
}

export function hasEntry(
  value: string,
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const wanted = normalise(directory, env);
  return value.split(";").some((entry) => entry.trim() !== "" && normalise(entry, env) === wanted);
}

/** The value with `directory` appended, or undefined when it is there already. */
export function withEntry(
  value: string,
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (hasEntry(value, directory, env)) return undefined;
  const trimmed = value.replace(/;+$/, "");
  return trimmed === "" ? directory : `${trimmed};${directory}`;
}

/** The value without any entry naming `directory`, or undefined when it has none. */
export function withoutEntry(
  value: string,
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (!hasEntry(value, directory, env)) return undefined;
  const wanted = normalise(directory, env);
  return value
    .split(";")
    .filter((entry) => entry.trim() === "" || normalise(entry, env) !== wanted)
    .join(";")
    .replace(/;{2,}/g, ";")
    .replace(/^;|;$/g, "");
}

/** Adds `directory` to the user PATH; true when it changed anything. */
export async function addToUserPath(
  registry: UserPathRegistry,
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  if (/[;\r\n\0]/.test(directory)) throw new Error(`Unsupported path for PATH: ${directory}`);
  const current = await registry.read();
  const next = withEntry(current.value, directory, env);
  if (next === undefined) return false;
  // A new value is expandable, as Windows' own editor writes it.
  await registry.write({ value: next, kind: current.value === "" ? "ExpandString" : current.kind });
  return true;
}

/** Takes `directory` back off the user PATH; the person's other entries stay as they were. */
export async function removeFromUserPath(
  registry: UserPathRegistry,
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const current = await registry.read();
  const next = withoutEntry(current.value, directory, env);
  if (next === undefined) return false;
  await registry.write({ value: next, kind: current.kind });
  return true;
}

// The shell. Values travel through environment variables and UTF-8 output, so any path
// (Unicode, spaces, quotes) survives without command-line quoting.
const readScript = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
  "$value=$null; $kind='None'",
  "if ($key) { $value=$key.GetValue('Path',$null,'DoNotExpandEnvironmentNames'); if ($null -ne $value) { $kind=$key.GetValueKind('Path').ToString() } }",
  "[Console]::Out.Write((ConvertTo-Json -Compress @{ value = [string]$value; kind = $kind }))",
].join("; ");

const writeScript = [
  "$ErrorActionPreference='Stop'",
  "$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$key.SetValue('Path',[string]$env:ACE_USER_PATH_VALUE,[Enum]::Parse([Microsoft.Win32.RegistryValueKind],$env:ACE_USER_PATH_KIND))",
  "$key.Close()",
  // Clearing an unset variable through .NET broadcasts WM_SETTINGCHANGE("Environment"), so
  // Explorer and the terminals it starts see the new PATH without signing out.
  "[Environment]::SetEnvironmentVariable('ACE_PATH_CHANGED',$null,'User')",
].join("; ");

function powershell(script: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env: { ...process.env, ...env }, timeout: 30_000, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    ),
  );
}

/** The real `HKCU\Environment` through Windows PowerShell, which every Windows 10+ has. */
export const userPathRegistry: UserPathRegistry = {
  async read() {
    const parsed: unknown = JSON.parse((await powershell(readScript)).trim());
    if (typeof parsed !== "object" || parsed === null) throw new Error("Unreadable user PATH");
    const value = "value" in parsed && typeof parsed.value === "string" ? parsed.value : "";
    const kind = "kind" in parsed ? parsed.kind : "None";
    if (kind === "None") return { value: "", kind: "ExpandString" };
    if (kind !== "ExpandString" && kind !== "String")
      throw new Error(`The user PATH has an unexpected registry type (${String(kind)})`);
    return { value, kind };
  },
  async write(path) {
    await powershell(writeScript, {
      ACE_USER_PATH_VALUE: path.value,
      ACE_USER_PATH_KIND: path.kind,
    });
  },
};
