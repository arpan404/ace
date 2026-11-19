/*
 * The words on /agents/: the roster's heading, its two groups, the line shown for an ACP agent
 * and the three facts under it. The agents themselves come from agents.ts (the app's own
 * tables); a built-in agent's line comes from its guide (agent-guides.ts).
 */

export const roster = {
  heading: "Pick one in the composer.",
  lede: "Each thread runs on the agent you choose in ace's model picker. Six are built in, and any agent that speaks the Agent Client Protocol joins them. Turn the dial to meet them.",
  /** The two groups, as the dial's switch and the grid's headings name them. */
  builtIn: "Built in",
  acp: "Through ACP",
  acpLong: "Through the Agent Client Protocol",
  acpMore: "And any other agent that speaks ACP.",
  /** What the composer says while the reader turns the dial. */
  prompt: "Ask anything",
  /** How the dial is named for assistive technology, and how to turn it. */
  dialLabel: "Agents ace runs. Use the arrow keys to turn.",
  open: (name: string) => `Run ${name} in ace`,
};

/** The line beside an ACP agent on the dial; the protocol, not a page of its own, is the story. */
export const acpLine = (name: string) =>
  `${name} joins through the Agent Client Protocol. Install it, sign in through its own CLI, and choose it in the composer like any built-in agent.`;

export const rosterFacts: { title: string; body: string; href?: string }[] = [
  {
    title: "Your own login",
    body: "Each agent signs in through its own CLI, the way you already use it. ace never asks for, stores or proxies a key.",
  },
  {
    title: "Several accounts",
    body: "Add several accounts per provider. When one hits its limit, the thread moves to another, by your hand or by ace's.",
    href: "/features/accounts/",
  },
  {
    title: "One team",
    body: "Any agent hands work to agents on other providers and waits for the results. They message each other and send files.",
    href: "/features/orchestration/",
  },
];
