/**
 * An error from a model call. Adapters convert their provider's errors into this so the
 * engine can decide whether to retry without knowing anything about the provider.
 */
export class ModelError extends Error {
  override readonly name = 'ModelError';
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface SerializedError {
  name: string;
  message: string;
  status?: number;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof ModelError) {
    return {
      name: error.name,
      message: error.message,
      ...(error.status !== undefined && { status: error.status }),
    };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
