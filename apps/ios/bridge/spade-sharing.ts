import {
  approverLine,
  sharedInLine,
  spadeOrgView,
  spadeSharedAccess,
  SpadeRequestError,
  type SpadeAgent,
  type SpadeSharedAccess,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";

/*
 * A shared bot's marks on the iPhone (ADR 0206 §2.3), from the rules web uses
 * (`@ace/ui-core/spade-chat`): "Shared" beside its name, and on each of its requests who may
 * answer. The machine's Spade says whether it belongs to an organization (`GET /v1/org`); only
 * then is each bot's access list read (`GET /v1/agents/{id}/access`). A personal machine's bots
 * show none of it. Swift sends who the person is and the organization's members' names
 * (`spade.people`), which only the account backend knows.
 */

/** Who the person is on the account, and the names of the organization's members by account. */
export const SpadePeople = z.object({
  self: z.string().min(1).max(256).nullable(),
  names: z.record(z.string().max(256), z.string().max(256)),
});
export type SpadePeople = z.infer<typeof SpadePeople>;

export interface SpadeSharingDeps {
  read(path: string): Promise<string>;
  now(): number;
  /** Something a row shows changed. */
  changed(): void;
}

/** The org answer is asked again at most this often; a bot's access list this often. */
const orgEvery = 60_000;
const accessEvery = 30_000;

export class SpadeSharing {
  /** The organization's name, when this machine's Spade belongs to one; null for none. */
  private org: { id: string; name: string | undefined } | null | undefined;
  private orgAt = -Infinity;
  private orgReading = false;
  private access = new Map<string, { at: number; access: SpadeSharedAccess | undefined }>();
  private reading = new Set<string>();
  private people: SpadePeople = { self: null, names: {} };
  private readonly deps: SpadeSharingDeps;

  constructor(deps: SpadeSharingDeps) {
    this.deps = deps;
  }

  /** The bots were read: ask the organization, then each bot's access, as far as they are due. */
  follow(agents: readonly SpadeAgent[]): void {
    if (this.deps.now() - this.orgAt >= orgEvery) this.readOrg(agents);
    else this.readAccess(agents);
  }

  /** Read everything again with the next list, as a pull to refresh does. */
  refresh(): void {
    this.orgAt = -Infinity;
    this.access.clear();
  }

  setPeople(people: SpadePeople): void {
    this.people = people;
    this.deps.changed();
  }

  /** "Shared in Acme Robotics" for a shared bot; null for a bot of the person's own. */
  sharedIn(agent: string): string | null {
    const org = this.org;
    if (!org || !this.access.get(agent)?.access) return null;
    return sharedInLine(org.name);
  }

  /** Who may answer a shared bot's request; null for a bot of the person's own. */
  approvers(agent: string): string | null {
    const access = this.org ? this.access.get(agent)?.access : undefined;
    if (!access) return null;
    return approverLine({
      approvers: access.approvers,
      nameOf: (account) => this.people.names[account],
      self: this.people.self ?? undefined,
    }).line;
  }

  private readOrg(agents: readonly SpadeAgent[]) {
    if (this.orgReading) return;
    this.orgReading = true;
    void this.deps.read("/v1/org").then(
      (text) => {
        const view = safe(() => spadeOrgView(text));
        const before = this.org;
        this.org = view?.org ? { id: view.org, name: view.name } : null;
        this.orgAt = this.deps.now();
        if (!this.org) this.access.clear();
        if (before?.id !== this.org?.id || before?.name !== this.org?.name) this.deps.changed();
      },
      // A Spade before organizations answers 404: the machine is a personal one.
      (error: unknown) => {
        if (error instanceof SpadeRequestError && error.status === 404) {
          this.org = null;
          this.orgAt = this.deps.now();
        }
      },
    ).finally(() => {
      this.orgReading = false;
      this.readAccess(agents);
    });
  }

  private readAccess(agents: readonly SpadeAgent[]) {
    if (!this.org) return;
    const now = this.deps.now();
    for (const agent of agents) {
      // Spade itself is the machine's own, never shared.
      if (agent.kind === "main" || this.reading.has(agent.id)) continue;
      const kept = this.access.get(agent.id);
      if (kept && now - kept.at < accessEvery) continue;
      this.reading.add(agent.id);
      void this.deps
        .read(`/v1/agents/${encodeURIComponent(agent.id)}/access`)
        .then(
          (text) => safe(() => spadeSharedAccess(text)),
          (error: unknown) => {
            // 404: not shared. Anything else keeps what was known.
            if (error instanceof SpadeRequestError && error.status === 404) return undefined;
            throw error;
          },
        )
        .then(
          (access) => {
            const shared = Boolean(kept?.access);
            this.access.set(agent.id, { at: this.deps.now(), access });
            if (shared !== Boolean(access) || access) this.deps.changed();
          },
          () => {},
        )
        .finally(() => this.reading.delete(agent.id));
    }
  }
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
