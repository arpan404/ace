import { z } from "zod";

/**
 * A Google Cloud project id: 6 to 30 lowercase letters, digits and hyphens, starting with a letter,
 * optionally behind a legacy `example.com:` domain. Non-secret; written to the agent's settings.
 */
export const GcpProjectId = z
  .string()
  .min(6)
  .max(100)
  .regex(/^(?:[a-z0-9][a-z0-9.-]{0,61}[a-z0-9]:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
/** A Google Cloud location (`global`, `us`, `eu`, `us-central1`). Non-secret. */
export const GcpLocation = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/);

/**
 * How an Antigravity account signs in. `google` is the agent's own Google sign-in. `enterprise`
 * signs in to Gemini Enterprise in the browser for a project and location. `agent_platform` uses
 * the Application Default Credentials already on the computer running ace, for a project and
 * location. Key-based methods are not offered: the agent keeps a key only in memory, so ace
 * would have to store it.
 */
export const AntigravitySignIn = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("google") }),
  z.strictObject({ method: z.literal("enterprise"), project: GcpProjectId, location: GcpLocation }),
  z.strictObject({
    method: z.literal("agent_platform"),
    project: GcpProjectId,
    location: GcpLocation,
  }),
]);
export type AntigravitySignIn = z.infer<typeof AntigravitySignIn>;
export const AntigravitySignInMethod = z.enum(["google", "enterprise", "agent_platform"]);
export type AntigravitySignInMethod = z.infer<typeof AntigravitySignInMethod>;
