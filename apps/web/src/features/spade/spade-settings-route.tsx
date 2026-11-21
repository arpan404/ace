import { spadeMostInRoute } from "@ace/ui-core/spade-chat";
import { PlusIcon, XIcon } from "@ace/icons";
import { useId, useState, type ReactNode } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SpadeModelPicker } from "./spade-model-picker.tsx";
import { fault, Refusal } from "./spade-settings-rows.tsx";

/**
 * One role's route in Settings (ADR 0205 §2): its model, then up to three it falls back to, in
 * order, when one can't answer (off, rate-limited, out of quota). Only the person's endpoints'
 * models: a route never holds a subscription. Each change saves the whole list; a refusal (a
 * model that can't call tools on a role that needs them) says why under the row.
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
  return (
    <>
      <SettingRow
        title={props.title}
        description={refusal ? <Refusal>{refusal}</Refusal> : props.description}
        htmlFor={id}
        density="compact"
      >
        <SpadeModelPicker
          id={id}
          label={props.title}
          value={first}
          none={props.none}
          follows={props.follows}
          forBots={props.forBots}
          onChange={(value) => void choose(value ? [value, ...rest] : [])}
        />
      </SettingRow>
      {rest.map((model, at) => (
        <FallbackRow
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
        <AddFallback title={props.title} forBots={props.forBots} route={route} choose={choose} />
      )}
    </>
  );
}

/** The route's model at position `at` (2 to 4): what serves when the ones before can't. */
function FallbackRow(props: {
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
    <SettingRow title="If it can't answer" htmlFor={id} density="compact" variant="route-fallback">
      <div className="flex items-center gap-1">
        <SpadeModelPicker
          id={id}
          label={label}
          value={props.model}
          forBots={props.forBots}
          onChange={(value) => {
            if (value) props.onChange(value);
          }}
        />
        <Button size="xs" variant="ghost" aria-label={`Remove ${label}`} onClick={props.onRemove}>
          <XIcon aria-hidden size={14} />
        </Button>
      </div>
    </SettingRow>
  );
}

/** Adds a model to the end of the route, picked from the person's endpoints. */
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
      <div className="flex justify-end px-3 pb-1">
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          <PlusIcon aria-hidden size={14} />
          Add a fallback
        </Button>
      </div>
    );
  return (
    <SettingRow title="If it can't answer" htmlFor={id} density="compact" variant="route-fallback">
      <SpadeModelPicker
        id={id}
        label={`${props.title}, a new fallback`}
        value=""
        none="Choose a model"
        forBots={props.forBots}
        onChange={(value) => {
          setAdding(false);
          if (value) void props.choose([...props.route, value]);
        }}
      />
    </SettingRow>
  );
}
