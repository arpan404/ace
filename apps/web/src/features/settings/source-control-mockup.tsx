/** Throwaway provider setup preview. All actions stay in memory. */
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SettingRow, SettingSection, SettingNote } from "@/components/setting-row.tsx";

const providers = [
  { name: "GitHub", host: "github.com" },
  { name: "GitLab", host: "gitlab.com" },
  { name: "GitBucket", host: "" },
  { name: "Bitbucket", host: "bitbucket.org" },
  { name: "Gitea", host: "" },
  { name: "Forgejo", host: "" },
];

export function SourceControlMockup() {
  const [selected, setSelected] = useState<string>();
  const [host, setHost] = useState("");
  const [notice, setNotice] = useState("");
  return (
    <>
      <SettingSection label="Git hosts">
        {providers.map((provider) => (
          <SettingRow
            key={provider.name}
            title={provider.name}
            description={
              provider.name === "GitHub"
                ? "github.com · Signed in as ada"
                : provider.host || "Self-hosted"
            }
            inline
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSelected(provider.name);
                setHost(provider.host);
                setNotice("");
              }}
            >
              {provider.name === "GitHub" ? "Manage" : "Add host"}
            </Button>
          </SettingRow>
        ))}
        <SettingNote>Design preview. Connection states are illustrative.</SettingNote>
      </SettingSection>
      {selected && (
        <SettingSection label={selected}>
          <SettingRow
            title="Host"
            description={`The hostname of your ${selected} installation.`}
            htmlFor="mock-host"
          >
            <Input
              id="mock-host"
              value={host}
              placeholder="git.example.com"
              onChange={(event) => setHost(event.target.value)}
            />
          </SettingRow>
          <SettingRow
            title="Expected account"
            description="Stop requests if a different account is signed in."
            htmlFor="mock-account"
          >
            <Input id="mock-account" placeholder="Any account" />
          </SettingRow>
          <SettingRow
            title="Connection"
            description={notice || "Check the account available on this computer."}
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setNotice("Preview only. No connection was made.")}
            >
              Check connection
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(undefined)}>
              Cancel
            </Button>
          </SettingRow>
        </SettingSection>
      )}
      <SettingSection label="Preferences">
        <SettingRow
          title="Repository remote"
          description="The Git remote that names a project's repository."
          htmlFor="mock-remote"
        >
          <Input id="mock-remote" defaultValue="origin" />
        </SettingRow>
      </SettingSection>
      <SettingSection label="Git transport">
        <SettingRow
          title="Check a project's remote"
          description="Reads from the remote; nothing is pushed."
        >
          <Button variant="secondary" size="sm">
            Choose a project
          </Button>
        </SettingRow>
        <SettingNote>
          API sign-in does not verify Git clone or push access. Configure your Git credential helper
          or SSH key on this computer.
        </SettingNote>
      </SettingSection>
    </>
  );
}
