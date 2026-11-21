import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, the apps side (ADR 0131): more of Spade's real catalogue so the
 * Marketplace's Apps and its search read as they will, a bot asking to connect Linear on a
 * connect card, and `aceFakeConnectors` on the page so a sign-in can be finished or failed by
 * hand (`aceFakeConnectors.finishSignIn("linear", "sam@example.com")`).
 */

const moreApps = [
  {
    id: "gmail",
    name: "Gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    sign_in: ["oauth_client"],
    notes:
      "Reads mail and writes drafts; it never sends. Signs in through Spade Cloud with your ace account once Spade's Google app is verified. You can instead use an OAuth client from your own Google Cloud project with the Gmail MCP API turned on.",
    category: "mail_chat",
    via: "cloud",
    ready: "sign_in",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    sign_in: ["oauth_client"],
    notes:
      "Signs in through Spade Cloud with your ace account once Spade's Google app is verified. You can instead use an OAuth client from your own Google Cloud project with the Calendar MCP API turned on.",
    category: "meetings",
    via: "cloud",
    ready: "sign_in",
  },
  {
    id: "slack",
    name: "Slack",
    url: "https://mcp.slack.com/mcp",
    sign_in: ["oauth_client"],
    notes:
      "Signs in through Spade Cloud with your ace account once Spade's Slack app is listed in Slack's directory: Slack lets only listed apps and a workspace's own internal apps use it. You can instead use the client ID and secret of an internal app in your workspace. Admins approve each app.",
    category: "mail_chat",
    via: "cloud",
    ready: "sign_in",
  },
  {
    id: "zoom",
    name: "Zoom",
    url: "https://mcp.zoom.us/mcp/meeting/streamable",
    sign_in: ["oauth_client"],
    notes:
      "Signs in through Spade Cloud with your ace account once Spade's Zoom app is registered: Zoom takes only apps registered with it, with a client secret. You can instead use a client ID and secret from your own app in Zoom's App Marketplace.",
    category: "meetings",
    via: "cloud",
    ready: "sign_in",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    sign_in: ["oauth_client"],
    notes:
      "Signs in through Spade Cloud with your ace account once Spade's Google app is verified. You can instead use an OAuth client from your own Google Cloud project with the Drive MCP API turned on.",
    category: "files",
    via: "cloud",
    ready: "sign_in",
  },
  {
    id: "figma",
    name: "Figma",
    url: "https://mcp.figma.com/mcp",
    sign_in: ["oauth"],
    notes: "Figma lets in only the apps in its MCP catalog.",
    category: "design",
  },
  {
    id: "stripe",
    name: "Stripe",
    url: "https://mcp.stripe.com",
    sign_in: ["oauth", "token"],
    notes:
      "For a key, use an agent API key: from December 2026 Stripe refuses plain secret keys here.",
    category: "money",
    key_url: "https://dashboard.stripe.com/apikeys",
  },
  {
    id: "airtable",
    name: "Airtable",
    url: "https://mcp.airtable.com/mcp",
    sign_in: ["oauth", "token"],
    notes:
      "You choose which bases it can reach when you sign in. A personal access token also works.",
    category: "work",
    key_url: "https://airtable.com/create/tokens",
  },
  {
    id: "todoist",
    name: "Todoist",
    url: "https://ai.todoist.net/mcp",
    sign_in: ["oauth"],
    notes: "",
    category: "work",
  },
  {
    id: "miro",
    name: "Miro",
    url: "https://mcp.miro.com/",
    sign_in: ["oauth"],
    notes: "One team per sign-in. On Enterprise plans an admin turns it on first.",
    category: "work",
  },
  {
    id: "calendly",
    name: "Calendly",
    url: "https://mcp.calendly.com/",
    sign_in: ["oauth"],
    notes: "Some tools, such as booking for an invitee, need a paid plan.",
    category: "meetings",
  },
  {
    id: "granola",
    name: "Granola",
    url: "https://mcp.granola.ai/mcp",
    sign_in: ["oauth"],
    notes: "Your meeting notes and transcripts.",
    category: "meetings",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    url: "https://mcp.hubspot.com",
    sign_in: ["oauth_client"],
    notes:
      "Signs in through Spade Cloud with your ace account, because HubSpot requires a client secret Spade can't ship. You can instead create an MCP connector in HubSpot (Development, then MCP Connectors) for a client ID and secret.",
    category: "sales_support",
    via: "cloud",
    ready: "sign_in",
  },
  {
    id: "intercom",
    name: "Intercom",
    url: "https://mcp.intercom.com/mcp",
    sign_in: ["oauth", "token"],
    notes: "US workspaces. EU workspaces add the server by URL: https://mcp.eu.intercom.com/mcp",
    category: "sales_support",
    key_url: "https://developers.intercom.com/docs/build-an-integration/learn-more/authentication",
  },
  {
    id: "vercel",
    name: "Vercel",
    url: "https://mcp.vercel.com",
    sign_in: ["oauth"],
    notes:
      "Can deploy your projects. Vercel lets in only the apps it has reviewed, until its sign-in names itself in its answers.",
    category: "code",
  },
  {
    id: "datadog",
    name: "Datadog",
    url: "https://mcp.datadoghq.com/v1/mcp",
    sign_in: ["oauth"],
    notes:
      "The US1 site. Other Datadog sites add their own server by URL, such as https://mcp.datadoghq.eu/v1/mcp.",
    category: "data",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    url: "https://mcp.dropbox.com/mcp",
    sign_in: ["oauth"],
    notes: "Beta.",
    category: "files",
  },
  {
    id: "supabase",
    name: "Supabase",
    url: "https://mcp.supabase.com/mcp",
    sign_in: ["oauth", "token"],
    notes: "A personal access token also works.",
    category: "code",
    key_url: "https://supabase.com/dashboard/account/tokens",
  },
  {
    id: "clickup",
    name: "ClickUp",
    url: "https://mcp.clickup.com/mcp",
    sign_in: ["oauth"],
    notes: "Public beta.",
    category: "work",
  },
  {
    id: "posthog",
    name: "PostHog",
    url: "https://mcp.posthog.com/mcp",
    sign_in: ["oauth", "token"],
    notes: "US Cloud. A personal API key made with the MCP Server preset also works.",
    category: "data",
    key_url: "https://app.posthog.com/settings/user-api-keys",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    url: "https://mcp.atlassian.com/v2/mcp",
    sign_in: ["oauth", "token"],
    notes: "Jira and Confluence. An admin decides whether API tokens may be used.",
    category: "work",
    key_url: "https://id.atlassian.com/manage-profile/security/api-tokens",
  },
  {
    id: "canva",
    name: "Canva",
    url: "https://api.canva.com/connect/v1/mcp",
    sign_in: ["oauth_client"],
    notes:
      "Signs in through Spade Cloud with your ace account, because Canva requires a client secret Spade can't ship. You can instead use a client ID and secret from Canva's Developer Portal with Canva MCP switched on. Some tools need Canva Pro.",
    category: "design",
    via: "cloud",
    ready: "sign_in",
  },
  {
    id: "fireflies",
    name: "Fireflies",
    url: "https://api.fireflies.ai/mcp",
    sign_in: ["oauth"],
    notes: "Your meeting transcripts and summaries.",
    category: "meetings",
  },
  {
    id: "zapier",
    name: "Zapier",
    url: "https://mcp.zapier.com/api/v1/connect",
    sign_in: ["token"],
    notes:
      "At mcp.zapier.com, create a server, pick its actions, then generate a connection token. Its actions may send or pay in other apps.",
    category: "work",
    key_url: "https://mcp.zapier.com/",
  },
  {
    id: "mercury",
    name: "Mercury",
    url: "https://mcp.mercury.com/mcp",
    sign_in: ["oauth"],
    notes: "Beta. Payments it requests still need approval in Mercury.",
    category: "money",
  },
  {
    id: "webflow",
    name: "Webflow",
    url: "https://mcp.webflow.com/mcp",
    sign_in: ["oauth"],
    notes: "One workspace per sign-in; sign in again to switch.",
    category: "design",
  },
] as const;

export function seedFakeApps(here: FakeSpadeApi) {
  const listed = new Set(here.connectors.catalogue.map((each) => each.id));
  for (const app of moreApps) {
    if (listed.has(app.id)) continue;
    here.connectors.catalogue.push({ ...app, sign_in: [...app.sign_in] });
    if ("via" in app) here.connectors.viaCloud.add(app.id);
  }
  // Slack is connected too, and used by two bots, so "Use in another bot" has something to do.
  here.connectors.connectors.push({
    id: "slack",
    name: "Slack",
    url: "https://mcp.slack.com/mcp",
    catalogue: "slack",
    sign_in: "oauth",
    via: "cloud",
    state: "connected",
    account: "sam@acme.dev",
    tools: 18,
    last_used_ms: Date.now() - 3 * 3_600_000,
  });
  here.connectors.access.set("inbox", { all: false, connectors: ["github", "slack"] });
  (globalThis as { aceFakeConnectors?: unknown }).aceFakeConnectors = here.connectors;

  const bot = here.addAgent({
    id: "standup",
    name: "Standup",
    task: "Write the team's daily standup from Linear and post it at 9.",
    avatar: {
      kind: "character",
      v: 1,
      body: "round",
      pair: "mint",
      ears: "none",
      marking: "none",
      eyes: "round",
      mouth: "smile",
      cheeks: "none",
      accessory: "none",
    },
  });
  here.store(bot.conversation, {
    type: "user_message",
    text: "Write tomorrow's standup from what moved in Linear today.",
  });
  here.card(bot, "c-linear", [
    {
      prompt: "I need to read your team's Linear issues to see what moved today.",
      kind: "connect",
      app: "linear",
      name: "Linear",
      way: "sign_in",
      can: ["Read issues and projects", "Comment on issues"],
    },
  ]);
}
