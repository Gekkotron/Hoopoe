// The LAN/Docker entry (server.ts) binds 0.0.0.0. AUTH_MODE=none would make
// the whole API open to the network, so it is refused there; none mode is
// only for the desktop sidecar, which binds 127.0.0.1.
export const SERVER_AUTH_MODE_ERROR =
  'AUTH_MODE=none is only supported by the desktop sidecar; the server entry listens on all interfaces. Use AUTH_MODE=session.';

// Throws when the server entry must not boot with this auth mode.
export function assertServerAuthMode(authMode: string): void {
  if (authMode === 'none') throw new Error(SERVER_AUTH_MODE_ERROR);
}
