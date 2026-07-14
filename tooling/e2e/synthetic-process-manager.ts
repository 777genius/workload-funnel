import {
  discoverSystemdCapabilities,
  syntheticDisposableLinuxProbe,
} from "@workload-funnel/executor-systemd/capability-discovery";
import {
  ProjectQuotaRegistry,
  type SyntheticTransientUnit,
  type TransientProjectQuotaControl,
  type VerifiedProjectQuotaReceipt,
} from "@workload-funnel/executor-systemd/transient-unit-start";
import type { Phase4aSystemdManager } from "@workload-funnel/node-launcher/systemd-mutation-boundary";

export class SyntheticProcessManager implements Phase4aSystemdManager {
  public readonly controlGroupStop = "supported" as const;
  public readonly externalFenceEnforced = false;
  public readonly processTrees = new Map<string, boolean[]>();
  public readonly projectQuotaControl = "supported" as const;
  public readonly quotas: TransientProjectQuotaControl[] = [];
  public readonly resourceCapabilities = discoverSystemdCapabilities(
    syntheticDisposableLinuxProbe(),
  );
  public readonly starts: SyntheticTransientUnit[] = [];
  public readonly transientServiceObservation = "supported" as const;
  public readonly transientServiceStart = "supported" as const;
  readonly #quotaRegistry = new ProjectQuotaRegistry();

  public applyProjectQuota(
    control: TransientProjectQuotaControl,
  ): VerifiedProjectQuotaReceipt {
    const receipt = this.#quotaRegistry.ensure(control);
    if (receipt.status === "applied") this.quotas.push(control);
    return receipt;
  }

  public observeTransientService(
    unitName: string,
  ): "active" | "failed" | "inactive" | "unknown" {
    const tree = this.processTrees.get(unitName);
    if (tree === undefined) return "unknown";
    return tree.some(Boolean) ? "active" : "inactive";
  }

  public startTransientService(
    unit: SyntheticTransientUnit,
  ): "created" | "exists" {
    if (this.processTrees.has(unit.unitName)) return "exists";
    this.starts.push(unit);
    this.processTrees.set(unit.unitName, [true, true, true]);
    return "created";
  }

  public stopTransientService(
    unitName: string,
    mode: "replace",
  ): "absent" | "stopped" {
    void mode;
    const tree = this.processTrees.get(unitName);
    if (tree === undefined) return "absent";
    tree.fill(false);
    return "stopped";
  }

  public verifyProjectQuotaReceipt(
    control: TransientProjectQuotaControl,
    receipt: VerifiedProjectQuotaReceipt,
  ): boolean {
    return this.#quotaRegistry.verify(control, receipt);
  }
}
