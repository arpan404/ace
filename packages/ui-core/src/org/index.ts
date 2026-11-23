/*
 * An organization's admin pages' shared rules (ADR 0206 §3, §4.2): the policy as lines of text
 * and a host's audit export read for a list. Web and the iPhone's bridge run the same code.
 */
export {
  allowEntries,
  allowText,
  blockEntries,
  blockText,
  lines,
  policyDraft,
  policyFromDraft,
  readPolicy,
  type PolicyDraft,
} from "./policy-text.ts";
export { readAuditLines, type AuditRow } from "./audit-lines.ts";
