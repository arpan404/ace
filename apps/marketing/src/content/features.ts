/*
 * One entry per feature page (/features/<slug>/). Each page's title, meta description, sections,
 * tools and questions live here, so the page, its structured data and llms.txt agree.
 */

export type FeatureSlug =
  | "computer-use"
  | "fleet"
  | "mobile"
  | "accounts"
  | "browser"
  | "devices"
  | "review"
  | "status";

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
  sections: { heading: string; body: string[] }[];
  /** ace's MCP tools behind the feature, when it has any. */
  tools: string[];
  questions: { question: string; answer: string }[];
  /** Search phrases the page answers, for structured data. */
  keywords: string[];
}

export const features: Feature[] = [
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
      "One switch turns it on; you choose apps agents can't use",
    ],
    sections: [
      {
        heading: "Your apps, used in the background",
        body: [
          "Coding agents are good at code and blind to everything else: the simulator that shows the bug, the design tool with the spec, the settings screen a test depends on. ace gives every agent the same computer-use tools, whichever CLI runs it, so Claude Code, Codex, Cursor and the rest can open an app, read what is on screen and act on it.",
          "Agents read each app through the system's accessibility interface, so they see real buttons, fields and labels instead of guessing from pixels. They work in the background: your mouse and keyboard stay yours while an agent fills a form in another app.",
        ],
      },
      {
        heading: "You stay in control",
        body: [
          "Every app an agent is using shows in ace with the agent's name beside it, a live view, and Take over and Stop. Take over hands the app back to you mid-task; Stop ends the agent's session with it at once.",
          "Computer use is off until you turn it on, with one switch. You decide which apps agents can never use, such as mail or a password manager, and ace refuses those apps whatever the agent asks.",
        ],
      },
      {
        heading: "Permissions stay with your CLI",
        body: [
          "ace never adds its own approval layer. Each agent's CLI decides what runs, in the permission mode you already chose for it, and asks you the way it always does. When an agent waits on an approval, its thread says Approve, on your desktop and on your phone.",
        ],
      },
    ],
    tools: ["screen_apps", "screen_state", "screen_act"],
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
    title: "Run coding agents across all your machines: ace Fleet",
    description:
      "Link your machines so agents share each other's threads, browsers, simulators and emulators, move work between them, and follow every thread from iPhone or iPad.",
    headline: "Orchestrate agents across every machine you own",
    intro:
      "Link your laptop, a Linux build server and a Windows workstation. Agents on one start threads, open browsers and use simulators on another, and you approve it all from your phone.",
    points: [
      "Agents start threads and open browsers on linked machines",
      "Simulators and emulators on one machine, used from any other",
      "Continue a thread on another machine, uncommitted changes and all",
      "Every machine's threads in one window, and in the phone app",
    ],
    sections: [
      {
        heading: "One fleet, many machines",
        body: [
          "Run ace on your laptop, a Linux build server and a Windows workstation, then link them. Linked machines can use each other: an agent on your laptop can delegate a long test run to the build server, or open a browser on the workstation to check a page there.",
          "Devices travel across the fleet too. An agent on the Linux build server can test your app on the iOS Simulator running on your Mac, and an agent on your laptop can use the Android emulator on your workstation, each with the device approval you'd give locally.",
          "Each machine sets how much other machines may do on it: nothing, read, or read and act. Every thread, wherever it runs, shows in the same window with its live status, you can start a new one on any machine from there, and an approval can be answered on whichever machine you're at. When a machine's run slots are full, delegated work waits in its queue instead of failing.",
        ],
      },
      {
        heading: "Move work to the machine that should do it",
        body: [
          "Continue on another machine takes a thread's project and branch, uncommitted changes included, to another of your machines and starts a thread there from this one's history. The data goes straight from machine to machine, so you can kick it off from your phone on cellular.",
        ],
      },
      {
        heading: "Your phone and tablet, paired",
        body: [
          "ace for iPhone and iPad pairs with your machines through a link or a QR code, for view only or view and act, and for as long as you choose. From it you follow every machine's threads, answer approvals, watch the browser and drive your desktops' simulators. Android is coming soon.",
          "Paired devices follow and steer agents; they don't run them. Your code and your agents stay on your computers.",
        ],
      },
      {
        heading: "Connect the way you already do",
        body: [
          "Machines and devices connect directly, over your local network or over Tailscale, where ace uses the machine's tailnet name with a valid HTTPS certificate. An optional end-to-end encrypted relay, which you can host yourself, carries only extras such as previews and files. Nothing joins your fleet unless you pair it.",
        ],
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
          "Directly, over your local network or Tailscale. An optional end-to-end encrypted relay you can host yourself carries only extras such as previews and files. Devices join only when you pair them.",
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
    title: "ace for iPhone and iPad: your coding agents in your pocket",
    description:
      "Follow and steer every agent from iPhone or iPad: approvals, diffs, terminals, the live browser, your desktop's simulators and Live Activities on the Lock Screen.",
    headline: "Every agent, every machine, in your pocket",
    intro:
      "ace for iPhone and iPad connects to all your paired machines at once. It isn't a viewer: you approve, review, browse, drive simulators and watch the apps agents are using, from wherever you are.",
    points: [
      "Live Activities that end only when the whole agent tree is done",
      "The live browser at 60 fps, which you can use",
      "Your desktops' simulators and emulators, from the phone",
      "Terminal, files, diffs, pull requests and the GitHub inbox",
    ],
    sections: [
      {
        heading: "More than approvals",
        body: [
          "The phone and tablet apps carry the whole workbench: every thread on every paired machine, approvals and questions, the terminal, files and the diff of each thread, pull requests, issues and your GitHub inbox, accounts and usage, automations, prompts and skills. Start a thread, fork one, or continue it on another machine.",
        ],
      },
      {
        heading: "See what agents see",
        body: [
          "Open the browser an agent is using and you get it live at 60 frames a second, and you can click and type in it. Open a tab on the phone and it switches to a phone-sized layout, and the agent is told it is working at that size.",
          "The simulators and emulators on your desktops are there too: watch them, tap through them, install or open apps, open links, and set location and language. And for computer use, see the apps agents are driving on each machine, live.",
        ],
      },
      {
        heading: "Done means done, on the Lock Screen too",
        body: [
          "A thread you follow shows as a Live Activity on the Lock Screen and in the Dynamic Island, and it only ends when every agent and command in the thread has finished. Notifications arrive while the app is connected, with snooze and quiet hours, and the app can lock itself when you leave it.",
        ],
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
          "Directly, over your local network or Tailscale, once you pair it with a link or QR code. You choose view only or view and act, and how long access lasts.",
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
      "When a limit hits, resume at reset or move to another account",
    ],
    sections: [
      {
        heading: "Accounts kept apart",
        body: [
          "Each extra account lives in its own private folder, and you sign in to it with the provider CLI's own login, in a terminal inside ace. Your usual home directory stays as it is, so git, gh and ssh keep working. ace never reads or stores the credentials.",
          "Name accounts, give them a colour, set the default for each provider, and choose the account per thread in the model picker. Claude, Codex, Cursor, OpenCode, Antigravity and Pi all support several accounts.",
        ],
      },
      {
        heading: "Limits you can trust",
        body: [
          "For Claude and Codex, ace reads each account's usage every few minutes and during turns. An account only counts as out of quota on a fresh reading at 100%, or on the provider's own limit error, so you are never blocked by a guess.",
          "When a limit is hit, what you send is held, not lost. Resume now, resume at the reset, snooze the thread until then, or move it to another account of the same provider. Moving between Claude accounts, or between Codex accounts, carries the whole native session over.",
        ],
      },
      {
        heading: "Delegation that spreads the load",
        body: [
          "When an agent hands work to other agents, ace picks their accounts for it: it skips accounts that are signed out, near their limit or exhausted, and prefers the one with the most headroom and the earliest reset.",
        ],
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
          "Your messages are held, not lost. Resume at the reset, snooze the thread until then, or move it to another account of the same provider.",
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
      "Use my Chrome: agents work in tabs you share from your own Chrome",
      "The live browser on your phone, at 60 fps",
    ],
    sections: [
      {
        heading: "See the page, not just the code",
        body: [
          "An agent that can't see the page it changed is guessing. In ace, agents open pages in a real Chromium browser, read the page as structured text, click, type and scroll, and check the console and network log for errors, then fix what they find.",
          "The tab is shared: you watch the agent work in it, and you can take over whenever you like. Screenshots at phone, tablet and desktop widths let an agent check a responsive layout in one step.",
        ],
      },
      {
        heading: "Watch it from anywhere",
        body: [
          "The browser agents use is one shared session, not a copy per viewer. Open it on your phone, in the web app or on another desktop and it streams live at 60 frames a second, and you can click and type in it. Open a tab on the phone and the page switches to a phone-sized layout, and the agent is told it is working at that size.",
        ],
      },
      {
        heading: "Point at what's wrong",
        body: [
          "Mark up a page directly, circling the broken button or the misaligned card, and send the notes to the agent with the page attached. It is the fastest way to say exactly what you mean about a UI.",
        ],
      },
      {
        heading: "Your own Chrome, when you need it",
        body: [
          "Some work needs your real sessions. Use my Chrome lets agents work in your own Chrome profile through an extension, but only in tabs you share from it or tabs they open in a separate ace window. Chrome shows its debugging bar while they do, and Stop or Revoke ends it at once.",
          "Settings pages, extension pages and the password manager are refused, cookie reads are blocked, and page storage reads are off unless you allow them. It works with Chrome, Chromium, Edge, Brave, Vivaldi and Arc.",
        ],
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
      "Run iOS Simulators and Android emulators inside ace. Use them yourself or hand one to an agent to test your app, with live screen, UI tree and logs.",
    headline: "Simulators and emulators in one hub",
    intro:
      "Run iOS Simulators and Android emulators inside ace. Tap, type and rotate them yourself, or hand a device to an agent to test your app.",
    points: [
      "Live screen, UI tree, logs and recordings",
      "Approve a device before an agent can use it",
      "Hand a device to any agent in the thread",
      "The same tools for every agent CLI",
    ],
    sections: [
      {
        heading: "Mobile testing that agents can do",
        body: [
          "The devices hub runs simulators and emulators in ace, beside the thread that is changing your app. Agents read the screen as a UI tree, tap and type, and read the device log, so they can reproduce a bug, fix it and check the fix on the device.",
          "iOS Simulators need a Mac with Xcode. Android emulators need the Android SDK on the machine that runs them.",
        ],
      },
      {
        heading: "Devices are yours to lend",
        body: [
          "An agent asks before it uses a device, and you approve it once. You can hand a device to any agent in a thread, and take it back at any time.",
        ],
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
          "Yes. Android emulators run in the same hub with the same tools, so any agent can test an Android build.",
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
      "Give every agent thread its own git worktree, review its diff beside the conversation, send line comments back, then commit, push and open the pull request.",
    headline: "Review the diff next to the conversation",
    intro:
      "Give a thread its own git worktree and its changes stay apart from every other agent's. Comment on a line, send it to the agent, then commit and push from the same panel.",
    points: [
      "One git worktree per thread, created for you",
      "Line comments go straight back to the agent",
      "Commit, push and open the pull request in place",
      "Pull requests and issues as full pages",
    ],
    sections: [
      {
        heading: "Parallel agents, no collisions",
        body: [
          "Several agents on one repository overwrite each other's files unless each has its own checkout. ace starts a thread in its own git worktree on its own branch, so you can run as many as you like and review each one on its own.",
        ],
      },
      {
        heading: "Review where the work happened",
        body: [
          "The Changes panel sits beside the conversation: a file tree with added and removed lines, the diff for the last turn or the whole branch, and line comments. Send comments to the agent as a request for changes, or approve and commit.",
          "Open pull requests and issues as full pages, link them to the thread that wrote the code, and merge once checks pass.",
        ],
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
    title: "Know which coding agent needs you: ace thread status",
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
    sections: [
      {
        heading: "Five words you can trust",
        body: [
          "Agents start subagents and leave commands running in the background. A status that only watches the main agent says Done while work is still happening. ace follows the whole tree, so Done means every agent and command in the thread has finished.",
          "Approve and Answer mean a thread is stopped on you: a permission or a question. Those threads come first, on your desktop and on your phone, so you never leave an agent waiting.",
        ],
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
