import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = process.cwd();
const gatewayRoot = resolve(
  root,
  "apps/scheduler-mutation-gateway/src/features",
);
const schedulerRoot = resolve(
  root,
  "packages/scheduler-hyperqueue/src/features",
);

function fail(message) {
  throw new Error(`ARCH-013/030 Phase 7 HyperQueue boundary: ${message}`);
}

function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...filesBelow(path));
    else files.push(path);
  }
  return files;
}

function productionSources(directory) {
  return filesBelow(directory).filter(
    (path) =>
      (path.endsWith(".ts") || path.endsWith(".mjs")) &&
      !path.includes("/tests/") &&
      !path.includes("/dist/") &&
      !path.includes("/node_modules/"),
  );
}

const expectedSchedulerFeatures = [
  "capability-discovery",
  "dispatch-cancellation",
  "dispatch-observation",
  "dispatch-submission",
  "hyperqueue-cli-mutation",
  "hyperqueue-reconciliation",
  "mutation-gateway-authority",
  "operation-lookup",
  "worker-inventory",
];
const schedulerFeatures = readdirSync(schedulerRoot)
  .filter((entry) => statSync(resolve(schedulerRoot, entry)).isDirectory())
  .sort();
if (schedulerFeatures.join("\n") !== expectedSchedulerFeatures.join("\n"))
  fail("scheduler feature inventory is not the closed Phase 7 set");

const expectedGatewayFeatures = [
  "authority-installation",
  "authority-registry",
  "composition",
  "hyperqueue-mutation-boundary",
  "recovery",
];
const gatewayFeatures = readdirSync(gatewayRoot)
  .filter((entry) => statSync(resolve(gatewayRoot, entry)).isDirectory())
  .sort();
if (gatewayFeatures.join("\n") !== expectedGatewayFeatures.join("\n"))
  fail("gateway feature inventory is not the closed Phase 7 set");

const production = [
  ...productionSources(schedulerRoot),
  ...productionSources(gatewayRoot),
];
const allProduction = [
  ...productionSources(resolve(root, "apps")),
  ...productionSources(resolve(root, "packages")),
];
const processMutationSources = production.filter((path) => {
  const source = readFileSync(path, "utf8");
  return /node:child_process|\bexecFile\b/u.test(source);
});
const soleMutationBoundary = resolve(
  gatewayRoot,
  "hyperqueue-mutation-boundary/index.ts",
);
if (
  processMutationSources.length !== 1 ||
  processMutationSources[0] !== soleMutationBoundary
)
  fail(
    `HyperQueue process mutation escaped the sole gateway boundary: ${processMutationSources
      .map((path) => relative(root, path))
      .join(", ")}`,
  );

for (const path of allProduction) {
  const source = readFileSync(path, "utf8");
  if (
    /mutationServerDirectory|--server-dir/u.test(source) &&
    path !== soleMutationBoundary
  )
    fail(`scheduler mutation credential leaked to ${relative(root, path)}`);
}

const cliMutationContractConsumers = allProduction.filter((path) =>
  readFileSync(path, "utf8").includes(
    "@workload-funnel/scheduler-hyperqueue/hyperqueue-cli-mutation",
  ),
);
if (
  cliMutationContractConsumers.length !== 1 ||
  cliMutationContractConsumers[0] !== soleMutationBoundary
)
  fail(
    `final CLI contract escaped the sole gateway boundary: ${cliMutationContractConsumers
      .map((path) => relative(root, path))
      .join(", ")}`,
  );

const highWatermarkPolicy = readFileSync(
  resolve(
    schedulerRoot,
    "mutation-gateway-authority/application/cross-scope-high-watermarks.ts",
  ),
  "utf8",
);
for (const component of [
  "allocation_owner",
  "attempt_revocation",
  "cluster",
  "desired_effect",
  "namespace",
  "operation_gate",
  "scheduler_instance",
]) {
  if (!highWatermarkPolicy.includes(`"${component}"`))
    fail(`cross-scope authority omits ${component}`);
}
const gatewayRegistrySources = productionSources(
  resolve(gatewayRoot, "authority-registry"),
)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
for (const required of [
  "authorityHighWatermarks",
  "assertCurrentCrossScopeAuthority",
  "schedulerAuthoritySerializationKeys",
]) {
  if (!gatewayRegistrySources.includes(required))
    fail(`durable final-boundary authority omits ${required}`);
}

const capabilitySource = readFileSync(
  resolve(schedulerRoot, "capability-discovery/index.ts"),
  "utf8",
);
for (const required of [
  "approvedProductionChecksum: null",
  "approvedProductionVersion: null",
  "ambiguousLiveSubmitCancellationProven: false",
  "ambiguousSubmitLookupProven: false",
  "cancellationProcessTreeProven: false",
  "credentialCustodyProven: false",
  "durableObservationSequenceProven: true",
  "fallbackExecutionTested: false",
  "mappingCreateOnlyProven: false",
  "neverRestartProven: false",
  'operationNameContract: "workload-funnel.hq-operation-name.v1"',
  "productionPolicyProfileApproved: false",
  "productionEnabled: false",
  "replayClassMappingApproved: false",
  "securityReviewApproved: false",
  "upstreamRiskDecisionApproved: false",
  "unresolvedOperationRetentionProven: false",
]) {
  if (!capabilitySource.includes(required))
    fail(`fail-closed research capability is missing ${required}`);
}

const fixedRoots = [
  resolve(
    root,
    "apps/control-service/src/generated/composition.control-postgres.ts",
  ),
  resolve(
    root,
    "apps/control-service/src/generated/composition.control-sqlite.ts",
  ),
];
for (const path of fixedRoots) {
  if (/hyperqueue/u.test(readFileSync(path, "utf8")))
    fail(`fixed Phase 0/1 root imports HyperQueue: ${relative(root, path)}`);
}

console.log(
  `ARCH-013/030 Phase 7 HyperQueue boundary passed (${production.length} production sources)`,
);
