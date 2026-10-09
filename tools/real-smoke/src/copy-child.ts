import { z } from "zod";
import { copyHome } from "./copy-home.ts";
const [source, scratch] = z.tuple([z.string(), z.string()]).parse(process.argv.slice(2));
process.stdout.write(JSON.stringify(await copyHome(source, scratch)));
