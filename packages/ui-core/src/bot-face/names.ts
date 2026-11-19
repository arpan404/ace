import { botFaceFieldOrder, type BotBody, type BotFace, type BotFaceValue } from "./model.ts";

/** Names that suit each creature; a round head goes by its ears instead. */
const bodyNames: Record<Exclude<BotBody, "round">, readonly string[]> = {
  blob: ["Mochi", "Blip", "Gummy", "Dot", "Jelly"],
  pebble: ["Pebble", "Flint", "Cobble", "Skip", "Rocco"],
  sprout: ["Fern", "Sprig", "Basil", "Clover", "Sorrel"],
  ghost: ["Wisp", "Boo", "Misty", "Glim", "Vesper"],
  bot: ["Bolt", "Gizmo", "Servo", "Widget", "Unit"],
  fox: ["Rusty", "Fennec", "Ember", "Tod", "Vixey"],
  bird: ["Pip", "Robin", "Tweet", "Finch", "Lark"],
  cloud: ["Nimbus", "Puff", "Cirrus", "Fluff", "Drizzle"],
  bean: ["Bean", "Pinto", "Lima", "Nib", "Jellybean"],
};
const earNames: Record<BotFaceValue<"ears">, readonly string[]> = {
  none: ["Scout", "Juno", "Otto", "Milo", "Indy"],
  cat: ["Miso", "Tofu", "Pounce", "Whisk", "Mittens"],
  bear: ["Bruno", "Honey", "Cub", "Barley", "Teddy"],
  bunny: ["Clover", "Hop", "Bun", "Bramble", "Dandelion"],
  tuft: ["Tuft", "Swirl", "Coco", "Curly", "Quill"],
  nubs: ["Imp", "Nibs", "Puck", "Gremlin", "Jinx"],
};

/**
 * Up to `count` names that suit the face, leaving out `except` (the name it has). The same face
 * always suggests the same names, so they don't jump while the person types.
 */
export function suggestBotNames(face: BotFace, except = "", count = 3): string[] {
  const list = face.body === "round" ? earNames[face.ears] : bodyNames[face.body];
  const key = botFaceFieldOrder.map((field) => face[field]).join(",");
  let hash = 7;
  for (const char of key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const out: string[] = [];
  for (let index = 0; out.length < count && index < list.length; index++) {
    const name = list[(hash + index) % list.length] ?? "";
    if (name && name.toLowerCase() !== except.trim().toLowerCase()) out.push(name);
  }
  return out;
}
