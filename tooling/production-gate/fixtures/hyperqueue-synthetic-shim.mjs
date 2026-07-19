#!/usr/bin/env node

import { setInterval } from "node:timers";

const args = process.argv.slice(2);
if (
  args.length !== 8 ||
  args[0] !== "--protocol" ||
  args[1] !== "phase7.scheduler-shim.v1" ||
  args[2] !== "--invocation-base64" ||
  !/^[A-Za-z0-9_-]{1,349526}$/u.test(args[3]) ||
  args[4] !== "--restart-policy" ||
  args[5] !== "never" ||
  args[6] !== "--mapping-fingerprint" ||
  !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(args[7])
)
  process.exit(64);

setInterval(() => undefined, 1_000);
