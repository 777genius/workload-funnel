import type { ResultManifest } from "../../domain/result-manifest.js";

export interface ResultStore {
  create(manifest: ResultManifest): ResultManifest;
  getByAttempt(attemptId: string): ResultManifest | undefined;
}
