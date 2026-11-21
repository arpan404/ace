import { AceOrgError } from "@ace/client/ace-org";

/*
 * What an org route's refusal means, in words (ADR 0206). Pure. The backend's `error` word
 * decides; anything else is a connection that didn't answer.
 */

const said: Record<string, string> = {
  forbidden: "Your role in this organization doesn't allow that.",
  not_member: "You're no longer a member of this organization.",
  org_sign_in_required: "This organization asks you to sign in again.",
  last_owner: "An organization always keeps one owner. Make someone else an owner first.",
  directory_managed: "Set by your identity provider, so it can't be changed here.",
  invitation_refused: "Couldn't invite that address. Check it, or it may already be invited.",
  email_unverified: "Verify your account's email address to create an organization.",
  person_required: "Only you, signed in on this device, can do that.",
  policy_changed: "Another admin saved the policy first. Look it over and save again.",
  consent_used: "That machine's consent was already used. Try again.",
  consent_expired: "That took too long. Try again.",
  not_your_machine: "Only this machine's owner can give it to an organization.",
  not_machine_owner: "Only this machine's owner can give it to an organization.",
  not_found: "That's no longer there.",
  busy: "Someone else is changing this organization. Try again in a moment.",
};

/** One sentence for why an org call didn't work. */
export function orgFailure(error: unknown): string {
  if (error instanceof AceOrgError) {
    if (error.status === 401) return "Your ace session ended. Sign in again.";
    return said[error.code] ?? "Couldn't reach your ace account. Try again.";
  }
  return "Couldn't reach your ace account. Try again.";
}
