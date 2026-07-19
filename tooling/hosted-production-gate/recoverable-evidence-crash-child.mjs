import { readFile } from "node:fs/promises";

import { finalizeCleanedControlState } from "./cleanup-finalization.mjs";
import { cleanupHost } from "./host-cleanup.mjs";
import { writeRecoverableJsonAtomically } from "./recoverable-json.mjs";
import { validateResidue } from "./residue.mjs";

const [contextPath, residuePath, targetName, boundary] = process.argv.slice(2);
if (
  process.argv.length !== 6 ||
  !new Set([
    "host-cleanup.json",
    "host-state-evidence.json",
    "residue.json",
  ]).has(targetName) ||
  !new Set(["after", "before", "during"]).has(boundary)
)
  throw new Error("crash_fixture_arguments_invalid");

const context = JSON.parse(await readFile(contextPath, "utf8"));
const residue = JSON.parse(await readFile(residuePath, "utf8"));
const kill = () => process.kill(process.pid, "SIGKILL");
const writeEvidence = (path, value, options = {}) => {
  const operations = path.endsWith(`/${targetName}`)
    ? boundary === "before"
      ? { beforeCreate: kill }
      : boundary === "during"
        ? {
            write: async (descriptor, bytes) => {
              await descriptor.writeFile(
                bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
              );
              await descriptor.sync();
              kill();
            },
          }
        : { afterRename: kill }
    : undefined;
  return writeRecoverableJsonAtomically(path, value, {
    ...options,
    operations,
  });
};

await cleanupHost(context, {
  finalizeState: (state) =>
    finalizeCleanedControlState(state, {
      expectedGid: process.getgid?.(),
      expectedUid: process.getuid?.(),
    }),
  proveRuntimeAbsent: async () => undefined,
  proveZeroResidue: async (candidateContext, options) => {
    await options.writeEvidence(
      `${candidateContext.artifactRoot}/residue.json`,
      residue,
      {
        acceptExisting: (candidate) => {
          validateResidue(candidate, candidateContext);
          return true;
        },
        mode: 0o444,
      },
    );
    return residue;
  },
  recoverChild: async () => undefined,
  writeEvidence,
});
