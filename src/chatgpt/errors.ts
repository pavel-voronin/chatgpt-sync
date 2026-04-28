export class BackendRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "BackendRequestError";
    this.status = status;
  }
}

export class ConversationUnavailableError extends BackendRequestError {
  readonly conversationId: string;

  constructor(conversationId: string, status: number | null) {
    super(
      `Could not fetch conversation payload for ${conversationId} status=${status ?? "unknown"}`,
      status,
    );
    this.name = "ConversationUnavailableError";
    this.conversationId = conversationId;
  }
}

export function isBackendRequestError(
  error: unknown,
): error is BackendRequestError {
  return error instanceof BackendRequestError;
}

export function isConversationUnavailableError(
  error: unknown,
): error is ConversationUnavailableError {
  return error instanceof ConversationUnavailableError;
}

export function shouldLockBackendForError(error: BackendRequestError) {
  const status = error.status;
  return (
    status === null ||
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}
