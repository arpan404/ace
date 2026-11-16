import { HairlineRow, RowGroup } from "@/components/hairline-row.tsx";
import { automationsQueryKey } from "@/features/automation-data/index.ts";
import { settingKeys, type SettingDef } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { PathSwitch } from "./path-switch.tsx";

/** What each way in means for a webhook's request body (ADR 0158, Consequences). */
const throughCloud = "ace cloud carries webhook bodies in plain text, never the secret.";

/**
 * Settings › a machine › Automation webhooks: one switch per way a signed webhook can reach
 * this machine (ADR 0158, decision 3), apart from outside apps' switches. Each reloads the
 * automation lists, whose webhooks list a URL per way that serves.
 */
export function AutomationWebhooks() {
  const publicUrl = useSettingControl(settingKeys.mcpPublicUrl, "Your own URL");
  const hasUrl = Boolean(publicUrl.value);
  return (
    <RowGroup label="Automation webhooks" anchor="automation-webhooks">
      <WayRow
        id="webhooks-custom"
        title="At your own URL"
        label="Automation webhooks at your own URL"
        setting={settingKeys.publicUrlWebhooks}
        sub={
          hasUrl
            ? "Senders reach your own proxy, which keeps request bodies off ace cloud."
            : "Add your own URL under Connect an app first."
        }
        blocked={!hasUrl}
      />
      <WayRow
        id="webhooks-tailscale"
        title="Over Tailscale"
        label="Automation webhooks over Tailscale"
        setting={settingKeys.tailscaleWebhooks}
        sub="Senders reach this machine's ts.net name, which keeps request bodies off ace cloud."
      />
      <WayRow
        id="webhooks-relay"
        title="Through ace cloud"
        label="Automation webhooks through ace cloud"
        setting={settingKeys.relayWebhooks}
        sub={throughCloud}
      />
    </RowGroup>
  );
}

function WayRow(props: {
  id: string;
  title: string;
  /** The switch's name, read apart from the group. */
  label: string;
  setting: SettingDef<boolean>;
  sub: string;
  blocked?: boolean;
}) {
  return (
    <HairlineRow
      id={props.id}
      title={props.title}
      wide
      sub={props.sub}
      actions={
        <PathSwitch
          setting={props.setting}
          title={props.label}
          refreshes={automationsQueryKey}
          blocked={props.blocked === true}
        />
      }
    />
  );
}
