import type { FilesystemSealBoundary } from "@workload-funnel/result-sealer/filesystem-seal-boundary";
import type { ResultSealerRecovery } from "@workload-funnel/result-sealer/recovery";
import type { SealAuthorityRegistry } from "@workload-funnel/result-sealer/seal-authority-registry";

export interface ResultSealer {
  readonly boundary: FilesystemSealBoundary;
  readonly recovery: ResultSealerRecovery;
  readonly registry: SealAuthorityRegistry;
  readonly privileges: Readonly<{
    artifactCredential: false;
    database: false;
    network: false;
    scheduler: false;
    secretStore: false;
    systemd: false;
  }>;
}

export function createResultSealer(
  input: Readonly<{
    boundary: FilesystemSealBoundary;
    recovery: ResultSealerRecovery;
    registry: SealAuthorityRegistry;
  }>,
): ResultSealer {
  return Object.freeze({
    ...input,
    privileges: Object.freeze({
      artifactCredential: false,
      database: false,
      network: false,
      scheduler: false,
      secretStore: false,
      systemd: false,
    }),
  });
}

export interface DisabledResultSealerStartEvidence {
  readonly capability: "privileged_result_seal";
  readonly reason: "native_openat2_sealer_start_disabled";
  readonly status: "unsupported";
}

export function startResultSealer(): DisabledResultSealerStartEvidence {
  return Object.freeze({
    capability: "privileged_result_seal",
    reason: "native_openat2_sealer_start_disabled",
    status: "unsupported",
  });
}
