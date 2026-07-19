import { describe, expect, it } from "vitest";

import {
  validateAuthenticatedPrincipal,
  validateLifecycleErasureAuthority,
  validateLifecycleErasureInput,
} from "../application/lifecycle-input-validation.js";

describe("lifecycle erasure input validation", () => {
  it.each(["tenantId", "namespaceId", "principalId"] as const)(
    "rejects an invalid authenticated %s",
    (field) => {
      expect(() => {
        validateAuthenticatedPrincipal({
          namespaceId: "namespace",
          principalId: "principal",
          tenantId: "tenant",
          [field]: "",
        });
      }).toThrow();
    },
  );

  it.each(["operationId", "subjectPrincipalId", "pseudonym"] as const)(
    "rejects an invalid erasure %s",
    (field) => {
      expect(() => {
        validateLifecycleErasureInput({
          operationId: "operation",
          pseudonym: "pseudonym",
          subjectPrincipalId: "subject",
          [field]: "",
        });
      }).toThrow();
    },
  );

  it("allows only self-erasure without an explicit delegated authority", () => {
    const principal = Object.freeze({
      namespaceId: "namespace",
      principalId: "principal",
      tenantId: "tenant",
    });
    const input = Object.freeze({
      operationId: "operation",
      pseudonym: "pseudonym",
      subjectPrincipalId: principal.principalId,
    });
    expect(() => {
      validateLifecycleErasureAuthority(principal, input);
    }).not.toThrow();
    expect(() => {
      validateLifecycleErasureAuthority(principal, {
        ...input,
        subjectPrincipalId: "foreign-principal",
      });
    }).toThrow("Erasure subject is not authorized");
  });

  it("rejects ill-formed Unicode before database canonicalization", () => {
    expect(() => {
      validateAuthenticatedPrincipal({
        namespaceId: "namespace",
        principalId: "\ud800",
        tenantId: "tenant",
      });
    }).toThrow();
    expect(() => {
      validateLifecycleErasureInput({
        operationId: "operation",
        pseudonym: "\udfff",
        subjectPrincipalId: "subject",
      });
    }).toThrow();
  });
});
