import type { AdmissionReasonCode } from "@workload-funnel/workload-control/tenant-admission";

export interface AuthenticatedIdentity {
  readonly principalId: string;
  readonly credentialId: string;
  readonly authenticatedAt: number;
}

export type ApiPermission =
  | "workload.submit"
  | "workload.observe"
  | "workload.cancel"
  | "operation.observe"
  | "result.observe"
  | "capacity.observe"
  | "explanation.observe"
  | "events.observe"
  | "consumer.manage"
  | "retention.manage"
  | "erasure.manage"
  | "audit.observe"
  | "reconciliation.observe"
  | "metrics.observe";

export interface TenantGrant {
  readonly tenantId: string;
  readonly permissions: ReadonlySet<ApiPermission>;
  readonly allowedWorkloadProfiles?: ReadonlySet<string>;
  readonly maximumCpuMillis?: number;
  readonly maximumMemoryMiB?: number;
}

export interface PrincipalAuthorizationPolicy {
  readonly principalId: string;
  readonly policyVersion: number;
  readonly tenantGrants: readonly TenantGrant[];
}

export interface AuthorizedRequestContext {
  readonly principalId: string;
  readonly effectiveTenantId: string;
  readonly credentialId: string;
  readonly permission: ApiPermission;
  readonly authorizationPolicyVersion: number;
  readonly authenticatedAt: number;
}

export interface AuthorizationRequest {
  readonly requestedTenantScope: string;
  readonly permission: ApiPermission;
  readonly workloadProfile?: string;
  readonly cpuMillis?: number;
  readonly memoryMiB?: number;
}

export interface AuthorizationService {
  authorize(
    identity: AuthenticatedIdentity,
    request: AuthorizationRequest,
  ): AuthorizedRequestContext;
}

export class AuthorizationDeniedError extends Error {
  public readonly code = "permission_denied";
  public readonly reason: AdmissionReasonCode | "tenant_scope_denied";

  public constructor(
    reason: AdmissionReasonCode | "tenant_scope_denied" = "tenant_scope_denied",
  ) {
    super(reason);
    this.name = "AuthorizationDeniedError";
    this.reason = reason;
  }
}

const supportedPermissions = new Set<ApiPermission>([
  "workload.submit",
  "workload.observe",
  "workload.cancel",
  "operation.observe",
  "result.observe",
  "capacity.observe",
  "explanation.observe",
  "events.observe",
  "consumer.manage",
  "retention.manage",
  "erasure.manage",
  "audit.observe",
  "reconciliation.observe",
  "metrics.observe",
]);

function boundedIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
}

export function createAuthorizationService(
  policies: readonly PrincipalAuthorizationPolicy[],
): AuthorizationService {
  if (
    new Set(policies.map((policy) => policy.principalId)).size !==
    policies.length
  )
    throw new Error("duplicate_principal_authorization_policy");
  for (const policy of policies) {
    if (
      !boundedIdentity(policy.principalId) ||
      !Number.isSafeInteger(policy.policyVersion) ||
      policy.policyVersion < 1
    )
      throw new Error("invalid_authorization_policy_version");
    if (
      new Set(policy.tenantGrants.map((grant) => grant.tenantId)).size !==
      policy.tenantGrants.length
    )
      throw new Error("duplicate_tenant_authorization_grant");
    for (const grant of policy.tenantGrants) {
      if (
        !boundedIdentity(grant.tenantId) ||
        [...grant.permissions].some(
          (permission) => !supportedPermissions.has(permission),
        ) ||
        (grant.allowedWorkloadProfiles !== undefined &&
          [...grant.allowedWorkloadProfiles].some(
            (profile) => !boundedIdentity(profile),
          )) ||
        (grant.maximumCpuMillis !== undefined &&
          (!Number.isSafeInteger(grant.maximumCpuMillis) ||
            grant.maximumCpuMillis < 1)) ||
        (grant.maximumMemoryMiB !== undefined &&
          (!Number.isSafeInteger(grant.maximumMemoryMiB) ||
            grant.maximumMemoryMiB < 1))
      )
        throw new Error("invalid_tenant_authorization_grant");
    }
  }
  const stablePolicies = policies.map((policy) =>
    Object.freeze({
      ...policy,
      tenantGrants: Object.freeze(
        policy.tenantGrants.map((grant) =>
          Object.freeze({
            ...grant,
            ...(grant.allowedWorkloadProfiles === undefined
              ? {}
              : {
                  allowedWorkloadProfiles: new Set(
                    grant.allowedWorkloadProfiles,
                  ),
                }),
            permissions: new Set(grant.permissions),
          }),
        ),
      ),
    }),
  );
  const byPrincipal = new Map(
    stablePolicies.map((policy) => [policy.principalId, policy] as const),
  );
  const service: AuthorizationService = {
    authorize(identity, request) {
      const policy = byPrincipal.get(identity.principalId);
      const grant = policy?.tenantGrants.find(
        (candidate) => candidate.tenantId === request.requestedTenantScope,
      );
      if (policy === undefined || grant === undefined)
        throw new AuthorizationDeniedError();
      if (!grant.permissions.has(request.permission))
        throw new AuthorizationDeniedError();
      if (
        request.workloadProfile !== undefined &&
        !grant.allowedWorkloadProfiles?.has(request.workloadProfile)
      )
        throw new AuthorizationDeniedError("missing_capability");
      if (
        (request.cpuMillis !== undefined &&
          (grant.maximumCpuMillis === undefined ||
            request.cpuMillis > grant.maximumCpuMillis)) ||
        (request.memoryMiB !== undefined &&
          (grant.maximumMemoryMiB === undefined ||
            request.memoryMiB > grant.maximumMemoryMiB))
      )
        throw new AuthorizationDeniedError("tenant_resource_quota");
      return Object.freeze({
        authenticatedAt: identity.authenticatedAt,
        authorizationPolicyVersion: policy.policyVersion,
        credentialId: identity.credentialId,
        effectiveTenantId: grant.tenantId,
        permission: request.permission,
        principalId: identity.principalId,
      });
    },
  };
  return Object.freeze(service);
}
