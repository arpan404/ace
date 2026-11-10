import { useState } from "react";
import { CaretRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { matchingServices, serviceLabel } from "@ace/ui-core";
import type { ProviderLoginProgress } from "@ace/protocol";
import { ProviderTile, StatusLine } from "@/components/provider-tile.tsx";
import { useModelInstances } from "@/lib/model-catalog.ts";
import { StepTitle, useFocusOnShow } from "./login-parts.tsx";

/** Past this many choices the list gets a search field and scrolls (OpenCode offers ~240). */
const searchFrom = 12;

/**
 * The CLI's own choices as a list: each with its mark and what connecting it means. For OpenCode
 * and Pi they are the services it can reach models through; a long list is searched by name.
 */
export function Choices(props: {
  progress: ProviderLoginProgress;
  provider: ProviderLoginProgress["provider"];
  upstreams: boolean;
  disabled: boolean | undefined;
  onChoose(choice: string): void;
}) {
  const long = (props.progress.choices?.length ?? 0) > searchFrom;
  const firstChoice = useFocusOnShow<HTMLButtonElement>();
  const search = useFocusOnShow<HTMLInputElement>();
  const [query, setQuery] = useState("");
  const instances = useModelInstances();
  const connected = new Set(
    instances
      .filter((instance) => instance.provider === props.provider)
      .flatMap((instance) =>
        (instance.sources ?? [])
          .filter((entry) => !entry.error || entry.error.code === "no_models")
          .map((entry) => entry.source.id),
      ),
  );
  const labelled = (props.progress.choices ?? []).map((choice) =>
    Object.assign({}, choice, {
      label: serviceLabel(choice.id) === choice.id ? choice.label : serviceLabel(choice.id),
    }),
  );
  const shown = matchingServices(labelled, query);
  const title = props.upstreams
    ? "Which service do you want to connect?"
    : (props.progress.prompt ?? "Choose how to sign in");
  return (
    <>
      <StepTitle title={title} line={props.upstreams ? "You can add more later." : undefined} />
      {long && (
        <label className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] has-focus-visible:shadow-[0_0_0_1px_color-mix(in_oklab,var(--ring)_50%,transparent)]">
          <MagnifyingGlassIcon aria-hidden size={14} className="shrink-0" />
          <input
            ref={search}
            type="search"
            value={query}
            aria-label="Search services"
            placeholder="Search services"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && shown[0]) {
                event.preventDefault();
                props.onChoose(shown[0].id);
              }
              if (event.key !== "Escape" || !query) return;
              event.stopPropagation();
              setQuery("");
            }}
            disabled={props.disabled}
            className="min-w-0 flex-1 bg-transparent text-ui text-foreground placeholder:text-subtle-foreground focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
      )}
      <ul
        role="group"
        aria-label={title}
        className={long ? "flex max-h-[min(50vh,26rem)] flex-col overflow-y-auto" : "flex flex-col"}
      >
        {shown.map((choice, at) => (
          <li key={choice.id}>
            <button
              ref={at === 0 && !long ? firstChoice : undefined}
              type="button"
              aria-label={choice.label}
              disabled={props.disabled}
              onClick={() => props.onChoose(choice.id)}
              className="flex w-full items-center h-9 gap-2 rounded-md px-2 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-accent disabled:opacity-50"
            >
              <ProviderTile
                provider={props.provider}
                service={choice.id === "other" ? undefined : { id: choice.id, label: choice.label }}
                size="sm"
                className="size-6 bg-transparent shadow-none"
              />
              <span className="min-w-0 flex-1">
                <span className="truncate font-medium text-foreground">{choice.label}</span>
              </span>
              {connected.has(choice.id) ? (
                <StatusLine tone="ready" text="Connected" />
              ) : (
                choice.note === "sign_in_again" && <StatusLine tone="action" text="Sign in again" />
              )}
              <CaretRightIcon aria-hidden size={14} className="text-subtle-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
