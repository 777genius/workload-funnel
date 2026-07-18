import { isDeepStrictEqual } from "node:util";

import {
  ARCHITECTURE_PLAN_SHA256,
  PINNED_IMAGES,
  PRODUCTION_GATE_RECOVERY_SCHEMA,
} from "./constants.mjs";
import { HostedGateRefusal } from "./contract.mjs";

function refuse(condition, code) {
  if (condition) throw new HostedGateRefusal(code);
}

function exactObject(value, keys, code) {
  const expected = new Set(keys);
  refuse(
    value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== expected.size ||
      Object.keys(value).some((key) => !expected.has(key)),
    code,
  );
  return value;
}

function validateReviewTuple(review, evidence) {
  exactObject(
    review,
    [
      "architecturePlanSha256",
      "executables",
      "host",
      "images",
      "manifestSha256",
      "reviewId",
      "reviewedFileCount",
      "runtimeModuleLinks",
      "sourceTreeDigest",
    ],
    "cleanup_recovery_review_invalid",
  );
  const expectedHost = {
    architecture: evidence.host.architecture,
    bootIdSha256: evidence.host.bootIdSha256,
    kernelRelease: evidence.host.kernelRelease,
    machineIdSha256: evidence.host.machineIdSha256,
  };
  refuse(
    review.architecturePlanSha256 !== ARCHITECTURE_PLAN_SHA256 ||
      review.manifestSha256 !== evidence.host.reviewManifestSha256 ||
      review.sourceTreeDigest !== evidence.host.sourceTreeDigest ||
      !isDeepStrictEqual(review.host, expectedHost) ||
      !isDeepStrictEqual(review.images, PINNED_IMAGES) ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(review.reviewId ?? "") ||
      !Number.isSafeInteger(review.reviewedFileCount) ||
      review.reviewedFileCount < 1 ||
      !Array.isArray(review.executables) ||
      review.executables.length < 1 ||
      !Array.isArray(review.runtimeModuleLinks) ||
      review.runtimeModuleLinks.length !== 2,
    "cleanup_recovery_review_invalid",
  );
}

export function validateRecoveryDocuments(documents, evidence, context) {
  refuse(
    !Array.isArray(documents) || documents.length !== 2,
    "cleanup_recovery_inventory_invalid",
  );
  let tuple;
  for (const document of documents) {
    exactObject(
      document,
      ["cleanup", "host", "review", "runId", "schemaVersion"],
      "cleanup_recovery_schema_invalid",
    );
    refuse(
      document.schemaVersion !== PRODUCTION_GATE_RECOVERY_SCHEMA ||
        document.runId !== context.runId ||
        !isDeepStrictEqual(document.host, evidence.host),
      "cleanup_recovery_tuple_invalid",
    );
    validateReviewTuple(document.review, evidence);
    const cleanup = exactObject(
      document.cleanup,
      ["certain", "outcomes", "pending"],
      "cleanup_recovery_result_invalid",
    );
    refuse(
      cleanup.certain !== true ||
        !Array.isArray(cleanup.outcomes) ||
        !Array.isArray(cleanup.pending) ||
        cleanup.pending.length !== 0,
      "cleanup_recovery_result_invalid",
    );
    for (const outcome of cleanup.outcomes) {
      exactObject(
        outcome,
        ["kind", "name", "status"],
        "cleanup_recovery_outcome_invalid",
      );
      refuse(
        outcome.status !== "removed" ||
          typeof outcome.kind !== "string" ||
          typeof outcome.name !== "string" ||
          !outcome.name.startsWith(context.runId),
        "cleanup_recovery_outcome_invalid",
      );
    }
    const observedTuple = {
      host: document.host,
      review: document.review,
      runId: document.runId,
    };
    if (tuple === undefined) tuple = observedTuple;
    else
      refuse(
        !isDeepStrictEqual(tuple, observedTuple),
        "cleanup_recovery_tuple_invalid",
      );
  }
  return documents;
}
