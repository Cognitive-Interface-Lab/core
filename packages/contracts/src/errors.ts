import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "auth",
  "rate_limit",
  "timeout",
  "unavailable",
  "bad_request",
  "content_filter",
  "not_found",
  "aborted",
  "unknown",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const CoreErrorShapeSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  provider: z.string().optional(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type CoreErrorShape = z.infer<typeof CoreErrorShapeSchema>;

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "rate_limit",
  "timeout",
  "unavailable",
]);

export function isRetryableCode(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly provider?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { provider?: string; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "CoreError";
    this.code = code;
    this.retryable = isRetryableCode(code);
    if (opts?.provider !== undefined) this.provider = opts.provider;
    if (opts?.details !== undefined) this.details = opts.details;
  }

  toJSON(): CoreErrorShape {
    const shape: CoreErrorShape = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.provider !== undefined) shape.provider = this.provider;
    if (this.details !== undefined) shape.details = this.details;
    return shape;
  }

  static fromShape(shape: CoreErrorShape): CoreError {
    const error = new CoreError(shape.code, shape.message, {
      ...(shape.provider !== undefined && { provider: shape.provider }),
      ...(shape.details !== undefined && { details: shape.details }),
    });
    // The shape is authoritative: it may carry a retryable flag that differs from the code default.
    Object.assign(error, { retryable: shape.retryable });
    return error;
  }

  static is(value: unknown): value is CoreError {
    return value instanceof CoreError;
  }
}
