import type { ResultManifest } from "../domain/result-manifest.js";

export interface ResultCompletionReceipt {
  readonly operationId: string;
  readonly resultManifestId: string;
  readonly manifestVersion: number;
  readonly terminalCandidate: "succeeded" | "publication_failure";
  readonly reason: "complete" | "required_output_missing";
}

export function decideResultCompletion(
  manifest: ResultManifest,
  requiredPaths: readonly string[],
): ResultCompletionReceipt {
  const paths = new Set(manifest.entries.map((entry) => entry.path));
  const complete =
    manifest.complete && requiredPaths.every((path) => paths.has(path));
  return Object.freeze({
    manifestVersion: manifest.version,
    operationId: `result-completion:${manifest.resultManifestId}:${String(manifest.version)}`,
    reason: complete ? "complete" : "required_output_missing",
    resultManifestId: manifest.resultManifestId,
    terminalCandidate: complete ? "succeeded" : "publication_failure",
  });
}
