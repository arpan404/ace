import {
  spadeDollarsOf,
  spadeMicrosOf,
  spadeMoney,
  type SpadeSpending,
} from "@ace/ui-core/spade-chat";
import { useId, useState } from "react";
import { Input } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { setAgentOversight, type SpadeAgentOversightChange } from "./spade-oversight-api.ts";
import type { SpadeTarget } from "./spade-requests.ts";

type ReviewChoice = "default" | "on" | "off";

const choiceOf = (review: boolean | undefined): ReviewChoice =>
  review === undefined ? "default" : review ? "on" : "off";

/**
 * A bot's caps and review switch as the edit form holds them (ADR 0135): what Spade sent with
 * the bot, the person's change, and saving that change as one `PUT …/oversight` of what moved.
 * Caps are typed in dollars and sent in micros; an empty cap is no cap.
 */
export function useOversightChoice(bot: {
  id: string;
  spending: SpadeSpending | undefined;
  review: boolean | undefined;
}) {
  const [daily, setDaily] = useState(spadeDollarsOf(bot.spending?.dailyCapMicros));
  const [monthly, setMonthly] = useState(spadeDollarsOf(bot.spending?.monthlyCapMicros));
  const [review, setReview] = useState(choiceOf(bot.review));
  const dailyMicros = spadeMicrosOf(daily);
  const monthlyMicros = spadeMicrosOf(monthly);
  const change: SpadeAgentOversightChange = {
    ...(dailyMicros !== null && dailyMicros !== bot.spending?.dailyCapMicros
      ? { daily_cap_micros: dailyMicros ?? null }
      : {}),
    ...(monthlyMicros !== null && monthlyMicros !== bot.spending?.monthlyCapMicros
      ? { monthly_cap_micros: monthlyMicros ?? null }
      : {}),
    ...(review !== choiceOf(bot.review)
      ? { review: review === "default" ? null : review === "on" }
      : {}),
  };
  return {
    spending: bot.spending,
    daily,
    monthly,
    review,
    setDaily,
    setMonthly,
    setReview,
    /** A cap that isn't a number of dollars: the form can't save it. */
    invalid: dailyMicros === null || monthlyMicros === null,
    changed: Object.keys(change).length > 0,
    save: async (client: SpadeTarget) => {
      if (Object.keys(change).length > 0) await setAgentOversight(client, bot.id, change);
    },
  };
}

/**
 * The form's Spending and Review: spent today and this month, the daily and monthly caps in
 * dollars, and whether a second model checks its steps (following the default, on or off).
 */
export function OversightFields(props: { choice: ReturnType<typeof useOversightChoice> }) {
  const { choice } = props;
  const ids = { daily: useId(), monthly: useId() };
  return (
    <>
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
        <p className="text-xs text-subtle-foreground">Leave a cap empty for no cap.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-ui font-medium">Review</span>
        <SegmentedControl<ReviewChoice>
          label="Review"
          value={choice.review}
          options={[
            { value: "default", label: "Follow default" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          onValueChange={choice.setReview}
          size="sm"
          className="w-fit"
        />
        <p className="text-xs text-subtle-foreground">
          A second model checks each step that changes something before it runs, and asks you when
          it looks wrong.
        </p>
      </div>
    </>
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
