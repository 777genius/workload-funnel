import { describe, expect, it } from "vitest";

import {
  checkMutationFenceImportBijection,
  parseMutationFenceGrants,
} from "./mutation-fence-import-bijection.mjs";

const owner = {
  kernelOwner: true,
  nodeId: "kernel",
  path: "packages/kernel/src/mutation-fence.ts",
  source: "export interface MutationFence { readonly schemaVersion: 1 }",
};
const ownerIndex = {
  kernelOwner: true,
  nodeId: "kernel",
  path: "packages/kernel/src/index.ts",
  source: `export {
    type DesiredEffect,
    type FenceAuthoritySnapshot,
    type FenceComparisonResult,
    type MutationFence,
    compareMutationFence,
    fingerprintMutationFence,
    serializeMutationFence,
    validateMutationFence,
  } from "./mutation-fence.js";`,
};

function check(source, symbols = "MutationFence") {
  return checkMutationFenceImportBijection(
    [
      owner,
      ownerIndex,
      {
        kernelOwner: false,
        nodeId: "workload-control/cancellation",
        path: "packages/workload-control/src/features/cancellation/index.ts",
        source,
      },
    ],
    parseMutationFenceGrants(`K|workload-control/cancellation|${symbols}`),
  ).map((failure) => failure.code);
}

describe("ARCH-021 MutationFence import bijection", () => {
  it("accepts an exact K grant with a used named kernel import", () => {
    expect(
      check(`
        import type { MutationFence } from "@workload-funnel/kernel";
        export interface CancellationCommand {
          readonly fence: MutationFence;
        }
        export function cancel(command: CancellationCommand) {
          return command.fence.desiredEffect;
        }
      `),
    ).toEqual([]);
  });

  it("rejects a marker-only declaration used to satisfy a K grant", () => {
    expect(
      check(`
        import type { MutationFence } from "@workload-funnel/kernel";
        export interface CancellationMutationAuthority {
          readonly attemptId: string;
          readonly mutationFence: MutationFence;
        }
      `),
    ).toContain("marker_only_declaration");
    expect(
      check(`
        import type { MutationFence } from "@workload-funnel/kernel";
        export interface CancellationCommand {
          readonly mutationFence: MutationFence;
        }
        export function cancel(_command: CancellationCommand) {
          return "no-op";
        }
      `),
    ).toContain("marker_only_declaration");
  });

  it("rejects used-but-ungranted and granted-but-unused rows", () => {
    expect(
      check(
        `import type { MutationFence } from "@workload-funnel/kernel";
         export type Command = Readonly<{ fence: MutationFence }>;`,
        "empty",
      ),
    ).toContain("used_but_ungranted");
    expect(check("export const featureEnabled = true;")).toContain(
      "granted_but_unused",
    );
  });

  it.each([
    [
      "transitive",
      `import type { MutationFence } from "@workload-funnel/node-execution/execution-ticket-validation";
       export type Command = Readonly<{ fence: MutationFence }>;`,
      "transitive_import",
    ],
    [
      "default",
      `import MutationFence from "@workload-funnel/kernel";
       export type Command = MutationFence;`,
      "default_import",
    ],
    [
      "namespace",
      `import * as kernel from "@workload-funnel/kernel";
       export type Command = kernel.MutationFence;`,
      "namespace_import",
    ],
  ])("rejects %s imports", (_case, source, code) => {
    expect(check(source)).toContain(code);
  });

  it("rejects structural and implicit MutationFence consumption", () => {
    expect(
      check(`
        export interface LocalFence {
          readonly attemptId: string;
          readonly clusterIncarnation: string;
          readonly clusterIncarnationVersion: number;
          readonly desiredEffect: string;
          readonly effectScopeKey: string;
          readonly executionGeneration: string;
          readonly expectedDesiredVersion: number;
          readonly namespaceWriterEpoch: number;
          readonly schemaVersion: 1;
          readonly supersessionKey: string;
        }
      `),
    ).toContain("structural_redeclaration");
    expect(
      check(`
        export function readFence(input: { readonly mutationFence: unknown }) {
          return input.mutationFence;
        }
      `),
    ).toContain("implicit_import");
  });

  it("rejects duplicate declarations and transitive re-exports", () => {
    expect(check("export interface MutationFence {}")).toContain(
      "duplicate_declaration",
    );
    expect(
      check(`export { type MutationFence } from "@workload-funnel/kernel";`),
    ).toContain("transitive_export");
  });
});
