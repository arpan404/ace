import type { ClientApi } from "@ace/client";
import { spadeTemplateRoutinesLine, type SpadeTemplate } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useOpenMarket } from "@/lib/open-market.ts";
import { PlusIcon, StorefrontIcon } from "@ace/icons";
import { BotFace } from "@/components/bot-face.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { firstUsableWords } from "./spade-model-options.ts";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { readTemplates } from "./spade-teams-api.ts";
import type { SpadeHost } from "./use-spade-roster.ts";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";

/* What a new bot's start (`NewBotStart`) shows at its top: where it starts from and how it runs. */

/** The quiet line's controls: words that brighten under the pointer, no box until hovered. */
const quiet =
  "-mx-0.5 flex h-6 max-w-full min-w-0 items-center rounded-md px-1.5 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground data-popup-open:bg-hover data-popup-open:text-foreground";

/**
 * How a new bot runs, as rows at the top of its page: its model, and its machine when there is
 * more than one to choose from (a single machine is said, not offered).
 */
export function RunsWithRows(props: {
  hosts: readonly SpadeHost[];
  host: SpadeHost;
  /** "": the model for new bots. */
  model: string;
  newBotModel: string | undefined;
  firstUsable: string | undefined;
  onModel(model: string): void;
  onMachine(host: SpadeHost): void;
}) {
  const machineName = props.host.machine.primary ? "This machine" : props.host.machine.name;
  return (
    <>
      <SettingRow title="Model" density="compact" inline>
        <SpadeModelPicker
          label="Model"
          subscriptions
          value={props.model || props.newBotModel || ""}
          none={props.newBotModel ? undefined : firstUsableWords(props.firstUsable)}
          follows={props.newBotModel ? undefined : props.firstUsable}
          onChange={(next) => props.onModel(next === props.newBotModel ? "" : next)}
        />
      </SettingRow>
      <SettingRow title="Machine" density="compact" inline>
        {props.hosts.length > 1 ? (
          <Menu>
            <MenuTrigger aria-label={`Machine: ${machineName}`} className={quiet}>
              <span className="truncate">{machineName}</span>
            </MenuTrigger>
            <MenuContent align="end">
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
          <span className="text-ui text-muted-foreground">{machineName}</span>
        )}
      </SettingRow>
    </>
  );
}

/** A start choice: its face over its name, filled while it is the one picked. */
const tile = (picked: boolean) =>
  cn(
    "flex w-24 shrink-0 flex-col items-center gap-2 rounded-xl px-1 pt-3 pb-2.5 text-center text-ui transition-colors duration-(--motion-fast) focus-ring hover:bg-hover",
    picked ? "bg-active text-foreground hover:bg-active" : "text-muted-foreground",
  );

/**
 * The top of a new bot's page: where it starts from, as one row of choices, each a face and a
 * name (Blank first, the machine's templates, then From the marketplace when that is on). One
 * press picks a template; Blank or a second press lets it go.
 */
export function StartFrom(props: {
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
  return (
    <ul aria-label="Start from" className="flex gap-1 overflow-x-auto pb-1">
      <li>
        <button
          type="button"
          aria-pressed={props.value === undefined}
          onClick={() => props.onChange(undefined)}
          className={tile(props.value === undefined)}
        >
          <span
            aria-hidden
            className="grid size-11 place-items-center rounded-full bg-hover text-muted-foreground"
          >
            <PlusIcon size={20} />
          </span>
          Your own
        </button>
      </li>
      {templates.data?.map((template) => {
        const picked = props.value === template.id;
        return (
          <li key={template.id}>
            <button
              type="button"
              aria-pressed={picked}
              title={template.blurb || undefined}
              onClick={() => props.onChange(picked ? undefined : template)}
              className={tile(picked)}
            >
              <BotFace face={template.face} size={44} />
              <span className="line-clamp-2">{template.name}</span>
            </button>
          </li>
        );
      })}
      {marketplace && (
        <li>
          <button
            type="button"
            onClick={() => openMarket("bots")}
            {...part("link")}
            className={tile(false)}
          >
            <span
              aria-hidden
              className="grid size-11 place-items-center rounded-full bg-hover text-muted-foreground"
            >
              <StorefrontIcon size={20} />
            </span>
            Marketplace
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * A template's routines as a row with the switch that starts them: on by default, since the
 * person is making this bot from ace's own template. Nothing for a template with no routines.
 */
export function TemplateRoutines(props: {
  template: SpadeTemplate;
  on: boolean;
  onChange(on: boolean): void;
}) {
  const line = spadeTemplateRoutinesLine(props.template.routines);
  if (!line) return null;
  return (
    <SettingRow title="Start its routines" description={line} density="compact" inline>
      <Switch
        aria-label={`Start ${props.template.name}'s routines`}
        checked={props.on}
        onCheckedChange={props.onChange}
      />
    </SettingRow>
  );
}
