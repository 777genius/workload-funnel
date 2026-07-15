import { createHash } from "node:crypto";

import { DECLARED_COMPONENTS, PRODUCTION_GATE_SCHEMA } from "./constants.mjs";

const secretKey =
  /(?:access.?key|authorization|credential|password|secret|token)/iu;

export function createRedactor(secretValues = []) {
  const secrets = new Set(secretValues.filter((value) => value.length > 0));
  const redact = (value, key = "") => {
    if (secretKey.test(key)) return "[REDACTED]";
    if (typeof value === "string") {
      let result = value;
      for (const secret of secrets)
        result = result.replaceAll(secret, "[REDACTED]");
      return result;
    }
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, redact(item, name)]),
      );
    return value;
  };
  return redact;
}

export function evidenceRecord(id, passed, detail, source = "real") {
  if (source !== "real" && source !== "synthetic")
    throw new Error("invalid_evidence_source");
  return Object.freeze({ detail, id, passed, source });
}

export function componentResult({ evidence, id, reasonCode, status }) {
  if (!DECLARED_COMPONENTS.includes(id))
    throw new Error("undeclared_gate_component");
  if (!new Set(["PASS", "BLOCKED", "UNSUPPORTED"]).has(status))
    throw new Error("invalid_component_status");
  if (
    status === "PASS" &&
    (evidence.length === 0 ||
      evidence.some((item) => !item.passed || item.source !== "real"))
  )
    throw new Error("real_evidence_required_for_component_pass");
  return Object.freeze({
    evidence: Object.freeze([...evidence]),
    id,
    reasonCode: status === "PASS" ? null : reasonCode,
    status,
  });
}

export function finalizeEvidence({
  components,
  finishedAt,
  host,
  runId,
  startedAt,
}) {
  if (
    components.length !== DECLARED_COMPONENTS.length ||
    components.some(
      (component, index) => component.id !== DECLARED_COMPONENTS[index],
    )
  )
    throw new Error("production_gate_component_inventory_incomplete");
  const overallVerdict = components.some((item) => item.status === "BLOCKED")
    ? "BLOCKED"
    : components.some((item) => item.status === "UNSUPPORTED")
      ? "UNSUPPORTED"
      : "PASS";
  const evidence = {
    components,
    finishedAt,
    host,
    overallVerdict,
    privilegedStartsEnabled: false,
    productionStartsEnabled: false,
    runId,
    schemaVersion: PRODUCTION_GATE_SCHEMA,
    startedAt,
    syntheticEvidenceAcceptedForRealFields: false,
  };
  return Object.freeze({
    ...evidence,
    evidenceDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(evidence), "utf8")
      .digest("hex")}`,
  });
}
