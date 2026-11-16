import { spadeMoney } from "@ace/ui-core/spade-chat";
import { SettingRow } from "@/components/setting-row.tsx";
import { ProfileSection } from "./spade-profile-parts.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/**
 * Spending (ADR 0135), a section of Details: this month's spend with today's under it. It is
 * information only: Spade has no spending limits (ADR 0166).
 */
export function ProfileSpending(props: { bot: RosterBot }) {
  const { bot } = props;
  const spending = bot.spending;
  return (
    <ProfileSection label="Spending">
      <SettingRow
        inline
        title="This month"
        description={spending ? `${spadeMoney(spending.todayMicros)} today` : undefined}
      >
        <span className="text-ui text-foreground tabular-nums">
          {spending ? spadeMoney(spending.monthMicros) : "Not recorded"}
        </span>
      </SettingRow>
    </ProfileSection>
  );
}
