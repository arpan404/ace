import { spadeUsedSurfaces, type SpadeAvatar } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import type { ConversationFollow } from "../conversation-follow.ts";
import { SpadeActivity } from "../spade-activity.tsx";
import { SpadeFace } from "../spade-face.tsx";
import { useSpadeClient, useSpadeMachine } from "../spade-machine.tsx";
import { ProfileSection } from "../spade-profile-parts.tsx";
import type { RosterBot } from "../use-spade-roster.ts";
import { BotServices, servicesKey } from "./bot-services.tsx";
import { BotTerminal } from "./bot-terminal.tsx";
import { DriveLine } from "./drive-line.tsx";
import { FileManager } from "./file-manager.tsx";
import { readServices } from "./services-api.ts";
import { computerViewNames, computerViews, type ComputerView } from "./panel-place.ts";
import { SurfacePicture } from "./surface-picture.tsx";
import type { BotComputerState } from "./use-bot-computer.ts";

/** Where the file manager is: a folder, and a file in it open. */
export interface FilesAt {
  folder: string;
  file?: string | undefined;
}

/** What Computer shows and where its file manager is, as the route says. */
export interface ProfileComputerPlace {
  view: ComputerView | undefined;
  files: FilesAt;
  onView(view: ComputerView, files?: FilesAt): void;
  state: BotComputerState;
  side: Pick<ConversationFollow, "onSide" | "onEnded"> | undefined;
}

/** "Github watcher's", "Flights'". */
const whose = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/**
 * Computer: what the bot drives, at the profile's size. A switcher of only the surfaces it has
 * used (Spade's `used`), the ones it uses now marked live, then Activity; the browser or screen
 * live in its frame with a caption ("Github watcher's browser"), its terminal, its files, the
 * services it keeps running (once it started one), or what it did in Spade's words. While its computer starts, its small face and "Waking up…". Who drives
 * shows under the surface only while someone does, with Take over or Hand back. Never used: one
 * line, then what it did.
 */
export function ProfileComputer(props: { bot: RosterBot; place: ProfileComputerPlace }) {
  const { bot, place } = props;
  const { state } = place;
  const computer = state.computer;
  // What it used, and the surface a link asked for (terminal and files are always there), so
  // the view never jumps away under the person.
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const services = useQuery({
    queryKey: [...servicesKey, machine, bot.id],
    queryFn: ({ signal }) => readServices(client, bot.id, signal),
    refetchInterval: place.view === "services" ? 5_000 : 30_000,
  });
  const runsServices = (services.data?.length ?? 0) > 0;
  const asked =
    place.view !== undefined && place.view !== "activity" && place.view !== "services"
      ? place.view
      : undefined;
  const used: ComputerView[] = spadeUsedSurfaces(computer);
  if (asked && !used.includes(asked)) used.push(asked);
  // Services once it started one, or while a link asks for them.
  if (runsServices || place.view === "services") used.push("services");
  used.sort((a, b) => computerViews.indexOf(a) - computerViews.indexOf(b));
  const waking = computer?.state === "starting";
  const views: ComputerView[] = [...used, "activity"];
  // Used lately, as Spade says: what the tab opens on. In use now only while the bot is at work.
  const recent = (kind: ComputerView) =>
    computer?.surfaces.some((each) => each.kind === kind && each.live) === true;
  const live = (kind: ComputerView) => state.atWork && recent(kind);
  const fallback =
    used.find((kind) => recent(kind)) ?? used.find((kind) => kind !== "services") ?? "activity";
  const view = place.view && views.includes(place.view) ? place.view : fallback;
  if (used.length === 0)
    return (
      <>
        {waking ? (
          <Waking bot={bot} caption={`${whose(bot.name)} screen`} />
        ) : (
          <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
            <SpadeFace avatar={bot.avatar} size={56} state="idle" />
            <p className="text-ui text-muted-foreground">{`${bot.name} hasn't used its computer yet.`}</p>
          </div>
        )}
        <ProfileSection label="Activity" bare>
          <SpadeActivity bot={bot} />
        </ProfileSection>
      </>
    );
  const surface = computer?.surfaces.find((each) => each.kind === view);
  const words =
    view === "activity" || view === "services" ? "" : computerViewNames[view].toLowerCase();
  // Starting a surface it never had: the frame it will show in heads the tab until it does.
  const wakingNew = waking && !used.includes("browser") && !used.includes("screen");
  return (
    <>
      {wakingNew && (
        <div className="mb-4">
          <Waking bot={bot} caption={`${whose(bot.name)} screen`} />
        </div>
      )}
      <div
        role="tablist"
        aria-label="Computer"
        {...part("tabs", undefined, "computer")}
        className="no-scrollbar mb-3 flex gap-0.5 overflow-x-auto"
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          const at = views.indexOf(view);
          const step = event.key === "ArrowRight" ? 1 : -1;
          const next = views[(at + step + views.length) % views.length];
          if (!next) return;
          event.preventDefault();
          place.onView(next);
          event.currentTarget.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus();
        }}
      >
        {views.map((kind) => {
          const selected = kind === view;
          return (
            <button
              key={kind}
              type="button"
              role="tab"
              data-view={kind}
              aria-selected={selected}
              {...part("tab", selected && "selected", kind)}
              tabIndex={selected ? 0 : -1}
              onClick={() => place.onView(kind)}
              className={cn(
                "flex h-[30px] shrink-0 items-center gap-1.5 rounded-full px-3 text-ui whitespace-nowrap transition-colors duration-(--motion-fast) focus-ring",
                selected
                  ? "bg-active font-medium text-foreground"
                  : "text-subtle-foreground hover:bg-hover hover:text-foreground",
              )}
            >
              {live(kind) && kind !== "files" && (
                <span aria-hidden className="size-1.5 rounded-full bg-status-working" />
              )}
              {computerViewNames[kind]}
              {live(kind) && kind !== "files" && <span className="sr-only">, in use</span>}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={computerViewNames[view]}>
        {view === "browser" || view === "screen" ? (
          waking && !surface?.live ? (
            <Waking bot={bot} caption={`${whose(bot.name)} ${words}`} />
          ) : (
            <>
              <SurfacePicture
                machine={bot.machine}
                bot={bot}
                kind={view}
                surface={surface}
                threadId={computer?.threadId}
                mayAct={state.mayAct}
                driving={state.driving}
                label={`${whose(bot.name)} ${words}`}
              />
              <p className="mx-1 mt-2.5 text-ui text-muted-foreground">{`${whose(bot.name)} ${words}`}</p>
              <DriveLine bot={bot} state={state} what={words} />
            </>
          )
        ) : view === "terminal" ? (
          <>
            {surface?.endingStuck && (
              <p role="status" className="mx-1 mb-2 text-ui text-muted-foreground">
                Still ending the last command
              </p>
            )}
            <div className="h-80 overflow-hidden rounded-xl bg-chat-well shadow-[inset_0_0_0_1px_var(--border-soft)]">
              <BotTerminal bot={bot} mayType={state.mayAct} />
            </div>
            <DriveLine bot={bot} state={state} what="terminal" />
          </>
        ) : view === "files" ? (
          <div className="-mx-4">
            <FileManager
              bot={bot}
              folder={place.files.folder}
              file={place.files.file}
              onOpen={(to) => place.onView("files", to)}
              side={place.side}
              writable={state.mayAct}
            />
            <div className="px-4">
              <DriveLine bot={bot} state={state} what="computer" />
            </div>
          </div>
        ) : view === "services" ? (
          <BotServices bot={bot} services={services} />
        ) : (
          <SpadeActivity bot={bot} />
        )}
      </div>
    </>
  );
}

/** The frame while the computer starts: the bot's small face and "Waking up…". */
function Waking(props: { bot: { avatar: SpadeAvatar }; caption: string }) {
  return (
    <div>
      <div
        role="status"
        className="grid aspect-[16/10] place-content-center justify-items-center gap-2.5 rounded-xl bg-code text-ui text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]"
      >
        <SpadeFace avatar={props.bot.avatar} size={40} state="acknowledge" />
        Waking up…
      </div>
      <p className="mx-1 mt-2.5 text-ui text-muted-foreground">{props.caption}</p>
    </div>
  );
}
