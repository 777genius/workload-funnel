export interface SyntheticTransportIdentity {
  readonly principalId: "synthetic-principal";
  readonly tenantId: "synthetic-tenant";
}

export class AuthenticationError extends Error {
  public constructor() {
    super("Synthetic transport authentication failed");
    this.name = "AuthenticationError";
  }
}

export function authenticateSyntheticToken(
  token: string,
): SyntheticTransportIdentity {
  if (token !== "phase1-synthetic-token") throw new AuthenticationError();
  return Object.freeze({
    principalId: "synthetic-principal",
    tenantId: "synthetic-tenant",
  });
}
