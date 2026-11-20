// oxlint-disable react/no-array-index-key -- ordered runs of one string.
import type { AskedLine } from "@ace/protocol";
import { Fragment, type ReactNode } from "react";
import { PictureChip } from "./picture-chip.tsx";
import { addresseePicture, devicePicture } from "./token-picture.ts";
import type { MentionPicture } from "./mention-mark.tsx";

interface Named {
  label: string;
  picture: MentionPicture;
  detail?: string | undefined;
  offline?: boolean | undefined;
}

/** What a line named, each as its chip's words: `@Research`, `@Fix login`, `@omarchy`. */
function namedOf(line: AskedLine): Named[] {
  return [
    ...line.to.map(({ to }) => ({
      label: `@${to.kind === "agent" ? to.title : to.name}`,
      picture: addresseePicture(to),
    })),
    ...line.devices.map((device) => ({
      label: `@${device.name}`,
      picture: devicePicture(device),
      detail: device.machine.here ? "On this machine" : `On ${device.machine.name}`,
      offline: !device.online,
    })),
  ].toSorted((a, b) => b.label.length - a.label.length);
}

/**
 * The person's words with each name the line knows drawn as its chip, where it was written;
 * a name it doesn't know (a device that went away) stays the plain words it was typed as.
 */
export function namedChips(line: AskedLine | undefined): ((text: string) => ReactNode) | undefined {
  if (!line) return undefined;
  const named = namedOf(line);
  if (!named.length) return undefined;
  return (text) => {
    const out: ReactNode[] = [];
    let rest = text;
    while (rest) {
      let at = -1;
      let found: Named | undefined;
      for (const each of named) {
        const index = rest.indexOf(each.label);
        if (index >= 0 && (at < 0 || index < at)) {
          at = index;
          found = each;
        }
      }
      if (!found) {
        out.push(rest);
        break;
      }
      if (at > 0) out.push(rest.slice(0, at));
      out.push(
        <PictureChip
          name={found.label}
          picture={found.picture}
          detail={found.detail}
          offline={found.offline}
        />,
      );
      rest = rest.slice(at + found.label.length);
    }
    return out.map((node, index) => <Fragment key={index}>{node}</Fragment>);
  };
}
