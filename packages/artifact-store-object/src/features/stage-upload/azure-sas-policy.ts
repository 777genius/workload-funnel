const VERSIONS = new Set(["2025-11-05", "2026-06-06"]);
const REQUIRED = new Set(["se", "sig", "sp", "spr", "sr", "sv"]);

export interface ScopedCredential {
  readonly expiresAtMs: number;
  readonly resourceUrl: string;
}

export interface PrivateFixtureTransport {
  readonly exactOrigin: string;
  readonly serviceVersion: "2025-11-05";
}

function query(url: URL, key: string, fail: (code: string) => never): string {
  const values = url.searchParams.getAll(key);
  const value = values.at(0);
  if (values.length !== 1 || value === undefined || value === "")
    fail("azure_blob_sas_malformed");
  return value;
}

function fixtureOrigin(
  fixture: PrivateFixtureTransport | undefined,
  fail: (code: string) => never,
): string | undefined {
  if (fixture === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(fixture.exactOrigin);
  } catch {
    return fail("azure_blob_fixture_origin_invalid");
  }
  const candidate = fixture as unknown as Readonly<{
    serviceVersion?: unknown;
  }>;
  if (
    candidate.serviceVersion !== "2025-11-05" ||
    parsed.protocol !== "http:" ||
    parsed.origin !== fixture.exactOrigin ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    fail("azure_blob_fixture_origin_invalid");
  return parsed.origin;
}

export function validateScopedSas(
  input: Readonly<{
    credential: ScopedCredential;
    expectedPermission: "c" | "d" | "r";
    expectedResourceType: "b";
    expectedResourceUrl: string;
    fail: (code: string) => never;
    fixture?: PrivateFixtureTransport;
    maxLifetimeMs: number;
    minValidityMs: number;
    latestExpiryMs: number;
    nowMs: number;
  }>,
): string {
  let expected: URL;
  let actual: URL;
  try {
    expected = new URL(input.expectedResourceUrl);
    actual = new URL(input.credential.resourceUrl);
  } catch {
    return input.fail("azure_blob_sas_url_invalid");
  }
  if (
    expected.search !== "" ||
    expected.hash !== "" ||
    expected.username !== "" ||
    expected.password !== "" ||
    actual.hash !== "" ||
    actual.username !== "" ||
    actual.password !== "" ||
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname
  )
    input.fail("azure_blob_sas_resource_mismatch");

  const allowedFixtureOrigin = fixtureOrigin(input.fixture, input.fail);
  const insecureFixture =
    actual.protocol === "http:" && actual.origin === allowedFixtureOrigin;
  if (actual.protocol !== "https:" && !insecureFixture)
    input.fail("azure_blob_sas_transport_invalid");

  const allowedKeys = new Set(REQUIRED);
  if (actual.searchParams.has("st")) allowedKeys.add("st");
  const actualKeys = [...actual.searchParams.keys()];
  if (
    actualKeys.length !== allowedKeys.size ||
    actualKeys.some(
      (key) =>
        !allowedKeys.has(key) || actual.searchParams.getAll(key).length !== 1,
    )
  )
    input.fail("azure_blob_sas_policy_invalid");

  const serviceVersion = query(actual, "sv", input.fail);
  if (
    query(actual, "sp", input.fail) !== input.expectedPermission ||
    query(actual, "sr", input.fail) !== input.expectedResourceType ||
    !VERSIONS.has(serviceVersion) ||
    (input.fixture !== undefined &&
      serviceVersion !== input.fixture.serviceVersion) ||
    query(actual, "sig", input.fail).length < 1
  )
    input.fail("azure_blob_sas_policy_invalid");
  const protocol = query(actual, "spr", input.fail);
  if (
    (insecureFixture && protocol !== "https,http") ||
    (!insecureFixture && protocol !== "https")
  )
    input.fail("azure_blob_sas_protocol_invalid");

  const expiresAtMs = Date.parse(query(actual, "se", input.fail));
  if (
    !Number.isSafeInteger(input.credential.expiresAtMs) ||
    !Number.isSafeInteger(input.latestExpiryMs) ||
    !Number.isFinite(expiresAtMs) ||
    Math.abs(expiresAtMs - input.credential.expiresAtMs) > 1_000 ||
    input.credential.expiresAtMs > input.latestExpiryMs ||
    expiresAtMs > input.latestExpiryMs ||
    expiresAtMs - input.nowMs < input.minValidityMs ||
    expiresAtMs - input.nowMs > input.maxLifetimeMs
  )
    input.fail("azure_blob_sas_expiry_invalid");
  const startsOn = actual.searchParams.get("st");
  if (startsOn !== null) {
    const startsAtMs = Date.parse(startsOn);
    if (!Number.isFinite(startsAtMs) || startsAtMs > input.nowMs + 1_000)
      input.fail("azure_blob_sas_not_active");
  }
  return actual.toString();
}
