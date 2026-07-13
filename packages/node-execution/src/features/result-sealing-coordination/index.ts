export {
  SEAL_OUTPUT_RPC_PROTOCOL,
  canonicalSealOutputClaims,
  createSealOutputClaims,
  fingerprintSealOutputTuple,
  sealOutputFenceFingerprint,
  signSealOutputRequest,
  validateSealOutputClaims,
  verifySealOutputRequest,
  type SealEntry,
  type SealOutputClaims,
  type SealOutputReceipt,
  type SealOutputRpcRequest,
  type SealOutputRpcResponse,
  type SignedSealOutputRequest,
} from "./application/seal-output-contract.js";

export interface FeatureApi {
  readonly capability: "trusted_result_sealing_coordination";
}

export function createProvider(): FeatureApi {
  return Object.freeze({ capability: "trusted_result_sealing_coordination" });
}
