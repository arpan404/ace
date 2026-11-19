import type { CastId } from "../scripts/feature-camera.ts";

/*
 * One entry per feature page (/features/<slug>/). Each page's title, meta description, story,
 * tools and questions live here, so the page, its structured data and llms.txt agree. The
 * page tells its story one section at a time while ace, drawn on a MacBook, shows that part
 * (components/features/FeatureStory.astro): each section says what the drawing does then
 * (`show.move`) and what the camera frames (`show.focus`). `preview` picks the one scene the
 * features page shows for it.
 */

export type FeatureSlug =
  | "orchestration"
  | "computer-use"
  | "fleet"
  | "mobile"
  | "remote-access"
  | "accounts"
  | "browser"
  | "devices"
  | "review"
  | "status";

/**
 * What the drawing does as a section comes into view: a scene of the drawn Mac
 * (scripts/stage-scenes.ts), a state the app is put in (scripts/feature-moves.ts), or `keep`,
 * which carries on from the section before.
 */
export type StepMove =
  | "rest"
  | "keep"
  | "agents"
  | "tree-done"
  | "approval"
  | "limit"
  | "phone-ask"
  | "parallel"
  | "team"
  | "fleet"
  | "devices"
  | "accounts"
  | "phone"
  | "review"
  | "computer"
  | "browser"
  | "remote";

/** A part of ace's window the camera can zoom to. */
export type StepPart =
  | "window"
  | "threads"
  | "thread"
  | "canvas"
  | "dock"
  | "changes"
  | "diff"
  | "commit"
  | "browser"
  | "sim";

/** What the camera frames: whole pieces of hardware, or one part of ace's window. */
export type StepFocus = CastId[] | [StepPart];

export interface FeatureSection {
  heading: string;
  body: string[];
  show: { move: StepMove; focus: StepFocus };
}

export interface Feature {
  slug: FeatureSlug;
  /** Short name for navigation and cards. */
  name: string;
  /** The <title>, about 60 characters. */
  title: string;
  /** The meta description, at most about 160 characters. */
  description: string;
  /** The page's one H1. */
  headline: string;
  intro: string;
  /** What the page covers, as short scannable points under the intro. */
  points: string[];
  /** The hardware in the page's picture; the Mac always comes first. */
  cast: CastId[];
  /** Lines from the Mac to the other hardware, each with the verb it carries. */
  links: { to: Exclude<CastId, "mac">; verb: string }[];
  /**
   * The one scene that shows the feature best, for the features page's tour of all ten: the
   * move the drawing plays and what the camera frames, as on a section.
   */
  preview: { move: Exclude<StepMove, "keep">; focus: StepFocus };
  sections: FeatureSection[];
  /** ace's MCP tools behind the feature, when it has any. */
  tools: string[];
  questions: { question: string; answer: string }[];
  /** Search phrases the page answers, for structured data. */
  keywords: string[];
}

export const features: Feature[] = [
  {
    slug: "orchestration",
    name: "Agent orchestration",
    title: "Agent orchestration for Claude Code, Codex and Cursor: ace",
    description:
      "Let one coding agent hand work to others: Claude Code delegates to Codex, Cursor or any agent, on any of your machines, and waits for the whole team.",
    headline: "Agents that hand work to each other",
    intro:
      "Any agent in ace can start other agents, on any provider and any of your machines, then wait for their results. The thread shows the whole team and isn't done until all of it is.",
    points: [
      "Delegate from any agent to any provider",
      "Helpers run on this machine or another one",
      "One thread shows the whole tree of agents",
      "Done only when every agent has finished",
    ],
    cast: ["mac", "build"],
    links: [{ to: "build", verb: "hands off" }],
    preview: { move: "team", focus: ["thread"] },
    sections: [
      {
        heading: "One agent, many providers",
        body: [
          "Claude Code can plan a change and hand the test to Codex, the review to Cursor and the docs to OpenCode. Each helper runs in its own thread, signed in through its own CLI, so you can open any of them and keep talking to it.",
        ],
        show: { move: "team", focus: ["thread"] },
      },
      {
        heading: "The same tools in every CLI",
        body: [
          "delegate starts helpers with a task, wait collects their results as they finish, agents_status shows where each one stands, and agent_message and agent_cancel steer or stop one. While it waits, the thread says so.",
        ],
        show: { move: "agents", focus: ["dock"] },
      },
      {
        heading: "Send work to the right machine",
        body: [
          "A helper can run on another of your linked machines: the soak test on your Linux machine, the Windows build on the workstation. When that machine is busy, the work waits in its queue instead of failing.",
        ],
        show: { move: "agents", focus: ["mac", "build"] },
      },
      {
        heading: "Done only when the whole team is",
        body: [
          "A thread's status covers every helper, the helpers they started and their background commands. A question from a helper several levels down shows on the thread you're looking at. Stop stops the whole tree, and results that arrive while ace is down are delivered when it comes back.",
        ],
        show: { move: "tree-done", focus: ["window"] },
      },
      {
        heading: "Limits you set",
        body: [
          "A thread can run up to 64 helpers, up to 8 levels deep. In Settings you choose how many run at once, and the rest wait their turn. A helper never gets more access than the agent that started it.",
        ],
        show: { move: "keep", focus: ["mac", "build"] },
      },
    ],
    tools: ["delegate", "wait", "agents_status", "agent_message", "agent_cancel", "machines"],
    questions: [
      {
        question: "Can Claude Code delegate work to Codex?",
        answer:
          "Yes. In ace, any agent can start another on any installed provider with the delegate tool. Claude Code can hand a task to Codex, Cursor, OpenCode or any ACP agent and wait for the result.",
      },
      {
        question: "Does the parent agent wait for its helpers?",
        answer:
          "Yes. A thread isn't done until every helper below it has finished, and it shows as needing you whenever any of them waits on you.",
      },
      {
        question: "Can a helper agent run on another computer?",
        answer:
          "Yes. With linked machines, delegate takes a machine and a project, and the helper runs there as an ordinary thread. If that machine is busy, it waits in the machine's queue.",
      },
      {
        question: "How many agents can work at once?",
        answer:
          "A thread can run up to 64 helpers, up to 8 levels deep. You can cap how many run at once in Settings; the rest queue.",
      },
      {
        question: "Do helper agents need API keys?",
        answer:
          "No. Each helper runs through its provider's own logged-in CLI, on the subscription you already have.",
      },
    ],
    keywords: [
      "multi-agent orchestration",
      "Claude Code delegate to Codex",
      "multi-provider coding agents",
      "coding agent subagents",
      "parallel coding agents",
      "agent orchestration tool",
    ],
  },
  {
    slug: "computer-use",
    name: "Computer use",
    title: "Computer use for Claude Code, Codex and Cursor: ace",
    description:
      "Let Claude Code, Codex and other agents use your desktop apps in the background, with a live view, Take over and Stop, and apps you keep off limits.",
    headline: "Computer use for every coding agent",
    intro:
      "Agents in ace can use the apps on your computer, not just your terminal. They work in the background, without taking your mouse or keyboard, and every session shows who is in control.",
    points: [
      "Agents read apps through accessibility, then click and type",
      "You keep using your computer while they work",
      "A live view of every app an agent is driving",
      "On macOS, Windows and Linux (Wayland), off until you turn it on",
    ],
    cast: ["mac", "build", "workstation"],
    links: [],
    preview: { move: "computer", focus: ["mac"] },
    sections: [
      {
        heading: "Your apps, used in the background",
        body: [
          "Coding agents are blind outside the terminal: the simulator that shows the bug, the design tool with the spec, the settings screen a test depends on. In ace every agent, whichever CLI runs it, can open an app, read what's on screen and act on it.",
        ],
        show: { move: "computer", focus: ["mac"] },
      },
      {
        heading: "Real buttons, not guessed pixels",
        body: [
          "Agents read each app through the system's accessibility interface, so they see real buttons, fields and labels. They work in the background: your mouse and keyboard stay yours while an agent fills a form in another app.",
        ],
        show: { move: "keep", focus: ["sim"] },
      },
      {
        heading: "You stay in control",
        body: [
          "Every app an agent is using shows in ace with the agent's name, a live view, and Take over and Stop. Computer use is off until you turn it on, and you choose apps agents may never use, such as mail or a password manager.",
        ],
        show: { move: "keep", focus: ["dock"] },
      },
      {
        heading: "Permissions stay with your CLI",
        body: [
          "ace adds no approval layer of its own. Each agent's CLI decides what runs, in the permission mode you chose, and asks you the way it always does. When an agent waits on you, its thread says Approve, on your desktop and on your phone.",
        ],
        show: { move: "approval", focus: ["dock"] },
      },
      {
        heading: "On Mac, Windows and Linux",
        body: [
          "Computer use works on macOS, on Windows, and on Linux under Wayland. On a Mac, letting agents work while the screen is locked is a separate switch, off until you turn it on.",
        ],
        show: { move: "rest", focus: ["mac", "build", "workstation"] },
      },
    ],
    tools: ["screen_apps", "screen_state", "screen_act", "screen_display"],
    questions: [
      {
        question: "Can an agent use my computer while I am working?",
        answer:
          "Yes. Agents act through accessibility in the background, so they don't move your pointer or type into the app you are using. Each session shows in ace with Take over and Stop.",
      },
      {
        question: "Can I keep agents out of some apps?",
        answer:
          "Yes. Choose the apps agents can't use, and ace refuses them whatever an agent asks. Computer use stays off until you turn it on.",
      },
      {
        question: "Which agents can use computer use?",
        answer:
          "Every agent ace runs: Claude Code, Codex, Cursor, OpenCode, Antigravity, Pi and any ACP agent. They all get the same MCP tools.",
      },
      {
        question: "Which systems does computer use work on?",
        answer:
          "macOS, Windows and Linux under Wayland. On a Mac, working while the screen is locked is a separate setting, off until you turn it on.",
      },
    ],
    keywords: [
      "computer use",
      "Claude Code computer use",
      "Codex computer use",
      "AI agent desktop automation",
      "agent accessibility automation",
    ],
  },
  {
    slug: "fleet",
    name: "Fleet",
    title: "Fleet: run coding agents across all your machines: ace",
    description:
      "Link your machines so agents share threads, browsers, simulators and emulators, move work between them, and follow every thread from iPhone or iPad.",
    headline: "Orchestrate agents across every machine you own",
    intro:
      "Link your laptop, a Linux machine and a Windows workstation. Agents on one start threads, open browsers and use simulators on another, and you approve it all from your phone.",
    points: [
      "Agents start threads and open browsers on linked machines",
      "Simulators and emulators on one machine, used from any other",
      "Continue a thread on another machine, uncommitted changes and all",
      "Every machine's threads in one window, and in the phone app",
    ],
    cast: ["mac", "build", "workstation", "phone"],
    links: [
      { to: "build", verb: "hands off" },
      { to: "workstation", verb: "opens a browser" },
      { to: "phone", verb: "asks you" },
    ],
    preview: { move: "agents", focus: ["mac", "build", "workstation"] },
    sections: [
      {
        heading: "One fleet, many machines",
        body: [
          "Run ace on your laptop, a Linux machine and a Windows workstation, then link them. An agent on your laptop can delegate a long test run to the Linux machine, or open a browser on the workstation to check a page there.",
        ],
        show: { move: "agents", focus: ["mac", "build", "workstation"] },
      },
      {
        heading: "Devices travel too",
        body: [
          "An agent on the Linux machine can test your app on the iOS Simulator on your Mac, and an agent on your laptop can use the Android emulator on your workstation, each with the device approval you'd give locally.",
        ],
        show: { move: "devices", focus: ["mac", "build"] },
      },
      {
        heading: "Every thread in one list",
        body: [
          "Every thread, wherever it runs, shows in the same window with its live status. Filter by machine, start a thread on any of them, and answer an approval on whichever machine you're at.",
        ],
        show: { move: "fleet", focus: ["threads"] },
      },
      {
        heading: "Each machine sets the rules",
        body: [
          "A machine decides how much the others may do on it: nothing, read, or read and act. Continue on another machine takes a thread's branch, uncommitted changes included, to another machine and carries on there.",
        ],
        show: { move: "rest", focus: ["mac", "workstation"] },
      },
      {
        heading: "Your phone and tablet, paired",
        body: [
          "Sign in to your ace account on iPhone or iPad and every machine on it is there. Or pair a machine with a link or a QR code, for view only or view and act. Paired devices follow and steer agents; they don't run them. Android is coming soon.",
        ],
        show: { move: "phone-ask", focus: ["mac", "phone"] },
      },
      {
        heading: "Connect the way you already do",
        body: [
          "Machines connect directly over your local network or Tailscale. Away from both, devices signed in to your ace account reach them through ace's end-to-end encrypted relay, or a relay you host. Nothing joins your fleet unless you pair it or sign it in.",
        ],
        show: { move: "keep", focus: ["mac", "build", "workstation", "phone"] },
      },
    ],
    tools: [
      "delegate",
      "wait",
      "agents_status",
      "browser_open",
      "sim_list",
      "sim_act",
      "thread_start",
    ],
    questions: [
      {
        question: "Can an agent use a simulator on another machine?",
        answer:
          "Yes. Simulators, emulators and browsers on a linked machine are available to agents on the others, as far as that machine's access setting allows, and you approve each device the same way as locally.",
      },
      {
        question: "Can an agent on one computer start work on another?",
        answer:
          "Yes. Linked machines let agents start threads, delegate to other agents and open browsers on each other, as far as each machine's access setting allows.",
      },
      {
        question: "Can I move a thread to another machine?",
        answer:
          "Yes. Continue on another machine takes the project and branch, uncommitted changes included, and starts a thread there from this one's history.",
      },
      {
        question: "How do my devices connect?",
        answer:
          "Directly over your local network or Tailscale when they can. From anywhere else, through ace's end-to-end encrypted relay once they're signed in to your ace account, or through a relay you host. Devices join only when you pair them or sign them in.",
      },
    ],
    keywords: [
      "multi-machine coding agents",
      "remote iOS simulator for agents",
      "agent orchestration",
      "remote coding agent",
      "Claude Code on phone",
      "approve coding agent from phone",
    ],
  },
  {
    slug: "mobile",
    name: "iPhone and iPad",
    title: "iPhone and iPad app for Claude Code and Codex agents: ace",
    description:
      "Follow and steer every agent from iPhone or iPad: approvals, diffs, terminals, the live browser, simulators and Live Activities on the Lock Screen.",
    headline: "Every agent, every machine, in your pocket",
    intro:
      "ace for iPhone and iPad connects to all your machines at once, from anywhere. It isn't a viewer: you approve, review, browse, drive simulators and watch the apps agents are using, from wherever you are.",
    points: [
      "Allow and Deny on the Lock Screen, from a push notification",
      "Live Activities that end only when the whole agent tree is done",
      "Your desktops' simulators and emulators, from the phone",
      "Widgets, and the terminal, files, diffs and pull requests",
    ],
    cast: ["mac", "phone"],
    links: [{ to: "phone", verb: "asks you" }],
    preview: { move: "phone-ask", focus: ["mac", "phone"] },
    sections: [
      {
        heading: "Allow and Deny on the Lock Screen",
        body: [
          "When an agent needs a permission, a push notification arrives with Allow and Deny on it. Answer from the Lock Screen without opening the app, and the agent carries on.",
        ],
        show: { move: "phone-ask", focus: ["phone"] },
      },
      {
        heading: "Done means done, on the Lock Screen too",
        body: [
          "A thread you follow shows as a Live Activity on the Lock Screen and in the Dynamic Island, and ends only when every agent and command in it has finished. Widgets keep your threads on the Home Screen.",
        ],
        show: { move: "phone", focus: ["phone"] },
      },
      {
        heading: "More than approvals",
        body: [
          "The phone and tablet apps carry the whole workbench: every thread on every machine, the terminal, files and diffs, pull requests and your GitHub inbox, accounts and usage, automations and skills. Start a thread, fork one or move it to another machine.",
        ],
        show: { move: "keep", focus: ["mac", "phone"] },
      },
      {
        heading: "See what agents see",
        body: [
          "Open the browser an agent is using and you get it live at 60 frames a second, and you can click and type in it. Your desktops' simulators and emulators are there too, and the apps agents are driving, live.",
        ],
        show: { move: "browser", focus: ["mac", "phone"] },
      },
    ],
    tools: [],
    questions: [
      {
        question: "Do agents run on the phone?",
        answer:
          "No. Agents run on your computers. The iPhone and iPad apps follow and steer them: approve, answer, review, browse and drive devices, across every paired machine at once.",
      },
      {
        question: "Is there an Android app?",
        answer:
          "Android is coming soon. Until then, any browser can pair with your machines through the web app.",
      },
      {
        question: "How does the phone reach my computers?",
        answer:
          "Sign in to your ace account and it reaches every machine on it, from anywhere, through ace's end-to-end encrypted relay. Or pair it with a link or QR code over your local network or Tailscale, choosing view only or view and act, and for how long.",
      },
    ],
    keywords: [
      "Claude Code iPhone app",
      "Codex mobile app",
      "approve coding agent from phone",
      "coding agent Live Activity",
      "AI coding agent iPad",
    ],
  },
  {
    slug: "remote-access",
    name: "Remote access",
    title: "Remote access to your coding agents from anywhere: ace",
    description:
      "Sign in once and every machine on your ace account opens from your phone, browser or laptop, anywhere, through an end-to-end encrypted relay.",
    headline: "Sign in once, reach every machine",
    intro:
      "Sign in to ace on your computers and your phone, and every machine on your account is a tap away, at home, at the office or on cellular. No pairing codes, no VPN, no ports to open.",
    points: [
      "Sign in with your email",
      "Every machine on your account, on every device",
      "End-to-end encrypted: the relay can't read your work",
      "A machine code adds a second lock to any computer",
    ],
    cast: ["mac", "workstation", "phone"],
    links: [
      { to: "workstation", verb: "relay" },
      { to: "phone", verb: "relay" },
    ],
    preview: { move: "remote", focus: ["threads"] },
    sections: [
      {
        heading: "One sign-in for every machine",
        body: [
          "Sign in from the desktop app and that computer joins your ace account. A headless server joins with ace account login, which prints a sign-in link you can open anywhere. Your phone, the web app and your other computers then list every machine on the account.",
        ],
        show: { move: "rest", focus: ["mac", "workstation", "phone"] },
      },
      {
        heading: "No codes to scan",
        body: [
          "You sign in with your email. A device signed in to your account gets full access to the machines on it, and a new machine shows up everywhere as soon as it signs in.",
        ],
        show: { move: "rest", focus: ["mac", "phone"] },
      },
      {
        heading: "Readable only by you",
        body: [
          "Away from your network and Tailscale, ace connects your devices through its relay. The connection is end-to-end encrypted, so the relay forwards what it can't read: never your prompts, code or screens. Sign a device out and it loses access within minutes.",
        ],
        show: { move: "rest", focus: ["mac", "workstation", "phone"] },
      },
      {
        heading: "A second lock where it matters",
        body: [
          "Set a machine code on any computer. Each device enters it once before it gets in, so a stolen account sign-in alone doesn't open that machine. The machine checks the code itself; ace's servers never see it.",
        ],
        show: { move: "remote", focus: ["window"] },
      },
      {
        heading: "Optional, and yours to run",
        body: [
          "You don't need an account to use ace. Pairing with a link or QR code, your local network, Tailscale and a relay you host yourself all work without one. Your agents, code and provider logins stay on your computers.",
        ],
        show: { move: "keep", focus: ["mac", "workstation", "phone"] },
      },
    ],
    tools: [],
    questions: [
      {
        question: "Do I need an ace account?",
        answer:
          "No. An account is for reaching your machines through ace's relay from anywhere. Everything else works without one, including pairing over your local network or Tailscale and running your own relay.",
      },
      {
        question: "How does a server without a screen sign in?",
        answer:
          "Run ace account login on it. It prints a sign-in link you open on any device, and you sign in with your email.",
      },
      {
        question: "Can ace read my code through the relay?",
        answer:
          "No. Traffic between your devices and your machines is end-to-end encrypted. The relay sees addresses, timing and the size of encrypted messages, and keeps none of it after the connection ends.",
      },
      {
        question: "What does an ace account store?",
        answer:
          "Your account id, email and name, and for each machine you sign in, its name, platform, key fingerprint and when it was last seen. Never your code, prompts or provider credentials.",
      },
      {
        question: "What if someone gets into my ace account?",
        answer:
          "They could open machines that have no machine code. Set a code on the machines that matter, use multi-factor sign-in, and sign out devices you no longer use.",
      },
    ],
    keywords: [
      "remote access for coding agents",
      "Claude Code remote access",
      "control Codex from anywhere",
      "end-to-end encrypted relay",
      "coding agents on cellular",
    ],
  },
  {
    slug: "accounts",
    name: "Accounts and limits",
    title: "Several Claude, Codex and Cursor accounts in one app: ace",
    description:
      "Sign in to several accounts per provider, pick one per thread, see usage and limits, and move a thread to another account when one runs out.",
    headline: "Several accounts per provider, one per thread",
    intro:
      "Work and personal plans, a team seat, a spare: add as many accounts as each provider allows, choose which one a thread runs on, and let ace keep work moving when one hits its limit.",
    points: [
      "Each account signs in through the CLI's own login, kept apart",
      "Pick the account per thread, or set a default per provider",
      "Fresh usage and limits for Claude and Codex accounts",
      "At a limit, the thread moves to another account, by you or by ace",
    ],
    cast: ["mac"],
    links: [],
    preview: { move: "accounts", focus: ["canvas"] },
    sections: [
      {
        heading: "Accounts kept apart",
        body: [
          "Each extra account lives in its own private folder, and you sign in with the provider CLI's own login, in a terminal inside ace. Your home directory stays as it is, so git, gh and ssh keep working. ace never reads or stores the credentials.",
        ],
        show: { move: "rest", focus: ["threads"] },
      },
      {
        heading: "One account per thread",
        body: [
          "Name accounts, give them a colour, set a default per provider, and pick the account for a thread in the model picker. Claude, Codex, Cursor, OpenCode, Antigravity and Pi all take several accounts.",
        ],
        show: { move: "rest", focus: ["dock"] },
      },
      {
        heading: "Limits you can trust",
        body: [
          "For Claude and Codex, ace reads each account's usage every few minutes and during turns, and a usage page shows them all. An account only counts as out on a fresh reading at 100%, or on the provider's own limit error.",
        ],
        show: { move: "limit", focus: ["canvas"] },
      },
      {
        heading: "Move by hand, or let ace move it",
        body: [
          "At a limit, what you send is held, not lost. Resume at the reset, move the thread to another account yourself, or have ace move it for you. Between Claude accounts, or between Codex accounts, the whole session comes along.",
        ],
        show: { move: "accounts", focus: ["canvas"] },
      },
      {
        heading: "Delegation that spreads the load",
        body: [
          "When an agent hands work to others, ace picks their accounts: it skips accounts that are signed out, near their limit or exhausted, and prefers the one with the most headroom and the earliest reset.",
        ],
        show: { move: "keep", focus: ["mac"] },
      },
    ],
    tools: [],
    questions: [
      {
        question: "Can I use my work and personal Claude accounts side by side?",
        answer:
          "Yes. Add each account, sign in through Claude Code's own login, and pick the account per thread or set a default. The same works for Codex, Cursor, OpenCode, Antigravity and Pi.",
      },
      {
        question: "What happens when an account hits its limit?",
        answer:
          "Your messages are held, not lost. Resume at the reset, snooze the thread until then, or move it to another account of the same provider, yourself or automatically.",
      },
      {
        question: "Can ace move a thread to another account by itself?",
        answer:
          "Yes. Move a thread yourself, or let ace move it when an account hits its limit. A usage page shows every account's usage and when it resets.",
      },
    ],
    keywords: [
      "multiple Claude Code accounts",
      "multiple Codex accounts",
      "switch Claude account",
      "Claude usage limits",
      "Codex rate limit",
    ],
  },
  {
    slug: "browser",
    name: "Browser use",
    title: "A real browser for Claude Code, Codex and Cursor: ace",
    description:
      "Agents open your dev server in ace's browser, click through it and read the console and network log, while you watch the same tab and can take over.",
    headline: "Agents check their work in a real browser",
    intro:
      "Every agent in ace can open your dev server in a real browser, click through it and read the console and network log. You watch the same tab and can take over at any moment.",
    points: [
      "One shared browser: the same tabs and logins for you and agents",
      "Console and network logs the agent can read",
      "Mark up a page and send the notes to the agent",
      "Use my Chrome on macOS and Linux: tabs you share from your own Chrome",
    ],
    cast: ["mac"],
    links: [],
    preview: { move: "browser", focus: ["browser"] },
    sections: [
      {
        heading: "An agent that checks its own work",
        body: [
          "An agent that can't see the page it changed is guessing. In ace, agents open pages in a real Chromium browser, read the page as structured text, click, type and scroll, and fix what they find.",
        ],
        show: { move: "browser", focus: ["window"] },
      },
      {
        heading: "Console and network, read for you",
        body: [
          "The browser tools return the page's console and network log, so an agent finds the error it caused. Screenshots at phone, tablet and desktop widths check a responsive layout in one step.",
        ],
        show: { move: "keep", focus: ["thread"] },
      },
      {
        heading: "One tab, shared with you",
        body: [
          "You watch the agent in the same tab and can take over at any moment. Open it on your phone, in the web app or on another desktop and it streams live at 60 frames a second.",
        ],
        show: { move: "keep", focus: ["dock"] },
      },
      {
        heading: "Point at what's wrong",
        body: [
          "Mark up a page directly, circling the broken button or the misaligned card, and send the notes to the agent with the page attached.",
        ],
        show: { move: "keep", focus: ["browser"] },
      },
      {
        heading: "Your own Chrome, when you need it",
        body: [
          "On macOS and Linux, Use my Chrome lets agents work in your own Chrome profile, only in tabs you share or open in a separate window. Settings, extension pages and the password manager are refused, and cookie reads are blocked.",
        ],
        show: { move: "keep", focus: ["window"] },
      },
    ],
    tools: [
      "browser_open",
      "browser_snapshot",
      "browser_act",
      "browser_logs",
      "browser_screenshot",
    ],
    questions: [
      {
        question: "Which browser do agents use?",
        answer:
          "ace's own browser, a real Chromium you can watch and take over, from your desktop or your phone. With Use my Chrome, agents can also work in tabs you share from your own Chrome.",
      },
      {
        question: "Can agents read console errors and network requests?",
        answer:
          "Yes. The browser tools return the page's console and network log, so an agent can find and fix the error it caused.",
      },
    ],
    keywords: [
      "browser use",
      "Claude Code browser",
      "AI agent browser testing",
      "agent reads console logs",
      "coding agent web testing",
    ],
  },
  {
    slug: "devices",
    name: "Devices",
    title: "iOS Simulators and Android emulators for agents: ace",
    description:
      "Run iOS Simulators, Android emulators and Android phones in ace. Use them yourself or hand one to an agent to test your app, with screen, UI tree and logs.",
    headline: "Simulators and emulators in one hub",
    intro:
      "Run iOS Simulators and Android emulators inside ace, and plug in a real Android phone. Tap, type and rotate them yourself, or hand a device to an agent to test your app.",
    points: [
      "Live screen, UI tree, logs and recordings",
      "Approve a device before an agent can use it",
      "Hand a device to any agent in the thread",
      "Real Android phones too, over USB or Wi-Fi",
    ],
    cast: ["mac", "build"],
    links: [{ to: "build", verb: "borrows the Simulator" }],
    preview: { move: "devices", focus: ["sim"] },
    sections: [
      {
        heading: "Lend a device, once",
        body: [
          "An agent asks before it uses a device, and you allow it once. Hand a device to any agent in a thread and take it back at any time.",
        ],
        show: { move: "devices", focus: ["dock"] },
      },
      {
        heading: "Agents test like you do",
        body: [
          "Agents read the screen as a UI tree, tap and type, and read the device log, so they can reproduce a bug, fix it and check the fix on the device.",
        ],
        show: { move: "keep", focus: ["sim"] },
      },
      {
        heading: "From any of your machines",
        body: [
          "This Linux machine has no simulator, so the agent on it borrows the iPhone 17 Pro on your Mac. Devices on one linked machine are there for agents on the others.",
        ],
        show: { move: "keep", focus: ["mac", "build"] },
      },
      {
        heading: "Simulators, emulators and Android phones",
        body: [
          "iOS Simulators run on a Mac with Xcode. Android emulators run wherever the Android SDK is, and real Android phones join over USB or Wi-Fi. Real iPhones aren't supported.",
        ],
        show: { move: "keep", focus: ["mac"] },
      },
    ],
    tools: ["sim_list", "sim_start", "sim_ui", "sim_act", "sim_logs", "sim_screenshot"],
    questions: [
      {
        question: "Can an agent test my iOS app?",
        answer:
          "Yes. On a Mac with Xcode, an agent can start an iOS Simulator, read its UI tree, tap and type, and read the logs. You approve the device first.",
      },
      {
        question: "Does it work with Android?",
        answer:
          "Yes. Android emulators and real Android phones, over USB or Wi-Fi, work in the same hub with the same tools, so any agent can test an Android build.",
      },
    ],
    keywords: [
      "iOS Simulator AI agent",
      "Android emulator AI agent",
      "mobile app testing coding agent",
      "Claude Code iOS simulator",
    ],
  },
  {
    slug: "review",
    name: "Worktrees and review",
    title: "Git worktrees and diff review for coding agents: ace",
    description:
      "Give each agent thread its own git worktree, review its diff beside the conversation, send line comments, then commit, push and open the pull request.",
    headline: "Review the diff next to the conversation",
    intro:
      "Give a thread its own git worktree and its changes stay apart from every other agent's. Comment on a line, send it to the agent, then commit and push from the same panel.",
    points: [
      "One git worktree per thread, created for you",
      "Line comments go straight back to the agent",
      "Commit, push and open the pull request in place",
      "Pull requests and issues as full pages",
    ],
    cast: ["mac"],
    links: [],
    preview: { move: "review", focus: ["changes"] },
    sections: [
      {
        heading: "Parallel agents, no collisions",
        body: [
          "Agents on one repository overwrite each other's files unless each has its own checkout. ace can start each thread in its own git worktree on its own branch, so you run as many as you like and review each one alone.",
        ],
        show: { move: "rest", focus: ["threads"] },
      },
      {
        heading: "Review where the work happened",
        body: [
          "The Changes panel sits beside the conversation: a file tree with added and removed lines, and the diff for the last turn or the whole branch.",
        ],
        show: { move: "review", focus: ["changes"] },
      },
      {
        heading: "Comments go back to the agent",
        body: [
          "Comment on any line and send your comments to the agent as a request for changes. It picks them up in the same thread.",
        ],
        show: { move: "keep", focus: ["diff"] },
      },
      {
        heading: "Commit, push and open the pull request",
        body: [
          "When it's right, commit and push from the same panel and open the pull request without leaving the thread.",
        ],
        show: { move: "keep", focus: ["commit"] },
      },
      {
        heading: "Pull requests and issues, as pages",
        body: [
          "Open pull requests and issues as full pages, link them to the thread that wrote the code, and merge once checks pass. All of it works on GitHub and most of it on GitLab; Gitea and Forgejo get reviews, merging and issues, and Bitbucket Cloud gets reviews.",
        ],
        show: { move: "keep", focus: ["window"] },
      },
    ],
    tools: ["thread_start", "thread_fork", "thread_merge", "thread_link_pr"],
    questions: [
      {
        question: "Can several agents work on the same repository?",
        answer:
          "Yes. Each thread can run in its own git worktree, so agents never overwrite each other's files, and you review each thread's diff separately.",
      },
    ],
    keywords: [
      "git worktrees coding agents",
      "parallel coding agents",
      "AI code review diff",
      "Claude Code worktree",
    ],
  },
  {
    slug: "status",
    name: "Thread status",
    title: "Thread status: know which coding agent needs you: ace",
    description:
      "ace shows whether each agent thread is working, waiting, failed, done or needs you, counting every subagent and background command it started.",
    headline: "Done means the whole tree is done",
    intro:
      "A thread's status in ace covers every subagent and background command it started. While a subagent still runs, the thread says Waiting, never Done.",
    points: [
      "Working, Approve, Waiting, Failed and Done",
      "Subagents and background shells counted",
      "The threads that need you, first",
      "The same status on desktop and phone",
    ],
    cast: ["mac", "phone"],
    links: [{ to: "phone", verb: "asks you" }],
    preview: { move: "parallel", focus: ["threads"] },
    sections: [
      {
        heading: "Five words you can trust",
        body: [
          "Working, Approve, Waiting, Failed and Done. Every row in the list says which, and shows what the thread is doing right now.",
        ],
        show: { move: "parallel", focus: ["threads"] },
      },
      {
        heading: "The ones that need you come first",
        body: [
          "Approve and Answer mean a thread is stopped on you: a permission or a question. Those threads stand out, on your desktop and on your phone, so you never leave an agent waiting.",
        ],
        show: { move: "approval", focus: ["canvas"] },
      },
      {
        heading: "Waiting, never Done too early",
        body: [
          "Agents start subagents and leave commands running. A status that watches only the main agent says Done while work still happens. ace follows the whole tree, so the thread says Waiting until they finish.",
        ],
        show: { move: "team", focus: ["thread"] },
      },
      {
        heading: "Done means everything is done",
        body: ["When the last agent and command finish, and only then, the thread says Done."],
        show: { move: "tree-done", focus: ["window"] },
      },
      {
        heading: "The same status on your phone",
        body: [
          "Your iPhone shows the same words, and a Live Activity for a thread you follow ends only when the whole tree has finished.",
        ],
        show: { move: "phone", focus: ["mac", "phone"] },
      },
    ],
    tools: ["agents_status", "wait", "threads_find"],
    questions: [
      {
        question: "Why does a thread say Waiting after the agent replied?",
        answer:
          "Its turn ended, but a subagent or a background command it started is still running. The thread says Done only when all of them finish.",
      },
    ],
    keywords: [
      "coding agent status",
      "multiple coding agents dashboard",
      "Claude Code subagents status",
      "agent needs approval notification",
    ],
  },
];

export function feature(slug: FeatureSlug): Feature {
  const found = features.find((entry) => entry.slug === slug);
  if (!found) throw new Error(`No feature called ${slug}`);
  return found;
}
