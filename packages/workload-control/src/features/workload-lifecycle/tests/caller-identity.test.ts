import { describe, expect, it } from "vitest";

import {
  authenticatedCallerScope,
  encodeLifecycleTuple,
  lifecycleOperationId,
} from "../index.js";

describe("lifecycle caller identity", () => {
  it("uses unambiguous length-prefixed tuple encoding", () => {
    expect(encodeLifecycleTuple(["a:b", "c"])).not.toBe(
      encodeLifecycleTuple(["a", "b:c"]),
    );
    expect(encodeLifecycleTuple(["", "12#value"])).toBe("v10#8#12#value");
    expect(encodeLifecycleTuple(["😀"])).toBe("v14#😀");
    expect(() => encodeLifecycleTuple(["\ud800"])).toThrow(
      "lifecycle_tuple_part_invalid",
    );
  });

  it("isolates delimiter collisions and identical identities across tenants", () => {
    const caller = Object.freeze({
      namespaceId: "namespace",
      principalId: "segment:principal",
      tenantId: "tenant-a",
    });
    const delimiterCollision = Object.freeze({
      namespaceId: "namespace:segment",
      principalId: "principal",
      tenantId: caller.tenantId,
    });
    const otherTenant = Object.freeze({ ...caller, tenantId: "tenant-b" });
    const scopes = [caller, delimiterCollision, otherTenant].map(
      authenticatedCallerScope,
    );

    expect(new Set(scopes)).toHaveLength(3);
    expect(
      new Set(
        scopes.map((scope) => lifecycleOperationId("submit", scope, "k")),
      ),
    ).toHaveLength(3);
  });
});
