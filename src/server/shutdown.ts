/**
 * Graceful shutdown. A stop signal can arrive while chats may
 * be streaming, so the listener closes first, in-flight responses get a
 * bounded time to finish, and only then are the databases closed. A chat cut
 * off by the deadline sees its request signal abort, which is the path that
 * records the answer as interrupted; whatever cannot finish before the
 * handles close is picked up by `recoverPendingChats` at the next start.
 */

/** The parts of a Node HTTP server the shutdown needs; `serve()` from @hono/node-server returns one. */
export interface DrainableServer {
  close(callback?: (error?: Error) => void): unknown;
  /** Closes keep-alive connections with no request in flight. */
  closeIdleConnections?(): void;
  /** Destroys every connection, aborting the requests on them. */
  closeAllConnections?(): void;
}

export interface ShutdownOptions {
  /** How long streaming responses may keep running before their connections are closed. */
  drainMs?: number;
  /**
   * After the last connection closes, how long to wait for `busy()` to clear:
   * an aborted chat still has to record its final state before the database
   * handle goes away.
   */
  settleMs?: number;
  /** Whether any tenant still has work finishing; omitted means never. */
  busy?: () => boolean;
  /** Closes the database handles once the traffic has drained. */
  onClosed: () => void;
  log?: (entry: Record<string, unknown>) => void;
}

export const DRAIN_MS = 20_000;
export const SETTLE_MS = 5_000;
const SETTLE_POLL_MS = 50;
const IDLE_SWEEP_MS = 250;

/**
 * Returns the handler to bind to SIGTERM and SIGINT. Calling it twice
 * (two signals, or a signal during the drain) does not restart the sequence.
 */
export function gracefulShutdown(server: DrainableServer, options: ShutdownOptions) {
  const drainMs = options.drainMs ?? DRAIN_MS;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const busy = options.busy ?? (() => false);
  const log = options.log ?? (() => {});
  let pending: Promise<void> | undefined;

  const drained = () =>
    new Promise<void>((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      server.close(() => {
        for (const timer of timers) clearTimeout(timer);
        resolve();
      });
      // Node closes the connections idle at this moment; one that turns idle
      // later (a finished response on a keep-alive socket) would otherwise
      // wait for its keep-alive timeout, so keep sweeping.
      const closeIdle = server.closeIdleConnections?.bind(server);
      if (closeIdle) {
        closeIdle();
        timers.push(setInterval(closeIdle, IDLE_SWEEP_MS).unref());
      }
      const closeAll = server.closeAllConnections?.bind(server);
      if (closeAll) {
        timers.push(
          setTimeout(() => {
            log({ event: 'shutdown_drain_expired', drainMs });
            // The close callback fires once the destroyed sockets are gone.
            closeAll();
          }, drainMs).unref(),
        );
      }
    });

  const settled = async () => {
    const deadline = Date.now() + settleMs;
    while (busy() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    return !busy();
  };

  return (signal?: string) => {
    if (pending) return pending;
    const start = Date.now();
    log({ event: 'shutdown', signal: signal ?? null });
    pending = (async () => {
      await drained();
      const clean = await settled();
      if (!clean) log({ event: 'shutdown_settle_expired', settleMs });
      options.onClosed();
      log({ event: 'shutdown_complete', clean, durationMs: Date.now() - start });
    })();
    return pending;
  };
}
