import { botFaceStateOf, type BotFaceState } from "@ace/ui-core/bot-face";
import { spadeIsDevelopment, type SpadeAvatar } from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { useMachines } from "@/lib/machines.ts";
import { part } from "@/lib/suit-part.ts";
import { useMarkAccent } from "./spade-accent.ts";
import { GroupFaces } from "./spade-group-faces.tsx";
import { SpadeFace } from "./spade-face.tsx";
import type { SpadeRowState } from "./spade-list-rows.ts";
import { SharedWord } from "./spade-shared-lines.tsx";
import { shownMembers, type RosterGroup } from "./use-spade-groups.ts";
import { useFaceState } from "./use-face-state.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/* Spade's list rows (docs/design/spade.md §2): a face that carries the state, the name, one line. */

/** The dot a face carries: needs you, failed and off only; working is the face moving. */
export type FaceDot = "needs-you" | "failed" | "off";

export const faceDotOf = (state: SpadeRowState): FaceDot | undefined =>
  state === "needs-you" || state === "failed" || state === "off" ? state : undefined;

const dotFill: Record<FaceDot, string> = {
  "needs-you": "bg-face-dot-needs-you",
  failed: "bg-face-dot-failed",
  off: "bg-face-dot-off",
};

/**
 * A face with its status dot on the bottom-right, ringed in what the row shows behind it: the
 * panel, with the row's hover or open wash (`--row-wash`) over it, so the ring always matches.
 */
export function DottedFace(props: {
  avatar: SpadeAvatar;
  size: number;
  state: BotFaceState;
  dot: FaceDot | undefined;
  /** The profile's bigger dot and ring. */
  large?: boolean;
  dim?: boolean;
  /** Its accent ring (ADR 0200 §5.3), from {@link useMarkAccent}; none when undefined. */
  accent?: CSSProperties | undefined;
}) {
  const ring = props.large ? "var(--face-dot-ring-lg)" : "var(--face-dot-ring)";
  return (
    <span className="relative grid shrink-0" style={props.accent}>
      {props.accent && (
        <span
          aria-hidden
          data-agent-accent="ring"
          className="absolute -inset-1.5 rounded-full border-2 border-(--agent-accent-light) dark:border-(--agent-accent-dark)"
        />
      )}
      <SpadeFace
        avatar={props.avatar}
        size={props.size}
        state={props.state}
        ring="bg-(--sidebar-panel) shadow-[0_0_0_2px_var(--sidebar-panel)]"
        className={cn(props.dim && "opacity-45")}
      />
      {props.dot && (
        <span
          aria-hidden
          data-face-dot={props.dot}
          className={cn(
            "absolute rounded-full",
            props.large
              ? "right-0 bottom-0 size-(--face-dot-lg)"
              : "-right-px -bottom-px size-(--face-dot)",
            dotFill[props.dot],
          )}
          style={{
            boxShadow: `0 0 0 ${ring} var(--row-wash, transparent), 0 0 0 ${ring} var(--sidebar-panel)`,
          }}
        />
      )}
    </span>
  );
}

/** A row's frame: 64px, the face, then the name over its one line. */
const rowClass =
  "group/row grid h-(--spade-list-row) w-full min-w-0 grid-cols-[var(--spade-list-face)_minmax(0,1fr)] grid-rows-[20px_20px] content-center gap-x-3 rounded-lg px-2.5 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover hover:[--row-wash:var(--hover)] aria-[current=page]:bg-active aria-[current=page]:[--row-wash:var(--active)]";

const lineTone: Partial<Record<SpadeRowState, string>> = {
  "needs-you": "needs-you",
  failed: "failed",
};

/** The quiet word after a development bot's name (ADR 0200 §9). */
export function DevelopmentWord(props: { className?: string }) {
  return (
    <span className={cn("shrink-0 text-ui/5 font-normal text-subtle-foreground", props.className)}>
      Development
    </span>
  );
}

function RowText(props: {
  name: string;
  line: string;
  state: SpadeRowState;
  development?: boolean;
  /** A word after the name, such as a shared bot's. */
  after?: ReactNode;
}) {
  const unseen = props.state === "unseen";
  const tone = lineTone[props.state];
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          data-view-row-title=""
          className={cn(
            "min-w-0 truncate text-md/5",
            unseen ? "font-semibold" : "font-medium",
            props.state === "off" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {props.name}
        </span>
        {props.development && <DevelopmentWord />}
        {props.after}
      </span>
      <span
        data-tone={tone}
        className={cn(
          "min-w-0 truncate text-ui/5",
          tone
            ? "text-(--tone-text)"
            : unseen
              ? "text-foreground"
              : props.state === "working"
                ? "text-muted-foreground"
                : "text-subtle-foreground",
          props.state === "needs-you" && "font-medium",
        )}
      >
        {props.line}
      </span>
    </>
  );
}

function FaceCell(props: { children: ReactNode }) {
  return <span className="row-span-2 grid self-center">{props.children}</span>;
}

/** The live pose for a row: still while off, pleased while unseen, else the bot's own state. */
export function livePose(bot: RosterBot, state: SpadeRowState): BotFaceState | null {
  if (state === "off") return null;
  if (state === "unseen") return "done";
  return botFaceStateOf(bot);
}

export function BotListRow(props: {
  bot: RosterBot;
  state: SpadeRowState;
  line: string;
  current: boolean;
}) {
  const { bot } = props;
  const pose = useFaceState(livePose(bot, props.state), props.current);
  const accent = useMarkAccent(bot);
  return (
    <Link
      to="/spade/$agentId"
      params={{ agentId: bot.id }}
      search={bot.machine.primary ? {} : { on: bot.machine.key }}
      aria-current={props.current ? "page" : undefined}
      data-panel-row=""
      {...part("nav-item", props.current && "active", "agent")}
      className={cn(rowClass, "relative")}
      style={accent}
    >
      {accent && (
        <span
          aria-hidden
          data-agent-accent="row"
          className="absolute top-1/2 left-0.5 h-4 w-0.5 -translate-y-1/2 rounded-full bg-(--agent-accent-light) dark:bg-(--agent-accent-dark)"
        />
      )}
      <FaceCell>
        <DottedFace
          avatar={bot.avatar}
          size={40}
          state={pose}
          dot={faceDotOf(props.state)}
          dim={props.state === "off"}
        />
      </FaceCell>
      <RowText
        name={bot.name}
        line={props.line}
        state={props.state}
        development={spadeIsDevelopment(bot.package)}
        after={<SharedWord bot={bot} />}
      />
    </Link>
  );
}

export function GroupListRow(props: {
  group: RosterGroup;
  bots: readonly RosterBot[];
  state: SpadeRowState;
  line: string;
  current: boolean;
}) {
  const { group } = props;
  const machines = useMachines();
  return (
    <Link
      to="/spade/groups/$groupId"
      params={{ groupId: group.id }}
      search={group.machine.primary ? {} : { on: group.machine.key }}
      aria-current={props.current ? "page" : undefined}
      data-panel-row=""
      {...part("nav-item", props.current && "active", "group")}
      className={rowClass}
    >
      <FaceCell>
        <span className={cn("flex", props.state === "off" && "opacity-45")}>
          <GroupFaces members={shownMembers(machines, group, props.bots)} size={40} />
        </span>
      </FaceCell>
      <RowText name={group.name} line={props.line} state={props.state} />
    </Link>
  );
}

/** Loading: skeleton rows at row size. */
export function ListSkeletonRows() {
  const widths = [
    { name: "w-24", line: "w-40" },
    { name: "w-32", line: "w-44" },
    { name: "w-20", line: "w-36" },
    { name: "w-28", line: "w-44" },
  ];
  return (
    <LoadingRegion label="Bots" className="flex flex-col" holdsStartup>
      {widths.map(({ name, line }) => (
        <div key={name + line} className={cn(rowClass, "hover:bg-transparent")}>
          <Skeleton className="row-span-2 size-(--spade-list-face) self-center rounded-full" />
          <Skeleton className={cn("h-3 self-center rounded-sm", name)} />
          <Skeleton className={cn("h-3 self-center rounded-sm", line)} />
        </div>
      ))}
    </LoadingRegion>
  );
}
