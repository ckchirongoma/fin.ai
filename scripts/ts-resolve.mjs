// Fin — letting Node run the TypeScript sources directly.
//
// The repo has no build step. Vercel transpiles each .ts file on its own and
// leaves import specifiers untouched, which means every relative import in
// api/ must already be written as "./thing.js" — write "./thing.ts" and it
// deploys as an import of a file that does not exist.
//
// Node's own type stripping does not do that rewrite in reverse: given
// "./thing.js" it looks for thing.js, finds nothing, and fails. So tests and
// scripts would either need a build step or a bundler.
//
// This resolver hook is the whole fix: when a relative specifier ends in .js
// and no such file exists but the .ts does, resolve to the .ts. Fifteen lines,
// no dependency, and it keeps the source honest — the specifiers stay exactly
// as production needs them.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const isRelative = (s) => /^\.{1,2}\//.test(s);
const isFileUrl = (s) => s.startsWith("file://");

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && (isRelative(specifier) || isFileUrl(specifier))) {
    const asTs = `${specifier.slice(0, -3)}.ts`;
    try {
      const candidate = isFileUrl(asTs) ? new URL(asTs) : new URL(asTs, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(asTs, context);
    } catch {
      // Not a resolvable URL; fall through to the default resolver.
    }
  }
  return nextResolve(specifier, context);
}
