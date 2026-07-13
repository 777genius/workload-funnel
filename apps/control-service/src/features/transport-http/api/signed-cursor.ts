import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CURSOR_CONTRACT_VERSION = "workload-funnel.cursor/v1" as const;

export interface CursorKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly sign: boolean;
}

export interface CursorKeyset {
  readonly keysetVersion: number;
  readonly keys: readonly CursorKey[];
}

export interface SignedCursorPayloadV1 {
  readonly contractVersion: typeof CURSOR_CONTRACT_VERSION;
  readonly keysetVersion: number;
  readonly keyId: string;
  readonly tenantId: string;
  readonly filtersDigest: string;
  readonly schemaVersion: 1;
  readonly partition: string;
  readonly snapshotWatermark: number;
  readonly streamPosition: number;
  readonly eventId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface CursorBinding {
  readonly tenantId: string;
  readonly filtersDigest: string;
  readonly schemaVersion: 1;
  readonly partition: string;
  readonly snapshotWatermark: number;
}

export interface SignedCursorCodec {
  encode(
    binding: CursorBinding,
    keyset: Readonly<{ streamPosition: number; eventId: string }>,
    now: number,
  ): string;
  decode(
    cursor: string,
    binding: CursorBinding,
    now: number,
  ): SignedCursorPayloadV1;
}

export class InvalidCursorError extends Error {
  public readonly code = "invalid_cursor";

  public constructor(message = "invalid_cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export class ExpiredCursorError extends Error {
  public readonly code = "cursor_expired";
  public readonly snapshotPath = "/v1/snapshots/workloads";

  public constructor() {
    super("cursor_expired");
    this.name = "ExpiredCursorError";
  }
}

function encodePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(secret: Uint8Array, encodedPayload: string): string {
  return createHmac("sha256", secret)
    .update(encodedPayload, "ascii")
    .digest("base64url");
}

function equalSignature(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function validateInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidCursorError();
}

export function cursorFiltersDigest(
  filters: Readonly<Record<string, string | readonly string[] | undefined>>,
): string {
  const normalized = Object.entries(filters)
    .flatMap(([key, value]) =>
      value === undefined
        ? []
        : [[key, typeof value === "string" ? value : [...value].sort()]],
    )
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function parsePayload(encoded: string): SignedCursorPayloadV1 {
  if (encoded.length > 4096) throw new InvalidCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new InvalidCursorError();
  const candidate = parsed as Partial<SignedCursorPayloadV1>;
  if (
    candidate.contractVersion !== CURSOR_CONTRACT_VERSION ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.keyId !== "string" ||
    typeof candidate.tenantId !== "string" ||
    typeof candidate.filtersDigest !== "string" ||
    typeof candidate.partition !== "string" ||
    typeof candidate.eventId !== "string" ||
    typeof candidate.keysetVersion !== "number" ||
    typeof candidate.snapshotWatermark !== "number" ||
    typeof candidate.streamPosition !== "number" ||
    typeof candidate.issuedAt !== "number" ||
    typeof candidate.expiresAt !== "number"
  )
    throw new InvalidCursorError();
  validateInteger(candidate.keysetVersion);
  validateInteger(candidate.snapshotWatermark);
  validateInteger(candidate.streamPosition);
  validateInteger(candidate.issuedAt);
  validateInteger(candidate.expiresAt);
  return candidate as SignedCursorPayloadV1;
}

export function createSignedCursorCodec(
  keyset: CursorKeyset,
  ttlMs: number,
): SignedCursorCodec {
  if (
    !Number.isSafeInteger(keyset.keysetVersion) ||
    keyset.keysetVersion < 1 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 604_800_000 ||
    keyset.keys.length < 1
  )
    throw new Error("invalid_cursor_keyset");
  if (new Set(keyset.keys.map((key) => key.keyId)).size !== keyset.keys.length)
    throw new Error("cursor_key_id_not_unique");
  for (const key of keyset.keys) {
    if (
      key.keyId.length < 1 ||
      key.keyId.length > 128 ||
      /\p{Cc}/u.test(key.keyId) ||
      key.secret.byteLength < 32 ||
      key.secret.byteLength > 4096 ||
      !Number.isSafeInteger(key.notBefore) ||
      key.notBefore < 0 ||
      !Number.isSafeInteger(key.notAfter) ||
      key.notAfter <= key.notBefore
    )
      throw new Error("invalid_cursor_key");
  }
  const stableKeys = keyset.keys.map((key) =>
    Object.freeze({ ...key, secret: new Uint8Array(key.secret) }),
  );
  const signingKeys = stableKeys.filter((key) => key.sign);
  if (signingKeys.length !== 1)
    throw new Error("cursor_signing_key_not_unique");
  const signingKey = signingKeys[0];
  if (signingKey === undefined) throw new Error("cursor_signing_key_missing");
  const byId = new Map(stableKeys.map((key) => [key.keyId, key] as const));
  const keysetVersion = keyset.keysetVersion;
  const codec: SignedCursorCodec = {
    decode(cursor, binding, now) {
      if (!Number.isSafeInteger(now) || now < 0 || cursor.length > 8192)
        throw new InvalidCursorError();
      const parts = cursor.split(".");
      if (
        parts.length !== 2 ||
        parts[0] === undefined ||
        parts[1] === undefined
      )
        throw new InvalidCursorError();
      const payload = parsePayload(parts[0]);
      const key = byId.get(payload.keyId);
      if (
        key === undefined ||
        payload.keysetVersion > keysetVersion ||
        !equalSignature(sign(key.secret, parts[0]), parts[1])
      )
        throw new InvalidCursorError();
      if (
        now < payload.issuedAt ||
        now < key.notBefore ||
        now > key.notAfter ||
        now > payload.expiresAt
      )
        throw new ExpiredCursorError();
      if (
        payload.tenantId !== binding.tenantId ||
        payload.filtersDigest !== binding.filtersDigest ||
        payload.partition !== binding.partition ||
        payload.snapshotWatermark !== binding.snapshotWatermark
      )
        throw new InvalidCursorError("cursor_binding_mismatch");
      return Object.freeze(payload);
    },
    encode(binding, after, now) {
      if (!Number.isSafeInteger(now) || now < 0)
        throw new Error("invalid_cursor_time");
      if (now < signingKey.notBefore || now > signingKey.notAfter)
        throw new Error("cursor_signing_key_inactive");
      validateInteger(binding.snapshotWatermark);
      validateInteger(after.streamPosition);
      const payload: SignedCursorPayloadV1 = Object.freeze({
        ...binding,
        contractVersion: CURSOR_CONTRACT_VERSION,
        eventId: after.eventId,
        expiresAt: Math.min(now + ttlMs, signingKey.notAfter),
        issuedAt: now,
        keyId: signingKey.keyId,
        keysetVersion,
        streamPosition: after.streamPosition,
      });
      const encoded = encodePart(JSON.stringify(payload));
      return `${encoded}.${sign(signingKey.secret, encoded)}`;
    },
  };
  return Object.freeze(codec);
}
