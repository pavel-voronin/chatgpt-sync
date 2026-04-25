export class BackendRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "BackendRequestError";
    this.status = status;
  }
}

export function isBackendRequestError(
  error: unknown,
): error is BackendRequestError {
  return error instanceof BackendRequestError;
}
