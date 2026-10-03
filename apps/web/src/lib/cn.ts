import { createCn } from "cn/engine";
import tables from "./cn-tables.gen.ts";

/**
 * Class merging that knows the app's type scale (`cn-extension.ts`). Import `cn` from here,
 * never from the `cn` package. The merge tables are compiled ahead of time
 * (`bun run --filter @ace/web cn:tables`), so the page carries the small engine, not the
 * config compiler, and the first call does no table building.
 */
export const cn = createCn(tables);
