import { NotificationPreferences } from "@/features/activity/index.ts";
import { lazy, Suspense } from "react";
import { useId } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import type { DesktopCategory, DesktopQuietHours } from "@/boot/desktop-settings.ts";
import { useDesktopPreferences } from "./data/desktop-preferences.ts";
import { settingRow } from "./settings-index.ts";

const defaultQuietHours: DesktopQuietHours = { start: 22 * 60, end: 8 * 60 };

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Every quarter hour of the day, 24-hour: unambiguous in every locale, nothing clipped. */
const quarterHours: SelectOption<string>[] = Array.from({ length: 96 }, (_, index) => {
  const label = clock(index * 15);
  return { value: String(index * 15), label };
});

const BrowserPushSettings = lazy(() => import("./browser-push-settings.tsx"));
export function NotificationSettings() {
  const desktop = useDesktopPreferences();
  return (
    <>
      <SettingSection label="While ace is open" scope="device">
        <NotificationPreferences />
      </SettingSection>
      {desktop.available ? (
        desktop.value && (
          <SettingSection label={settingRow("notifications.system").title} scope="computer">
            <CategorySwitch
              category="needsYou"
              title="Needs you"
              description="Approvals, questions and escalations."
            />
            <CategorySwitch
              category="failed"
              title="Failures"
              description="Failed runs and unresponsive agents."
            />
            <CategorySwitch
              category="finished"
              title="Thread done"
              description="When a thread settles with no open items."
            />
            <CategorySwitch
              category="agentSays"
              title="Agent messages"
              description="Messages an agent asks ace to tell you about."
            />
            <QuietHoursRow />
          </SettingSection>
        )
      ) : (
        <Suspense fallback={null}>
          <BrowserPushSettings />
        </Suspense>
      )}
    </>
  );
}

function CategorySwitch(props: { category: DesktopCategory; title: string; description?: string }) {
  const id = useId();
  const { value, update } = useDesktopPreferences();
  if (!value) return null;
  const notifications = value.notifications;
  return (
    <SettingRow
      density="compact"
      title={props.title}
      description={props.description}
      htmlFor={id}
      inline
    >
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
  const change = (edge: "start" | "end", minutes: number) => {
    if (!quiet) return;
    const next = { ...quiet, [edge]: minutes };
    // An empty window means nothing; the stored one stays.
    if (next.start !== next.end) save(next);
  };
  const row = settingRow("notifications.quietHours");
  return (
    <SettingRow
      {...row}
      htmlFor={id}
      description={
        quiet
          ? `${clock(quiet.start)} to ${clock(quiet.end)}. This computer stays silent; a phone keeps its own quiet hours.`
          : "Silence notifications on this computer overnight."
      }
    >
      <span className="flex items-center justify-end gap-2">
        {quiet && (
          <>
            <Select
              label="Quiet hours start"
              className="min-w-0 tabular-nums"
              value={String(quiet.start - (quiet.start % 15))}
              options={quarterHours}
              onValueChange={(next) => change("start", Number(next))}
            />
            <span className="text-sm text-muted-foreground">to</span>
            <Select
              label="Quiet hours end"
              className="min-w-0 tabular-nums"
              value={String(quiet.end - (quiet.end % 15))}
              options={quarterHours}
              onValueChange={(next) => change("end", Number(next))}
            />
          </>
        )}
        <Switch
          id={id}
          checked={quiet !== null}
          onCheckedChange={(on) => save(on ? defaultQuietHours : null)}
        />
      </span>
    </SettingRow>
  );
}
