import { useThreadMeta } from "@ace/client-react";
import {
  currentModelChoice,
  limitDestinations,
  threadSwitchRoute,
  type LimitDestination,
} from "@ace/ui-core";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { useModelChoices } from "@/features/models/index.ts";
import { useThreadModelAvailability } from "../lib/model-availability.ts";
import type { CarryTarget } from "./use-carry-on.ts";

const textButton =
  "h-7 shrink-0 rounded-md px-2 font-medium text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground focus-ring disabled:opacity-50";

/** The places with room for this thread's held work, best first. */
function useDestinations(threadId: string): LimitDestination[] {
  const meta = useThreadMeta(threadId);
  const choices = useModelChoices();
  const { selection } = useThreadModelAvailability(threadId);
  const current = currentModelChoice(choices, selection);
  if (!meta || !selection) return [];
  return limitDestinations(
    choices,
    {
      provider: selection.provider,
      accountId: current?.accountId ?? selection.instanceId ?? "",
      key: current?.key,
    },
    // Only moves the thread can make in place; a new-thread route belongs to the full picker.
    (choice) => threadSwitchRoute(meta, choice) === "in_place",
  );
}

/**
 * The limit strip's Switch: the accounts and providers with room, each with the model it carries
 * on with and how much is left. Picking one carries the held work on there at once (another
 * provider gets the conversation as context). Other models opens the full picker.
 */
export function LimitSwitchMenu(props: {
  threadId: string;
  disabled: boolean;
  onPick(target: CarryTarget): void;
  onOtherModels(): void;
}) {
  const [open, setOpen] = useState(false);
  const destinations = useDestinations(props.threadId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={props.disabled} className={textButton}>
        Switch
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        aria-label="Continue somewhere with room"
        className="w-80 p-1 text-xs"
      >
        {destinations.length ? (
          <ul aria-label="Accounts with room">
            {destinations.map((destination) => (
              <li key={destination.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    props.onPick({
                      name: destination.name,
                      model: destination.model,
                      selection: destination.action.selection,
                    });
                  }}
                  className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-(--motion-fast) hover:bg-accent focus-ring-inset"
                >
                  <span className="flex h-5 shrink-0 items-center">
                    <ProviderAccountIcon
                      provider={destination.provider}
                      instance={destination.accountId || undefined}
                      size={14}
                      decorative
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                        {destination.name}
                      </span>
                      {destination.left && (
                        <span className="shrink-0 text-muted-foreground tabular-nums">
                          {destination.left}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-muted-foreground">
                      {destination.model}
                      {destination.handsOver ? " · context handoff" : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2 py-1.5 text-muted-foreground">No other account has room right now.</p>
        )}
        <div className="mt-1 flex justify-end border-t border-border pt-1">
          <button
            type="button"
            className={textButton}
            onClick={() => {
              setOpen(false);
              props.onOtherModels();
            }}
          >
            Other models
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
