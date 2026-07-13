export interface RuntimeEventClient {
  readEvents(cursor: string | undefined, limit: number): Promise<unknown>;
  readProjectSnapshot(
    pageToken: string | undefined,
    limit: number,
  ): Promise<unknown>;
}
