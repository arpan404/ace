import { serviceLabel } from "@ace/models/service-labels";
import type { LoginUpdate, ProviderLoginDriver } from "@ace/accounts";
import { loginUrl } from "@ace/accounts";
import { PiProviderId, piSdkEntry } from "@ace/provider-kit/discovery";
import { probeOutput, spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import type { OpenTerminalOptions } from "@ace/terminal";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Offered when this Pi can't list its providers (SDKs before `getProviders`). */
export const piLoginChoices = ["github-copilot", "openai-codex", "anthropic", "other"].map(
  (id) => ({ id, label: serviceLabel(id) }),
);
/**
 * Providers whose sign-in pages are reviewed from Pi's own SDK, so they run in ace's dialog.
 * Others (xAI, Kimi, Meta, Radius) get their page from their server at sign-in, so Pi's terminal
 * shows it.
 */
const inDialog = new Set(["github-copilot", "openai", "anthropic", "openrouter", "openai-codex"]);
const preferred = ["github-copilot", "openai", "anthropic", "openrouter"];
const choiceId = /^[a-z0-9_-]{1,64}$/;
const browserHint =
  "This page finishes on the computer running ace. Signing in from another device? Cancel and choose Other provider to use Pi's own terminal, where you can paste the final address.";
const Frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth_url"), url: z.string().max(8192) }),
  z.object({
    type: z.literal("device_code"),
    verificationUri: z.string().max(8192),
    userCode: z.string().regex(/^[A-Z0-9]{4,5}-[A-Z0-9]{4,5}$/),
  }),
  z.object({ type: z.literal("complete") }),
]);
const Listing = z.object({
  type: z.literal("providers"),
  providers: z
    .array(
      z.object({
        id: PiProviderId,
        name: z.string().max(128),
        oauth: z.string().max(128).optional(),
      }),
    )
    .max(512)
    .optional(),
  signedIn: z.array(PiProviderId).max(512).optional(),
});
type Listing = z.infer<typeof Listing>;
export type PiChoice = { id: string; label: string; route: "dialog" | "terminal" };

function rank(id: string): number {
  return preferred.includes(id) ? preferred.indexOf(id) : preferred.length;
}

/** What sign-in offers: Pi's OAuth providers, the reviewed ones in the dialog, then Other. */
export function piSignInChoices(providers: Listing["providers"]): PiChoice[] {
  if (!providers)
    return piLoginChoices.map(({ id, label }): PiChoice => ({
      id,
      label,
      route: id === "other" ? "terminal" : "dialog",
    }));
  const oauth = providers.filter((provider) => provider.oauth && choiceId.test(provider.id));
  // Pi's current ChatGPT sign-in supersedes its legacy Codex one.
  const current = oauth.some((provider) => provider.id === "openai")
    ? oauth.filter((provider) => provider.id !== "openai-codex")
    : oauth;
  return [
    ...current
      .toSorted((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
      .slice(0, 31)
      .map((provider): PiChoice => ({
        id: provider.id,
        label: (provider.oauth || provider.name).slice(0, 128),
        route: inDialog.has(provider.id) ? "dialog" : "terminal",
      })),
    { id: "other", label: serviceLabel("other"), route: "terminal" },
  ];
}

/** What sign-out offers: only providers Pi has a saved sign-in for, when it can say. */
export function piSignOutChoices(listing: Listing | undefined): PiChoice[] {
  if (!listing?.signedIn) return piSignInChoices(undefined);
  const names = new Map(listing.providers?.map((provider) => [provider.id, provider.name]));
  return listing.signedIn
    .filter((id) => choiceId.test(id))
    .slice(0, 32)
    .map((id) => ({
      id,
      label: (serviceLabel(id) !== id ? serviceLabel(id) : (names.get(id) ?? id)).slice(0, 128),
      route: "dialog",
    }));
}

/** The worker command for one Pi SDK operation; an API key goes on its stdin, never in argv. */
export function piWorkerArgs(
  entry: string,
  action: "providers" | "login" | "logout" | "api_key",
  provider?: string,
): string[] {
  return [
    fileURLToPath(new URL("./pi-login-worker.ts", import.meta.url)),
    entry,
    action,
    ...(provider ? [PiProviderId.parse(provider)] : []),
  ];
}

export interface PiLoginOptions {
  command: string;
  version?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  action: "login" | "logout";
  assertCurrent?(): void;
  openTerminal?:
    | ((launch: OpenTerminalOptions) => {
        id: string;
        exited: Promise<boolean>;
        stop(): Promise<void>;
      })
    | undefined;
}

const workerEnv = (env: NodeJS.ProcessEnv) => ({
  ...env,
  NODE_OPTIONS: undefined,
  NODE_PATH: undefined,
});

/**
 * A Pi API key goes to the installed SDK's own key prompt in the worker: the key on stdin, the
 * provider it belongs to in argv. ace neither logs nor stores it.
 */
export async function piKeyHandOff(
  command: string,
  version: string | undefined,
  upstream: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
  if (!upstream) throw new Error("Choose which provider the key is for");
  const entry = await piSdkEntry(command, version);
  return {
    command: process.execPath,
    args: piWorkerArgs(entry, "api_key", upstream),
    env: workerEnv(env),
  };
}

/** Only safe SDK challenges cross the wire. Other services use a subscriber-started native PTY. */
export function piLoginDriver(options: PiLoginOptions): ProviderLoginDriver {
  let choose: ((choice: string) => boolean) | undefined;
  let child: SupervisedProcess | undefined;
  let terminal: ReturnType<NonNullable<PiLoginOptions["openTerminal"]>> | undefined;
  const inTerminal = async (
    signal: AbortSignal,
    emit: (update: LoginUpdate) => void,
    provider?: string,
  ) => {
    if (!options.openTerminal) throw new Error("Terminal unavailable");
    terminal = options.openTerminal({
      shell: options.command,
      args: [],
      cwd: options.cwd,
      env: options.env,
      cols: 80,
      rows: 24,
      name: "Pi sign-in",
    });
    const abort = () => {
      void terminal?.stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      emit({
        state: "awaiting_input",
        manual: {
          action: "open_terminal",
          command: "pi",
          instruction: provider
            ? `Type /${options.action} ${provider}, then finish its prompts. Exit Pi when you're done.`
            : `Type /${options.action}, choose your provider, then finish its prompts. Exit Pi when you're done.`,
          terminalId: terminal.id,
        },
      });
      if (signal.aborted) abort();
      return { success: (await terminal.exited) && !signal.aborted };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  return {
    input(input) {
      return "choice" in input && !!choose?.(input.choice);
    },
    async drain() {
      await child?.stop();
      await terminal?.stop();
    },
    async run(signal, emit) {
      let entry: string;
      try {
        entry = await piSdkEntry(options.command, options.version);
      } catch {
        // Without its SDK, Pi still signs in through its own terminal.
        signal.throwIfAborted();
        options.assertCurrent?.();
        return inTerminal(signal, emit);
      }
      let listing: Listing | undefined;
      try {
        const output = await probeOutput(process.execPath, piWorkerArgs(entry, "providers"), {
          env: workerEnv(options.env),
          timeoutMs: 10_000,
          signal,
        });
        listing =
          output.code === 0
            ? Listing.parse(JSON.parse(output.stdout.trim().split("\n").at(-1) ?? ""))
            : undefined;
      } catch {
        signal.throwIfAborted();
        listing = undefined;
      }
      const offered =
        options.action === "login"
          ? piSignInChoices(listing?.providers)
          : piSignOutChoices(listing);
      if (!offered.length) return { success: false, message: "Pi has no saved sign-in to remove." };
      const upstream = await new Promise<string>((resolve, reject) => {
        const abort = () => {
          choose = undefined;
          reject(new Error("Cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        choose = (choice) => {
          if (!offered.some((candidate) => candidate.id === choice)) return false;
          signal.removeEventListener("abort", abort);
          choose = undefined;
          resolve(choice);
          return true;
        };
        emit({
          state: "awaiting_input",
          choices: offered.map(({ id, label }) => ({ id, label })),
        });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      options.assertCurrent?.();
      const choice = offered.find((candidate) => candidate.id === upstream);
      if (choice?.route !== "dialog")
        return inTerminal(signal, emit, upstream === "other" ? undefined : upstream);
      child = spawnSupervised({
        command: process.execPath,
        args: piWorkerArgs(entry, options.action, upstream),
        cwd: options.cwd,
        env: workerEnv(options.env),
        name: "Pi login",
        maxLineBytes: 16384,
        maxOutputBytes: 262144,
      });
      const owned = child;
      let completed = false;
      let invalid = false;
      const abort = () => {
        void owned.stop();
      };
      signal.addEventListener("abort", abort, { once: true });
      owned.stderr.on("line", () => {});
      owned.stdout.on("line", (line) => {
        if (signal.aborted || invalid) return;
        try {
          const frame = Frame.parse(JSON.parse(line));
          if (frame.type === "complete") {
            completed = true;
            return;
          }
          const url = loginUrl("pi", frame.type === "auth_url" ? frame.url : frame.verificationUri);
          if (!url) throw new Error("Unreviewed login URL");
          emit({
            state: frame.type === "device_code" ? "awaiting_code_entry" : "awaiting_browser",
            url,
            ...(frame.type === "device_code"
              ? { userCode: frame.userCode }
              : { hint: browserHint }),
          });
        } catch {
          invalid = true;
          abort();
        }
      });
      try {
        if (signal.aborted) abort();
        const exit = await owned.exited;
        signal.throwIfAborted();
        return { success: completed && !invalid && exit.code === 0 && exit.reason === "exit" };
      } finally {
        signal.removeEventListener("abort", abort);
        await owned.stop();
      }
    },
  };
}
