import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
const { path, task } = z
  .object({ path: z.string(), task: z.enum(["integrity", "pages"]) })
  .parse({ path: process.argv[2], task: process.argv[3] });
let db: DatabaseSync | undefined;
try {
  db = new DatabaseSync(path, { readOnly: true, timeout: 200 });
  if (task === "integrity") {
    const rows = db.prepare("PRAGMA integrity_check(1)").all();
    process.stdout.write(
      JSON.stringify(rows.length === 1 && rows[0]?.integrity_check === "ok" ? "ok" : "corrupt"),
    );
  } else {
    const count = z
      .object({ page_count: z.number().nonnegative() })
      .parse(db.prepare("PRAGMA page_count").get());
    const size = z
      .object({ page_size: z.number().nonnegative() })
      .parse(db.prepare("PRAGMA page_size").get());
    process.stdout.write(JSON.stringify(count.page_count * size.page_size));
  }
} catch (error) {
  const detail = z.object({ errcode: z.number().optional() }).safeParse(error);
  if (
    task === "integrity" &&
    detail.success &&
    (detail.data.errcode === 11 || detail.data.errcode === 26)
  )
    process.stdout.write(JSON.stringify("corrupt"));
  else {
    process.stdout.write(JSON.stringify("unavailable"));
    process.exitCode = 1;
  }
} finally {
  db?.close();
}
