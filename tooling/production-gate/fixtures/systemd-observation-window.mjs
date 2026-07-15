import { access } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

const marker = process.argv[2];
const timeoutMs = Number(process.argv[3]);

if (
  !/^\/var\/lib\/workload-funnel\/allocations\/wf-production-gate-[a-f0-9]{32}\/\.observed-[a-z0-9-]{1,24}$/u.test(
    marker ?? "",
  ) ||
  !Number.isSafeInteger(timeoutMs) ||
  timeoutMs < 1 ||
  timeoutMs > 4_000
)
  process.exit(2);

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
