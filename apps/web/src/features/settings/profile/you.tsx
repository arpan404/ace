import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useProfileName } from "@/lib/profile.ts";
import { settingRow } from "../settings-index.ts";

/** The name ace shows beside the person's messages, kept on this device. */
export function NameSetting() {
  const [name, setName] = useProfileName();
  const [draft, setDraft] = useState(name);
  const save = (value: string) => {
    const next = value.trim();
    setDraft(next);
    setName(next);
  };
  return (
    <SettingSection label="You" card scope="device">
      <SettingRow {...settingRow("profile.name")} htmlFor="profile-name">
        <Input
          id="profile-name"
          className="@[30rem]:w-52"
          value={draft}
          placeholder="Name"
          autoComplete="name"
          maxLength={80}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={(event) => save(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save(event.currentTarget.value);
          }}
        />
      </SettingRow>
    </SettingSection>
  );
}

export function Legal() {
  const link = "underline decoration-border underline-offset-3 hover:text-foreground";
  return (
    <nav aria-label="Legal" className="flex gap-4 text-xs text-subtle-foreground">
      <a
        href="https://acehq.dev/terms-of-service"
        target="_blank"
        rel="noreferrer"
        className={link}
      >
        Terms of service
      </a>
      <a href="https://acehq.dev/privacy-policy" target="_blank" rel="noreferrer" className={link}>
        Privacy policy
      </a>
    </nav>
  );
}
