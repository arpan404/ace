import { z } from "zod";
import { secretCommand, slackManifest } from "./render.ts";
import type { BrokerEntry, Registry } from "./types.ts";

/**
 * The one registration a command can do: Slack creates an app from a manifest
 * (`apps.manifest.create`, with an app configuration token that has `app_configurations:write`)
 * and answers with its client ID and secret. The secret is printed once, to a terminal, and
 * written nowhere.
 */

export const SLACK_CREATE_URL = "https://slack.com/api/apps.manifest.create";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const Created = z.object({
  ok: z.literal(true),
  app_id: z.string().min(1),
  credentials: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }),
});
const Failed = z.object({
  ok: z.literal(false),
  error: z.string(),
  errors: z.array(z.object({ message: z.string(), pointer: z.string().optional() })).optional(),
});

export type SlackApp = { appId: string; clientId: string; clientSecret: string };

/** Posts the manifest. Throws with Slack's own error when it refuses. */
export async function createSlackApp(
  manifest: unknown,
  token: string,
  fetch: Fetch,
): Promise<SlackApp> {
  const response = await fetch(SLACK_CREATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ manifest: JSON.stringify(manifest) }).toString(),
  });
  const body: unknown = await response.json().catch(() => undefined);
  const created = Created.safeParse(body);
  if (created.success)
    return {
      appId: created.data.app_id,
      clientId: created.data.credentials.client_id,
      clientSecret: created.data.credentials.client_secret,
    };
  const failed = Failed.safeParse(body);
  if (!failed.success) throw new Error(`Slack answered HTTP ${response.status} without a result`);
  const details = (failed.data.errors ?? []).map(
    (each) => `${each.pointer ? `${each.pointer}: ` : ""}${each.message}`,
  );
  throw new Error([`Slack refused: ${failed.data.error}`, ...details].join("\n"));
}

export type SlackRun = {
  registry: Registry;
  args: readonly string[];
  token: string | undefined;
  /** Whether standard output is a terminal; the secret is never printed into a pipe or file. */
  isTTY: boolean;
  fetch: Fetch;
  out: (line: string) => void;
  err: (line: string) => void;
};

/** `bun run docs:connectors slack --yes`. Returns the exit code. */
export async function runSlack(run: SlackRun): Promise<number> {
  if (run.args.length !== 1 || run.args[0] !== "--yes") {
    run.err(
      "This creates a real Slack app from registry.json (the manifest in out/slack-manifest.json). Run again with --yes.",
    );
    return 1;
  }
  const token = run.token?.trim();
  if (!token) {
    run.err(
      "Set SLACK_CONFIG_TOKEN to an app configuration token with app_configurations:write " +
        "(https://api.slack.com/apps, Your App Configuration Tokens).",
    );
    return 1;
  }
  if (!run.isTTY) {
    run.err(
      "Standard output isn't a terminal. The client secret is printed once and must not land " +
        "in a file or log; run this in a terminal.",
    );
    return 1;
  }
  const slack = run.registry.registrations.find(
    (entry): entry is BrokerEntry => entry.kind === "broker" && entry.id === "slack",
  );
  if (!slack) {
    run.err("registry.json has no slack broker entry");
    return 1;
  }
  const created = await createSlackApp(slackManifest(run.registry), token, run.fetch);
  const [idName, secretName] = slack.secrets;
  run.out(`Created Slack app ${created.appId}.`);
  run.out(`Client ID: ${created.clientId}`);
  run.out("");
  run.out("From apps/cloud, set the Worker secrets; wrangler asks for each value:");
  run.out(`  ${secretCommand(idName)}    # paste the client ID`);
  run.out(`  ${secretCommand(secretName)}    # paste the client secret`);
  run.out("");
  run.out(`Client secret, shown this once and saved nowhere by this tool: ${created.clientSecret}`);
  run.out(`Slack shows it again at https://api.slack.com/apps/${created.appId}/general.`);
  run.out("Then set slack's status in registry.json and run bun run docs:connectors.");
  return 0;
}
