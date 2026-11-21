import { describe, expect, it } from "vitest";
import { botSchemaAddress, readRecipe } from "@ace/marketplace";
import { CliBotStarter } from "@ace/protocol/cli-outputs";
import { scaffold } from "./scaffold.ts";

/** `ace bot init`'s bot.json, parsed. */
function botJson(kind: CliBotStarter) {
  const file = scaffold("Fare watcher", kind).find((one) => one.path === "bot.json");
  return {
    text: file?.text ?? "",
    json: JSON.parse(file?.text ?? "null") as Record<string, unknown>,
  };
}

describe("ace bot init's bot.json", () => {
  it.each(CliBotStarter.options)(
    "a %s package points editors at the format's schema and names its spec version",
    (kind) => {
      const { text, json } = botJson(kind);
      expect(json["$schema"]).toBe(botSchemaAddress);
      expect(botSchemaAddress).toBe("https://spec.acehq.dev/1.0/bot.schema.json");
      expect(json["spec"]).toBe("1.0");
      // The reader keeps both as fields it knows: nothing is left "not used by this Spade".
      const read = readRecipe(text, new Set([`skills/fare-watcher`]), { spade: "0.0.25" });
      expect(read.problems).toEqual([]);
      expect(read.recipe?.extra).toBeUndefined();
    },
  );
});
