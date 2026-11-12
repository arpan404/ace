import { listNames } from "../list-names.ts";
import type { MapFix, MapNode } from "./map-types.ts";

/*
 * What the Fleet map says around its facts: each fix's button, a node's state in a word or two,
 * what signing in on a paired device gives, and the question asked before turning off a network
 * something reaches a machine over. Shared by the web's map and the phone's list. Pure.
 */

/** Each fix's button. */
export const fixWords: Record<MapFix, string> = {
  enterCode: "Enter code",
  openAccount: "Try again",
  turnOnLan: "Turn on local network",
  turnOnRemote: "Turn on remote access",
  reconnect: "Try again",
  removeMachine: "Remove",
  forgetMachine: "Forget",
  removeDevice: "Remove",
  askSignIn: "Ask it to sign in",
};

/** A fix's button. Opening an account machine nothing is wrong with is "Open", not a retry. */
export function fixLabel(node: Pick<MapNode, "problem">, fix: MapFix): string {
  return fix === "openAccount" && !node.problem ? "Open" : fixWords[fix];
}

/** The fixes a node offers, the first being the primary one; an offer when nothing's wrong. */
export function nodeFixes(node: Pick<MapNode, "problem" | "offer">): readonly MapFix[] {
  return node.problem?.fixes ?? (node.offer ? [node.offer] : []);
}

/** A node's state beside its dot: connected, needs you, can't connect, else what it says. */
export function nodeStateWords(node: Pick<MapNode, "tone" | "status">): string {
  switch (node.tone) {
    case "on":
      return "Connected";
    case "warn":
      return "Needs you";
    case "bad":
      return "Can't connect";
    case "unknown":
      return node.status;
  }
}

/** What "Ask it to sign in" says to do on a paired device. */
export function signInHint(device: string): string {
  return `Open app.acehq.dev on ${device} and sign in with your ace account. It then reaches every machine from anywhere, with no code.`;
}

/** A question asked before a change that can disconnect something. */
export interface NetworkOffQuestion {
  title: string;
  body: string;
  confirm: string;
}

/**
 * The question before turning a network off on a machine while devices or machines reach it
 * now; undefined when nothing does, so it turns off at once. `where` is "this computer" or the
 * machine's name.
 */
export function networkOffQuestion(input: {
  network: string;
  where: string;
  dependents: readonly string[];
}): NetworkOffQuestion | undefined {
  if (input.dependents.length === 0) return undefined;
  return {
    title: `Turn off ${input.network} on ${input.where}?`,
    body: `${listNames(input.dependents)} may disconnect until they can reach ${input.where} another way.`,
    confirm: "Turn off",
  };
}

/**
 * The question before removing a paired device from every machine it's on. `viewer` is what
 * disconnects when it's the device asking: "This window", "This iPhone".
 */
export function removeDeviceQuestion(
  device: { name: string; self: boolean },
  viewer: string,
): NetworkOffQuestion {
  return {
    title: `Remove ${device.name}?`,
    body: device.self
      ? `This is the device you're using. ${viewer} disconnects at once and has to be paired again.`
      : "It disconnects at once and has to be paired again to see or steer threads.",
    confirm: "Remove",
  };
}
