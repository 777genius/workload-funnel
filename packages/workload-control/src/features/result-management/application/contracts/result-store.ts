import type { ResultManifest } from "../../domain/result-manifest.js";

export interface ResultStore {
  create(manifest: ResultManifest): ResultManifest;
  getByAttempt(attemptId: string): ResultManifest | undefined;
  get(resultManifestId: string): ResultManifest | undefined;
  save(manifest: ResultManifest, expectedVersion: number): ResultManifest;
}
