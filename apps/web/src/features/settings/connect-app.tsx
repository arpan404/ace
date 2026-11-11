import type { OutsideEndpoint } from "@ace/protocol";
import { endpointNames, enrollCommand } from "@ace/ui-core/outside-clients";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { CopyCommand } from "@/components/copy-command.tsx";
import { HairlineRow, RowAction, RowGroup, StateWords } from "@/components/hairline-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import type { ClientApi } from "@ace/client";
import { outsideEndpoints, outsideKeys } from "@/features/connected-apps/index.ts";
import { outsideSettingKeys, settingKeys, type SettingDef } from "./data/setting-keys.ts";
import { useSettingControl, useSettingsLoaded } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";

const order: readonly OutsideEndpoint["path"][] = ["local", "tailscale", "relay", "custom"];

/** Said once, on the relay's row (ADR 0117, Reach). */
const relayTrust = "ace's relay can read what passes through it; it keeps none of it.";

/**
 * Settings › a machine › Connect an app: the four addresses an outside client can use, each with
 * Copy, its own on/off and, when it can't serve, why; then the command terminal agents use.
 * Renders inside the machine's scope.
 */
export function ConnectApp(props: { client: ClientApi }) {
  const query = useQuery({
    queryKey: outsideKeys.endpoints,
    queryFn: () => outsideEndpoints(props.client),
  });
  const byPath = new Map((query.data ?? []).map((endpoint) => [endpoint.path, endpoint]));
  return (
    <RowGroup label="Connect an app" anchor="connect-an-app">
      {query.isError && (
        <p role="alert" className="py-2.5 text-xs text-muted-foreground">
          {query.error.message || "Couldn't read its addresses."}
        </p>
      )}
      {order.map((path) => (
        <EndpointRow key={path} path={path} endpoint={byPath.get(path)} />
      ))}
      <div className="flex min-h-13 flex-wrap items-center gap-x-2 gap-y-1 py-2.5 text-ui text-muted-foreground">
        For a terminal agent, run <CopyCommand command={enrollCommand} />
      </div>
    </RowGroup>
  );
}

function EndpointRow(props: {
  path: OutsideEndpoint["path"];
  endpoint: OutsideEndpoint | undefined;
}) {
  const { path, endpoint } = props;
  const toast = useToast();
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy. Select the address and copy it yourself." }),
  );
  const [editing, setEditing] = useState(false);
  const url = endpoint?.url ?? undefined;
  const state = !endpoint ? undefined : endpoint.problem ? (
    <StateWords tone="warn">{endpoint.problem}</StateWords>
  ) : url ? (
    <span className="font-mono">{url}</span>
  ) : (
    "Off"
  );
  const setting =
    path === "relay"
      ? settingKeys.relayMcp
      : path === "tailscale"
        ? outsideSettingKeys.tailscaleMcp
        : undefined;
  const publicUrl = path === "custom" ? outsideSettingKeys.mcpPublicUrl : undefined;
  return (
    <HairlineRow
      id={`outside-${path}`}
      title={endpointNames[path]}
      wide
      sub={
        <>
          {state}
          {path === "relay" && <div>{relayTrust}</div>}
          {editing && publicUrl && (
            <PublicUrlForm setting={publicUrl} onDone={() => setEditing(false)} />
          )}
        </>
      }
      actions={
        <>
          {url && !endpoint?.problem && (
            <RowAction onClick={() => copy(url)}>{copied ? "Copied" : "Copy"}</RowAction>
          )}
          {publicUrl && !editing && <EditUrl setting={publicUrl} onEdit={() => setEditing(true)} />}
          {setting && <PathSwitch setting={setting} title={endpointNames[path]} />}
        </>
      }
    />
  );
}

/**
 * A path's on/off. A daemon that doesn't know the setting yet (older than its OAuth work) has
 * nothing to switch, so the switch hides once its settings have loaded without it.
 */
function PathSwitch(props: { setting: SettingDef<boolean>; title: string }) {
  const id = useId();
  const control = useSettingControl(props.setting, props.title);
  const settingsLoaded = useSettingsLoaded();
  const queries = useQueryClient();
  if (settingsLoaded && !control.loaded) return null;
  return (
    <DaemonSlot control={control}>
      <Switch
        id={id}
        aria-label={props.title}
        checked={control.value}
        disabled={control.offline}
        onCheckedChange={(on) => {
          control.set(on);
          void queries.invalidateQueries({ queryKey: outsideKeys.endpoints });
        }}
      />
    </DaemonSlot>
  );
}

function EditUrl(props: { setting: SettingDef<string | null>; onEdit(): void }) {
  const control = useSettingControl(props.setting, "Your own URL");
  const settingsLoaded = useSettingsLoaded();
  if (settingsLoaded && !control.loaded) return null;
  return (
    <DaemonSlot control={control}>
      <RowAction className="text-foreground" disabled={control.offline} onClick={props.onEdit}>
        {control.value ? "Change" : "Add"}
      </RowAction>
    </DaemonSlot>
  );
}

function PublicUrlForm(props: { setting: SettingDef<string | null>; onDone(): void }) {
  const control = useSettingControl(props.setting, "Your own URL");
  const queries = useQueryClient();
  const [draft, setDraft] = useState(control.value ?? "");
  const save = async (value: string | null) => {
    control.set(value);
    await queries.invalidateQueries({ queryKey: outsideKeys.endpoints });
    props.onDone();
  };
  const valid = /^https:\/\/[^\s/]+/.test(draft.trim());
  return (
    <form
      aria-label="Your own URL"
      className="relative z-1 mt-2 flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void save(draft.trim());
      }}
    >
      <Input
        aria-label="Base URL"
        autoFocus
        value={draft}
        placeholder="https://ace.example.com"
        onChange={(event) => setDraft(event.currentTarget.value)}
        className="w-64"
      />
      <Button type="submit" size="sm" variant="primary" disabled={control.pending || !valid}>
        Save
      </Button>
      {control.value && (
        <Button type="button" size="sm" variant="ghost" onClick={() => void save(null)}>
          Remove
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={props.onDone}>
        Cancel
      </Button>
    </form>
  );
}
