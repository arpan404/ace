import type { Check } from "@ace/diagnostics";
import { computerUsePorts, type ComputerUsePorts, type ScreenFacts } from "./computer-use-facts.ts";
import { linuxComputerPorts } from "./computer-use-linux-facts.ts";
import { linuxComputerChecks, type LinuxComputerPorts } from "./computer-use-linux.ts";
import type { DoctorContext, DoctorFeature } from "./feature.ts";

const helperFix = "Open the ace desktop app; it installs Ace Screen Helper and starts ace with it.";
const grants = [
  {
    id: "computer.accessibility",
    key: "accessibility",
    title: "Accessibility",
    pane: "System Settings › Privacy & Security › Accessibility",
    needed: "agents can't click or type in apps",
  },
  {
    id: "computer.screen-recording",
    key: "screenRecording",
    title: "Screen Recording",
    pane: "System Settings › Privacy & Security › Screen & System Audio Recording",
    needed: "agents can't see app windows",
  },
] as const;

/**
 * macOS computer use: Ace Screen Helper is installed, and holds the Accessibility and Screen
 * Recording grants. Grants are known only through the running daemon's helper; while ace is
 * stopped they read as unknown, which is not a problem. Linux: the Wayland session and what
 * the helper needs on its bus (`computer-use-linux.ts`).
 */
export function computerUseFeature(
  ports: ComputerUsePorts = computerUsePorts,
  linux: LinuxComputerPorts = linuxComputerPorts,
): DoctorFeature {
  return {
    id: "computer",
    checks(context) {
      if (context.platform === "win32") return [windowsGrantsCheck()];
      if (context.platform === "linux") return linuxComputerChecks(context, linux);
      if (context.platform !== "darwin") return [];
      let facts: Promise<ScreenFacts | undefined> | undefined;
      const load = () => (facts ??= ports.screen(context));
      return [helperCheck(context, ports, load), ...grants.map((grant) => grantCheck(grant, load))];
    },
  };
}

export const computerUse: DoctorFeature = computerUseFeature();

function helperCheck(
  context: DoctorContext,
  ports: ComputerUsePorts,
  load: () => Promise<ScreenFacts | undefined>,
): Check {
  return {
    id: "computer.helper",
    fix: helperFix,
    async run() {
      const facts = await load();
      if (facts?.kind === "unconfigured")
        return {
          status: "warn",
          message: "ace is running without Ace Screen Helper, so computer use is unavailable",
          fix: "Quit ace and start it from the desktop app, which runs it with the helper.",
        };
      if (facts?.kind === "failed")
        return {
          status: "warn",
          message: `Ace Screen Helper didn't answer: ${facts.message.slice(0, 512)}`,
          fix: "Turn computer use off and on in Settings › Computer use. If it still fails, run ace triage.",
        };
      const path = await ports.helper(context);
      if (path)
        return {
          status: "ok",
          message: `Ace Screen Helper at ${tilde(path, context)}`,
          fix: helperFix,
        };
      // A running helper answered, so it exists even where doctor can't see its path.
      if (facts?.kind === "known")
        return { status: "ok", message: "Ace Screen Helper is running", fix: helperFix };
      return {
        status: "warn",
        message: "Ace Screen Helper isn't installed, so computer use is unavailable",
        fix: helperFix,
      };
    },
  };
}

function grantCheck(
  grant: (typeof grants)[number],
  load: () => Promise<ScreenFacts | undefined>,
): Check {
  const fix = `Open ${grant.pane} and turn on Ace Screen Helper. If it's already on, remove it and add it again.`;
  return {
    id: grant.id,
    fix,
    async run() {
      const facts = await load();
      if (!facts)
        return { status: "ok", message: `${grant.title}: unknown while ace is stopped`, fix };
      if (facts.kind !== "known")
        return { status: "ok", message: `${grant.title}: unknown without Ace Screen Helper`, fix };
      if (facts.permissions[grant.key])
        return { status: "ok", message: `${grant.title} granted to Ace Screen Helper`, fix };
      if (!facts.enabled)
        return {
          status: "ok",
          message: `${grant.title} not granted; needed once computer use is on`,
          fix,
        };
      return {
        status: "warn",
        message: `Ace Screen Helper doesn't have ${grant.title}, so ${grant.needed}`,
        fix,
      };
    },
  };
}

function tilde(path: string, context: DoctorContext): string {
  return context.home && path.startsWith(`${context.home}/`)
    ? `~${path.slice(context.home.length)}`
    : path;
}

/** Windows has no per-app screen or input grant; integrity levels are the only limit. */
function windowsGrantsCheck(): Check {
  return {
    id: "computer.grants",
    fix: "Nothing to do.",
    async run() {
      return {
        status: "ok",
        message:
          "Windows needs no Accessibility or Screen Recording grant for computer use; apps running as administrator stay out of reach",
        fix: "Nothing to do.",
      };
    },
  };
}
