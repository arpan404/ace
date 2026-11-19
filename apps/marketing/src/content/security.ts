import { links } from "../site.ts";

/*
 * The words of /security/: where things live (the drawn map), then ace's boundaries in four
 * groups. Every line follows a record: ADR 0002 (provider logins), 0070 (pairing), 0100 and
 * 0111 (the account and machine codes), 0105 (what linked machines may do), 0106 (the push
 * gateway), 0110 (the relay), 0122 (outside MCP apps) and content/legal.ts. When one of those
 * changes, change this too. The page's questions are product.ts's `securityQuestions`, which
 * seo/markdown.ts also reads.
 */

export const securityPage = {
  title: "Security and privacy: where your code lives with ace",
  description:
    "ace runs on your machines. Logins stay with each CLI, the relay forwards only encrypted traffic, and the account holds your email and a list of machines.",
  headline: "Your code never leaves your machines for ours",
  intro:
    "ace is an app you run, not a service you send work to. Here is what lives where, and what each part can see.",
  mapHeading: "Where things live.",
  mapLede:
    "Your devices reach your machines directly, over your network or Tailscale, or through ace's relay when they're apart.",
  mapNote: "No relay needed on your own network, over Tailscale or with a relay you host.",
  boundariesHeading: "Where ace stops.",
  recordsHeading: "Read it for yourself.",
  questionsHeading: "Questions about security.",
} as const;

/** One place on the map: what it is, and the facts about what it holds or sees. */
export interface MapNode {
  id: "machines" | "relay" | "account" | "devices";
  label: string;
  name: string;
  facts: string[];
}

export const mapNodes: MapNode[] = [
  {
    id: "machines",
    label: "Your machines",
    name: "Where the work happens",
    facts: [
      "Code, worktrees and terminals",
      "Threads, history and settings",
      "Each CLI's own login",
      "Agents, talking to their providers",
    ],
  },
  {
    id: "relay",
    label: "ace's relay",
    name: "Forwards what it can't read",
    facts: [
      "Sees addresses, timing and sizes",
      "Never prompts, code or screens",
      "Keeps nothing after",
    ],
  },
  {
    id: "devices",
    label: "Your devices",
    name: "Phone, browser, laptop",
    facts: ["Paired, or on your account", "A machine code asks for a PIN first"],
  },
  {
    id: "account",
    label: "ace account, optional",
    name: "Says which machines are yours",
    facts: [
      "Email and name",
      "Each machine's name, platform and last seen",
      "Sessions, stored only as hashes",
    ],
  },
];

/** The words on the lines between the places. */
export const mapLinks = {
  encrypted: "end-to-end encrypted",
  pass: "a five-minute pass",
} as const;

export interface BoundaryGroup {
  heading: string;
  rows: string[];
  /**
   * The words that turn each row into a sentence of its own where the heading isn't there to
   * carry it, as in the page's Markdown copy: "ace does not" before "store your…".
   */
  lead?: string;
}

export const boundaryGroups: BoundaryGroup[] = [
  {
    heading: "What stays on your machines",
    rows: [
      "Your code, threads, prompts, transcripts, files and settings live on your computers and are never sent to us.",
      "Agents run on your computers, never on ace's servers.",
      "Each agent signs in through its own CLI, which keeps its own login.",
      "Keys you add for Spade's endpoints go into your system keychain, nowhere else.",
    ],
  },
  {
    heading: "What ace never does",
    lead: "ace does not",
    rows: [
      "Store your coding agents' credentials, or pass them through its servers.",
      "Answer an approval for you. Your CLI's permission mode decides what runs.",
      "Send usage statistics or crash reports. The website has no analytics or tracking cookies.",
      "Read your repositories or contacts when you sign in with GitHub or Google. It asks only for your name and email.",
    ],
  },
  {
    heading: "What ace's services can see",
    rows: [
      "The relay sees the addresses of both ends, timing and message sizes, and logs none of it.",
      "Between ace's apps and your machines, it forwards only end-to-end encrypted traffic.",
      "Phone alerts are encrypted on your machine so that only your phone can read them.",
      "If you let an outside MCP app reach a machine through ace's relay, that path is plain HTTPS the relay could read. It is off until you turn it on.",
    ],
  },
  {
    heading: "What you control",
    rows: [
      "Devices get in only when you pair them or sign them in to your account. Pairing codes last five minutes and work once.",
      "A machine code makes even your own account's devices enter a PIN or password, checked by that machine alone.",
      "Each machine decides what your other machines may do on it. Using its apps and running commands start off.",
      "You can skip ace's relay entirely: use your own network, Tailscale or a relay you host.",
    ],
  },
];

/** The records to check the page against. */
export const records: { label: string; body: string; href: string }[] = [
  {
    label: "Privacy policy",
    body: "What the account, relay and push gateway collect, and how to delete it.",
    href: "/privacy-policy/",
  },
  {
    label: "Terms of service",
    body: "The rules for ace's hosted services.",
    href: "/terms-of-service/",
  },
  {
    label: "Source code",
    body: "Every line of ace, Apache-2.0, with the decisions behind it.",
    href: links.source,
  },
];
