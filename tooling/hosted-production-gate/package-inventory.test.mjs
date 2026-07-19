import { expect, test } from "vitest";

import { packageInventoryDiff } from "./host-tools.mjs";

test("records every installed, changed, and removed package identity", () => {
  expect(
    packageInventoryDiff(
      { "libpq5:amd64": "16.9-1", stable: "1.0" },
      {
        "libpq5:amd64": "18.4-1",
        "postgresql-client-18": "18.4-1.pgdg24.04+1",
      },
    ),
  ).toEqual({
    changed: [{ from: "16.9-1", name: "libpq5:amd64", to: "18.4-1" }],
    installed: [
      { name: "postgresql-client-18", version: "18.4-1.pgdg24.04+1" },
    ],
    removed: [{ name: "stable", version: "1.0" }],
  });
  expect(() => packageInventoryDiff({ "$(id)": "1" }, {})).toThrow(
    "package_inventory_invalid",
  );
});
