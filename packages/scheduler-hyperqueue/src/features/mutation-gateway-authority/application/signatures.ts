import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  SchedulerFenceInstallAcknowledgementClaims,
  SchedulerFenceInstallClaims,
  SignedSchedulerFenceInstall,
  SignedSchedulerFenceInstallAcknowledgement,
} from "../domain/gateway-contract.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function signature(claims: unknown, key: Uint8Array): string {
  return createHmac("sha256", key)
    .update(canonical(claims), "utf8")
    .digest("base64url");
}

function immutableSnapshot<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item))
      return;
    for (const nested of Object.values(item)) freeze(nested);
    Object.freeze(item);
  };
  freeze(cloned);
  return cloned;
}

function matches(
  claims: unknown,
  signatureValue: string,
  key: Uint8Array,
): boolean {
  const expected = Buffer.from(signature(claims, key), "base64url");
  const actual = Buffer.from(signatureValue, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function signSchedulerFenceInstall(
  claims: SchedulerFenceInstallClaims,
  key: Uint8Array,
): SignedSchedulerFenceInstall {
  const immutableClaims = immutableSnapshot(claims);
  return Object.freeze({
    claims: immutableClaims,
    signatureBase64Url: signature(immutableClaims, key),
  });
}

export function verifySchedulerFenceInstallSignature(
  request: SignedSchedulerFenceInstall,
  key: Uint8Array,
): boolean {
  return matches(request.claims, request.signatureBase64Url, key);
}

export function signSchedulerFenceInstallAcknowledgement(
  claims: SchedulerFenceInstallAcknowledgementClaims,
  key: Uint8Array,
): SignedSchedulerFenceInstallAcknowledgement {
  const immutableClaims = immutableSnapshot(claims);
  return Object.freeze({
    claims: immutableClaims,
    signatureBase64Url: signature(immutableClaims, key),
  });
}

export function verifySchedulerFenceInstallAcknowledgement(
  acknowledgement: SignedSchedulerFenceInstallAcknowledgement,
  key: Uint8Array,
): boolean {
  return matches(
    acknowledgement.claims,
    acknowledgement.signatureBase64Url,
    key,
  );
}
