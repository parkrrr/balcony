import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

// A no-op tracer until telemetry.ts sets up Azure Monitor, so tests and local runs are unaffected.
const tracer = trace.getTracer("balcony");

/**
 * Wraps a socket event handler in a server span, so it shows up in Application Insights as a
 * request named after the event, with its Cosmos DB calls nested under it.
 */
export function traced<A extends unknown[]>(event: string, handler: (...args: A) => unknown) {
  return (...args: A) =>
    tracer.startActiveSpan(`socket ${event}`, { kind: SpanKind.SERVER }, async (span) => {
      try {
        await handler(...args);
      } catch (err) {
        failed(err);
        throw err;
      } finally {
        span.end();
      }
    });
}

/** Marks the current span failed, for errors a handler catches and answers itself. */
export function failed(err: unknown): void {
  const span = trace.getActiveSpan();
  span?.recordException(err instanceof Error ? err : String(err));
  span?.setStatus({ code: SpanStatusCode.ERROR });
}
