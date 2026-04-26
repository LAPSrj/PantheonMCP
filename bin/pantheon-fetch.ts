#!/usr/bin/env bun
import { runFetch } from "../src/cli/fetch.ts";

runFetch({ args: process.argv.slice(2) })
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `pantheon-fetch: fatal: ${(err as Error).message ?? String(err)}\n`,
    );
    process.exit(1);
  });
