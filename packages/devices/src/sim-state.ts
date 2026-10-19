import { SimRefs } from "./sim-refs.ts";

const maxGuided = 1024;

/** What the sim_* tools and `ace sim` remember per agent, shared so both see the same refs. */
export class SimAgentState {
  readonly refs = new SimRefs();
  private readonly guided = new Set<string>();

  /** True the first time this agent starts this device: the moment it needs the how-to. */
  firstStart(owner: string, deviceId: string): boolean {
    const key = JSON.stringify([owner, deviceId]);
    if (this.guided.has(key)) return false;
    this.guided.add(key);
    if (this.guided.size > maxGuided) {
      const oldest = this.guided.values().next().value;
      if (oldest !== undefined) this.guided.delete(oldest);
    }
    return true;
  }
}
