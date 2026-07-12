import type { AdmissionExplanation } from "../domain/fair-admission.js";

export interface AdmissionExplanationProjection {
  readonly projectionRevision: number;
  readonly latestByAttempt: Readonly<Record<string, AdmissionExplanation>>;
}

export class AdmissionExplanationGapError extends Error {
  public constructor() {
    super("admission_explanation_projection_gap");
    this.name = "AdmissionExplanationGapError";
  }
}

export class AdmissionExplanationView {
  #projectionRevision = 0;
  readonly #latestByAttempt = new Map<string, AdmissionExplanation>();

  public applyNext(
    sequence: number,
    explanation: AdmissionExplanation,
  ): AdmissionExplanationProjection {
    if (sequence !== this.#projectionRevision + 1) {
      throw new AdmissionExplanationGapError();
    }
    this.#latestByAttempt.set(explanation.attemptId, explanation);
    this.#projectionRevision = sequence;
    return this.snapshot();
  }

  public latest(attemptId: string): AdmissionExplanation | undefined {
    return this.#latestByAttempt.get(attemptId);
  }

  public snapshot(): AdmissionExplanationProjection {
    return Object.freeze({
      latestByAttempt: Object.freeze(Object.fromEntries(this.#latestByAttempt)),
      projectionRevision: this.#projectionRevision,
    });
  }
}
