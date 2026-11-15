import { spadeDollarsOf, spadeMicrosOf, spadeMoney } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { setAgentOversight } from "./spade-oversight-api.ts";
import { fault } from "./spade-profile-actions.ts";
import { ProfileSection } from "./spade-profile-parts.tsx";
import { agentsKey, type RosterBot } from "./use-spade-roster.ts";

/**
 * Spending (ADR 0135), a section of Details: this month's spend with today's under it, then the
 * daily and monthly caps in dollars, each saved when the person leaves its field or presses ↵.
 * An empty cap is no cap; Esc puts the field back.
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
      <CapRow bot={bot} which="daily" saved={spending?.dailyCapMicros} />
      <CapRow bot={bot} which="monthly" saved={spending?.monthlyCapMicros} />
    </ProfileSection>
  );
}

function CapRow(props: { bot: RosterBot; which: "daily" | "monthly"; saved: number | undefined }) {
  const id = useId();
  const client = useSpadeClient();
  const cache = useQueryClient();
  const saved = spadeDollarsOf(props.saved);
  const [text, setText] = useState(saved);
  const [seen, setSeen] = useState(saved);
  const [problem, setProblem] = useState<string>();
  // Spade's value moved on (another window, a reset): the field follows while untouched.
  if (seen !== saved) {
    setSeen(saved);
    if (text === seen) setText(saved);
  }
  const micros = spadeMicrosOf(text);
  const save = () => {
    if (micros === null) return setProblem("Type an amount in dollars, or leave it empty.");
    if (micros === props.saved) return setProblem(undefined);
    setProblem(undefined);
    const field = props.which === "daily" ? "daily_cap_micros" : "monthly_cap_micros";
    setAgentOversight(client, props.bot.id, { [field]: micros ?? null }).then(
      () => cache.invalidateQueries({ queryKey: agentsKey }),
      (error: unknown) => setProblem(fault(error)),
    );
  };
  const title = props.which === "daily" ? "Daily cap" : "Monthly cap";
  return (
    <SettingRow
      inline
      title={title}
      htmlFor={id}
      description={problem && <span className="text-destructive">{problem}</span>}
    >
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="text-ui text-muted-foreground">
          $
        </span>
        <Input
          id={id}
          inputMode="decimal"
          placeholder="No cap"
          value={text}
          aria-invalid={micros === null || undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setText(saved);
              setProblem(undefined);
            }
          }}
          className="w-24 tabular-nums"
        />
      </div>
    </SettingRow>
  );
}
