import { paths } from "./registry.ts";
import {
  type ApprovalEntry,
  type BrokerEntry,
  type Entry,
  type Identity,
  inOrder,
  type Registry,
  type Status,
} from "./types.ts";

/**
 * What `render` writes, as path and content: the checklist in `spade/docs`, and in `out/` the
 * runbook page's inputs, the outreach messages and Slack's manifest. Pure: no I/O here.
 */

/** One value the person types or pastes into a console, in the order the console asks. */
export type Field = { label: string; value: string };

export const statusLabel: Record<Status, string> = {
  "not-started": "Not started",
  submitted: "Submitted",
  approved: "Approved",
  blocked: "Blocked",
};

const kindLabel: Record<Entry["kind"], string> = {
  broker: "ace cloud app",
  public: "public app",
  approval: "maker approval",
};

/** The command that stores one Worker secret; wrangler asks for the value. */
export function secretCommand(name: string): string {
  return `XDG_CONFIG_HOME=~/.ace-cloudflare bunx wrangler secret put ${name} --env production`;
}

function identityFields(app: Identity): Field[] {
  return [
    { label: "Name", value: app.name },
    { label: "Homepage", value: app.homepage },
    { label: "Privacy policy", value: app.privacy },
    { label: "Terms of service", value: app.terms },
    { label: "Description", value: app.description },
  ];
}

function brokerFields(entry: BrokerEntry, app: Identity): Field[] {
  return [
    ...identityFields(app),
    ...entry.redirects.map((value) => ({ label: "Redirect URL", value })),
    ...entry.scopes.map((value) => ({ label: "Scope", value })),
    ...entry.secrets.map((name) => ({
      label: "Secret, from apps/cloud",
      value: secretCommand(name),
    })),
  ];
}

function approvalFields(entry: ApprovalEntry, app: Identity): Field[] {
  return [
    { label: "Client name", value: app.name },
    { label: "Homepage", value: app.homepage },
    { label: "Client ID metadata document", value: entry.client_document },
    ...entry.redirects.map((value) => ({ label: "Redirect URI (loopback, any port)", value })),
    { label: "Privacy policy", value: app.privacy },
    { label: "Terms of service", value: app.terms },
    { label: "Contact", value: app.contact },
  ];
}

/** Every field for one registration, in the order its console asks for them. */
export function fields(entry: Entry, app: Identity): Field[] {
  if (entry.kind === "broker") return brokerFields(entry, app);
  if (entry.kind === "approval") return approvalFields(entry, app);
  return [
    { label: "Application name", value: app.name },
    { label: "Homepage URL", value: app.homepage },
    { label: "Application description", value: app.description },
    ...entry.redirects.map((value) => ({ label: "Authorization callback URL", value })),
    { label: "Enable Device Flow", value: "on" },
  ];
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function codeBlock(lines: readonly string[], language = ""): string[] {
  return ["```" + language, ...lines, "```"];
}

function bullets(list: readonly Field[]): string[] {
  return list.map((field) => `- ${field.label}: \`${field.value}\``);
}

function sectionFields(entry: Entry, app: Identity): string[] {
  if (entry.kind !== "broker") return bullets(fields(entry, app));
  const lines = bullets(identityFields(app));
  lines.push("", "Redirect URLs, one per line:", "", ...codeBlock(entry.redirects), "");
  if (entry.scopes.length) lines.push("Scopes, one per line:", "", ...codeBlock(entry.scopes));
  else lines.push("Scopes: none to enter (see the notes).");
  lines.push(
    "",
    "Then, from `apps/cloud`:",
    "",
    ...codeBlock(entry.secrets.map(secretCommand), "sh"),
  );
  return lines;
}

function section(entry: Entry, app: Identity, step: number): string[] {
  const lines = [`## ${step}. ${entry.name}`, ""];
  const started = entry.started ? ` Started ${entry.started}.` : "";
  lines.push(
    `Kind: ${kindLabel[entry.kind]}. Status: ${statusLabel[entry.status].toLowerCase()}.${started} About ${entry.minutes} minutes.`,
    "",
  );
  if (entry.blocked_on) lines.push(`**Blocked on:** ${entry.blocked_on}.`, "");
  if (entry.kind === "approval") {
    const where = entry.console ? `[${entry.channel}](${entry.console})` : entry.channel;
    lines.push(
      `Send to: ${where}. The message, ready to send, is written to \`${paths.out}/outreach/${entry.id}.md\`.`,
      "",
    );
    lines.push(`> ${entry.ask}`, "");
    lines.push("Values:", "");
  } else {
    lines.push(`Where: ${entry.where}`, "", `Console: <${entry.console}>`, "");
    if (entry.kind === "broker") {
      lines.push(`Covers: ${entry.apps.map((id) => `\`${id}\``).join(", ")}.`, "");
    }
    lines.push("Fields, in the order the console asks for them:", "");
  }
  lines.push(...sectionFields(entry, app), "");
  if (entry.kind === "public")
    lines.push(
      `Scopes, asked for at sign-in: ${entry.scopes.map((s) => `\`${s}\``).join(", ")}.`,
      "",
    );
  if (entry.notes.length) lines.push("Notes:", "", ...entry.notes.map((note) => `- ${note}`), "");
  return lines;
}

/** `spade/docs/connector-registrations.md`. */
export function renderMarkdown(registry: Registry): string {
  const entries = inOrder(registry);
  const lines = [
    "# Spade's connector registrations",
    "",
    `Generated by \`bun run docs:connectors\` from [\`registry.json\`](../../${paths.registry}). Don't edit this file by hand: change the registry and run the command again. \`bun run docs:connectors --check\` fails when the registry and the code disagree, or when this file is stale.`,
    "",
    "Every OAuth app and MCP client approval Spade needs from a maker, in the order to do them: the longest review queues first. Why each one is needed is in [connector-apps.md](connector-apps.md).",
    "",
    "## What can be automated",
    "",
    "Slack can: `bun run docs:connectors slack --yes` creates the app from its manifest through Slack's `apps.manifest.create` API and prints the client ID and secret once, to the terminal. No other maker here offers an API for creating an OAuth app, so the browser part is done by a person; this page and the runbook (`bun run docs:connectors` writes it to `" +
      paths.out +
      "/runbook.html`) put every value one copy away.",
    "",
    "## Status",
    "",
    "| Registration | Kind | Status | Minutes | Blocked on |",
    "| --- | --- | --- | --- | --- |",
    ...entries.map(
      (entry) =>
        `| ${cell(entry.name)} | ${kindLabel[entry.kind]} | ${statusLabel[entry.status]} | ${entry.minutes} | ${cell(entry.blocked_on ?? "")} |`,
    ),
    "",
    ...entries.flatMap((entry, index) => section(entry, registry.app, index + 1)),
  ];
  return lines.join("\n").trimEnd() + "\n";
}

/** A message to one approval maker, with every value it needs. */
export function renderOutreach(entry: ApprovalEntry, app: Identity): string {
  const where = entry.console ? `${entry.channel}: ${entry.console}` : entry.channel;
  return [
    `# ${entry.name}: Spade as an MCP client`,
    "",
    `Send to: ${where}`,
    "",
    `Subject: Spade (ace) as an MCP client for ${entry.name}`,
    "",
    `Hello ${entry.name} team,`,
    "",
    entry.ask,
    "",
    ...fields(entry, app).map((field) => `- ${field.label}: ${field.value}`),
    "",
    "Spade is open source, under Apache-2.0.",
    "",
    "Thanks,",
    `The ace team (${app.contact})`,
    "",
  ].join("\n");
}

/** The Slack app's manifest for `apps.manifest.create`: user scopes only, nothing else on. */
export function slackManifest(registry: Registry) {
  const slack = registry.registrations.find(
    (entry): entry is BrokerEntry => entry.kind === "broker" && entry.id === "slack",
  );
  if (!slack) throw new Error("registry.json has no slack broker entry");
  return {
    display_information: { name: registry.app.name, description: registry.app.description },
    oauth_config: { redirect_urls: slack.redirects, scopes: { user: slack.scopes } },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
