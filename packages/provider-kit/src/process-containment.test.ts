import { describe, expect, test } from "vitest";
import {
  createKillOnCloseJob,
  createRetainedJob,
  type WindowsJobApi,
} from "./process-containment.ts";

function fixture(
  options: { arm?: boolean; join?: boolean; handle?: unknown; closeFails?: boolean } = {},
) {
  const jobHandle = { kind: "job" };
  const processHandle = { kind: "process" };
  const state = {
    held: false,
    processHeld: false,
    loaded: true,
    failUnload: false,
    members: 0,
    failClose: options.closeFails ?? false,
  };
  const api: WindowsJobApi = {
    create() {
      const handle = Object.hasOwn(options, "handle") ? options.handle : jobHandle;
      state.held = handle === jobHandle;
      return handle;
    },
    setKillOnClose: () => options.arm ?? true,
    openProcess() {
      state.processHeld = true;
      return processHandle;
    },
    assignProcess() {
      if (options.join === false) return false;
      state.members++;
      return true;
    },
    close(handle) {
      if (handle === processHandle) {
        if (!state.processHeld) throw new Error("Process handle closed twice");
        state.processHeld = false;
      } else if (handle === jobHandle) {
        if (!state.held) throw new Error("Job handle closed twice");
        if (state.failClose) throw new Error("close denied");
        state.held = false;
        state.members = 0;
      } else throw new Error("Invalid close");
    },
    activeCount: () => state.members,
    terminate() {
      state.members = 0;
    },
    unload() {
      if (state.failUnload) throw new Error("unload denied");
      state.loaded = false;
    },
  };
  return { api, state };
}

describe.runIf(process.platform === "win32")("Windows job containment", () => {
  test("a retained job owns descendants until termination even after its leader leaves", () => {
    const { api, state } = fixture();
    const job = createRetainedJob(() => api);
    job.assign(4242);
    state.members = 2;
    state.members--; // The leader exits; one descendant remains.
    expect(job.activeCount()).toBe(1);
    expect(state.processHeld).toBe(false);
    job.terminate();
    expect(job.activeCount()).toBe(0);
    job.dispose();
    expect(state.held).toBe(false);
    expect(state.loaded).toBe(false);
  });

  test("a denied assignment is visible and releases the process handle", () => {
    const { api, state } = fixture({ join: false });
    const job = createRetainedJob(() => api);
    expect(() => job.assign(4242)).toThrow("assignment failed");
    expect(state.processHeld).toBe(false);
    expect(job.activeCount()).toBe(0);
    job.dispose();
  });

  test("failed job setup closes the created handle and unloads the library", () => {
    const { api, state } = fixture({ arm: false });
    expect(() => createRetainedJob(() => api)).toThrow("setup failed");
    expect(state.held).toBe(false);
    expect(state.loaded).toBe(false);
  });

  test.each([null, undefined, 0, 0n])(
    "a null job cannot masquerade as containment: %s",
    (handle) => {
      const { api, state } = fixture({ handle });
      expect(() => createRetainedJob(() => api)).toThrow("creation failed");
      expect(state.held).toBe(false);
      expect(state.loaded).toBe(false);
    },
  );

  test("a failed close keeps ownership available for a later shutdown retry", () => {
    const { api, state } = fixture({ closeFails: true });
    const job = createRetainedJob(() => api);
    job.assign(4242);
    expect(() => job.dispose()).toThrow("close denied");
    expect(state.held).toBe(true);
    expect(state.loaded).toBe(true);
    expect(job.activeCount()).toBe(1);
    state.failClose = false;
    job.dispose();
    job.dispose();
    expect(state.held).toBe(false);
    expect(state.loaded).toBe(false);
    expect(() => job.assign(4242)).toThrow("closed");
  });

  test("optional containment keeps the existing tree fallback on setup and join failure", () => {
    const failed = fixture({ arm: false });
    expect(createKillOnCloseJob(() => failed.api)).toBeUndefined();
    expect(failed.state.held).toBe(false);
    const denied = fixture({ join: false });
    const job = createKillOnCloseJob(() => denied.api);
    expect(job).toBeDefined();
    expect(() => job?.assign(4242)).not.toThrow();
    job?.dispose();
    expect(denied.state.held).toBe(false);
  });

  test("a failed library unload retries without reopening or double-closing the job", () => {
    const { api, state } = fixture();
    const job = createRetainedJob(() => api);
    state.failUnload = true;
    expect(() => job.dispose()).toThrow("unload denied");
    expect(state.held).toBe(false);
    expect(state.loaded).toBe(true);
    expect(() => job.activeCount()).toThrow("closed");
    state.failUnload = false;
    job.dispose();
    expect(state.loaded).toBe(false);
  });
});
