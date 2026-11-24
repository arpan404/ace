import { spadeMostInRoute } from "@ace/ui-core/spade-chat";
import { PlusIcon, XIcon } from "@ace/icons";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { fault, Refusal } from "./spade-settings-rows.tsx";

/** Shared 3-column desktop grid for role rows (Role | Model | Thinking) and their header. */
export const roleGridColumns =
  "grid grid-cols-1 gap-2 @min-[580px]:grid-cols-[minmax(140px,1fr)_minmax(200px,240px)_196px] @min-[580px]:items-center @min-[580px]:gap-3";

/**
 * One role's route in Settings (ADR 0205 §2): its model, optional thinking effort beside it,
 * and up to three fallbacks nested directly under the model column so every role stays one
 * self-contained block inside `SettingCard`.
 */
export function RouteSettingRow(props: {
  title: string;
  description?: ReactNode;
  /** The route as saved; empty when the role follows its default. */
  route: readonly string[];
  /** The empty first choice's words ("Fast model"), when the role has a default. */
  none?: string | undefined;
  follows?: string | undefined;
  /** The role runs tool work: a model that can't call tools can't be picked. */
  forBots: boolean;
  /** A control beside the model: how hard it thinks (`EffortSelect`). */
  beside?: ReactNode;
  save(route: string[] | null): Promise<unknown>;
}) {
  const id = useId();
  const [refusal, setRefusal] = useState<string>();
  const [pending, setPending] = useState<string[]>();
  const route = pending ?? [...props.route];
  const choose = async (next: string[]) => {
    const tidy = next.filter((model, at) => model && next.indexOf(model) === at);
    setRefusal(undefined);
    setPending(tidy);
    try {
      await props.save(tidy.length ? tidy : null);
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setPending(undefined);
    }
  };
  const first = route[0] ?? "";
  const rest = route.slice(1);
  const room = first !== "" && route.length < spadeMostInRoute;
  const hasTree = rest.length > 0 || room;
  return (
    <div {...part("settings-row")} className="@container py-2.5">
      <div
        className={
          props.beside
            ? roleGridColumns
            : "grid grid-cols-1 gap-2 @min-[580px]:grid-cols-[minmax(140px,1fr)_minmax(200px,240px)] @min-[580px]:items-center @min-[580px]:gap-3"
        }
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <label
            htmlFor={id}
            className="w-fit rounded-sm text-ui font-medium text-foreground focus-ring"
          >
            {props.title}
          </label>
          {(refusal || props.description) && (
            <span className="max-w-prose text-xs leading-relaxed text-subtle-foreground">
              {refusal ? <Refusal>{refusal}</Refusal> : props.description}
            </span>
          )}
        </div>
        <SpadeModelPicker
          id={id}
          label={props.title}
          className="w-full"
          value={first}
          none={props.none}
          follows={props.follows}
          forBots={props.forBots}
          onChange={(value) => void choose(value ? [value, ...rest] : [])}
        />
        {props.beside}
      </div>

      {hasTree && (
        <div
          className={cn(
            "mt-2",
            props.beside &&
              "@min-[580px]:grid @min-[580px]:grid-cols-[minmax(140px,1fr)_minmax(200px,240px)_196px] @min-[580px]:gap-3",
          )}
        >
          <div
            className={cn(
              "flex flex-col gap-1.5",
              props.beside
                ? "@min-[580px]:col-start-2 @min-[580px]:col-span-2"
                : "@min-[580px]:ml-auto @min-[580px]:w-fit",
            )}
          >
            {rest.map((model, at) => (
              <FallbackItem
                key={model}
                title={props.title}
                at={at + 2}
                model={model}
                forBots={props.forBots}
                onChange={(value) =>
                  void choose(route.map((each, index) => (index === at + 1 ? value : each)))
                }
                onRemove={() => void choose(route.filter((_, index) => index !== at + 1))}
              />
            ))}
            {room && (
              <AddFallback
                title={props.title}
                forBots={props.forBots}
                route={route}
                choose={choose}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One fallback entry inside the role's chain (position 2 to 4). */
function FallbackItem(props: {
  title: string;
  at: number;
  model: string;
  forBots: boolean;
  onChange(value: string): void;
  onRemove(): void;
}) {
  const id = useId();
  const label = `${props.title}, fallback ${props.at - 1}`;
  return (
    <div {...part("settings-row", undefined, "route-fallback")} className="flex items-center gap-2">
      <label htmlFor={id} className="w-24 shrink-0 text-xs text-subtle-foreground">
        If it can't answer
      </label>
      <SpadeModelPicker
        id={id}
        label={label}
        className="min-w-0 flex-1 max-w-64"
        value={props.model}
        forBots={props.forBots}
        onChange={(value) => {
          if (value) props.onChange(value);
        }}
      />
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Remove ${label}`}
        className="shrink-0 text-subtle-foreground hover:text-foreground"
        onClick={props.onRemove}
      >
        <XIcon aria-hidden size={14} />
      </Button>
    </div>
  );
}

/** Inline trigger to append another fallback to the role's chain. */
function AddFallback(props: {
  title: string;
  forBots: boolean;
  route: readonly string[];
  choose(next: string[]): Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const id = useId();
  if (!adding)
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="inline-flex h-6 w-fit items-center gap-1.5 rounded-sm px-1 text-xs text-subtle-foreground transition-colors duration-(--motion-fast) hover:text-foreground focus-ring"
      >
        <PlusIcon aria-hidden size={12} />
        Add a fallback
      </button>
    );
  return (
    <div {...part("settings-row", undefined, "route-fallback")} className="flex items-center gap-2">
      <label htmlFor={id} className="w-24 shrink-0 text-xs text-subtle-foreground">
        If it can't answer
      </label>
      <SpadeModelPicker
        id={id}
        label={`${props.title}, a new fallback`}
        className="min-w-0 flex-1 max-w-60"
        value=""
        none="Choose a model"
        forBots={props.forBots}
        onChange={(value) => {
          setAdding(false);
          if (value) void props.choose([...props.route, value]);
        }}
      />
      <Button
        size="xs"
        variant="ghost"
        aria-label="Cancel adding fallback"
        className="shrink-0 text-subtle-foreground hover:text-foreground"
        onClick={() => setAdding(false)}
      >
        <XIcon aria-hidden size={14} />
      </Button>
    </div>
  );
}
