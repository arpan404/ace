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
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { readTemplates } from "./spade-teams-api.ts";
import type { SpadeHost } from "./use-spade-roster.ts";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";

/* What a new bot's conversation (`NewBotStart`) shows under its name: its line and templates. */

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
        none={props.newBotModel ? undefined : "Your first usable model"}
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
 * The templates to start from, as the list's rows: face, name and what it does. Picking one
 * names the bot and gives it the template's face and task; picking it again lets it go.
 */
export function TemplateRows(props: {
  client: ClientApi;
  machineKey: string;
  value: string | undefined;
  onChange(template: SpadeTemplate | undefined): void;
}) {
  const openMarket = useOpenMarket();
  const client = props.client;
  const marketplace = useBetaEnabled("marketplace") === true;
  const templates = useQuery({
    queryKey: ["spade", "templates", props.machineKey],
    queryFn: ({ signal }) => readTemplates(client, { signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!templates.data?.length) return null;
  return (
    <section aria-labelledby="new-bot-templates" className="mt-7 flex flex-col">
      <h2 id="new-bot-templates" className="mb-1.5 px-3 text-xs font-medium text-muted-foreground">
        Start from
      </h2>
      <ul className="flex flex-col gap-0.5">
        {templates.data.map((template) => {
          const picked = props.value === template.id;
          return (
            <li key={template.id}>
              <button
                type="button"
                aria-pressed={picked}
                onClick={() => props.onChange(picked ? undefined : template)}
                className={cn(
                  "flex h-(--spade-list-row) w-full min-w-0 items-center gap-3 rounded-xl px-3 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover",
                  picked && "bg-active hover:bg-active",
                )}
              >
                <BotFace face={template.face} size={40} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-ui font-medium text-foreground">
                    {template.name}
                  </span>
                  {template.blurb && (
                    <span className="truncate text-ui text-muted-foreground">{template.blurb}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {marketplace && (
        <button
          type="button"
          onClick={() => openMarket("bots")}
          {...part("link")}
          className="mt-2 self-start rounded-sm px-3 text-ui text-foreground hover:underline focus-ring"
        >
          From the marketplace
        </button>
      )}
    </section>
  );
}
