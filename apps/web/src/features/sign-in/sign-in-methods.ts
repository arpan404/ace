import type { ProviderKind } from "@ace/protocol";
import type { Brand } from "@ace/ui-core";

/*
 * A way to sign in that a CLI offers (Claude's subscription, Console or SSO; an ACP agent's
 * methods), as the choices list draws it: a mark that says what kind of sign-in it is, a short
 * name and one line on what it means. Services OpenCode and Pi reach are not methods; their marks
 * come from `serviceInfo`.
 */

export type MethodGlyph = "key" | "briefcase" | "globe" | "terminal" | "account";

export interface SignInMethod {
  label: string;
  description?: string | undefined;
  /** The maker's mark, when the method is the maker's own account. */
  brand?: Brand | undefined;
  glyph: MethodGlyph;
}

const claudeMethods: Record<string, Omit<SignInMethod, "glyph"> & { glyph?: MethodGlyph }> = {
  claudeai: {
    label: "Claude subscription",
    description: "Use your Pro, Max, Team or Enterprise plan",
    brand: "claude",
  },
  console: {
    label: "Anthropic Console",
    description: "Pay for what you use with API billing",
    glyph: "key",
  },
  sso: {
    label: "Single sign-on",
    description: "Sign in through your organization",
    glyph: "briefcase",
  },
};

/** What a method's own words say it is, for CLIs whose method ids carry no meaning. */
function glyphFor(label: string): MethodGlyph {
  if (/api[\s_-]?key|console|billing/i.test(label)) return "key";
  if (/\bsso\b|single sign|enterprise|organi[sz]ation|workspace|vertex|cloud/i.test(label))
    return "briefcase";
  if (/terminal|command|cli\b/i.test(label)) return "terminal";
  if (/browser|web|oauth/i.test(label)) return "globe";
  return "account";
}

/** How a sign-in method the CLI offers is drawn and named. */
export function signInMethod(
  provider: ProviderKind,
  choice: { id: string; label: string },
): SignInMethod {
  const known = provider === "claude" ? claudeMethods[choice.id] : undefined;
  if (known) return { ...known, glyph: known.glyph ?? "account" };
  return { label: choice.label, glyph: glyphFor(choice.label) };
}
