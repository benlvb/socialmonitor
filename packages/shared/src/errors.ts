/**
 * Typed pipeline errors drive the cursor contract (SPEC sections 5 and 9):
 *  - PerItemError   -> drop the item, keep going, cursor may advance
 *  - TransientError -> hold cursor, retry next run
 *  - SystemicError  -> increment breaker; trips after BREAKER_THRESHOLD
 */
export class PerItemError extends Error {
  readonly kind = "per_item" as const;
  constructor(
    message: string,
    readonly externalId?: string,
  ) {
    super(message);
    this.name = "PerItemError";
  }
}

export class TransientError extends Error {
  readonly kind = "transient" as const;
  constructor(
    message: string,
    readonly causeDetail?: unknown,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

export class SystemicError extends Error {
  readonly kind = "systemic" as const;
  constructor(
    message: string,
    readonly causeDetail?: unknown,
  ) {
    super(message);
    this.name = "SystemicError";
  }
}

export type PipelineError = PerItemError | TransientError | SystemicError;

/** Map an HTTP status to the right error class (adapter helper). */
export function errorFromStatus(status: number, message: string): PipelineError {
  if (status === 429 || status >= 500) return new TransientError(`${status}: ${message}`);
  if (status === 401 || status === 403 || status === 404)
    return new SystemicError(`${status}: ${message}`);
  return new PerItemError(`${status}: ${message}`);
}
