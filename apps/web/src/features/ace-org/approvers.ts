/*
 * Who answers a shared bot's requests (ADR 0206 §2.3), pure: the bot's approvers are its person.
 * They all see one request; the first answer counts.
 */

/** "Dana Kim", "Dana Kim or Lee Park", "Dana Kim, Lee Park or Sam Wu". */
function either(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * The line under a shared bot's request: whether the person is one of its approvers, and who the
 * others are, by name where the organization's list has one.
 */
export function approverLine(input: {
  approvers: readonly string[];
  nameOf: (account: string) => string | undefined;
  self: string | undefined;
}): { line: string; canAnswer: boolean } {
  const canAnswer = input.self !== undefined && input.approvers.includes(input.self);
  const others = input.approvers
    .filter((account) => account !== input.self)
    .map((account) => input.nameOf(account) ?? "a member");
  if (canAnswer)
    return {
      canAnswer,
      line: others.length
        ? `You or ${either(others)} can answer. The first answer counts.`
        : "You're its approver.",
    };
  return {
    canAnswer,
    line: others.length
      ? `Waiting on ${either(others)}. Only its approvers can answer.`
      : "Waiting on its approver. Only its approvers can answer.",
  };
}
