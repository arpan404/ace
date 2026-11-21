import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * Spade on an org host, in the fake (ADR 0206 §2.3, §4.2): the organization it belongs to
 * (`GET /v1/org`), shared bots' access lists (`GET /v1/agents/{id}/access`) and the host's audit
 * log as JSON Lines (`GET /v1/org/audit/export`), in Spade's JSON. A fake Spade no test binds
 * belongs to no organization, as a personal machine's.
 */

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);

export interface FakeSpadeOrgBinding {
  org: string;
  name: string;
  host: string;
  policy: number;
  auditKey: string;
}

export interface FakeSpadeAccess {
  org: string;
  maker: string;
  talk?: string[];
  approvers: string[];
  configurers?: string[];
}

export class FakeSpadeOrg {
  binding: FakeSpadeOrgBinding | undefined;
  /** Shared bots' access lists, by bot id. */
  access = new Map<string, FakeSpadeAccess>();
  /** The host's log lines after the header, as Spade writes them. */
  audit: Record<string, unknown>[] = [];

  route(method: string, sub: string | undefined, part: string | undefined): FakeSpadeAnswer {
    if (method !== "GET") return problem(405, "Method not allowed.");
    if (sub === undefined) return reply(this.binding ? { ...this.binding } : { org: null });
    if (sub === "audit" && part === "export") {
      if (!this.binding) return problem(404, "this Spade doesn't belong to an organization");
      const header = {
        kind: "header",
        org: this.binding.org,
        host: this.binding.host,
        key: this.binding.auditKey,
      };
      return {
        status: 200,
        body: [header, ...this.audit].map((line) => `${JSON.stringify(line)}\n`).join(""),
      };
    }
    return problem(404, "Not found.");
  }

  accessRoute(method: string, agent: string): FakeSpadeAnswer {
    if (method !== "GET") return problem(405, "Method not allowed.");
    const found = this.access.get(agent);
    return found ? reply({ access: found }) : problem(404, "that bot isn't a shared bot");
  }
}
