import { useId } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import type { DesktopCategory, DesktopQuietHours } from "@/boot/desktop-settings.ts";
import { useDesktopPreferences } from "./data/desktop-preferences.ts";

const defaultQuietHours: DesktopQuietHours = { start: 22 * 60, end: 8 * 60 };

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
function minutesOf(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/**
 * Which notifications this computer shows, and when. The desktop app owns and applies these;
 * a phone keeps its own. In a browser there is nothing here to configure.
 */
export function NotificationSettings() {
  const desktop = useDesktopPreferences();
  if (!desktop.available)
    return (
      <section className="mt-7" aria-label="Notifications">
        <p className="max-w-[60ch] text-ui leading-normal text-muted-foreground">
          Notifications on a computer are set in the ace desktop app, and a phone keeps its own. In
          this browser, choose which changes show a toast from Activity.
        </p>
      </section>
    );
  if (!desktop.value) return null;
  return (
    <section className="mt-7" aria-label="Notifications">
      <CategorySwitch
        category="needsYou"
        title="Needs you"
        description="Approvals, questions and escalations."
      />
      <CategorySwitch
        category="finished"
        title="Thread done"
        description="When a thread settles with no open items."
      />
      <CategorySwitch category="failed" title="Failures and unresponsive agents" />
      <QuietHoursRow />
    </section>
  );
}

function CategorySwitch(props: { category: DesktopCategory; title: string; description?: string }) {
  const id = useId();
  const { value, update } = useDesktopPreferences();
  if (!value) return null;
  const notifications = value.notifications;
  return (
    <SettingRow title={props.title} description={props.description} htmlFor={id}>
      <Switch
        id={id}
        // The desktop shows a category unless it is switched off.
        checked={notifications.categories[props.category] !== false}
        onCheckedChange={(on) =>
          void update({
            notifications: {
              ...notifications,
              categories: { ...notifications.categories, [props.category]: on },
            },
          })
        }
      />
    </SettingRow>
  );
}

function QuietHoursRow() {
  const id = useId();
  const { value, update } = useDesktopPreferences();
  if (!value) return null;
  const notifications = value.notifications;
  const quiet = notifications.quietHours;
  const save = (quietHours: DesktopQuietHours | null) =>
    void update({ notifications: { ...notifications, quietHours } });
  const change = (edge: "start" | "end", text: string) => {
    const minutes = minutesOf(text);
    if (!quiet || minutes === undefined) return;
    const next = { ...quiet, [edge]: minutes };
    // An empty window means nothing; the stored one stays.
    if (next.start !== next.end) save(next);
  };
  return (
    <SettingRow
      title="Quiet hours"
      htmlFor={id}
      description={
        quiet
          ? `${clock(quiet.start)} to ${clock(quiet.end)}. This computer stays silent; a phone keeps its own quiet hours.`
          : "Silence notifications on this computer overnight."
      }
    >
      {quiet && (
        <>
          <Input
            type="time"
            aria-label="Quiet hours start"
            value={clock(quiet.start)}
            onChange={(event) => change("start", event.target.value)}
            className="h-7 w-[92px] font-mono text-[12px]"
          />
          <span className="text-sm text-subtle-foreground">to</span>
          <Input
            type="time"
            aria-label="Quiet hours end"
            value={clock(quiet.end)}
            onChange={(event) => change("end", event.target.value)}
            className="h-7 w-[92px] font-mono text-[12px]"
          />
        </>
      )}
      <Switch
        id={id}
        checked={quiet !== null}
        onCheckedChange={(on) => save(on ? defaultQuietHours : null)}
      />
    </SettingRow>
  );
}
