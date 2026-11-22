import type { AceOrgPolicy, AceOrgSpace } from "@ace/protocol/ace-org";
import { useState } from "react";
import {
  SettingFooter,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  allowEntries,
  allowText,
  blockEntries,
  blockText,
  lines,
  orgFailure,
  readPolicy,
  useOrgPolicy,
  useSetPolicy,
  type PolicyEffect,
} from "@/features/ace-org/index.ts";

type Rule = "unset" | "off" | "admins" | "approvers";
type Raise = "unset" | "never" | "admins" | "approvers";

const ruleOptions: SelectOption<Rule>[] = [
  { value: "unset", label: "Each bot decides" },
  { value: "approvers", label: "Its approvers can turn it on" },
  { value: "admins", label: "Only admins can turn it on" },
  { value: "off", label: "Never" },
];
const raiseOptions: SelectOption<Raise>[] = [
  { value: "unset", label: "Each bot decides" },
  { value: "approvers", label: "Its approvers can allow it" },
  { value: "admins", label: "Only admins can allow it" },
  { value: "never", label: "Never" },
];

const effectRows: readonly { key: PolicyEffect; title: string }[] = [
  { key: "send_as_person", title: "Send in a member's name" },
  { key: "publish", title: "Publish and post" },
  { key: "pay", title: "Pay" },
  { key: "change_access", title: "Change who has access" },
  { key: "network_without_hosts", title: "Reach sites it doesn't name" },
];

/** The policy as the page edits it: the stored one, its lists as lines of text. */
function draftOf(policy: AceOrgPolicy) {
  return {
    policy,
    allow: allowText(policy.packages?.allow),
    block: blockText(policy.packages?.block),
    endpoints: (policy.models?.endpoints ?? []).join("\n"),
  };
}
type Draft = ReturnType<typeof draftOf>;

/** The draft as the next version: its lists from their lines, an empty list left out. */
function policyOf(draft: Draft): AceOrgPolicy {
  const allow = allowEntries(draft.allow);
  const block = blockEntries(draft.block);
  const endpoints = lines(draft.endpoints);
  const { packages, models } = draft.policy;
  return {
    ...draft.policy,
    packages: {
      ...packages,
      ...(allow.length ? { allow } : { allow: undefined }),
      ...(block.length ? { block } : { block: undefined }),
    },
    models: {
      ...models,
      ...(endpoints.length ? { endpoints } : { endpoints: undefined }),
      // Shared bots never think on a member's coding subscription in M4.
      subscriptions: false,
    },
  };
}

/**
 * Settings › Organization › Policy (ADR 0206 §3): one versioned document, a ceiling over what the
 * organization's hosts allow anyway, so it only ever narrows. The backend signs each version;
 * hosts take only a newer one. Two admins saving at once: the second is asked again.
 */
export function PolicyPage(props: { org: AceOrgSpace }) {
  const policy = useOrgPolicy(props.org.id);
  if (policy.isLoading) return <SettingNote>Loading the policy…</SettingNote>;
  if (policy.error || !policy.data)
    return <SettingNote role="alert">{orgFailure(policy.error)}</SettingNote>;
  // A new version starts the page over from what was saved.
  return (
    <PolicyEditor
      key={policy.data.version}
      org={props.org}
      version={policy.data.version}
      stored={readPolicy(policy.data.body)}
    />
  );
}

function PolicyEditor(props: { org: AceOrgSpace; version: number; stored: AceOrgPolicy }) {
  const [draft, setDraft] = useState(() => draftOf(props.stored));
  const save = useSetPolicy(props.org.id);
  const [error, setError] = useState("");
  const set = (change: (policy: AceOrgPolicy) => AceOrgPolicy) =>
    setDraft((before) => ({ ...before, policy: change(before.policy) }));
  const { policy } = draft;
  const sources = policy.packages?.sources ?? {};
  return (
    <>
      <SettingSection
        label="What shared bots may do"
        anchor="org.policy.effects"
        note="Every send, payment and access change still asks one of the bot's approvers each time."
      >
        {effectRows.map((row) => (
          <SettingRow key={row.key} title={row.title} inline>
            <Select
              label={row.title}
              value={policy.effects?.[row.key] ?? "unset"}
              options={ruleOptions}
              onValueChange={(rule) =>
                set((before) => ({
                  ...before,
                  effects: { ...before.effects, [row.key]: rule === "unset" ? undefined : rule },
                }))
              }
            />
          </SettingRow>
        ))}
        <SettingRow title="Full access" description="A bot acting without asking." inline>
          <Select
            label="Full access"
            value={policy.full_access ?? "unset"}
            options={raiseOptions}
            onValueChange={(rule) =>
              set((before) => ({ ...before, full_access: rule === "unset" ? undefined : rule }))
            }
          />
        </SettingRow>
        <SettingRow title="Commands outside the sandbox" inline>
          <Select
            label="Commands outside the sandbox"
            value={policy.commands_outside_sandbox ?? "unset"}
            options={raiseOptions}
            onValueChange={(rule) =>
              set((before) => ({
                ...before,
                commands_outside_sandbox: rule === "unset" ? undefined : rule,
              }))
            }
          />
        </SettingRow>
        <SettingRow title="Members can make shared bots" inline>
          <Switch
            aria-label="Members can make shared bots"
            checked={policy.members_create_bots !== false}
            onCheckedChange={(on) => set((before) => ({ ...before, members_create_bots: on }))}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection label="Packages" anchor="org.policy.packages">
        {(["market", "registry", "git"] as const).map((source) => (
          <SettingRow
            key={source}
            title={
              source === "market"
                ? "From the Marketplace"
                : source === "registry"
                  ? `From ${props.org.name}'s registry`
                  : "From git catalogs"
            }
            description={source === "git" ? "Git catalogs carry no signature." : undefined}
            inline
          >
            <Switch
              aria-label={`Packages from ${source}`}
              checked={sources[source] ?? source !== "git"}
              onCheckedChange={(on) =>
                set((before) => ({
                  ...before,
                  packages: {
                    ...before.packages,
                    sources: { ...before.packages?.sources, [source]: on },
                  },
                }))
              }
            />
          </SettingRow>
        ))}
        <SettingRow
          title="Only listed packages"
          description="Install nothing that isn't allowed below."
          inline
        >
          <Switch
            aria-label="Only listed packages"
            checked={policy.packages?.mode === "allowlist"}
            onCheckedChange={(on) =>
              set((before) => ({
                ...before,
                packages: { ...before.packages, mode: on ? "allowlist" : "open" },
              }))
            }
          />
        </SettingRow>
        <ListField
          label="Allowed"
          hint="One per line: market, registry or git, then the name. registry * allows all of yours."
          value={draft.allow}
          onChange={(allow) => setDraft((before) => ({ ...before, allow }))}
        />
        <ListField
          label="Blocked"
          hint="One per line: a name, or sha256: and an archive's hash. A bot on a blocked version pauses and says why."
          value={draft.block}
          onChange={(block) => setDraft((before) => ({ ...before, block }))}
        />
      </SettingSection>
      <SettingSection
        label="Models"
        anchor="org.policy.models"
        note="Keys stay on each host's keychain. Shared bots never use a member's coding subscription."
      >
        <ListField
          label="Endpoints"
          hint="One host per line, such as api.example.com."
          value={draft.endpoints}
          onChange={(endpoints) => setDraft((before) => ({ ...before, endpoints }))}
        />
        <SettingRow title="Models on the host itself" inline>
          <Switch
            aria-label="Models on the host itself"
            checked={policy.models?.local !== false}
            onCheckedChange={(on) =>
              set((before) => ({ ...before, models: { ...before.models, local: on } }))
            }
          />
        </SettingRow>
      </SettingSection>
      <SettingSection label="Audit log" anchor="org.policy.audit">
        <SettingRow
          title="What entries keep"
          description="Never message text, never a member's private work."
          inline
        >
          <Select
            label="What audit entries keep"
            value={policy.audit?.content ?? "digests"}
            options={[
              { value: "digests", label: "Targets and digests" },
              { value: "targets", label: "Targets only" },
            ]}
            onValueChange={(content) => set((before) => ({ ...before, audit: { content } }))}
          />
        </SettingRow>
      </SettingSection>
      <SettingFooter>
        {error && (
          <span role="alert" className="mr-auto text-ui text-destructive">
            {error}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {props.version ? `Version ${props.version}` : "No policy yet"}
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={save.isPending}
          onClick={() => {
            setError("");
            save.mutate(policyOf(draft), { onError: (cause) => setError(orgFailure(cause)) });
          }}
        >
          {save.isPending ? "Saving…" : `Save version ${props.version + 1}`}
        </Button>
      </SettingFooter>
    </>
  );
}

function ListField(props: {
  label: string;
  hint: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label data-setting-slot="" className="flex flex-col gap-1.5 py-3">
      <span className="text-ui font-medium text-foreground">{props.label}</span>
      <span className="text-xs text-subtle-foreground">{props.hint}</span>
      <Textarea
        rows={3}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="font-mono text-ui"
      />
    </label>
  );
}
