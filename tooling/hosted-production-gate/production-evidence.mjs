import { Buffer } from "node:buffer";

import {
  PRODUCTION_GATE_SCHEMA,
  REQUIRED_PRODUCTION_COMPONENTS,
} from "./constants.mjs";
import { HostedGateRefusal, sha256 } from "./contract.mjs";

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

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function validateProductionEvidence(evidence, context) {
  exactObject(
    evidence,
    [
      "components",
      "evidenceDigest",
      "finishedAt",
      "host",
      "overallVerdict",
      "privilegedStartsEnabled",
      "productionStartsEnabled",
      "runId",
      "schemaVersion",
      "startedAt",
      "syntheticEvidenceAcceptedForRealFields",
    ],
    "production_evidence_schema_invalid",
  );
  refuse(
    evidence.schemaVersion !== PRODUCTION_GATE_SCHEMA ||
      evidence.runId !== context.runId ||
      evidence.overallVerdict !== "PASS" ||
      evidence.productionStartsEnabled !== false ||
      evidence.privilegedStartsEnabled !== false ||
      evidence.syntheticEvidenceAcceptedForRealFields !== false ||
      !validTimestamp(evidence.startedAt) ||
      !validTimestamp(evidence.finishedAt) ||
      Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt),
    "production_evidence_verdict_invalid",
  );
  const host = exactObject(
    evidence.host,
    [
      "architecture",
      "bootIdSha256",
      "hostname",
      "kernelRelease",
      "machineIdSha256",
      "reviewManifestSha256",
      "sourceTreeDigest",
    ],
    "production_evidence_host_invalid",
  );
  refuse(
    host.architecture !== "x64" ||
      typeof host.hostname !== "string" ||
      host.hostname.length < 1 ||
      typeof host.kernelRelease !== "string" ||
      host.kernelRelease.length < 1 ||
      !/^[a-f0-9]{64}$/u.test(host.bootIdSha256 ?? "") ||
      !/^[a-f0-9]{64}$/u.test(host.machineIdSha256 ?? "") ||
      !/^[a-f0-9]{64}$/u.test(host.reviewManifestSha256 ?? "") ||
      !/^sha256:[a-f0-9]{64}$/u.test(host.sourceTreeDigest ?? ""),
    "production_evidence_host_invalid",
  );
  refuse(
    !Array.isArray(evidence.components) ||
      evidence.components.length !== REQUIRED_PRODUCTION_COMPONENTS.length,
    "production_evidence_components_invalid",
  );
  for (const [index, component] of evidence.components.entries()) {
    exactObject(
      component,
      ["evidence", "id", "reasonCode", "status"],
      "production_evidence_component_invalid",
    );
    refuse(
      component.id !== REQUIRED_PRODUCTION_COMPONENTS[index] ||
        component.status !== "PASS" ||
        component.reasonCode !== null ||
        !Array.isArray(component.evidence) ||
        component.evidence.length < 1,
      "production_evidence_component_invalid",
    );
    for (const record of component.evidence) {
      exactObject(
        record,
        ["detail", "id", "passed", "source"],
        "production_evidence_record_invalid",
      );
      refuse(
        !/^[a-z0-9_]{1,128}$/u.test(record.id ?? "") ||
          record.passed !== true ||
          record.source !== "real",
        "production_evidence_record_invalid",
      );
    }
  }
  const { evidenceDigest, ...unsigned } = evidence;
  refuse(
    evidenceDigest !==
      `sha256:${sha256(Buffer.from(JSON.stringify(unsigned)))}`,
    "production_evidence_digest_invalid",
  );
  return evidence;
}
