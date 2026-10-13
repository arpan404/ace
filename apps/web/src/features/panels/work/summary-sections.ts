/** What the thread has to show beyond its head line. */
export interface SummaryFacts {
  /** Plans the thread shows. */
  plans: number;
  /** The main agent has subagents, working or finished (each opens as its own chat). */
  subagents: boolean;
  /** Some agent is in a turn, waiting on its tree, or waiting on the person. */
  agentsLive: boolean;
  /** Background commands still run, or input is queued. */
  background: boolean;
  /** The project has schedules (or reading them failed). */
  automations: boolean;
}

export interface SummarySections {
  plans: boolean;
  agents: boolean;
  background: boolean;
  /** More than one section shows: each takes a small label. */
  labelled: boolean;
}

/**
 * Which sections the Summary draws. A section with nothing in it is left out rather than
 * saying it is empty; a lone main agent at rest is the head line's "Nothing running", not a
 * tree of one. Labels appear only when there is more than one section to tell apart. Pure.
 */
export function summarySections(facts: SummaryFacts): SummarySections {
  const plans = facts.plans > 0;
  const agents = facts.subagents || facts.agentsLive;
  const shown = [plans, agents, facts.background, facts.automations].filter(Boolean).length;
  return { plans, agents, background: facts.background, labelled: shown > 1 };
}
