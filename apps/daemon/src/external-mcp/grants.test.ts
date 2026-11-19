import { expect, test } from "vitest";
import { endedListed } from "./grants.ts";
import { draft, grantFixture } from "./grant-test-support.ts";

test("every live grant is listed however many ended grants came after it", () => {
  const f = grantFixture();
  const old = f.grants.create(draft({ name: "Oldest live" }));
  for (let i = 0; i < endedListed + 5; i++) {
    f.clock.now += 1;
    const ended = f.grants.create(draft({ name: `Ended ${i}` }));
    f.grants.revoke(ended.id);
  }
  f.clock.now += 1;
  const expired = f.grants.create(draft({ expiresAt: f.clock.now + 1 }));
  f.clock.now += 2;
  const listed = f.grants.list();
  expect(listed[0]?.id).toBe(old.id);
  expect(listed.filter((grant) => grant.revokedAt === null && grant.id !== expired.id)).toEqual([
    expect.objectContaining({ id: old.id }),
  ]);
  // The newest ended grants, the expired one first, up to the limit.
  expect(listed).toHaveLength(1 + endedListed);
  expect(listed[1]?.id).toBe(expired.id);
  expect(f.grants.liveGrants().map((grant) => grant.id)).toEqual([old.id]);
});
