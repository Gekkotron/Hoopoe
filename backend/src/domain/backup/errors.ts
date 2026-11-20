// Short, client-safe failure categories. Upstream error text (server replies,
// socket messages, response bodies) is logged server-side only and never
// returned to the client or persisted in lastError.
export type BackupErrorCategory =
  | 'connection refused'
  | 'connection failed'
  | 'authentication failed'
  | 'timed out'
  | 'destination not allowed'
  | 'unexpected response'
  | 'folder unavailable'
  | 'internal error';

export class BackupProviderError extends Error {
  constructor(
    message: string,
    readonly category: BackupErrorCategory = 'unexpected response',
  ) {
    super(message);
    this.name = 'BackupProviderError';
  }
}

// Thrown when a destination points somewhere backups must never go
// (loopback/link-local/unspecified address, folder outside
// BACKUP_FOLDER_ROOT). The message is written by us, so it is safe to show.
export class DestinationNotAllowedError extends BackupProviderError {
  constructor(message: string) {
    super(message, 'destination not allowed');
    this.name = 'DestinationNotAllowedError';
  }
}

export function categorizeNetworkError(err: unknown): BackupErrorCategory {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } } | null;
  const code = e?.code ?? e?.cause?.code;
  const name = e?.name ?? e?.cause?.name;
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    name === 'TimeoutError' ||
    name === 'AbortError'
  ) {
    return 'timed out';
  }
  return 'connection failed';
}

export function publicErrorCategory(err: unknown): BackupErrorCategory {
  return err instanceof BackupProviderError ? err.category : 'internal error';
}
