/** What the thread has to show in its Summary. */
export interface SummaryFacts {
  /** Requests, failed or silent agents waiting on the person. */
  needsYou: number;
  /** The thread has a turn to sum up. */
  turn: boolean;
  /** Plans the thread shows. */
  plans: number;
  /** The main agent has subagents, working or finished (each opens as its own chat). */
  subagents: boolean;
  /** Some agent is in a turn, waiting on its tree, or waiting on the person. */
  agentsLive: boolean;
  /** Background commands still run, or input is queued. */
  background: boolean;
  /** Agents whose changes in the turn the Summary attributes. */
  changingAgents: number;
  /** Checks the turn ran. */
  checks: number;
  /** The thread moved on since this device last read it. */
  catchUp: boolean;
  /** The project has schedules (or reading them failed). */
  automations: boolean;
}

export interface SummarySections {
  needsYou: boolean;
  turn: boolean;
  plans: boolean;
  agents: boolean;
  changes: boolean;
  checks: boolean;
  catchUp: boolean;
  /** More than one section shows: each takes a small label. */
  labelled: boolean;
}

/**
 * Which sections the Summary draws. A section with nothing in it is left out rather than saying
 * it is empty: a lone main agent at rest is no tree, and changes by agent show only once more
 * than one agent changed files (one agent's are the turn's own list). Labels appear only when
 * there is more than one section to tell apart. Pure.
 */
export function summarySections(facts: SummaryFacts): SummarySections {
  const shown = {
    needsYou: facts.needsYou > 0,
    turn: facts.turn,
    plans: facts.plans > 0,
    agents: facts.subagents || facts.agentsLive || facts.background,
    changes: facts.changingAgents > 1,
    checks: facts.checks > 0,
    catchUp: facts.catchUp,
  };
  const count = Object.values(shown).filter(Boolean).length + Number(facts.automations);
  return { ...shown, labelled: count > 1 };
}
