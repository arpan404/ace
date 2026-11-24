import { useNow } from "@/lib/time.ts";
import { SettingCard } from "@/components/setting-row.tsx";
import { part } from "@/lib/suit-part.ts";
import { RoutineLine } from "./spade-routines.tsx";
import { useSpadeRoutines } from "./use-spade-routines.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** Activity's Routines: one compact row each, its name and when it runs; none when it has none. */
export function ProfileRoutineRows(props: { bot: RosterBot }) {
  const routines = useSpadeRoutines(props.bot.id).routines.data ?? [];
  const now = useNow();
  if (routines.length === 0) return null;
  return (
    <section aria-label="Routines">
      <div className="mx-1 mb-1.5 flex min-h-6 items-center">
        <h3 className="text-ui text-muted-foreground">Routines</h3>
      </div>
      <SettingCard>
        {routines.map((routine) => (
          <div
            key={routine.id}
            data-setting-slot=""
            {...part("list-row", undefined, "routine")}
            className="flex min-h-11 flex-col justify-center py-1.5"
          >
            <span className="truncate text-ui font-medium text-foreground">{routine.name}</span>
            <span className="truncate text-xs text-subtle-foreground">
              <RoutineLine routine={routine} now={now} />
            </span>
          </div>
        ))}
      </SettingCard>
    </section>
  );
}
