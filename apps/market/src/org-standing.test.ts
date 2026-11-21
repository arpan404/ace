import { expect, it } from "vitest";
import { askOrgStanding } from "./org-standing.ts";

/*
 * The market's question to the account backend about an org grant (ADR 0206 §6): asked of the
 * configured address with the market's own token, and nothing but that address's own answer
 * counts.
 */

const route = { url: "https://cloud.example/v1/grants/standing", token: "t".repeat(43) };
const yes = () => Response.json({ current: true, role: "member" });

/** A fetch that does what the platform's does: follows a redirect unless told not to. */
function platform(answer: (url: string, init: RequestInit) => Response) {
  const asked: string[] = [];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push(url);
    const response = answer(url, init);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location && init.redirect !== "manual")
      return fetcher(new URL(location, url).toString(), init);
    return response;
  };
  return { fetcher, asked };
}

it("asks the configured address with the market's token", async () => {
  const seen: (string | null)[] = [];
  const { fetcher } = platform((_url, init) => {
    seen.push(new Headers(init.headers).get("authorization"));
    return yes();
  });
  expect(await askOrgStanding(route, fetcher, "grant")).toEqual({ current: true });
  expect(seen).toEqual([`Bearer ${route.token}`]);
});

it("takes no answer from where a redirect points", async () => {
  const { fetcher, asked } = platform((url) =>
    url === route.url
      ? new Response(null, { status: 307, headers: { location: "https://elsewhere.example/yes" } })
      : yes(),
  );
  expect(await askOrgStanding(route, fetcher, "grant")).toBeUndefined();
  expect(asked).toEqual([route.url]);
});

it("asks nothing without an address and a token", async () => {
  const { fetcher, asked } = platform(yes);
  expect(
    await askOrgStanding({ url: route.url, token: undefined }, fetcher, "grant"),
  ).toBeUndefined();
  expect(
    await askOrgStanding({ url: undefined, token: route.token }, fetcher, "grant"),
  ).toBeUndefined();
  expect(asked).toEqual([]);
});
