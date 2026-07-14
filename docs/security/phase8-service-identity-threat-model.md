# Phase 8 service identity threat model

## Assets and trust boundaries

The durable identity authority protects service-to-service principal binding,
node enrollment, credential generation, revocation revision, node boot epoch,
and replay cursor. Certificate private keys and CA signing keys remain secret
references managed by the deployment environment; they are never stored in a
workload specification, event, result manifest, test fixture, or this
repository.

The control-service transport authenticates the certificate before mapping the
identity to a node or service audience. HyperQueue transport identity is not a
WorkloadFunnel authorization source. The unprivileged node agent has no CA,
ticket-signing, systemd, result-sealing, scheduler, or artifact-retention
credential.

## Required controls

- Enrollment verifies a fresh signed authorization decision from an allowlisted
  actor key before writing anything. The pending record durably binds the actor,
  evidence digest, canonical node, and exact credential fingerprint that may be
  approved.
- Node identities bind exactly one `nodeId`; service identities cannot claim a
  node binding.
- Credentials are short-lived and unique by ID, certificate fingerprint, and
  serial. Rotation immediately rejects the superseded credential.
- Revocation and quarantine increase a monotonic revision and prevent
  authentication before application authorization runs.
- The authority issues the boot epoch. Node messages must match it and advance a
  durable source sequence with a fresh nonce.
- Exact operation retry returns the recorded outcome. Reusing an operation ID
  with different bytes, replaying a message sequence, or using an old boot
  epoch fails closed.
- The production identity store must declare durable authenticated writes,
  multi-writer CAS, and recovery. An absent or weaker capability prevents
  multi-node enablement.

## Synthetic adversarial evidence

The Phase 8 identity tests cover tampered actor decisions, unauthenticated
preclaim, cross-node and cross-credential substitution, old boot replay,
duplicate message replay across authority reconstruction, operation-ID
conflict, credential rotation, revocation/quarantine, and incapable store
startup. Test credentials contain fingerprints and serial labels only, never
secret key material.
