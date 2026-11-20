// Host-header allow-list for AUTH_MODE=none (the desktop sidecar). In that
// mode every request is the local user, so the only thing standing between
// the API and a hostile web page is the socket being loopback-only. A page
// whose hostname resolves to 127.0.0.1 (DNS rebinding) still reaches the
// socket, but its requests carry the attacker's hostname in `Host`. Refusing
// every Host that is not a loopback name closes that route.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// True when the Host header names the loopback interface (any port).
export function isLoopbackHost(hostHeader: string | undefined | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  let hostname: string;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return false;
    hostname = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    if (rest !== '' && !/^:\d*$/.test(rest)) return false;
  } else {
    const colon = host.indexOf(':');
    hostname = colon === -1 ? host : host.slice(0, colon);
    if (colon !== -1 && !/^\d*$/.test(host.slice(colon + 1))) return false;
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}
