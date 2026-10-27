import type { Admission, AppUpdate, DiagnosticsHealth } from "@ace/protocol";

/** Each read-only setup check's name as people know it, and what to do when it fails. */
export const hostChecks: Record<string, { label: string; fix: string }> = {
  "home.permissions": {
    label: "Data folder access",
    fix: "Run safe repairs, or restore owner access to the ace data folder.",
  },
  "logs.directory": {
    label: "Log folder",
    fix: "Run safe repairs to create the log folder or restore owner access.",
  },
  node: { label: "App runtime", fix: "Update ace and restart it." },
  git: { label: "Git", fix: "Install Git. On a Mac, install the Xcode Command Line Tools." },
  "node-pty": { label: "Terminal", fix: "Reinstall ace, then try opening a terminal again." },
  chromium: { label: "Browser", fix: "Install Chrome or Chromium to use the browser tools." },
  disk: {
    label: "Storage",
    fix: "Free some disk space and check that ace can read and write its data folder.",
  },
  sqlite: {
    label: "Saved conversations",
    fix: "Quit ace and back up its data folder before restoring a known-good backup.",
  },
  "remote.openssl": {
    label: "Secure connections",
    fix: "Install OpenSSL to use secure remote connections.",
  },
};
export const unknownCheck = {
  label: "Additional check",
  fix: "Update ace and run the checks again. If this continues, export a support bundle.",
};
export const checkStatusWords = {
  ok: "Passed",
  warn: "Needs attention",
  fail: "Needs a fix",
} as const;

/** Each daemon queue's name as people know it. */
export const queueLabels: Record<string, string> = {
  intents: "Actions",
  notifications: "Notifications",
  "output.chunks": "Output updates",
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
const ms = (value: number | null) => (value === null ? "–" : `${value.toFixed(1)} ms`);

/** The daemon's health as label and value rows, in the order Settings shows them. */
export function healthRows(health: DiagnosticsHealth): [string, string][] {
  return [
    ["Memory", mb(health.memory.rssBytes)],
    ["Heap", `${mb(health.memory.heapUsedBytes)} of ${mb(health.memory.heapTotalBytes)}`],
    ["Sessions", health.activeSessions === null ? "–" : String(health.activeSessions)],
    ["Event loop", `p99 ${ms(health.eventLoop.p99Ms)} · max ${ms(health.eventLoop.maxMs)}`],
    ["Open handles", String(health.openHandles)],
  ];
}

/** Pending work by queue name, with unnamed queues as "Other work". */
export function queueRows(health: DiagnosticsHealth): { name: string; depth: number }[] {
  return Object.entries(health.queues).map(([name, depth]) => ({
    name: queueLabels[name] ?? "Other work",
    depth,
  }));
}

const systemHolds = {
  update: "Updating ace · new work resumes after",
  kill: "Stopping all work · new work resumes after",
  stop: "ace is shutting down",
} as const;

/** How much work is still running while admission is closed, waiting-on-you counted apart. */
function stillRunning(admission: Admission): string {
  const finishing = Math.max(0, admission.busy - admission.waiting);
  const parts = [
    ...(finishing === 1 ? ["1 thread is finishing"] : []),
    ...(finishing > 1 ? [`${finishing} threads are finishing`] : []),
    ...(admission.waiting > 0 ? [`${admission.waiting} waiting on you`] : []),
  ];
  return parts.length ? parts.join(" · ") : "nothing is running";
}

/**
 * "Pause new work": where a machine stands and the one action that changes it. Pausing and
 * resuming change only the person's own hold; while an update, kill-all or stop holds admission,
 * the line says so and Resume can't be used (pausing still can).
 */
export function admissionWords(admission: Admission): {
  paused: boolean;
  line: string | null;
  action: string;
  canChange: boolean;
} {
  const paused = admission.holds.includes("user");
  const system = admission.holds.find((hold): hold is keyof typeof systemHolds => hold !== "user");
  const action = paused ? "Resume new work" : "Pause new work";
  if (system) return { paused, line: systemHolds[system], action, canChange: !paused };
  if (!paused) return { paused, line: null, action, canChange: true };
  return { paused, line: `New work paused · ${stillRunning(admission)}`, action, canChange: true };
}

/**
 * The desktop app's update, read-only: its version and one line. Restart required is the only
 * state that needs the person; a daemon no app has reported to reads Unknown.
 */
export function appUpdateWords(update: AppUpdate): {
  version: string;
  line: string | null;
  needsYou: boolean;
} {
  const report = update.report;
  if (!report) return { version: "Unknown", line: null, needsYou: false };
  if (report.restartRequired)
    return { version: report.version, line: "Restart to finish updating", needsYou: true };
  return {
    version: report.version,
    line: report.available ? `Update ${report.available} available` : "Up to date",
    needsYou: false,
  };
}
