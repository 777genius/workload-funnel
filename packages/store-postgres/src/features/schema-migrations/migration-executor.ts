export interface PostgresMigrationQueryResult<
  Row extends Record<string, unknown>,
> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresMigrationClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresMigrationQueryResult<Row>>;
}

export interface PostgresMigrationExecutor {
  transaction<T>(
    work: (client: PostgresMigrationClient) => Promise<T>,
  ): Promise<T>;
}
