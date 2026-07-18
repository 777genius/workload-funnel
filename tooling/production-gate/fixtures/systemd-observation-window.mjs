import { access } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

import { exactSystemdObservationWindowInput } from "../systemd-observation-window-contract.mjs";

const marker = process.argv[2];
const timeoutMs = Number(process.argv[3]);

if (!exactSystemdObservationWindowInput(marker, timeoutMs)) process.exit(2);

const deadline = Date.now() + timeoutMs;
for (;;) {
  try {
    await access(marker);
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") process.exit(3);
  }
  if (Date.now() >= deadline) process.exit(4);
  await wait(10);
}
