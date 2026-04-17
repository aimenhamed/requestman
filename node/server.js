import { TextDecoder, TextEncoder } from "node:util";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient, getClientBuildVersion } from "./build-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");
const port = Number(process.env.PORT ?? 3000);

const themeBootstrap = `
(() => {
  const savedTheme = localStorage.getItem("requestman-theme");
  const isDark =
    savedTheme === "dark" ||
    (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.dataset.theme = isDark ? "dark" : "light";
})();
`;

function renderPage(assetVersion) {
  const assetSuffix = assetVersion > 0 ? `?v=${assetVersion}` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Requestman</title>
    <meta
      name="description"
      content="Developer-first API client with response inspection, request history, and a focused workspace."
    />
    <script>${themeBootstrap}</script>
    <link rel="stylesheet" href="/assets/styles.css${assetSuffix}" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/client.js${assetSuffix}"></script>
  </body>
</html>`;
}

function isEnabledEntry(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.enabled === "boolean" &&
      typeof value.key === "string" &&
      typeof value.value === "string",
  );
}

function isValidRequestBody(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.url === "string" &&
      typeof value.method === "string" &&
      Array.isArray(value.headers) &&
      value.headers.every(isEnabledEntry) &&
      Array.isArray(value.query) &&
      value.query.every(isEnabledEntry) &&
      (value.bodyType === "none" || value.bodyType === "json" || value.bodyType === "text") &&
      typeof value.body === "string" &&
      (value.timeoutMs === undefined || typeof value.timeoutMs === "number"),
  );
}

function appendQuery(url, query) {
  for (const item of query) {
    if (!item.enabled || !item.key.trim()) {
      continue;
    }

    url.searchParams.set(item.key, item.value);
  }
}

function buildHeaders(headers) {
  const finalHeaders = {};

  for (const item of headers) {
    if (!item.enabled || !item.key.trim()) {
      continue;
    }

    finalHeaders[item.key] = item.value;
  }

  return finalHeaders;
}

function makeBody(method, bodyType, body) {
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }

  if (bodyType === "none" || !body.trim()) {
    return undefined;
  }

  return body;
}

function createEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function ensureClientBuilt() {
  if (process.env.NODE_ENV === "production") {
    await buildClient(true);
    return;
  }

  await buildClient();
}

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/assets", express.static(distDir, { etag: false }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "requestman",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/request", async (req, res) => {
  const startedAt = performance.now();
  const encoder = new TextEncoder();

  if (!isValidRequestBody(req.body)) {
    res.status(400);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("connection", "keep-alive");
    res.write(
      encoder.encode(
        createEvent("error", {
          message: "Invalid request payload",
          durationMs: Math.round(performance.now() - startedAt),
          sizeBytes: 0,
          requestedAt: new Date().toISOString(),
        }),
      ),
    );
    res.end();
    return;
  }

  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  try {
    const targetUrl = new URL(req.body.url);
    appendQuery(targetUrl, req.body.query);

    const headers = buildHeaders(req.body.headers);
    const requestBody = makeBody(req.body.method.toUpperCase(), req.body.bodyType, req.body.body);

    if (req.body.bodyType === "json" && requestBody && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }

    const timeoutMs = Math.min(Math.max(req.body.timeoutMs ?? 30_000, 1_000), 120_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: req.body.method.toUpperCase(),
        headers,
        body: requestBody,
        redirect: "follow",
        signal: controller.signal,
      });

      const requestedAt = new Date().toISOString();
      const responseHeaders = Object.fromEntries(response.headers.entries());
      let sizeBytes = 0;

      res.write(
        encoder.encode(
          createEvent("meta", {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            headers: responseHeaders,
            requestedAt,
          }),
        ),
      );

      if (!response.body) {
        res.write(
          encoder.encode(
            createEvent("done", {
              durationMs: Math.round(performance.now() - startedAt),
              sizeBytes,
            }),
          ),
        );
        res.end();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          sizeBytes += value.byteLength;
          res.write(
            encoder.encode(
              createEvent("chunk", {
                value: decoder.decode(value, { stream: true }),
                sizeBytes,
              }),
            ),
          );
        }

        const tail = decoder.decode();

        if (tail) {
          sizeBytes += encoder.encode(tail).byteLength;
          res.write(
            encoder.encode(
              createEvent("chunk", {
                value: tail,
                sizeBytes,
              }),
            ),
          );
        }

        res.write(
          encoder.encode(
            createEvent("done", {
              durationMs: Math.round(performance.now() - startedAt),
              sizeBytes,
            }),
          ),
        );
        res.end();
      } catch (error) {
        res.write(
          encoder.encode(
            createEvent("error", {
              message: error instanceof Error ? error.message : "Unknown stream error",
              durationMs: Math.round(performance.now() - startedAt),
              sizeBytes,
            }),
          ),
        );
        res.end();
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    res.status(500);
    res.write(
      encoder.encode(
        createEvent("error", {
          message: error instanceof Error ? error.message : "Unknown error",
          durationMs: Math.round(performance.now() - startedAt),
          sizeBytes: 0,
          requestedAt: new Date().toISOString(),
        }),
      ),
    );
    res.end();
  }
});

app.get("/", async (_req, res, next) => {
  try {
    await ensureClientBuilt();
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.send(renderPage(getClientBuildVersion()));
  } catch (error) {
    next(error);
  }
});

app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/assets/")) {
    next();
    return;
  }

  try {
    await ensureClientBuilt();
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.send(renderPage(getClientBuildVersion()));
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : "Unknown server error";
  res.status(500).json({ ok: false, error: message });
});

await ensureClientBuilt();

app.listen(port, () => {
  console.log(`Requestman running at http://localhost:${port}`);
});
