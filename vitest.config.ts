import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@workload-funnel\/bridge-subscription-runtime\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/bridge-subscription-runtime/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/client-sdk\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/client-sdk/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/artifact-store-filesystem\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/artifact-store-filesystem/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/artifact-store-object\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/artifact-store-object/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/control-service\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./apps/control-service/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/dispatcher-local\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/dispatcher-local/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/executor-systemd\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/executor-systemd/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: "@workload-funnel/kernel",
        replacement: fileURLToPath(
          new URL("./packages/kernel/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@workload-funnel\/node-execution\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/node-execution/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/node-agent\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./apps/node-agent/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/observability\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/observability/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/node-launcher\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./apps/node-launcher/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/result-sealer\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./apps/result-sealer/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/store-postgres\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/store-postgres/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/store-sqlite\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/store-sqlite/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@workload-funnel\/workload-control\/(.+)$/,
        replacement: fileURLToPath(
          new URL(
            "./packages/workload-control/src/features/$1/index.ts",
            import.meta.url,
          ),
        ),
      },
    ],
  },
  test: {
    include: [
      "packages/**/src/features/**/tests/**/*.test.ts",
      "apps/**/*.test.ts",
      "tooling/architecture/**/*.test.mjs",
      "tooling/compatibility/**/*.test.mjs",
      "tooling/phase-0-5/**/*.test.mjs",
    ],
    passWithNoTests: false,
  },
});
