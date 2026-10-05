import { expect, it } from "vitest";
import { z } from "zod";
import { setup, executablePath } from "./parity-test-support.ts";
it.skipIf(!executablePath)(
  "inspection returns filtered inline entries and redacts completed responses",
  async () => {
    const f = await setup();
    const Logs = z.object({
      entries: z.array(
        z.object({
          text: z.string(),
          url: z.string().optional(),
          requestId: z.string().optional(),
          status: z.number().optional(),
        }),
      ),
    });
    await expect
      .poll(
        async () =>
          Logs.parse(await f.execute({ action: "logs", kind: "network", status: 201 })).entries
            .length,
      )
      .toBe(1);
    const response = Logs.parse(await f.execute({ action: "logs", url: "/body", status: 201 }))
      .entries[0];
    expect(response?.requestId).toBeTruthy();
    await expect
      .poll(async () => {
        try {
          return z
            .object({ body: z.string() })
            .parse(await f.execute({ action: "network_body", requestId: response?.requestId }))
            .body.includes("body-marker");
        } catch {
          return false;
        }
      })
      .toBe(true);
    const body = z
      .object({ body: z.string() })
      .parse(await f.execute({ action: "network_body", requestId: response?.requestId }));
    expect(body.body).toContain("body-marker");
    expect(body.body).not.toContain("secret-value");
    await expect
      .poll(
        async () =>
          Logs.parse(
            await f.execute({ action: "logs", kind: "network", url: "/frame", status: 200 }),
          ).entries.filter((entry) => entry.url?.startsWith("http://localhost:")).length,
      )
      .toBe(1);
    const crossFrame = Logs.parse(
      await f.execute({ action: "logs", kind: "network", url: "/frame", status: 200 }),
    ).entries.find((entry) => entry.url?.startsWith("http://localhost:"));
    await expect
      .poll(async () => {
        try {
          return z
            .object({ body: z.string() })
            .parse(await f.execute({ action: "network_body", requestId: crossFrame?.requestId }))
            .body.includes("Frame input");
        } catch {
          return false;
        }
      })
      .toBe(true);
    expect(
      z
        .object({ body: z.string() })
        .parse(await f.execute({ action: "network_body", requestId: crossFrame?.requestId })).body,
    ).toContain("Frame input");
    await f.evaluate("fetch('/failed').catch(()=>undefined)");
    await expect
      .poll(
        async () =>
          Logs.parse(
            await f.execute({ action: "logs", kind: "network", level: "failed", url: "/failed" }),
          ).entries.length,
      )
      .toBeGreaterThan(0);
    const original = f.service.state("thread").activeTabId;
    await f.execute({ action: "tabs", operation: "open" });
    await f.execute({ action: "tabs", operation: "close", tabId: original });
    await expect(
      f.execute({ action: "network_body", requestId: response?.requestId }),
    ).rejects.toThrow(/unavailable/);

    expect(
      Logs.parse(await f.execute({ action: "logs", level: "warning" })).entries[0]?.text,
    ).toContain("console-marker");
  },
);
it.skipIf(!executablePath)(
  "oversized response bodies and evicted inspection entries are unavailable",
  async () => {
    const f = await setup();
    const Logs = z.object({
      entries: z.array(z.object({ requestId: z.string().optional(), url: z.string().optional() })),
    });
    await f.evaluate("fetch('/retained?old').then(r=>r.text())");
    const old = Logs.parse(
      await f.execute({ action: "logs", url: "/retained?old", kind: "network" }),
    ).entries[0]?.requestId;
    expect(old).toBeTruthy();
    expect(await f.execute({ action: "network_body", requestId: old })).toMatchObject({
      body: "retention-marker",
    });
    await f.evaluate("fetch('/large').then(r=>r.text()).then(s=>s.length)");
    const large = Logs.parse(await f.execute({ action: "logs", url: "/large", kind: "network" }))
      .entries[0]?.requestId;
    expect(large).toBeTruthy();
    await expect(f.execute({ action: "network_body", requestId: large })).rejects.toThrow(/limit/);
    await f.evaluate(
      "(async()=>{for(let n=0;n<205;n++) await fetch('/retained?'+n).then(r=>r.text());return true})()",
    );
    await expect(f.execute({ action: "network_body", requestId: old })).rejects.toThrow(
      /unavailable/,
    );
    const retained = Logs.parse(await f.execute({ action: "logs", limit: 200 })).entries;
    expect(retained).toHaveLength(200);
    expect(retained.some((entry) => entry.requestId === old)).toBe(false);
    expect(Logs.parse(await f.execute({ action: "logs", limit: 3 })).entries).toHaveLength(3);
  },
);
