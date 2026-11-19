import { route } from "./routes.ts";

/*
 * Every part of ace in one list, for the home page: four groups, each part with one line saying
 * what it does. A part with a page of its own links to it (the path must be in routes.ts).
 * Parts still behind the app's Beta switch say so. Keep this to what a person can reach in the
 * app today.
 */

export interface Part {
  name: string;
  body: string;
  /** The page that tells more, when there is one. */
  href?: string;
  /** Off until switched on in Settings. */
  beta?: boolean;
}

export interface PartGroup {
  name: string;
  line: string;
  parts: Part[];
}

const page = (path: string) => route(path).path;

export const partGroups: PartGroup[] = [
  {
    name: "Agents",
    line: "A team, not a row of chat windows.",
    parts: [
      {
        name: "Delegation",
        body: "Any agent hands work to agents on other providers and waits for the results.",
        href: page("/features/orchestration/"),
      },
      {
        name: "Thread status",
        body: "A thread is done only when every agent and command under it has finished.",
        href: page("/features/status/"),
      },
      {
        name: "Hand off between models",
        body: "Switch a thread from Claude to Codex and its context carries over.",
      },
      {
        name: "Agents talk to each other",
        body: "They send messages and files between threads, on one machine or across them.",
      },
      {
        name: "Skills",
        body: "One library of skills for every agent: browse, write, install and share them.",
      },
      {
        name: "Spade",
        body: "ace's own assistant, with bots, routines and memory.",
        href: page("/spade/"),
        beta: true,
      },
    ],
  },
  {
    name: "Tools",
    line: "The same tools in every CLI.",
    parts: [
      {
        name: "Browser use",
        body: "Agents drive a real browser while you watch, take over or stop them.",
        href: page("/features/browser/"),
      },
      {
        name: "Computer use",
        body: "Agents work desktop apps in the background, on Mac, Windows and Linux.",
        href: page("/features/computer-use/"),
      },
      {
        name: "Devices",
        body: "Agents test on iOS Simulators, Android emulators and real Android phones.",
        href: page("/features/devices/"),
      },
      {
        name: "Answers you can see",
        body: "Charts, diagrams and interactive pages, posted straight into the thread.",
      },
      {
        name: "Automations",
        body: "Run a prompt on a schedule, on a GitHub event, when files change or when a webhook calls.",
      },
      {
        name: "MCP tools",
        body: "Every agent gets them, and other MCP apps can use them with the access you choose.",
        href: page("/mcp/"),
      },
    ],
  },
  {
    name: "Machines",
    line: "Every computer you own, working at once.",
    parts: [
      {
        name: "Fleet",
        body: "Linked machines start threads and use each other's browsers and simulators.",
        href: page("/features/fleet/"),
      },
      {
        name: "Remote access",
        body: "Reach every machine from anywhere through an end-to-end encrypted relay.",
        href: page("/features/remote-access/"),
      },
      {
        name: "iPhone and iPad",
        body: "Follow and steer from your pocket, with Allow and Deny on the Lock Screen.",
        href: page("/features/mobile/"),
      },
      {
        name: "Accounts and limits",
        body: "Several accounts per provider. A thread moves to another when one hits its limit.",
        href: page("/features/accounts/"),
      },
      {
        name: "Mac, Windows and Linux",
        body: "One app on all three, for Arm and x64, updating itself.",
        href: page("/download/"),
      },
      {
        name: "The ace CLI",
        body: "Threads, projects, accounts and devices from your terminal.",
      },
    ],
  },
  {
    name: "Workbench",
    line: "From the first diff to merged.",
    parts: [
      {
        name: "Worktrees and review",
        body: "Each thread in its own worktree. Comment on lines, then commit and push.",
        href: page("/features/review/"),
      },
      {
        name: "Pull requests and issues",
        body: "Full pages linked to the thread that wrote the code, on GitHub, GitLab, Gitea and Forgejo.",
      },
      {
        name: "Files",
        body: "A file tree, an editor and quick open, beside the conversation.",
      },
      {
        name: "Terminals",
        body: "A shell in every thread's worktree, and the commands an agent left running.",
      },
      {
        name: "Suits",
        body: "Pick a look for ace, or describe one and an agent makes it.",
      },
      {
        name: "Market",
        body: "Skills, looks and bots other people have published.",
        beta: true,
      },
    ],
  },
];
