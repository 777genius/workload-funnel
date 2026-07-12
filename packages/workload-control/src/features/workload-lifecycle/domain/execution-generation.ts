export interface ExecutionGenerationIssuer {
  issueForAttempt(attemptId: string): string;
}

export function createExecutionGenerationIssuer(): ExecutionGenerationIssuer {
  const issued = new Map<string, string>();
  return Object.freeze({
    issueForAttempt(attemptId: string) {
      const prior = issued.get(attemptId);
      if (prior !== undefined) return prior;
      const generation = `generation:${attemptId}`;
      issued.set(attemptId, generation);
      return generation;
    },
  });
}
