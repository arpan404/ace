import { z } from "zod";

/*
 * The person's outside A2A agents (ADR 0202 §5), as `GET /v1/a2a-agents` lists them: each added
 * by its address like an app, with whether its card's signature held and the skills its bots may
 * call, every call going to the person. Read leniently: an entry that doesn't read is left out.
 */

export interface SpadeOutsideAgent {
  id: string;
  name: string;
  address: string;
  /** Its card's signature held with its publisher's key. */
  signed: boolean;
  /** "Signed by its publisher's key" or "Not signed", as Spade words it. */
  signature: string;
  /** Why it reads as not signed. */
  unsignedBecause: string | undefined;
  skills: readonly { id: string; name: string }[];
}

const Agent = z
  .object({
    id: z.string().min(1),
    name: z.string().catch(""),
    address: z.string().catch(""),
    signed: z.boolean().catch(false),
    signature: z.string().catch("Not signed"),
    unsigned_because: z.string().nullish().catch(undefined),
    skills: z.array(z.object({ id: z.string(), name: z.string().catch("") })).catch([]),
  })
  .transform((agent): SpadeOutsideAgent => {
    // Only Spade's word that it held makes it signed.
    const signed = agent.signed && agent.signature === "Signed by its publisher's key";
    return {
      id: agent.id,
      name: agent.name || agent.id,
      address: agent.address,
      signed,
      signature: signed ? agent.signature : "Not signed",
      unsignedBecause: agent.unsigned_because ?? undefined,
      skills: agent.skills.map((skill) => ({ id: skill.id, name: skill.name || skill.id })),
    };
  });

const Listed = z.object({ agents: z.array(z.unknown()).catch([]) });
const Added = z.object({ agent: z.unknown() });

/** The agents from Spade's list; none when it can't be read. */
export function readSpadeOutsideAgents(raw: unknown): SpadeOutsideAgent[] {
  const read = Listed.safeParse(raw);
  if (!read.success) return [];
  return read.data.agents.flatMap((item) => {
    const agent = Agent.safeParse(item);
    return agent.success ? [agent.data] : [];
  });
}

/** One agent from Spade's answer to adding it, or undefined. */
export function readSpadeOutsideAgent(raw: unknown): SpadeOutsideAgent | undefined {
  const read = Added.safeParse(raw);
  if (!read.success) return undefined;
  const agent = Agent.safeParse(read.data.agent);
  return agent.success ? agent.data : undefined;
}
