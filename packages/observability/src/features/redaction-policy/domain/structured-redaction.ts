export type RedactionClassification =
  | "public"
  | "internal"
  | "sensitive"
  | "secret";

export interface RedactionPolicy {
  readonly policyVersion: number;
  readonly secretKeys: ReadonlySet<string>;
  readonly sensitiveKeys: ReadonlySet<string>;
  readonly maximumStringLength: number;
  readonly maximumArrayLength: number;
  readonly maximumDepth: number;
}

export interface RedactedValue {
  readonly value: unknown;
  readonly classifications: readonly RedactionClassification[];
  readonly redactedFields: number;
  readonly truncatedFields: number;
}

const alwaysSecret = new Set([
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "password",
  "privatekey",
  "secret",
  "token",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function classificationFor(
  key: string,
  policy: RedactionPolicy,
): RedactionClassification {
  const normalized = normalizedKey(key);
  if (
    alwaysSecret.has(normalized) ||
    [...policy.secretKeys].some((item) => normalizedKey(item) === normalized)
  )
    return "secret";
  if (
    ["prompt", "providerpayload", "childoutput", "stdout", "stderr"].includes(
      normalized,
    ) ||
    [...policy.sensitiveKeys].some((item) => normalizedKey(item) === normalized)
  )
    return "sensitive";
  return "internal";
}

export function createStructuredRedactor(policy: RedactionPolicy): Readonly<{
  redact(value: unknown): RedactedValue;
}> {
  if (
    !Number.isSafeInteger(policy.policyVersion) ||
    policy.policyVersion < 1 ||
    !Number.isSafeInteger(policy.maximumStringLength) ||
    policy.maximumStringLength < 16 ||
    policy.maximumStringLength > 1_048_576 ||
    !Number.isSafeInteger(policy.maximumArrayLength) ||
    policy.maximumArrayLength < 1 ||
    policy.maximumArrayLength > 4096 ||
    !Number.isSafeInteger(policy.maximumDepth) ||
    policy.maximumDepth < 1 ||
    policy.maximumDepth > 64
  )
    throw new Error("invalid_redaction_policy");
  const stablePolicy: RedactionPolicy = Object.freeze({
    ...policy,
    secretKeys: new Set(policy.secretKeys),
    sensitiveKeys: new Set(policy.sensitiveKeys),
  });

  return Object.freeze({
    redact(input: unknown): RedactedValue {
      const classifications = new Set<RedactionClassification>();
      const visited = new WeakSet<object>();
      let redactedFields = 0;
      let truncatedFields = 0;

      function visit(value: unknown, depth: number): unknown {
        if (depth > stablePolicy.maximumDepth) {
          truncatedFields += 1;
          return "[maximum-depth]";
        }
        if (typeof value === "string") {
          if (value.length <= stablePolicy.maximumStringLength) return value;
          truncatedFields += 1;
          return `${value.slice(0, stablePolicy.maximumStringLength)}[truncated]`;
        }
        if (Array.isArray(value)) {
          if (visited.has(value)) return "[circular]";
          visited.add(value);
          if (value.length > stablePolicy.maximumArrayLength)
            truncatedFields += 1;
          return Object.freeze(
            value
              .slice(0, stablePolicy.maximumArrayLength)
              .map((item) => visit(item, depth + 1)),
          );
        }
        if (typeof value !== "object" || value === null) return value;
        if (visited.has(value)) return "[circular]";
        visited.add(value);
        const output: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
          const classification = classificationFor(key, stablePolicy);
          classifications.add(classification);
          if (classification === "secret") {
            output[key] = "[redacted]";
            redactedFields += 1;
          } else if (classification === "sensitive") {
            output[key] = "[quarantined]";
            redactedFields += 1;
          } else {
            output[key] = visit(child, depth + 1);
          }
        }
        return Object.freeze(output);
      }

      return Object.freeze({
        classifications: Object.freeze([...classifications].sort()),
        redactedFields,
        truncatedFields,
        value: visit(input, 0),
      });
    },
  });
}
