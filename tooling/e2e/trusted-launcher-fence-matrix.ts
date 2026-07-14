import type { MutationFence } from "@workload-funnel/kernel";

import { TrustedSyntheticLauncher } from "./trusted-synthetic-launcher.js";

export function exerciseTrustedLauncherFenceMatrix(
  directory: string,
  processFence: MutationFence,
) {
  const launcher = new TrustedSyntheticLauncher(directory);
  const authority = Object.freeze({
    ...processFence,
    namespaceWriterEpoch: 3,
    ownerFence: 2,
  });
  launcher.install(authority);
  launcher.restart();
  return Object.freeze({
    externalStartCount: () => launcher.externalStartCount,
    lower: launcher.attemptStart(
      Object.freeze({ ...authority, ownerFence: 1 }),
    ),
    mismatch: launcher.attemptStart(
      Object.freeze({
        ...authority,
        clusterIncarnation: "equal-version-mismatched-cluster",
      }),
    ),
    missing: launcher.attemptTamperedStart(authority, "ownerFence"),
    stale: launcher.attemptStart(
      Object.freeze({ ...authority, namespaceWriterEpoch: 2 }),
    ),
  });
}
