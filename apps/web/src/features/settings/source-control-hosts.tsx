import type { ForgeRepository, SourceControlPreferences } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";

export const gitProviders: readonly {
  forge: ForgeRepository["forge"];
  name: string;
  host: string;
}[] = [
  { forge: "github", name: "GitHub", host: "github.com" },
  { forge: "origin", name: "Cursor Origin", host: "origin.cursor.com" },
  { forge: "gitlab", name: "GitLab", host: "gitlab.com" },
  { forge: "gitbucket", name: "GitBucket", host: "" },
  { forge: "bitbucket", name: "Bitbucket", host: "bitbucket.org" },
  { forge: "gitea", name: "Gitea", host: "" },
  { forge: "forgejo", name: "Forgejo", host: "codeberg.org" },
];

export function SourceControlHosts(props: {
  preferences: SourceControlPreferences | undefined;
  disabled: boolean;
  onManage(forge: ForgeRepository["forge"], host: string): void;
}) {
  return (
    <SettingSection label="Git hosts">
      {gitProviders.map((provider) => {
        const hosts =
          props.preferences?.hosts.filter(
            (entry) => (entry.forge ?? "github") === provider.forge,
          ) ?? [];
        return (
          <SettingRow
            key={provider.forge}
            title={provider.name}
            description={
              hosts.length
                ? hosts.map((entry) => entry.host).join(", ")
                : provider.host || "Self-hosted"
            }
            inline
          >
            <Button
              variant="secondary"
              size="sm"
              disabled={props.disabled}
              aria-label={`${hosts.length ? "Manage" : "Add"} ${provider.name} host`}
              onClick={() => props.onManage(provider.forge, hosts[0]?.host ?? provider.host)}
            >
              {hosts.length ? "Manage" : "Add host"}
            </Button>
          </SettingRow>
        );
      })}
    </SettingSection>
  );
}
