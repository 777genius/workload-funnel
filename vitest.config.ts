import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@workload-funnel/workload-control/tenant-admission": fileURLToPath(
        new URL(
          "./packages/workload-control/src/features/tenant-admission/index.ts",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: [
      "packages/**/src/features/**/tests/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
    passWithNoTests: false,
  },
});
