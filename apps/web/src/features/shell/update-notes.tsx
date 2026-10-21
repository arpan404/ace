import { ArrowUpRightIcon } from "@phosphor-icons/react";
import { openRelease, releasesUrl, type UpdateStatus } from "@/boot/desktop-updates.ts";
import { PopoverTitle } from "@/components/ui/popover.tsx";
import { updateLabel } from "./update-status.ts";

/** The card's short heading, and what a click on the button does from here. */
function cardHeading(status: UpdateStatus): { headline: string; hint?: string } {
  if (status.error) return { headline: updateLabel(status) };
  if (status.state === "available")
    return status.inPlace
      ? { headline: "Update ready to download", hint: "Click to download" }
      : { headline: "Update available", hint: "Click to get it from GitHub" };
  if (status.state === "downloaded")
    return { headline: "Update downloaded", hint: "Click to restart and install" };
  return { headline: updateLabel(status) };
}

/** Lines keyed by their text and how often it came before: two identical lines stay apart. */
function keyed(items: readonly string[]): { key: string; item: string }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const times = seen.get(item) ?? 0;
    seen.set(item, times + 1);
    return { key: `${times}:${item}`, item };
  });
}

function ReleaseLink(props: { url: string; scope?: object | undefined; children: string }) {
  return (
    <a
      href={props.url}
      onClick={(event) => {
        event.preventDefault();
        openRelease(props.url, props.scope);
      }}
      className="mt-1.5 inline-flex items-center gap-1 rounded-xs text-xs text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors duration-(--motion-fast) focus-ring hover:text-foreground"
    >
      {props.children}
      <ArrowUpRightIcon aria-hidden size={11} weight="bold" />
    </a>
  );
}

/**
 * What changed in every release since this version, newest first: the update button's
 * hover card. Each release lists its first changes and links to the rest on GitHub.
 */
export function UpdateNotes(props: { status: UpdateStatus; scope?: object | undefined }) {
  const { status } = props;
  const { headline, hint } = cardHeading(status);
  return (
    <div className="flex max-h-[min(28rem,calc(100vh-6rem))] w-80 flex-col">
      <div className="shrink-0 px-3 pt-3 pb-2">
        <PopoverTitle className="text-ui font-medium text-foreground">{headline}</PopoverTitle>
        <p className="text-xs text-muted-foreground">
          {status.currentVersion} → {status.version}
          {hint && ` · ${hint}`}
        </p>
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-3 pb-3">
        {status.notes.map((note, index) => {
          const url = `${releasesUrl}/tag/v${encodeURIComponent(note.version)}`;
          const more = note.total - note.items.length;
          return (
            <section key={note.version} className={index > 0 ? "border-t border-border pt-3" : ""}>
              <h3 className="text-xs font-semibold text-foreground">
                {index === 0 ? "What's changed" : `Changes in ${note.version}`}
              </h3>
              <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                {keyed(note.items).map(({ key, item }) => (
                  <li key={key}>{item}</li>
                ))}
              </ul>
              <ReleaseLink url={url} scope={props.scope}>
                {more > 0
                  ? `${more} more ${more === 1 ? "change" : "changes"} on GitHub`
                  : "View release on GitHub"}
              </ReleaseLink>
            </section>
          );
        })}
        {status.olderReleases > 0 && (
          <div className="border-t border-border pt-3">
            <ReleaseLink url={releasesUrl} scope={props.scope}>
              {`${status.olderReleases} older ${status.olderReleases === 1 ? "release" : "releases"} on GitHub`}
            </ReleaseLink>
          </div>
        )}
      </div>
    </div>
  );
}
