---
"@workload-funnel/dispatcher-local": minor
"@workload-funnel/node-execution": minor
"@workload-funnel/scheduler-hyperqueue": minor
"@workload-funnel/scheduler-mutation-gateway": minor
"@workload-funnel/workload-control": minor
---

Add the fail-closed Phase 7 HyperQueue adapter, synchronous node-owned shim,
sole-credential mutation gateway, complete-fence receipts, and crash-safe
unknown reconciliation without approving a production HyperQueue pin. The
gateway persists applicable cross-scope authority maxima so a newer cluster,
namespace, gate, Allocation owner, Attempt revocation, or desired effect fences
stale dispatch scopes before the final CLI call, including after restart.
