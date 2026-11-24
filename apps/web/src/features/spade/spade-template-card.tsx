import { useQuery } from "@tanstack/react-query";
import {
  ShareTemplateDetails,
  ShareTemplateReview,
  type MarketVisibility,
} from "@ace/protocol/marketplace";
import {
  parseSpadeAvatar,
  type SpadeAvatar,
  type SpadeCardRow,
  type SpadeAgentStyle,
} from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { market, marketShareUrl, usePersonGrant } from "@/features/marketplace/index.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { spadeHttp } from "./spade-requests.ts";
import { useCardAccent } from "./spade-accent.ts";
import { SpadeFace } from "./spade-face.tsx";
import { TemplateDetailsSheet } from "./spade-template-details.tsx";

export function SpadeTemplateCard(props: {
  item: SpadeCardRow;
  avatar: SpadeAvatar;
  style?: SpadeAgentStyle | undefined;
}) {
  const client = useSpadeClient();
  const personGrant = usePersonGrant();
  const machine = useSpadeMachine();
  const { cardId: id, card } = props.item;
  return (
    <TemplateCard
      {...props}
      scope={machine.key}
      read={async (signal) =>
        ShareTemplateDetails.parse(
          JSON.parse(
            await spadeHttp(client, "GET", `/v1/share-templates/${encodeURIComponent(id)}`, {
              signal,
            }),
          ),
        )
      }
      publish={async (review) => {
        await market(
          client,
          { op: "publishTemplate", id, review },
          "publishedTemplate",
          undefined,
          personGrant,
        );
      }}
      live={async (signal, shareId) => {
        const { entry } = await market(
          client,
          shareId
            ? { op: "readShare", id: shareId }
            : {
                op: "read",
                source: "market",
                type: "spade-bot",
                name: id.replaceAll("_", "-"),
              },
          "read",
          signal,
        );
        return entry.versions.some(({ version }) => version === "1.0.0");
      }}
      title={card.title}
    />
  );
}

export function TemplateCard(props: {
  item: SpadeCardRow;
  title: string;
  scope: string;
  avatar: SpadeAvatar;
  style?: SpadeAgentStyle | undefined;
  read(signal: AbortSignal): Promise<ShareTemplateDetails>;
  publish(review: ShareTemplateReview): Promise<void>;
  live(signal: AbortSignal, shareId?: string): Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState<MarketVisibility>("listed");
  const details = useQuery({
    queryKey: ["spade-share-template", props.scope, props.item.cardId],
    queryFn: ({ signal }) => props.read(signal),
    retry: false,
  });
  const visibility = details.data?.visibility;
  const shareId = details.data?.shareId ?? undefined;
  const ongoing = useQuery({
    queryKey: ["spade-share-template-live", props.scope, props.item.cardId, shareId],
    queryFn: ({ signal }) => props.live(signal, shareId),
    enabled: visibility === "listed" || shareId !== undefined,
    retry: false,
    refetchInterval: (query) => (query.state.data === true ? false : 30_000),
  });
  const recipe = details.data?.draft.recipe;
  const avatar = recipe ? parseSpadeAvatar(recipe.face, props.item.cardId) : props.avatar;
  const storedStyle = recipe?.style ? { accent: recipe.style.accent, chosen: false } : undefined;
  const accent = useCardAccent({ avatar, style: recipe ? storedStyle : props.style });
  const description = props.item.card.blocks.find((block) => block.kind === "fields")?.rows[0]
    ?.value;
  const count = (n: number, singular: string, plural = `${singular}s`) =>
    n ? `${n} ${n === 1 ? singular : plural}` : "";
  const summary = recipe
    ? [
        count(recipe.skills.length, "skill"),
        count(recipe.knowledge?.filter(({ kind }) => kind === "playbook").length ?? 0, "playbook"),
        count(recipe.knowledge?.filter(({ kind }) => kind === "lesson").length ?? 0, "lesson"),
        count(
          recipe.triggers.filter(({ kind }) => kind !== "message").length +
            (recipe.heartbeat ? 1 : 0),
          "routine",
        ),
        ...[
          ...recipe.needs.connectors.map(({ id }) => id),
          ...(recipe.plugins ?? []).map((id) => id.split("/").at(-1)),
        ]
          .filter(Boolean)
          .map((id) => `needs ${id}`),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const status =
    visibility == null
      ? "Unpublished"
      : !ongoing.data
        ? "Awaiting Store review"
        : visibility === "unlisted"
          ? "Shared by link"
          : "Published";
  const link = shareId
    ? marketShareUrl(shareId)
    : `https://app.acehq.dev/store?at=bot/${props.item.cardId.replaceAll("_", "-")}`;
  function review(next: MarketVisibility) {
    setDestination(next);
    setOpen(true);
  }
  return (
    <section
      aria-label="Bot template"
      data-part="card"
      data-variant="spade-agent"
      className="flex w-full max-w-sm flex-col gap-3 rounded-(--chat-bubble-radius) bg-chat-bubble px-(--chat-bubble-x) py-4 wrap-anywhere"
      style={accent}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-base font-medium text-foreground">{recipe?.name ?? props.title}</h3>
        <span className="rounded-full bg-chat-well px-2 py-1 text-xs text-muted-foreground">
          {status}
        </span>
      </header>
      <div className="grid aspect-2/1 place-items-center rounded-md bg-[color-mix(in_srgb,var(--agent-accent-light)_22%,var(--color-chat-bubble))] dark:bg-[color-mix(in_srgb,var(--agent-accent-dark)_22%,var(--color-chat-bubble))]">
        <SpadeFace avatar={avatar} size={64} />
      </div>
      <p className="text-ui text-muted-foreground">{recipe?.blurb ?? description}</p>
      {summary && <p className="text-xs text-muted-foreground">{summary}</p>}
      {recipe && recipe.skills.length > 0 && (
        <ul aria-label="Skills" className="flex flex-wrap gap-1">
          {recipe.skills.map((skill) => (
            <li key={skill} className="rounded-full bg-chat-well px-2 py-1 text-xs">
              {skill.split("/").at(-1)}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {details.data && visibility == null && (
          <>
            <Button size="sm" variant="primary" onClick={() => review("listed")}>
              Publish
            </Button>
            <Button size="sm" variant="secondary" onClick={() => review("unlisted")}>
              Share link
            </Button>
          </>
        )}
        {ongoing.data && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void navigator.clipboard.writeText(link)}
          >
            Copy link
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          View Details
        </Button>
      </div>
      {open && (
        <TemplateDetailsSheet
          details={details.data}
          error={details.error?.message}
          destination={destination}
          setDestination={setDestination}
          close={() => setOpen(false)}
          publish={async (review) => {
            await props.publish(ShareTemplateReview.parse(review));
            await details.refetch();
          }}
        />
      )}
      {ongoing.data && visibility === "unlisted" && (
        <a className={cn("text-xs break-all text-muted-foreground underline")} href={link}>
          {link}
        </a>
      )}
    </section>
  );
}
