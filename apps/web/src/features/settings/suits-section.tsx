import type { SuitProblem, SuitSummary } from "@ace/protocol/suits";
import { themes, type Scheme } from "@ace/themes";
import { Link } from "@tanstack/react-router";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button, buttonLook } from "@/components/ui/button.tsx";
import { suitReady } from "@/theme/suits/applied-suit.ts";
import { suitPalette } from "@/theme/suits/suit-css.ts";
import { useSuitDetail, useSuitLibrary } from "@/theme/suits/suit-library.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";
import { part } from "@/lib/suit-part.ts";
import { settingRow } from "./settings-index.ts";

/*
 * Settings > Appearance > Suits (ADR 0150): the looks agents made, from the daemon's library.
 * A Suit that passes every check can be used on this device; one that doesn't says what needs
 * fixing, and can't be used until an agent fixes it.
 */

const schemeWords = (schemes: readonly Scheme[]) =>
  schemes.length === 2 ? "Light and dark" : schemes[0] === "light" ? "Light only" : "Dark only";

/** Page, sidebar, accent and text of the Suit in the scheme on screen. Decoration only. */
function Swatch(props: { summary: SuitSummary; scheme: Scheme }) {
  const detail = useSuitDetail(props.summary);
  const palette = detail ? suitPalette(detail.manifest, props.scheme) : undefined;
  const colours: [string, string][] = palette
    ? [
        ["page", palette.s0],
        ["sidebar", palette.sidebar],
        ["accent", palette.accent],
        ["text", palette.t1],
      ]
    : ["page", "sidebar", "accent", "text"].map((region) => [region, "var(--skel)"]);
  return (
    <span
      aria-hidden
      data-testid="suit-swatch"
      className="flex h-4 w-12 shrink-0 overflow-hidden rounded-xs shadow-[0_0_0_1px_var(--border)]"
    >
      {colours.map(([region, colour]) => (
        <span key={region} className="flex-1" style={{ background: colour }} />
      ))}
    </span>
  );
}

function problemText(problem: SuitProblem): string {
  const where = [problem.scheme, problem.field].filter(Boolean).join(" ");
  return where ? `${problem.message} (${where})` : problem.message;
}

function SuitRow(props: { summary: SuitSummary }) {
  const { summary } = props;
  const { appearance, update, resolved, suitsOff } = useTheme();
  const picked = appearance.suit === summary.id;
  const ready = suitReady(summary);
  const facts = [schemeWords(summary.schemes), summary.scene ? "Has a scene" : undefined]
    .filter(Boolean)
    .join(" · ");
  return (
    <SettingRow
      variant="suit"
      state={picked ? "selected" : ready ? undefined : "failed"}
      title={
        <span className="flex items-center gap-2">
          <Swatch summary={summary} scheme={resolved.scheme} />
          {summary.name}
        </span>
      }
      description={
        <span className="flex flex-col gap-0.5">
          {summary.description && <span>{summary.description}</span>}
          <span>{facts}</span>
          {!ready && (
            <span className="flex flex-col gap-0.5">
              <span className="text-foreground">Needs fixes before it can be used:</span>
              <ul
                aria-label={`What ${summary.name} needs fixed`}
                {...part("list", undefined, "problems")}
                className="list-disc pl-4"
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
            </span>
          )}
        </span>
      }
    >
      {picked ? (
        <Button size="sm" onClick={() => update({ suit: null })}>
          Turn off
        </Button>
      ) : (
        ready && (
          <Button
            size="sm"
            disabled={suitsOff}
            aria-label={`Use ${summary.name}`}
            onClick={() => update({ suit: summary.id })}
          >
            Use
          </Button>
        )
      )}
    </SettingRow>
  );
}

/** One sentence on what's on screen, when it isn't simply the picked Suit. */
function statusNote(input: {
  /** An agent's preview: the Suit's name, null for the theme, undefined when none runs. */
  previewName: string | null | undefined;
  pickedName: string | undefined;
  pickedReady: boolean;
  showing: boolean;
  suitsOff: boolean;
  themeName: string;
}): string | undefined {
  if (input.suitsOff) return `Suits are off for this session, so ${input.themeName} shows.`;
  if (input.previewName !== undefined)
    return `An agent is previewing ${input.previewName ?? input.themeName} until it keeps or reverts it.`;
  if (input.showing)
    return "The Suit sets colours, fonts and shape. Theme and Accent apply again when it's off.";
  if (input.pickedName && !input.pickedReady)
    return `${input.pickedName} needs fixes, so ${input.themeName} shows.`;
  return undefined;
}

/**
 * Starts a new thread with the make-a-suit skill named first, on the person's current agent, the
 * way a skill's "Use in a thread" does: they describe the look and send.
 */
function MakeOne(props: { title: string }) {
  return (
    <SettingRow title={props.title} description="Describe the look you want and an agent makes it.">
      <Link
        to="/new"
        search={{ skill: "make-a-suit" }}
        {...buttonLook({ variant: "secondary", size: "sm" })}
      >
        Make one with an agent
      </Link>
    </SettingRow>
  );
}

export function SuitsSection() {
  const { summaries, failed, preview } = useSuitLibrary();
  const { appearance, suit, suitsOff } = useTheme();
  const picked = summaries?.find((summary) => summary.id === appearance.suit);
  const previewed = preview ? summaries?.find((summary) => summary.id === preview) : undefined;
  const note = statusNote({
    previewName:
      preview === undefined ? undefined : preview === null ? null : (previewed?.name ?? preview),
    pickedName: picked?.name,
    pickedReady: picked ? suitReady(picked) : true,
    showing: suit !== null,
    suitsOff,
    themeName: themes[appearance.theme].name,
  });
  const row = settingRow("appearance.suits");
  return (
    <SettingSection label={row.title} anchor={row.id} scope="device" card note={note}>
      {summaries === undefined ? (
        <SettingRow title="Reading Suits…" />
      ) : summaries.length === 0 && failed ? (
        <SettingRow title="Suits couldn't be read" />
      ) : (
        <>
          {summaries.map((summary) => (
            <SuitRow key={summary.id} summary={summary} />
          ))}
          <MakeOne title={summaries.length > 0 ? "Make your own" : "No Suits yet"} />
        </>
      )}
    </SettingSection>
  );
}
