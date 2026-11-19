import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * Web search settings in the fake Spade API (spade/docs/design.md, Web search): the person's
 * SearXNG address and whether a Brave Search key is stored. The key itself is never kept.
 */

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);

export class FakeSpadeSearch {
  searxngUrl: string | null = null;
  braveKeySet = false;

  /** `GET`/`PUT /v1/search` and `PUT`/`DELETE /v1/search/brave-key`. */
  route(method: string, sub: string | undefined, body: Json, keychain: boolean): FakeSpadeAnswer {
    if (sub === "brave-key") {
      if (!keychain)
        return problem(503, "This machine has no keychain; set BRAVE_API_KEY instead.");
      if (method === "PUT") {
        if (typeof body.key !== "string" || !body.key.trim())
          return problem(400, "the key is empty");
        this.braveKeySet = true;
        return { status: 204 };
      }
      if (method === "DELETE") {
        if (!this.braveKeySet) return problem(404, "no Brave Search key is stored");
        this.braveKeySet = false;
        return { status: 204 };
      }
      return problem(405, "Not allowed.");
    }
    if (sub !== undefined) return problem(404, "Not found.");
    if (method === "PUT") {
      const url = typeof body.searxng_url === "string" ? body.searxng_url.trim() : "";
      if (url && !/^https?:\/\/[^/]+/.test(url))
        return problem(400, "the SearXNG address must start with http:// or https://");
      this.searxngUrl = url ? (url.endsWith("/") ? url : `${url}/`) : null;
    } else if (method !== "GET") return problem(405, "Not allowed.");
    return reply({ searxng_url: this.searxngUrl, brave_key_set: this.braveKeySet, keychain });
  }
}
