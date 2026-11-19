/*
 * The words on /agents/: the headings and ledes of its two lists and the three facts under
 * them. The agents themselves come from agents.ts (the app's own
 * tables); a built-in agent's line comes from its guide (agent-guides.ts).
 */

export const roster = {
  builtIn: {
    heading: "Six are built in.",
    lede: "Each has an adapter of its own in ace. Choose one for a thread in the composer's model picker, and change it whenever you like.",
  },
  acp: {
    heading: "And any agent that speaks ACP.",
    lede: "The Agent Client Protocol lets an agent join without an adapter. Install it, sign in through its own CLI, and it stands in the picker beside the rest.",
    more: "Any other ACP agent",
  },
  factsHeading: "The same deal for every one.",
};

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
