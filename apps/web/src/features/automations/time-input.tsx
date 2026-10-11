import { useState } from "react";
import { Input } from "@/components/ui/input.tsx";

function readTime(text: string): string {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(text.trim());
  if (!match) return text;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3]?.toLowerCase();
  if (minute > 59 || hour > (period ? 12 : 23) || (period && hour < 1)) return text;
  if (period) hour = (hour % 12) + (period === "pm" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function displayTime(time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return time;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

/** A plain time field accepts either clock convention and preserves exact minutes. */
export function TimeInput(props: {
  id: string;
  value: string;
  onValueChange(value: string): void;
  onBlur(): void;
  "aria-invalid"?: boolean | undefined;
  "aria-describedby"?: string | undefined;
}) {
  const [draft, setDraft] = useState<string | undefined>();
  return (
    <Input
      id={props.id}
      name="time"
      value={draft ?? displayTime(props.value)}
      onFocus={() => setDraft(displayTime(props.value))}
      onValueChange={(text) => {
        setDraft(text);
        props.onValueChange(readTime(text));
      }}
      onBlur={() => {
        setDraft(undefined);
        props.onBlur();
      }}
      aria-invalid={props["aria-invalid"]}
      aria-describedby={props["aria-describedby"]}
      placeholder="9:00 AM"
      className="tabular-nums"
    />
  );
}
