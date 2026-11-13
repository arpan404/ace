import {
  spadeDollarsOf,
  spadeMicrosOf,
  spadeMoney,
  type SpadeSpending,
} from "@ace/ui-core/spade-chat";
import { useId, useState } from "react";
import { Input } from "@/components/ui/input.tsx";
import { setAgentOversight, type SpadeAgentOversightChange } from "./spade-oversight-api.ts";
import type { SpadeTarget } from "./spade-requests.ts";

/**
 * A bot's caps as the edit form holds them (ADR 0135): what Spade sent with
 * the bot, the person's change, and saving that change as one `PUT …/oversight` of what moved.
 * Caps are typed in dollars and sent in micros; an empty cap is no cap.
 */
export function useOversightChoice(bot: { id: string; spending: SpadeSpending | undefined }) {
  const [daily, setDailyText] = useState(spadeDollarsOf(bot.spending?.dailyCapMicros));
  const [monthly, setMonthlyText] = useState(spadeDollarsOf(bot.spending?.monthlyCapMicros));
  // A cap is sent only once the person has typed in its field: saving the name or the task
  // never rewrites a cap from how the form shows it.
  const [edited, setEdited] = useState({ daily: false, monthly: false });
  const setDaily = (value: string) => {
    setDailyText(value);
    setEdited((was) => ({ ...was, daily: true }));
  };
  const setMonthly = (value: string) => {
    setMonthlyText(value);
    setEdited((was) => ({ ...was, monthly: true }));
  };
  const dailyMicros = spadeMicrosOf(daily);
  const monthlyMicros = spadeMicrosOf(monthly);
  const change: SpadeAgentOversightChange = {
    ...(edited.daily && dailyMicros !== null && dailyMicros !== bot.spending?.dailyCapMicros
      ? { daily_cap_micros: dailyMicros ?? null }
      : {}),
    ...(edited.monthly && monthlyMicros !== null && monthlyMicros !== bot.spending?.monthlyCapMicros
      ? { monthly_cap_micros: monthlyMicros ?? null }
      : {}),
  };
  return {
    spending: bot.spending,
    daily,
    monthly,
    setDaily,
    setMonthly,
    /** A cap that isn't a number of dollars: the form can't save it. */
    invalid: (edited.daily && dailyMicros === null) || (edited.monthly && monthlyMicros === null),
    changed: Object.keys(change).length > 0,
    save: async (client: SpadeTarget) => {
      if (Object.keys(change).length > 0) await setAgentOversight(client, bot.id, change);
    },
  };
}

/**
 * The form's Spending: spent today and this month, and the daily and monthly caps in dollars.
 */
export function OversightFields(props: { choice: ReturnType<typeof useOversightChoice> }) {
  const { choice } = props;
  const ids = { daily: useId(), monthly: useId() };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ui font-medium">Spending</span>
      {choice.spending && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {`${spadeMoney(choice.spending.todayMicros)} today · ${spadeMoney(choice.spending.monthMicros)} this month`}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <CapInput
          id={ids.daily}
          label="Daily cap"
          value={choice.daily}
          onChange={choice.setDaily}
        />
        <CapInput
          id={ids.monthly}
          label="Monthly cap"
          value={choice.monthly}
          onChange={choice.setMonthly}
        />
      </div>
    </div>
  );
}

function CapInput(props: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const invalid = spadeMicrosOf(props.value) === null;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="text-xs text-muted-foreground">
        {props.label}
      </label>
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="text-ui text-muted-foreground">
          $
        </span>
        <Input
          id={props.id}
          inputMode="decimal"
          placeholder="No cap"
          value={props.value}
          aria-invalid={invalid || undefined}
          onChange={(event) => props.onChange(event.target.value)}
          className="w-28 tabular-nums"
        />
      </div>
    </div>
  );
}
