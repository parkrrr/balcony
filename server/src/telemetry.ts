// Sends traces, metrics and exceptions to Application Insights. Loaded with `node --import`
// before the app, after @azure/monitor-opentelemetry/loader, because ESM modules can only be
// instrumented if the hooks are in place before they load (see the Dockerfile's CMD).
// Without a connection string (local dev, tests) it does nothing.
import { useAzureMonitor } from "@azure/monitor-opentelemetry";
import type { HttpInstrumentationConfig } from "@opentelemetry/instrumentation-http";
import { IncomingMessage } from "node:http";

const http: HttpInstrumentationConfig = {
  enabled: true,
  // Probes hit /healthz every few seconds, and /assets are cache-forever static files; neither
  // says anything about how the app is doing.
  ignoreIncomingRequestHook: (req) => req.url === "/healthz" || !!req.url?.startsWith("/assets/"),
  // The SDK's own background calls: its Azure VM metadata probe (which fails outside a VM, so it
  // would also log an exception on every start) and its remote configuration checks.
  ignoreOutgoingRequestHook: (req) =>
    (req.hostname ?? req.host) === "169.254.169.254" || !!req.path?.startsWith("/AzMonSDKDynamicConfiguration"),
  // Without Express instrumentation every request would be named just "GET". Every route is a
  // fixed path, so name requests by path, never the query string (it can hold video IDs).
  requestHook: (span, req) => {
    if (req instanceof IncomingMessage) span.updateName(`${req.method} ${req.url?.split("?")[0]}`);
  },
};

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  useAzureMonitor({
    // Rate-limited sampling (the default, made explicit): at most 5 traces a second, so a busy
    // moment can't run up the ingestion bill.
    tracesPerSecond: 5,
    enableLiveMetrics: true,
    instrumentationOptions: { http },
  });
}
