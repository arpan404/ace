/**
 * Formats an ISO date string into a concise calendar label.
 */
export function formatIssueRelativeTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const dayDiff = Math.round((today.getTime() - targetDay.getTime()) / 86_400_000);

  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";

  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  });
}
