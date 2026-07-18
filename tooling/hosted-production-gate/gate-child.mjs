import { hostedContext } from "./contract.mjs";
import { gateArguments } from "./gate-invocation.mjs";
import {
  finishGateChild,
  readGateChildIdentity,
  startGateChild,
} from "./gate-child-state.mjs";
import { readHostState } from "./host-state.mjs";

const invocation = process.argv[2];
const context = hostedContext(process.env);
let state = await readHostState(context);
const planned = state.gateInvocations.find((item) => item.id === invocation);
if (process.env.WF_HOSTED_GATE_CHILD_MARKER !== planned?.marker)
  throw new Error("gate_child_marker_invalid");
const identity = await readGateChildIdentity(process.pid);
if (identity === undefined) throw new Error("gate_child_identity_missing");
await startGateChild(context, invocation, identity);
state = await readHostState(context);
process.env.WF_PRODUCTION_GATE_DISPOSABLE_HOST_ATTESTATION =
  "I_ATTEST_THIS_IS_A_DISPOSABLE_HOST_WITH_NO_USER_PROJECTS";
process.env.WF_PRODUCTION_GATE_REVIEW_MANIFEST_SHA256 = state.manifest.sha256;
process.argv = [
  state.executables.node,
  ...gateArguments(state, invocation === "gate" ? "run" : "recover-cleanup"),
];
await import(`${state.reviewRoot}/tooling/production-gate/run.mjs`);
const exitCode = Number.isSafeInteger(process.exitCode) ? process.exitCode : 0;
await finishGateChild(await readHostState(context), invocation, {
  exitCode,
  outcome: "completed",
});
