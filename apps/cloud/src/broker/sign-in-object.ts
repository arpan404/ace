import { DurableObject } from "cloudflare:workers";
import { appOf, begin, callback, finish, nextExpiry, prune } from "./sign-ins.ts";
import type { Book, CallbackVerdict, FinishVerdict, SignIn } from "./sign-ins.ts";
import type { SignInDirectory, SignInStore } from "./store.ts";
import { stateRoute } from "./store.ts";

const BOOK = "book";

/**
 * One account's sign-ins in progress (ADR 0141), named by the account id. Its storage holds at
 * most five sign-ins and only until each runs out: an alarm at the next expiry drops them, and
 * the object's storage is emptied once none are left. Calls run one at a time, so a code is
 * handed out once. The Worker passes its clock with each call.
 */
export class SignInObject extends DurableObject implements SignInStore {
  private async change<T>(apply: (book: Book) => { book: Book; verdict: T }): Promise<T> {
    const before = (await this.ctx.storage.get<Book>(BOOK)) ?? [];
    const { book, verdict } = apply(before);
    if (book !== before) await this.keep(book);
    return verdict;
  }

  private async keep(book: Book): Promise<void> {
    if (book.length === 0) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.put(BOOK, book);
    const next = nextExpiry(book);
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
  }

  async begin(signIn: SignIn, now: number): Promise<void> {
    await this.change((book) => ({ book: begin(book, signIn, now), verdict: undefined }));
  }

  async appOf(state: string): Promise<string | undefined> {
    return appOf((await this.ctx.storage.get<Book>(BOOK)) ?? [], state);
  }

  callback(input: Parameters<SignInStore["callback"]>[0], now: number): Promise<CallbackVerdict> {
    return this.change((book) => callback(book, input, now));
  }

  finish(input: Parameters<SignInStore["finish"]>[0], now: number): Promise<FinishVerdict> {
    return this.change((book) => finish(book, input, now));
  }

  /** Drops what ran out; the runtime retries an alarm that throws. */
  override async alarm(): Promise<void> {
    const book = (await this.ctx.storage.get<Book>(BOOK)) ?? [];
    await this.keep(prune(book, Date.now()));
  }
}

/** Each account's object, and the route its OAuth states carry: the object's id, not the account. */
export function durableSignIns(namespace: DurableObjectNamespace<SignInObject>): SignInDirectory {
  return {
    forAccount(account) {
      const id = namespace.idFromName(account);
      return { store: namespace.get(id), route: id.toString() };
    },
    forState(state) {
      const route = stateRoute(state);
      if (!route) return undefined;
      try {
        return namespace.get(namespace.idFromString(route));
      } catch {
        return undefined;
      }
    },
  };
}
