import { describe, expect, test } from "vitest";
import { ClientError } from "@ace/client";
import { HostCallError } from "@ace/native-host";
import { accountCredential, accountGate, machineCodeRefusal } from "./account-machine.ts";

const grant = (token: string) => async () => JSON.stringify({ grant: token });

describe("account machine credential", () => {
  test("presents the relay socket's grant, then the typed code until the daemon welcomes it", async () => {
    const gate = accountGate(grant("g1"));
    const credential = accountCredential(gate);
    expect(await credential()).toEqual({ grant: "g1" });
    gate.refused("machine_code_required");
    expect(gate.asking).toBe("machine_code_required");
    gate.enter("2468");
    expect(await credential()).toEqual({ grant: "g1", machineCode: "2468" });
    gate.welcomed();
    expect(await credential()).toEqual({ grant: "g1" });
  });

  test("a wrong code is forgotten and the daemon's reason is asked again", async () => {
    const gate = accountGate(grant("g1"));
    gate.enter("1111");
    gate.refused("machine_code_wrong");
    expect(gate.asking).toBe("machine_code_wrong");
    expect(await accountCredential(gate)()).toEqual({ grant: "g1" });
  });

  test("a grant the phone can't fetch offline retries; a signed-out phone stops", async () => {
    const offline = accountCredential(
      accountGate(async () => Promise.reject(new HostCallError("credential", "offline"))),
    );
    await expect(offline()).rejects.toMatchObject({ code: "offline" });
    const signedOut = accountCredential(
      accountGate(async () => Promise.reject(new HostCallError("credential", "invalid"))),
    );
    const failure = await signedOut().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClientError);
    expect(failure).toMatchObject({ code: "auth" });
  });
});

describe("machine code refusals", () => {
  test("reads the daemon's refusal frame and nothing else", () => {
    expect(
      machineCodeRefusal(
        JSON.stringify({ type: "error", code: "machine_code_locked", message: "Try later." }),
      ),
    ).toBe("machine_code_locked");
    expect(
      machineCodeRefusal(JSON.stringify({ type: "error", code: "unauthorized", message: "No." })),
    ).toBeUndefined();
    expect(
      machineCodeRefusal(JSON.stringify({ type: "welcome", note: "machine_code_required" })),
    ).toBeUndefined();
    expect(machineCodeRefusal("not json machine_code_wrong")).toBeUndefined();
  });
});
