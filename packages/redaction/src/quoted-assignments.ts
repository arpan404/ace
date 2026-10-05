// Consume the entire quoted value, including whitespace, before bare assignments.
export const QUOTED_SECRET_ASSIGNMENT =
  /\b(?:token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code)\s*[=:]\s*(?:"(?:[^"\\]|\\[\s\S]?)*(?:"|$)|'(?:[^'\\]|\\[\s\S]?)*(?:'|$))/gi;
