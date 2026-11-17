import { accessCommands, accessNouns } from "./access.ts";
import { grammarRelease as since, limit, providerName } from "./flags.ts";
import type { CommandSpec, NounSpec } from "./spec.ts";

/** Provider CLIs, models, the ace account and who can reach this machine (ADR 0176 §7). */
export const providerNouns: readonly NounSpec[] = [
  {
    name: "provider",
    summary: "The agent CLIs ace drives, and their accounts",
    group: "providers",
  },
  { name: "model", summary: "The models each provider offers", group: "providers" },
  { name: "account", summary: "This machine's ace account", group: "providers" },
  ...accessNouns,
];

const providers = "codex, claude, cursor, opencode, antigravity or pi";
const providerArg = { name: "PROVIDER", summary: providers, required: true } as const;
const loginAliases = ["codex", "claude", "cursor", "opencode", "antigravity", "pi"].map(
  (provider) => ({
    words: ["login", provider],
    deprecatedSince: since,
    insertWords: [provider],
  }),
);
const account = { name: "account", value: "ACCOUNT", summary: "Which of the provider's accounts" };

const ownCommands: readonly CommandSpec[] = [
  {
    id: "provider.list",
    words: ["provider", "list"],
    summary: "Installed provider CLIs and whether they're ready",
    group: "providers",
    nounDefault: true,
    aliases: [
      { words: ["providers"], quiet: true },
      { words: ["providers", "status"], deprecatedSince: since },
    ],
    examples: [{ command: "ace provider list", summary: "Which agents are ready" }],
    output: "provider.list",
  },
  {
    id: "provider.show",
    words: ["provider", "show"],
    summary: "One provider: its CLI, sign-in and accounts",
    group: "providers",
    args: [providerArg],
    examples: [{ command: "ace provider show codex", summary: "Codex's state" }],
    output: "provider.show",
  },
  {
    id: "provider.capabilities",
    words: ["provider", "capabilities"],
    summary: "Providers, models, permission modes and ace's tools, in full",
    group: "providers",
    aliases: [{ words: ["capabilities"], deprecatedSince: since }],
    examples: [
      { command: "ace provider capabilities --json", summary: "Everything, for a script" },
    ],
    output: "provider.capabilities",
  },
  {
    id: "provider.login",
    words: ["provider", "login"],
    summary: "Sign a provider CLI in with its own login",
    description:
      "Starts the provider's own sign-in and prints the address and code to finish it in a browser. A provider that asks which service to connect takes --choice; without one, a person at a terminal picks from the list.",
    group: "providers",
    mutates: true,
    args: [providerArg],
    flags: [
      account,
      { name: "choice", value: "ID", summary: "The service to connect, when the CLI asks" },
      { name: "instance", value: "ACCOUNT", summary: "Same as --account", hidden: true },
    ],
    aliases: loginAliases,
    exits: [{ code: 2, when: "The sign-in needs the person: a code, a choice or a key" }],
    examples: [
      { command: "ace provider login codex", summary: "Sign Codex in" },
      { command: "ace provider login opencode --choice anthropic", summary: "Connect a service" },
    ],
    output: "provider.login",
  },
  {
    id: "provider.account.list",
    words: ["provider", "account", "list"],
    summary: "Provider accounts ace knows",
    group: "providers",
    offline: true,
    aliases: [{ words: ["accounts", "list"], deprecatedSince: since }],
    examples: [{ command: "ace provider account list", summary: "Every provider account" }],
    output: "provider.account.list",
  },
  {
    id: "provider.account.add",
    words: ["provider", "account", "add"],
    summary: "Add a provider account from its home folder",
    group: "providers",
    offline: true,
    mutates: true,
    args: [
      providerArg,
      { name: "ID", summary: "An id for the account", required: true },
      { name: "HOME", summary: "The provider's home folder for it", required: true },
      { name: "LABEL", summary: "A name you'll recognise", required: true },
    ],
    flags: [{ name: "console", summary: "A console (API) account" }],
    aliases: [{ words: ["accounts", "add"], deprecatedSince: since }],
    examples: [
      {
        command: "ace provider account add codex work ~/.codex-work Work",
        summary: "A second Codex account",
      },
    ],
    output: "provider.account.add",
  },
  {
    id: "provider.account.show",
    words: ["provider", "account", "show"],
    summary: "One provider account, its sign-in checked now",
    group: "providers",
    offline: true,
    args: [{ name: "ID", summary: "The account id", required: true }],
    aliases: [{ words: ["accounts", "status"], deprecatedSince: since }],
    examples: [{ command: "ace provider account show work", summary: "Is it signed in" }],
    output: "provider.account.show",
  },
  {
    id: "provider.account.discover",
    words: ["provider", "account", "discover"],
    summary: "Find provider accounts already on this machine",
    group: "providers",
    offline: true,
    aliases: [{ words: ["accounts", "discover"], deprecatedSince: since }],
    examples: [{ command: "ace provider account discover", summary: "Homes ace could add" }],
    output: "provider.account.discover",
  },
  {
    id: "model.list",
    words: ["model", "list"],
    summary: "Models you can pick, by provider",
    group: "providers",
    nounDefault: true,
    flags: [providerName, account, limit],
    examples: [
      { command: "ace model list", summary: "Every model" },
      { command: "ace model list --provider claude --quiet", summary: "Claude's model ids" },
    ],
    output: "model.list",
  },
  {
    id: "account.status",
    words: ["account", "status"],
    summary: "Whether this machine is signed in to ace, and as whom",
    group: "providers",
    nounDefault: true,
    examples: [{ command: "ace account", summary: "Who this machine is signed in as" }],
    output: "account.status",
  },
  {
    id: "account.login",
    words: ["account", "login"],
    summary: "Sign this machine in to your ace account",
    description:
      "Prints an address to open in a browser, then waits until the sign-in finishes there.",
    group: "providers",
    mutates: true,
    flags: [{ name: "origin", value: "URL", summary: "Another ace account server" }],
    aliases: [{ words: ["login"] }],
    examples: [{ command: "ace login", summary: "Sign in" }],
    output: "account.status",
  },
  {
    id: "account.logout",
    words: ["account", "logout"],
    summary: "Sign this machine out of its ace account",
    group: "providers",
    mutates: true,
    aliases: [{ words: ["logout"] }],
    examples: [{ command: "ace logout", summary: "Sign out" }],
    output: "account.status",
  },
  {
    id: "account.machine-code.set",
    words: ["account", "machine-code", "set"],
    summary: "Set the code account devices enter once",
    description:
      "Pass - to read the code from stdin. Without it, a terminal asks for it without echo; nothing else is read.",
    group: "providers",
    mutates: true,
    args: [{ name: "CODE", summary: "The code; asked without echo when omitted", stdin: true }],
    aliases: [{ words: ["machine-code", "set"], deprecatedSince: since }],
    examples: [{ command: "ace account machine-code set -", summary: "Read it from stdin" }],
    output: "account.status",
  },
  {
    id: "account.machine-code.clear",
    words: ["account", "machine-code", "clear"],
    summary: "Clear the machine code",
    group: "providers",
    mutates: true,
    aliases: [{ words: ["machine-code", "clear"], deprecatedSince: since }],
    examples: [{ command: "ace account machine-code clear", summary: "Clear it" }],
    output: "account.status",
  },
];

export const providerCommands: readonly CommandSpec[] = [...ownCommands, ...accessCommands];
