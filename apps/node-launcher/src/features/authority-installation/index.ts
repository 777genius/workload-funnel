import {
  AuthorityRegistryError,
  type AuthorityInstallAcknowledgement,
  type LauncherAuthoritySnapshot,
  type RootAuthorityRegistry,
} from "@workload-funnel/node-launcher/authority-registry";

export interface AuthorityInstallerPeer {
  readonly gid: number;
  readonly pid: number;
  readonly transport: "unix";
  readonly uid: number;
}

export class RootAuthorityInstaller {
  public constructor(
    private readonly registry: RootAuthorityRegistry,
    private readonly trustedInstallerUid: number,
    private readonly trustedInstallerGid: number,
  ) {}

  public install(
    peer: unknown,
    snapshot: LauncherAuthoritySnapshot,
  ): AuthorityInstallAcknowledgement {
    const candidate = peer as Partial<AuthorityInstallerPeer> | null;
    if (
      candidate?.transport !== "unix" ||
      candidate.uid !== this.trustedInstallerUid ||
      candidate.gid !== this.trustedInstallerGid ||
      typeof candidate.pid !== "number" ||
      !Number.isSafeInteger(candidate.pid) ||
      candidate.pid <= 0
    ) {
      throw new AuthorityRegistryError(
        "invalid_authority",
        "authority installation peer is not trusted",
      );
    }
    return this.registry.install(snapshot);
  }
}
