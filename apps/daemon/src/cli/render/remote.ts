import { columns } from "./provider-columns.ts";

interface Profile {
  readonly name: string;
  readonly origin?: string | undefined;
  readonly relay?: { readonly url: string } | undefined;
  readonly label?: string | undefined;
}

/** `ace remote list`: the one in use marked, then the rest. Pure. */
export function remoteListLines(value: {
  readonly active: string;
  readonly profiles: readonly Profile[];
}): string[] {
  const rows: (string | undefined)[][] = [[mark("local", value.active), "local", "this machine"]];
  for (const profile of value.profiles)
    rows.push([mark(profile.name, value.active), profile.name, where(profile), profile.label]);
  return [
    ...columns(rows),
    ...(value.profiles.length
      ? []
      : ["", "Add another machine with ace remote add NAME --link URL."]),
  ];
}

export function remoteNames(value: { readonly profiles: readonly Profile[] }): string[] {
  return value.profiles.map((profile) => profile.name);
}

export function remoteAddedLine(profile: Profile): string {
  return `Added ${profile.name} (${where(profile)}). Use it with ace remote use ${profile.name}, or --remote ${profile.name}.`;
}

/** Where the machine is reached: its address, or the relay it was linked through. */
function where(profile: Profile): string {
  return profile.origin ?? (profile.relay ? `through ${profile.relay.url}` : "");
}

function mark(name: string, active: string): string {
  return name === active ? "*" : " ";
}
