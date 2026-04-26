#!/usr/bin/env bun
import { runFetch } from "../src/cli/fetch.ts";
import { assertNoLegacyLayout, LegacyLayoutError } from "../src/storage/index.ts";

try {
  assertNoLegacyLayout();
} catch (err) {
  if (err instanceof LegacyLayoutError) {
    process.stderr.write(err.message + "\n");
    process.exit(1);
  }
  throw err;
}

runFetch({ args: process.argv.slice(2) })
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `pantheon-fetch: fatal: ${(err as Error).message ?? String(err)}\n`,
    );
    process.exit(1);
  });
