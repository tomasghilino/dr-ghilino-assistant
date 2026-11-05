/**
 * Error categories are part of the public contract: they appear in API responses and in
 * metrics. They must never carry user content, stack traces or upstream messages.
 */
export const ERROR_CATEGORIES = [
  "validation",
  "forbidden_origin",
  "rate_limited",
  "budget_exceeded",
  "payload_too_large",
  "not_found",
  "upstream_llm",
  "upstream_embeddings",
  "database",
  "timeout",
  "configuration",
  "internal",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export class AppError extends Error {
  readonly category: ErrorCategory;
  /** Safe to show to a visitor. Never include internals here. */
  readonly publicMessage: string;
  readonly retryable: boolean;

  constructor(
    category: ErrorCategory,
    publicMessage: string,
    options: { cause?: unknown; retryable?: boolean; internalMessage?: string } = {},
  ) {
    super(options.internalMessage ?? publicMessage, { cause: options.cause });
    this.name = "AppError";
    this.category = category;
    this.publicMessage = publicMessage;
    this.retryable = options.retryable ?? false;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
