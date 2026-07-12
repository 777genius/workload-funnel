# Threat model: System or feature name

- Status: Draft
- Owners: Owning feature and security reviewer
- Last reviewed: YYYY-MM-DD
- Architecture references: Section(s), ADR(s), and invariant ID(s)
- Production gate: Closed until named evidence passes

## Scope and security objectives

Define the workload, deployment profiles, data, operations, and failure domains
covered. State the safety properties that must remain true under compromise or
partial failure.

## Out of scope

List excluded systems and assumptions. Exclusion must not transfer a required
WorkloadFunnel invariant to an untrusted caller.

## Assets and sensitive data

| Asset   | Owner   | Confidentiality | Integrity   | Availability | Retention |
| ------- | ------- | --------------- | ----------- | ------------ | --------- |
| Example | Feature | Requirement     | Requirement | Requirement  | Policy    |

## Trust boundaries and actors

Describe authenticated callers, tenants, unprivileged services, privileged
services, stores, external adapters, operators, and attacker capabilities. Add
a data-flow diagram when review would otherwise miss a boundary.

## Entry points and data flows

For every entry point, record authentication, authorization, input schema,
idempotency/fencing data, secret handling, logging, and the final side-effect
authority.

## Threat analysis

| ID     | Boundary or asset | Threat              | Preconditions       | Impact  | Control    | Evidence       | Residual risk |
| ------ | ----------------- | ------------------- | ------------------- | ------- | ---------- | -------------- | ------------- |
| TM-001 | Example           | STRIDE-style threat | Attacker capability | Outcome | Mitigation | Test or review | Accepted risk |

At minimum cover spoofed identity or tenant, tampering and stale fences, replay
and duplicate delivery, repudiation/audit gaps, secret disclosure, denial of
service and resource exhaustion, privilege escalation, ambiguous side effects,
dependency/supply-chain compromise, and unsafe recovery or rollback.

## Abuse and failure cases

Include malformed structured requests, cross-tenant access, forged or stale
receipts, crash boundaries, compromised adapters, unavailable dependencies,
secret-bearing output, disk/queue exhaustion, and operator mistakes. State the
fail-closed result for every unavailable required capability.

## Security controls and verification

Map each control to executable tests, architecture checks, schema validation,
dependency review, deployment configuration, monitoring, and an owner. A named
control without evidence does not open a production gate.

## Residual risks and approvals

List accepted risk, expiry/review dates, approvers, and compensating controls.
Record unresolved critical/high findings as closed production gates.

## Change history

Record reviews that alter trust boundaries, authoritative writers, credentials,
secret flow, lifecycle guarantees, or production-gate status.
