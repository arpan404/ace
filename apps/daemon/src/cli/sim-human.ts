import { z } from "zod";
import type { CliSimVerb } from "@ace/protocol";

type Node = {
  ref?: string | undefined;
  role: string;
  name: string;
  value?: string | undefined;
  children: Node[];
};
const Node: z.ZodType<Node> = z.lazy(() =>
  z.looseObject({
    ref: z.string().optional(),
    role: z.string(),
    name: z.string(),
    value: z.string().optional(),
    children: z.array(Node),
  }),
);
const Tree = z.looseObject({ nodes: z.array(Node), truncated: z.boolean() });
const Listed = z.looseObject({
  devices: z.array(z.looseObject({ id: z.string(), name: z.string(), state: z.string() })),
});
const State = z.looseObject({
  simId: z.string(),
  name: z.string(),
  lifecycle: z.string(),
  controller: z.string(),
  guide: z.string().optional(),
});
const Shot = z.looseObject({
  path: z.string(),
  width: z.number(),
  height: z.number(),
  scale: z.number(),
});
const Lines = z.looseObject({ lines: z.array(z.string()) });
const Acted = z.looseObject({ ref: z.string(), role: z.string(), name: z.string() });
const Clipboard = z.looseObject({ text: z.string(), truncated: z.boolean() });

function outline(nodes: Node[], depth: number, lines: string[]): void {
  for (const node of nodes) {
    const parts = [node.ref, node.role, node.name ? JSON.stringify(node.name) : undefined];
    if (node.value && node.value !== node.name) parts.push(`= ${JSON.stringify(node.value)}`);
    lines.push(`${"  ".repeat(depth)}${parts.filter(Boolean).join(" ")}`);
    outline(node.children, depth + 1, lines);
  }
}

/** Pure: the short human form of an `ace sim` result; anything unrecognised stays JSON. */
export function simHuman(verb: CliSimVerb, data: unknown): string {
  const fallback = () => JSON.stringify(data);
  switch (verb) {
    case "list": {
      const listed = Listed.safeParse(data);
      if (!listed.success) return fallback();
      return (
        listed.data.devices
          .map((device) => `${device.id}  ${device.name}  ${device.state}`)
          .join("\n") || "No simulators or emulators."
      );
    }
    case "start":
    case "stop": {
      const state = State.safeParse(data);
      if (!state.success) return fallback();
      const { simId, name, lifecycle, controller, guide } = state.data;
      return [`${simId} ${name}: ${lifecycle}, controller ${controller}`, guide]
        .filter(Boolean)
        .join("\n");
    }
    case "ui": {
      const tree = Tree.safeParse(data);
      if (!tree.success) return fallback();
      const lines: string[] = [];
      outline(tree.data.nodes, 0, lines);
      if (tree.data.truncated) lines.push("(truncated: narrow with a NAME, --text or --role)");
      return lines.join("\n") || "No elements.";
    }
    case "act": {
      const clipboard = Clipboard.safeParse(data);
      if (clipboard.success)
        return `${clipboard.data.text}${clipboard.data.truncated ? "\n(truncated)" : ""}`;
      const acted = Acted.safeParse(data);
      return acted.success
        ? `ok ${acted.data.ref} ${acted.data.role}${acted.data.name ? ` ${JSON.stringify(acted.data.name)}` : ""}`
        : "ok";
    }
    case "screenshot": {
      const shot = Shot.safeParse(data);
      return shot.success
        ? `${shot.data.path} (${shot.data.width}x${shot.data.height}; divide pixels by ${shot.data.scale} for points)`
        : fallback();
    }
    case "logs": {
      const logs = Lines.safeParse(data);
      return logs.success ? logs.data.lines.join("\n") : fallback();
    }
  }
}
