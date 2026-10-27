import type { BrowserProfileScope, ProjectDefaults } from "@ace/protocol";
import { projectBrowserProfiles } from "@ace/ui-core";
import { Select } from "@/components/ui/select.tsx";

const inherit = "inherit";
const options = projectBrowserProfiles.map((profile) => ({
  value: profile.value ?? inherit,
  label: profile.label,
}));
const notes: Record<string, string> = {
  ...Object.fromEntries(projectBrowserProfiles.map((profile) => [profile.value, profile.note])),
  inherit: "Follows Settings › Browser.",
};

/**
 * Which kept browser profile the project's threads open in: ace's Chrome and the desktop app
 * both follow it. Live browsers keep the profile they opened with.
 */
export function ProjectBrowserProfile(props: {
  value: ProjectDefaults;
  onChange(value: ProjectDefaults): void;
}) {
  const { value, onChange } = props;
  const current = value.browserProfileScope ?? inherit;
  return (
    <div role="group" aria-label="Browser" className="grid gap-1">
      <h3 className="text-sm font-medium text-muted-foreground">Browser</h3>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <span aria-hidden className="text-sm text-muted-foreground">
          Profile
        </span>
        <Select
          label="Browser profile"
          className="w-56"
          value={current}
          options={options}
          onValueChange={(picked) => {
            const next = { ...value };
            delete next.browserProfileScope;
            const scope: BrowserProfileScope | undefined = projectBrowserProfiles.find(
              (profile) => (profile.value ?? inherit) === picked,
            )?.value;
            onChange(scope ? { ...next, browserProfileScope: scope } : next);
          }}
        />
      </div>
      <p className="text-xs text-subtle-foreground">
        {notes[current]} Applies to browsers opened after you save.
      </p>
    </div>
  );
}
