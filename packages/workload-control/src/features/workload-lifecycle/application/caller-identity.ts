export interface LifecycleCallerIdentity {
  readonly namespaceId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const utf8 = new TextEncoder();

export function isWellFormedLifecycleText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export function encodeLifecycleTuple(parts: readonly string[]): string {
  if (parts.some((part) => !isWellFormedLifecycleText(part)))
    throw new RangeError("lifecycle_tuple_part_invalid");
  return `v1${parts
    .map((part) => `${String(utf8.encode(part).byteLength)}#${part}`)
    .join("")}`;
}

export function authenticatedCallerScope(
  principal: LifecycleCallerIdentity,
): string {
  return `caller:${encodeLifecycleTuple([
    principal.tenantId,
    principal.namespaceId,
    principal.principalId,
  ])}`;
}

export function lifecycleOperationId(
  kind: "cancel" | "submit",
  callerScope: string,
  idempotencyKey: string,
): string {
  return `${kind}:${encodeLifecycleTuple([callerScope, idempotencyKey])}`;
}

export function lifecycleIdempotencyStorageKey(
  callerScope: string,
  idempotencyKey: string,
): string {
  return encodeLifecycleTuple([callerScope, idempotencyKey]);
}
