import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { PINNED_IMAGES, REVIEW_MANIFEST_SCHEMA } from "./constants.mjs";
import { HostedGateRefusal, validateTrustedIdentity } from "./contract.mjs";
import {
  collectReviewedFiles,
  inspectExecutable,
  inspectPathIdentity,
  sourceTreeDigest,
} from "./review-manifest.mjs";
import { verifyRuntimeCustody } from "./runtime-custody.mjs";

function refuse(condition, code) {
  if (condition) throw new HostedGateRefusal(code);
}

function exactFileInventory(expected, observed) {
  const inventory = new Map();
  for (const item of expected) {
    refuse(
      typeof item?.path !== "string" ||
        !/^[a-f0-9]{64}$/u.test(item?.sha256 ?? "") ||
        inventory.has(item.path),
      "invocation_review_inventory_invalid",
    );
    inventory.set(item.path, item.sha256);
  }
  refuse(
    inventory.size !== observed.length ||
      observed.some((item) => inventory.get(item.path) !== item.sha256),
    "invocation_review_file_drift",
  );
}

export async function verifyInvocationCustody(state) {
  const { executables, hqArchive, hostRoot, manifest, reviewRoot } = state;
  refuse(
    reviewRoot !== `${hostRoot}/source` ||
      hqArchive !== `${hostRoot}/fixtures/hq-v0.26.2-linux-x64.tar.gz` ||
      manifest?.path !== `${hostRoot}/review-manifest.json` ||
      !/^[a-f0-9]{64}$/u.test(manifest?.sha256 ?? "") ||
      executables === null ||
      typeof executables !== "object" ||
      Array.isArray(executables),
    "invocation_custody_state_invalid",
  );
  await verifyRuntimeCustody(state);
  const manifestIdentity = await inspectPathIdentity(manifest.path);
  refuse(
    manifestIdentity.kind !== "file" ||
      manifestIdentity.symlink === true ||
      manifestIdentity.canonicalPath !== manifest.path ||
      manifestIdentity.uid !== 0 ||
      manifestIdentity.gid !== 0 ||
      manifestIdentity.mode !== 0o400 ||
      manifestIdentity.sha256 !== manifest.sha256,
    "invocation_review_manifest_drift",
  );
  let decoded;
  try {
    decoded = JSON.parse(await readFile(manifest.path, "utf8"));
  } catch {
    throw new HostedGateRefusal("invocation_review_manifest_invalid");
  }
  refuse(
    decoded?.schemaVersion !== REVIEW_MANIFEST_SCHEMA ||
      !Array.isArray(decoded.reviewedFiles) ||
      !Array.isArray(decoded.executables) ||
      !isDeepStrictEqual(decoded.images, PINNED_IMAGES) ||
      decoded.sourceTreeDigest !== sourceTreeDigest(decoded.reviewedFiles),
    "invocation_review_manifest_invalid",
  );
  const reviewedFiles = [...(await collectReviewedFiles(reviewRoot))];
  const archiveIdentity = await inspectPathIdentity(hqArchive);
  refuse(
    archiveIdentity.kind !== "file" ||
      archiveIdentity.symlink === true ||
      archiveIdentity.canonicalPath !== hqArchive ||
      archiveIdentity.uid !== 0 ||
      archiveIdentity.gid !== 0 ||
      (archiveIdentity.mode & 0o222) !== 0,
    "invocation_hyperqueue_archive_drift",
  );
  reviewedFiles.push({ path: hqArchive, sha256: archiveIdentity.sha256 });
  exactFileInventory(decoded.reviewedFiles, reviewedFiles);
  refuse(
    sourceTreeDigest(reviewedFiles) !== decoded.sourceTreeDigest,
    "invocation_review_file_drift",
  );

  const expectedPaths = [...new Set(Object.values(executables))].sort();
  refuse(
    expectedPaths.length !== Object.keys(executables).length ||
      decoded.executables.length !== expectedPaths.length,
    "invocation_executable_inventory_invalid",
  );
  const manifestExecutables = new Map();
  for (const entry of decoded.executables) {
    refuse(
      typeof entry?.path !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry?.sha256 ?? "") ||
        manifestExecutables.has(entry.path),
      "invocation_executable_inventory_invalid",
    );
    manifestExecutables.set(entry.path, entry);
  }
  for (const path of expectedPaths) {
    const expected = manifestExecutables.get(path);
    refuse(expected === undefined, "invocation_executable_inventory_invalid");
    const identity = await inspectExecutable(path);
    validateTrustedIdentity(identity, {
      executable: true,
      expectedPath: path,
      expectedSha256: expected.sha256,
    });
    refuse(
      identity.uid !== expected.uid ||
        identity.gid !== expected.gid ||
        identity.mode !== expected.mode,
      "invocation_executable_identity_drift",
    );
  }
  refuse(
    !manifestExecutables.has(executables.node),
    "invocation_node_identity_missing",
  );
}
