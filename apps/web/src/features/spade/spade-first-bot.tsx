import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BotFace } from "@/components/bot-face.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";
import { useOpenMarket } from "@/lib/open-market.ts";
import { readTemplates } from "./spade-teams-api.ts";
import type { SpadeHost } from "./use-spade-roster.ts";

/*
 * The list before the person has any bot (docs/design/spade.md §5): under Spade's own row, one
 * inviting start instead of a blank panel. One primary action, New bot, which starts a bot from
 * one message; the machine's templates by their faces, each one press from a bot of that kind;
 * and From the marketplace when that is on. It leaves as soon as there is a bot or a club.
 */
export function FirstBotStart(props: { host: SpadeHost | undefined; onNewBot(): void }) {
  const navigate = useNavigate();
  const openMarket = useOpenMarket();
  const marketplace = useBetaEnabled("marketplace") === true;
  const client = props.host?.machine.client;
  const templates = useQuery({
    queryKey: ["spade", "templates", props.host?.spade.key ?? "none"],
    queryFn: ({ signal }) =>
      client ? readTemplates(client, { signal }) : Promise.reject(new Error("offline")),
    enabled: client !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <section aria-label="Your first bot" className="mt-6 flex flex-col px-2.5">
      <h2 className="text-base font-semibold text-foreground">Make your first bot</h2>
      <p className="mt-1 text-ui text-muted-foreground">
        A bot does one job for you on its own, and asks when it needs you.
      </p>
      <Button
        variant="primary"
        className="mt-4 h-(--spade-pill-button) rounded-full"
        disabled={!props.host}
        onClick={props.onNewBot}
      >
        New bot
      </Button>
      {templates.data && templates.data.length > 0 && (
        <>
          <h3 className="mt-6 mb-1 text-xs font-medium text-subtle-foreground">Or start from</h3>
          <ul aria-label="Templates" className="-mx-1 flex flex-col">
            {templates.data.map((template) => (
              <li key={template.id}>
                <button
                  type="button"
                  onClick={() =>
                    void navigate({ to: "/spade/new", search: { template: template.id } })
                  }
                  className="flex w-full min-w-0 items-center gap-3 rounded-lg px-1.5 py-2 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover"
                >
                  <BotFace face={template.face} size={32} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-ui text-foreground">{template.name}</span>
                    {template.blurb && (
                      <span className="truncate text-xs text-muted-foreground">
                        {template.blurb}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {marketplace && (
        <button
          type="button"
          onClick={() => openMarket("bots")}
          className="mt-3 self-start rounded-sm px-0.5 text-ui text-muted-foreground focus-ring hover:text-foreground"
        >
          Get one from the marketplace
        </button>
      )}
    </section>
  );
}
