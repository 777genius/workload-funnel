export interface RuntimeCapabilityClient {
  discoverCapabilities(targetId: string): Promise<unknown>;
}
