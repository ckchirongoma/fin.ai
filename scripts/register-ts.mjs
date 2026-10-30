// Registers the .js → .ts resolver. Used via `node --import ./scripts/register-ts.mjs`.
// See scripts/ts-resolve.mjs for why this exists.
import { register } from "node:module";
register("./ts-resolve.mjs", import.meta.url);
