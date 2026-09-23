/**
 * Whether a URL uses a loopback hostname or literal address. `localhost` is left to
 * the resolver because every local model server documents it; the rest are
 * literal loopback addresses. Node's URL parser compresses IPv6, so `[::1]`
 * covers every spelling of the IPv6 loopback.
 */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}
