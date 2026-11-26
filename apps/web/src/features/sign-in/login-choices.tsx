import { useState } from "react";
import {
  BriefcaseIcon,
  CaretRightIcon,
  GlobeIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  TerminalWindowIcon,
  UserCircleIcon,
} from "@ace/icons";
import { matchingServices, serviceLabel } from "@ace/ui-core";
import type { ProviderLoginProgress } from "@ace/protocol";
import { ProviderTile, StatusLine } from "@/components/provider-tile.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useModelInstances } from "@/lib/model-catalog.ts";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { StepTitle, useFocusOnShow } from "./login-parts.tsx";
import { signInMethod, type MethodGlyph, type SignInMethod } from "./sign-in-methods.ts";

/** Past this many choices the list gets a search field and scrolls (OpenCode offers ~240). */
const searchFrom = 12;

const glyphs = {
  key: KeyIcon,
  briefcase: BriefcaseIcon,
  globe: GlobeIcon,
  terminal: TerminalWindowIcon,
  account: UserCircleIcon,
} satisfies Record<MethodGlyph, unknown>;

/** A sign-in method's mark on a small tile: the maker's own, or a glyph for its kind. */
function MethodMark(props: { provider: ProviderLoginProgress["provider"]; method: SignInMethod }) {
  const Glyph = glyphs[props.method.glyph];
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-secondary text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
      {props.method.brand ? (
        <ProviderIcon provider={props.provider} brand={props.method.brand} size={16} decorative />
      ) : (
        <Glyph aria-hidden size={16} />
      )}
    </span>
  );
}

/**
 * The CLI's own choices as a list: each with its mark and what connecting it means. For OpenCode
 * and Pi they are the services it can reach models through; a long list is searched by name.
 * Otherwise they are ways to sign in, each with a mark for its kind and a line on what it means.
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
        <label
          {...part("search-field")}
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] has-focus-visible:shadow-[0_0_0_1px_color-mix(in_oklab,var(--ring)_50%,transparent)]"
        >
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
        {...part("list", undefined, "sign-in-choices")}
        className={long ? "flex max-h-[min(50vh,26rem)] flex-col overflow-y-auto" : "flex flex-col"}
      >
        {shown.map((choice, at) => {
          // A CLI's numbered options are ways to sign in, even inside a service's own sign-in.
          const method =
            props.upstreams && !/^(option|method)-\d+$/.test(choice.id)
              ? undefined
              : signInMethod(props.provider, choice);
          const label = method?.label ?? choice.label;
          return (
            <li key={choice.id}>
              <button
                {...part(
                  "list-row",
                  connected.has(choice.id) ? "done" : props.disabled && "disabled",
                  "sign-in-choice",
                )}
                ref={at === 0 && !long ? firstChoice : undefined}
                type="button"
                aria-label={label}
                aria-description={method?.description}
                disabled={props.disabled}
                onClick={() => props.onChoose(choice.id)}
                className={cn(
                  "flex w-full items-center rounded-md px-2 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-accent disabled:opacity-50",
                  method ? "min-h-12 gap-3 py-2" : "h-9 gap-2",
                )}
              >
                {method ? (
                  <MethodMark provider={props.provider} method={method} />
                ) : (
                  <ProviderTile
                    provider={props.provider}
                    service={
                      choice.id === "other" ? undefined : { id: choice.id, label: choice.label }
                    }
                    size="sm"
                    className="size-6 bg-transparent shadow-none"
                  />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-foreground">{label}</span>
                  {method?.description && (
                    <span className="truncate text-sm text-muted-foreground">
                      {method.description}
                    </span>
                  )}
                </span>
                {connected.has(choice.id) ? (
                  <StatusLine tone="ready" text="Connected" />
                ) : (
                  choice.note === "sign_in_again" && (
                    <StatusLine tone="action" text="Sign in again" />
                  )
                )}
                <CaretRightIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
