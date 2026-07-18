import { Buffer } from "node:buffer";

import { expect, test, vi } from "vitest";

import {
  AWS_CLI,
  POSTGRES_CLIENT,
  POSTGRES_SIGNING_KEY,
} from "./constants.mjs";
import {
  downloadHttps,
  isolatedPostgresAptArguments,
  postgresAptConfiguration,
  verifyAwsArchiveSha256,
  verifyAwsCliVersion,
  verifyAwsKeyListing,
  verifyAwsSignatureStatus,
  verifyPostgresKeyListing,
  verifyPostgresNotPreinstalled,
  verifyPsqlVersion,
} from "./host-tools.mjs";

function downloadResponse(contentLength, bytes = Uint8Array.of(1, 2, 3)) {
  return {
    arrayBuffer: async () => bytes.buffer,
    body: {},
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-length" ? contentLength : null,
    },
    ok: true,
    url: POSTGRES_SIGNING_KEY.url,
  };
}

test("bounds downloads with or without an honest content-length", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    fetch.mockResolvedValueOnce(downloadResponse(null));
    await expect(downloadHttps(POSTGRES_SIGNING_KEY.url, 3)).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
    fetch.mockResolvedValueOnce(downloadResponse("0003"));
    await expect(downloadHttps(POSTGRES_SIGNING_KEY.url, 3)).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );

    for (const contentLength of ["0", "-1", "invalid", "4", "9".repeat(32)]) {
      fetch.mockResolvedValueOnce(downloadResponse(contentLength));
      await expect(downloadHttps(POSTGRES_SIGNING_KEY.url, 3)).rejects.toThrow(
        "download_size_invalid",
      );
    }

    fetch.mockResolvedValueOnce(
      downloadResponse(null, Uint8Array.of(1, 2, 3, 4)),
    );
    await expect(downloadHttps(POSTGRES_SIGNING_KEY.url, 3)).rejects.toThrow(
      "download_size_invalid",
    );
  } finally {
    fetch.mockRestore();
  }
});

test("accepts only the official exact PostgreSQL 18.4 package identity", () => {
  expect(verifyPostgresNotPreinstalled(false, 1)).toBe(true);
  expect(() => verifyPostgresNotPreinstalled(true, 1)).toThrow(
    "postgres_client_preinstalled_refused",
  );
  expect(() => verifyPostgresNotPreinstalled(false, 0)).toThrow(
    "postgres_client_preinstalled_refused",
  );
  const official = `fpr:::::::::${POSTGRES_SIGNING_KEY.fingerprint}:\n`;
  expect(verifyPostgresKeyListing(official)).toBe(
    POSTGRES_SIGNING_KEY.fingerprint,
  );
  for (const listing of [
    `fpr:::::::::${"A".repeat(40)}:\n`,
    `${official}fpr:::::::::${"A".repeat(40)}:\n`,
  ])
    expect(() => verifyPostgresKeyListing(listing)).toThrow(
      "postgres_signing_key_untrusted",
    );
  expect(
    verifyPsqlVersion(
      "psql (PostgreSQL) 18.4 (Ubuntu package)\n",
      POSTGRES_CLIENT.packageVersion,
    ),
  ).toBe("18.4");
  for (const [output, packageVersion] of [
    ["psql (PostgreSQL) 18.5\n", POSTGRES_CLIENT.packageVersion],
    ["psql (PostgreSQL) 18.4\n", "18.4-2.mutable"],
  ])
    expect(() => verifyPsqlVersion(output, packageVersion)).toThrow(
      "postgres_client_18_4_version_mismatch",
    );
});

test("isolates PostgreSQL metadata, archives, keyring, and source configuration", () => {
  const hostRoot = `/opt/workload-funnel-hosted-production-gate-${"a".repeat(32)}`;
  const configuration = postgresAptConfiguration(hostRoot);
  expect(configuration).toEqual({
    aptSource: `deb [arch=amd64 signed-by=${hostRoot}/postgres-apt/ACCC4CF8.gpg] https://apt.postgresql.org/pub/repos/apt noble-pgdg main`,
    archivesPath: `${hostRoot}/postgres-apt/archives`,
    keyringPath: `${hostRoot}/postgres-apt/ACCC4CF8.gpg`,
    listsPath: `${hostRoot}/postgres-apt/lists`,
    sourceListPath: `${hostRoot}/postgres-apt/postgresql.list`,
  });
  const arguments_ = isolatedPostgresAptArguments(hostRoot, [
    "install",
    `${POSTGRES_CLIENT.packageName}=${POSTGRES_CLIENT.packageVersion}`,
  ]);
  expect(arguments_).toContain("Dir::Etc::sourceparts=-");
  expect(arguments_).toContain(
    `Dir::Etc::sourcelist=${configuration.sourceListPath}`,
  );
  expect(arguments_).toContain(`Dir::State::lists=${configuration.listsPath}`);
  expect(arguments_).toContain(
    `Dir::Cache::archives=${configuration.archivesPath}`,
  );
  expect(arguments_).toContain("Dir::Cache::pkgcache=");
  expect(arguments_).toContain("Dir::Cache::srcpkgcache=");
  expect(arguments_).toContain("APT::Get::AllowUnauthenticated=false");
  expect(arguments_.join("\n")).not.toContain("/etc/apt/sources.list");
  expect(() => postgresAptConfiguration("/tmp/hostile")).toThrow(
    "postgres_apt_root_invalid",
  );
});

test("accepts only the exact signed AWS CLI 2.35.23 identity", () => {
  expect(verifyAwsArchiveSha256(AWS_CLI.archiveSha256)).toBe(
    AWS_CLI.archiveSha256,
  );
  expect(() => verifyAwsArchiveSha256("0".repeat(64))).toThrow(
    "aws_archive_sha256_mismatch",
  );
  const keyListing = `pub:-:4096:1:A6310ACC4672475C:0:0::-:::scESC::::::23::0:\nfpr:::::::::${AWS_CLI.signingKeyFingerprint}:\n`;
  expect(verifyAwsKeyListing(keyListing)).toBe(AWS_CLI.signingKeyFingerprint);
  expect(
    verifyAwsSignatureStatus(
      `[GNUPG:] VALIDSIG ${AWS_CLI.signingKeyFingerprint} 2026-07-18 0 0 0 0 0 0 0 ${AWS_CLI.signingKeyFingerprint}\n`,
    ),
  ).toBe(AWS_CLI.signingKeyFingerprint);
  expect(
    verifyAwsCliVersion(
      "aws-cli/2.35.23 Python/3.13.11 Linux/6.11 exe/x86_64\n",
    ),
  ).toBe("2.35.23");
  expect(() => verifyAwsCliVersion("aws-cli/2.35.24 Python/3.13\n")).toThrow(
    "aws_cli_version_mismatch",
  );
  expect(() =>
    verifyAwsSignatureStatus(
      `[GNUPG:] VALIDSIG ${"A".repeat(40)} 2026-07-18\n`,
    ),
  ).toThrow("aws_archive_signature_untrusted");
});
