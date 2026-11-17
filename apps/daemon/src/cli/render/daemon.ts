import type { CliLogRecord } from "@ace/protocol/cli-outputs";

/** Words for `ace daemon …` and `ace service …` (ADR 0176 §3). Pure: values → lines. */

export interface StartedDaemon {
  running: true;
  url: string;
  tokenPath: string;
  remoteUrl?: string | undefined;
  fingerprint?: string | undefined;
}

/**
 * What `ace start` prints for a person. The desktop app and the login service read this
 * process's output, so these bytes never change.
 */
export function startedText(daemon: StartedDaemon): string {
  return `ace daemon: ${daemon.url}\nToken file: ${daemon.tokenPath}${daemon.remoteUrl ? `\nRemote: ${daemon.remoteUrl}\nPublic-key SHA-256: ${daemon.fingerprint}` : ""}`;
}

/** What `ace start --json` prints: the same keys as ever. */
export function startedJson(daemon: StartedDaemon): StartedDaemon {
  return {
    running: true,
    url: daemon.url,
    tokenPath: daemon.tokenPath,
    remoteUrl: daemon.remoteUrl,
    fingerprint: daemon.fingerprint,
  };
}

export type Health =
  | { running: false }
  | ({ running: true; version: string } & Record<string, unknown>);

export function healthLines(health: Health): string[] {
  if (!health.running) return ["ace isn't running.", "Start it with ace start, or open the app."];
  const lines = [`ace is running, version ${health.version}.`];
  if (health.ready !== true) lines.push("It is still starting up.");
  return lines;
}

const serviceWords = {
  install: (active: boolean) =>
    active ? "ace runs at login now, and it is running." : "ace runs at login now.",
  uninstall: () => "ace no longer runs at login.",
  start: (active: boolean) =>
    active ? "The login service is running." : "✕ The login service didn't start.",
  stop: () => "The login service is stopped.",
  status: (active: boolean) =>
    active ? "ace runs at login, and it is running." : "The login service isn't running.",
} as const;

export function serviceLines(
  verb: keyof typeof serviceWords,
  state: { active: boolean; linger?: true },
): string[] {
  const lines = [serviceWords[verb](state.active)];
  if (state.linger) lines.push("It keeps running after you log out.");
  return lines;
}

const levelColor: Readonly<Record<CliLogRecord["level"], string | undefined>> = {
  debug: "\u001b[2m",
  info: undefined,
  warn: "\u001b[33m",
  error: "\u001b[31m",
};

const two = (value: number) => String(value).padStart(2, "0");

function clock(at: number): string {
  const time = new Date(at);
  return `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())}`;
}

/** One log record as one line: when, level, component, message, then its data compactly. */
export function logLine(record: CliLogRecord, color = false): string {
  const level = record.level.padEnd(5);
  const shown =
    color && levelColor[record.level] ? `${levelColor[record.level]}${level}\u001b[0m` : level;
  const data = record.data === undefined || record.data === null ? "" : `  ${compact(record.data)}`;
  return `${clock(record.at)} ${shown} ${record.component}  ${record.message}${data}`;
}

function compact(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = (text ?? "").replace(/\s+/g, " ");
  return flat.length > 400 ? `${flat.slice(0, 399)}…` : flat;
}
