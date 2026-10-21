import { z } from "zod";

/*
 * The facts a list row shows beyond its title, read from what a search already returned: label
 * colours and people's avatars. Anything malformed is left out of the row, never fatal.
 */

const hex = /^[0-9a-fA-F]{6}$/;
const Label = z.looseObject({ name: z.string().max(256), color: z.unknown().optional() });
const Person = z.looseObject({ login: z.string().max(100), avatar_url: z.unknown().optional() });

/** Each label's colour by name, for the labels GitHub gave one. */
export function labelColors(labels: readonly unknown[]): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const value of labels) {
    const label = Label.safeParse(value);
    if (label.success && typeof label.data.color === "string" && hex.test(label.data.color))
      colors[label.data.name] = label.data.color;
  }
  return colors;
}

/** Logins of `people` that parse, in order. */
export function logins(people: readonly unknown[] | undefined): string[] {
  return (people ?? []).flatMap((value) => {
    const person = Person.safeParse(value);
    return person.success ? [person.data.login] : [];
  });
}

/** Avatars by login for REST users (`avatar_url`) and GraphQL users (`avatarUrl`). */
export function avatars(people: readonly unknown[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const value of people) {
    const person = z
      .looseObject({
        login: z.string().max(100),
        avatar_url: z.string().max(4096).optional().catch(undefined),
        avatarUrl: z.string().max(4096).optional().catch(undefined),
      })
      .safeParse(value);
    const url = person.success ? (person.data.avatar_url ?? person.data.avatarUrl) : undefined;
    if (person.success && url) found[person.data.login] = url;
  }
  return found;
}
