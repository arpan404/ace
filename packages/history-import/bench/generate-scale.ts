import { resolve } from "node:path";
import { scaleFixture } from "./scale-fixture.ts";
import { databaseFixture } from "./database-fixture.ts";
const destination = process.argv[2];
if (!destination?.startsWith("/")) throw new Error("Expected scratch destination");
const fixture = await scaleFixture(resolve(destination));
databaseFixture(destination, fixture.cwd);
