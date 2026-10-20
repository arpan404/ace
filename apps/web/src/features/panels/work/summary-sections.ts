/** What the thread has to show in its Summary. */
export interface SummaryFacts {
  /** Requests, failed or silent agents waiting on the person. */
  needsYou: number;
  /** An Offshift run that is not done yet. A done run has nothing left to act on. */
  offshift: boolean;
  /** The thread has a turn to sum up. */
  turn: boolean;
  /** Plans the thread shows. */
  plans: number;
  /** Agents still working or waiting: the main agent, or any subagent. */
  working: number;
  /** Background commands still run, or input is queued. */
  background: boolean;
  /** Pull requests the thread linked or its agents opened. */
  prs: number;
  /** Subagents whose whole branch settled. */
  done: number;
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
  offshift: boolean;
  working: boolean;
  prs: boolean;
  done: boolean;
  turn: boolean;
  plans: boolean;
  changes: boolean;
  checks: boolean;
  catchUp: boolean;
  /** More than one section shows: each takes a small label. */
  labelled: boolean;
}

/**
 * Which sections the Summary draws. A section with nothing in it is left out rather than saying
 * it is empty: a lone main agent at rest is nothing working, and changes by agent show only once
 * more than one agent changed files (one agent's are the turn's own list). Labels appear only
 * when there is more than one section to tell apart. Pure.
 */
export function summarySections(facts: SummaryFacts): SummarySections {
  const shown = {
    needsYou: facts.needsYou > 0,
    offshift: facts.offshift,
    working: facts.working > 0 || facts.background,
    prs: facts.prs > 0,
    done: facts.done > 0,
    turn: facts.turn,
    plans: facts.plans > 0,
    changes: facts.changingAgents > 1,
    checks: facts.checks > 0,
    catchUp: facts.catchUp,
  };
  const count = Object.values(shown).filter(Boolean).length + Number(facts.automations);
  return { ...shown, labelled: count > 1 };
}
