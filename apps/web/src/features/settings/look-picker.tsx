import type { SuitProblem, SuitSummary } from "@ace/protocol/suits";
import { themeIds, themes, type Scheme } from "@ace/themes";
import { PlusIcon } from "@ace/icons";
import { Link } from "@tanstack/react-router";
import { videoSizeLabel } from "@ace/suits";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { part } from "@/lib/suit-part.ts";
import { suitReady } from "@/theme/suits/applied-suit.ts";
import { useSuitDetail, useSuitLibrary } from "@/theme/suits/suit-library.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";
import { useVideoSize } from "@/features/suits/index.ts";
import { AppPreview } from "./app-preview.tsx";
import { useLook } from "./look.ts";
import { PickerCard } from "./picker-card.tsx";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";

/*
 * Settings > Appearance > Look: every built-in theme and every installed Suit (ADR 0150) as
 * equal cards, each drawn as it looks in the scheme on screen. Picking one is the only action:
 * a theme turns the Suit off, a Suit turns it on. A Suit that needs fixes is dimmed and can't be
 * picked, with what it needs under its name. The last card opens a thread to make one.
 */

const card =
  "grid w-full grid-cols-2 gap-x-4 gap-y-5 @min-[420px]:grid-cols-3 @min-[420px]:gap-x-5";
const skeleton = "block aspect-[16/9] rounded-lg bg-skel";

/**
 * The card's tags. A Suit with a video says so, and while it plays here, the size its file
 * really has (ADR 0169): "4K" only for a 4K file.
 */
function tagsFor(
  summary: SuitSummary,
  video: { has: boolean; size: { width: number; height: number } | undefined },
): string[] {
  const tags = summary.scene ? ["Scene"] : [];
  if (video.size) tags.push(`Video, ${videoSizeLabel(video.size)}`);
  else if (video.has) tags.push("Video");
  if (summary.schemes.length === 1)
    tags.push(summary.schemes[0] === "dark" ? "Dark only" : "Light only");
  return tags;
}

function problemText(problem: SuitProblem): string {
  const where = [problem.scheme, problem.field].filter(Boolean).join(" ");
  return where ? `${problem.message} (${where})` : problem.message;
}

/** What a Suit needs fixed: one short line under its name that opens to the full list. */
function Problems(props: { summary: SuitSummary }) {
  const { summary } = props;
  const [first] = summary.problems;
  if (!first) return null;
  return (
    <details className="group/fixes min-w-0 text-xs text-subtle-foreground">
      <summary className="cursor-pointer list-none truncate outline-none hover:text-muted-foreground focus-visible:text-foreground [&::-webkit-details-marker]:hidden">
        Needs fixes: {first.message}
        {summary.problems.length > 1 && ` and ${summary.problems.length - 1} more`}
      </summary>
      <ul
        aria-label={`What ${summary.name} needs fixed`}
        {...part("list", undefined, "problems")}
        className="mt-1 flex list-disc flex-col gap-0.5 pl-4"
      >
        {summary.problems.map((problem) => (
          <li
            key={`${problem.check}:${problem.scheme}:${problem.field}:${problem.message}`}
            {...part("list-row", "failed", "problem")}
          >
            {problemText(problem)}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The Suit drawn as the theme cards are, once its files are read; a placeholder until then. */
function SuitThumbnail(props: { summary: SuitSummary; scheme: Scheme }) {
  const detail = useSuitDetail(props.summary);
  return detail ? (
    <AppPreview look={{ suit: detail }} scheme={props.scheme} className="aspect-[16/9]" />
  ) : (
    <span aria-hidden className={skeleton} />
  );
}

function SuitCard(props: { summary: SuitSummary; checked: boolean; off: boolean }) {
  const { summary } = props;
  const { resolved } = useTheme();
  const { pick } = useLook();
  const ready = suitReady(summary);
  const detail = useSuitDetail(summary);
  const size = useVideoSize(summary.id);
  return (
    <PickerCard
      label={summary.name}
      description={summary.description || undefined}
      checked={props.checked}
      disabled={!ready || props.off}
      onChoose={() => pick({ suit: summary.id })}
      tags={tagsFor(summary, { has: detail?.manifest.video !== undefined, size })}
      preview={<SuitThumbnail summary={summary} scheme={resolved.scheme} />}
      after={ready ? undefined : <Problems summary={summary} />}
    />
  );
}

/** Starts a new thread with the make-a-suit skill named first, on the person's current agent. */
function MakeYourOwn() {
  return (
    <Link
      to="/new"
      search={{ skill: "make-a-suit" }}
      aria-label="Make your own"
      aria-description="Describe the look you want and an agent makes it."
      {...part("card", undefined, "make-look")}
      className="group flex min-w-0 flex-col items-stretch gap-2 text-left outline-none"
    >
      <span className="grid aspect-[16/9] place-items-center rounded-lg border border-dashed border-border-strong text-muted-foreground transition-[color,border-color,translate] duration-(--motion-base) ease-(--ease-out) group-hover:border-foreground/40 group-hover:text-foreground group-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)] motion-safe:group-hover:-translate-y-0.5 motion-reduce:transition-none">
        <PlusIcon aria-hidden className="size-5" />
      </span>
      <span
        aria-hidden
        className="text-sm text-muted-foreground transition-colors duration-(--motion-fast) group-hover:text-foreground"
      >
        Make your own
      </span>
    </Link>
  );
}

export function LookPicker() {
  const { appearance, resolved, suitsOff } = useTheme();
  const { summaries, failed } = useSuitLibrary();
  const look = useLook();
  const marketplace = useBetaEnabled("marketplace") === true;
  return (
    <div className="flex flex-col gap-3">
      <div
        role="radiogroup"
        // `theme` is the contract's name for this list (docs/design/suit-parts.md); Suits style it.
        {...part("list", undefined, "theme")}
        aria-label="Look"
        onKeyDown={onRadioKeys}
        className={card}
      >
        {themeIds.map((id) => (
          <PickerCard
            key={id}
            label={themes[id].name}
            description={themes[id].character}
            checked={look.suitId === null && appearance.theme === id}
            onChoose={() => look.pick({ theme: id })}
            labelStyle={{ fontFamily: themes[id].fonts.ui }}
            preview={
              <AppPreview look={{ theme: id }} scheme={resolved.scheme} className="aspect-[16/9]" />
            }
          />
        ))}
        {summaries === undefined
          ? [0, 1].map((at) => (
              <span key={at} aria-hidden className="flex flex-col gap-2">
                <span className={skeleton} />
                <span className="h-4 w-1/2 rounded-sm bg-skel" />
              </span>
            ))
          : summaries.map((summary) => (
              <SuitCard
                key={summary.id}
                summary={summary}
                checked={look.suitId === summary.id}
                off={suitsOff}
              />
            ))}
        <MakeYourOwn />
      </div>
      {marketplace && (
        <Link
          to="/marketplace"
          search={{ type: "suit" }}
          {...part("link")}
          className="self-start rounded-sm text-ui text-foreground hover:underline focus-ring"
        >
          More Suits
        </Link>
      )}
      {look.note && <p className="text-xs text-muted-foreground">{look.note}</p>}
      {summaries?.length === 0 && failed && (
        <p className="text-xs text-muted-foreground">Your own looks couldn't be read.</p>
      )}
    </div>
  );
}
