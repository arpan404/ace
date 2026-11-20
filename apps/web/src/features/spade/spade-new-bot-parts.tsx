import type { ClientApi } from "@ace/client";
import type { SpadeTemplate } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useOpenMarket } from "@/lib/open-market.ts";
import { BotFace } from "@/components/bot-face.tsx";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { firstUsableWords } from "./spade-model-options.ts";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { readTemplates } from "./spade-teams-api.ts";
import type { SpadeHost } from "./use-spade-roster.ts";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";

/* What a new bot's start (`NewBotStart`) shows: its settings line and the templates' chips. */

/** The quiet line's controls: words that brighten under the pointer, no box until hovered. */
const quiet =
  "-mx-0.5 flex h-6 max-w-full min-w-0 items-center rounded-md px-1.5 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground data-popup-open:bg-hover data-popup-open:text-foreground";

/**
 * The one quiet line under a new bot's name: its model and machine, each opening its own choice
 * where it shows. A single machine is said, not offered.
 */
export function RunsWith(props: {
  hosts: readonly SpadeHost[];
  host: SpadeHost;
  name: string;
  /** "": the model for new bots. */
  model: string;
  newBotModel: string | undefined;
  /** The model a new bot gets when nobody chose one: named, never "the first usable model". */
  firstUsable: string | undefined;
  onModel(model: string): void;
  onMachine(host: SpadeHost): void;
}) {
  const machineName = props.host.machine.primary ? "This machine" : props.host.machine.name;
  const dot = (
    <span aria-hidden className="text-subtle-foreground">
      ·
    </span>
  );
  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center justify-center gap-x-1">
      <SpadeModelPicker
        label="Model"
        value={props.model || props.newBotModel || ""}
        none={props.newBotModel ? undefined : firstUsableWords(props.firstUsable)}
        follows={props.newBotModel ? undefined : props.firstUsable}
        onChange={(next) => props.onModel(next === props.newBotModel ? "" : next)}
        // The words alone: no box, source or caret on the quiet line.
        className={cn(
          quiet,
          "w-auto max-w-64 justify-start gap-0 bg-transparent pr-1.5 pl-1.5 @max-[440px]:w-auto [&>span>span]:hidden [&>svg]:hidden",
        )}
      />
      {dot}
      {props.hosts.length > 1 ? (
        <Menu>
          <MenuTrigger aria-label={`Machine: ${machineName}`} className={quiet}>
            <span className="truncate">{machineName}</span>
          </MenuTrigger>
          <MenuContent align="center">
            <MenuRadioGroup
              value={props.host.spade.key}
              onValueChange={(next: unknown) => {
                const picked = props.hosts.find((each) => each.spade.key === next);
                if (picked) props.onMachine(picked);
              }}
            >
              {props.hosts.map((each) => (
                <MenuRadioItem key={each.spade.key} value={each.spade.key}>
                  {each.machine.primary ? "This machine" : each.machine.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      ) : (
        <span className="px-1 text-ui text-muted-foreground">{machineName}</span>
      )}
    </div>
  );
}

/**
 * Under the new bot's composer: the templates as chips, each its face and name, one press to
 * start from it (again to let it go), From the marketplace when that is on, and More settings,
 * which shows the model and machine on the page. A personality step joins More settings once the
 * person's personality settings ship.
 */
export function StartChips(props: {
  client: ClientApi;
  machineKey: string;
  value: string | undefined;
  onChange(template: SpadeTemplate | undefined): void;
  more: boolean;
  onMore(): void;
}) {
  const openMarket = useOpenMarket();
  const client = props.client;
  const marketplace = useBetaEnabled("marketplace") === true;
  const templates = useQuery({
    queryKey: ["spade", "templates", props.machineKey],
    queryFn: ({ signal }) => readTemplates(client, { signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const word =
    "h-8 rounded-full px-3 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground";
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 px-1">
      {templates.data && templates.data.length > 0 && (
        <ul aria-label="Start from" className="contents">
          {templates.data.map((template) => {
            const picked = props.value === template.id;
            return (
              <li key={template.id} className="contents">
                <button
                  type="button"
                  aria-pressed={picked}
                  title={template.blurb || undefined}
                  onClick={() => props.onChange(picked ? undefined : template)}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-full bg-secondary pr-3 pl-1.5 text-ui text-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover",
                    picked && "bg-active hover:bg-active",
                  )}
                >
                  <BotFace face={template.face} size={20} />
                  {template.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {marketplace && (
        <button
          type="button"
          onClick={() => openMarket("bots")}
          {...part("link")}
          className={word}
        >
          From the marketplace
        </button>
      )}
      <button type="button" aria-expanded={props.more} onClick={props.onMore} className={word}>
        {props.more ? "Fewer settings" : "More settings"}
      </button>
    </div>
  );
}
