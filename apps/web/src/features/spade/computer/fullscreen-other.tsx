import { useQuery } from "@tanstack/react-query";
import { SpadeActivity } from "../spade-activity.tsx";
import { useSpadeClient, useSpadeMachine } from "../spade-machine.tsx";
import type { RosterBot } from "../use-spade-roster.ts";
import { BotServices, servicesKey } from "./bot-services.tsx";
import { FileManager } from "./file-manager.tsx";
import type { ProfileComputerPlace } from "./profile-computer.tsx";
import { readServices } from "./services-api.ts";

/** The views a link can ask for beyond the three surfaces: the files, its services, what it did. */
export type OtherView = "files" | "services" | "activity";
export const otherNames: Record<OtherView, string> = {
  files: "Files",
  services: "Services",
  activity: "Activity",
};
export const isOtherView = (view: string | undefined): view is OtherView =>
  view === "files" || view === "services" || view === "activity";

/** Files, services or the activity log, in the full-screen view's own scrolling column. */
export function OtherPane(props: { bot: RosterBot; view: OtherView; place: ProfileComputerPlace }) {
  const { bot, place } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const services = useQuery({
    queryKey: [...servicesKey, machine, bot.id],
    queryFn: ({ signal }) => readServices(client, bot.id, signal),
    refetchInterval: 5_000,
    enabled: props.view === "services",
  });
  if (props.view === "files") {
    return (
      <div role="tabpanel" aria-label={otherNames.files} className="flex min-h-0 flex-1 flex-col">
        <FileManager
          key={`${bot.machine.key}/${bot.id}`}
          bot={bot}
          folder={place.files.folder}
          file={place.files.file}
          side={place.side}
          writable={place.state.mayAct}
        />
      </div>
    );
  }
  return (
    <div
      role="tabpanel"
      aria-label={otherNames[props.view]}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-3xl px-4 pb-10">
        {props.view === "services" ? (
          <BotServices bot={bot} services={services} />
        ) : (
          <SpadeActivity bot={bot} scope="computer" />
        )}
      </div>
    </div>
  );
}
