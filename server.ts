import { staticPlugin } from "@elysiajs/static";
import { Elysia, t } from "elysia";
import { buildClient, getClientBuildVersion } from "./src/build-client";

type EnabledEntry = {
  enabled: boolean;
  key: string;
  value: string;
};

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

function renderPage(assetVersion: number) {
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

const requestSchema = t.Object({
  url: t.String(),
  method: t.String(),
  headers: t.Array(
    t.Object({
      enabled: t.Boolean(),
      key: t.String(),
      value: t.String(),
    }),
  ),
  query: t.Array(
    t.Object({
      enabled: t.Boolean(),
      key: t.String(),
      value: t.String(),
    }),
  ),
  bodyType: t.Union([t.Literal("none"), t.Literal("json"), t.Literal("text")]),
  body: t.String(),
  timeoutMs: t.Optional(t.Number()),
});

function appendQuery(url: URL, query: EnabledEntry[]) {
  for (const item of query) {
    if (!item.enabled || !item.key.trim()) {
      continue;
    }

    url.searchParams.set(item.key, item.value);
  }
}

function buildHeaders(headers: EnabledEntry[]) {
  const finalHeaders: Record<string, string> = {};

  for (const item of headers) {
    if (!item.enabled || !item.key.trim()) {
      continue;
    }

    finalHeaders[item.key] = item.value;
  }

  return finalHeaders;
}

function makeBody(method: string, bodyType: "none" | "json" | "text", body: string) {
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }

  if (bodyType === "none" || !body.trim()) {
    return undefined;
  }

  return body;
}

function createEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

await buildClient(process.env.NODE_ENV === "production");

const app = new Elysia()
  .use(
    staticPlugin({
      assets: "dist",
      prefix: "/assets",
      alwaysStatic: true,
    }),
  )
  .get("/api/health", () => ({
    ok: true,
    service: "requestman",
    timestamp: new Date().toISOString(),
  }))
  .post(
    "/api/request",
    async ({ body, set }) => {
      const startedAt = performance.now();
      const encoder = new TextEncoder();

      try {
        const targetUrl = new URL(body.url);
        appendQuery(targetUrl, body.query);

        const headers = buildHeaders(body.headers);
        const requestBody = makeBody(body.method.toUpperCase(), body.bodyType, body.body);

        if (body.bodyType === "json" && requestBody && !headers["content-type"]) {
          headers["content-type"] = "application/json";
        }

        const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 30_000, 1_000), 120_000);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(targetUrl, {
            method: body.method.toUpperCase(),
            headers,
            body: requestBody,
            redirect: "follow",
            signal: controller.signal,
          });
          const requestedAt = new Date().toISOString();
          const responseHeaders = Object.fromEntries(response.headers.entries());

          set.headers["content-type"] = "text/event-stream; charset=utf-8";
          set.headers["cache-control"] = "no-store";
          set.headers.connection = "keep-alive";

          return new ReadableStream({
            async start(controller) {
              let sizeBytes = 0;

              controller.enqueue(
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
                controller.enqueue(
                  encoder.encode(
                    createEvent("done", {
                      durationMs: Math.round(performance.now() - startedAt),
                      sizeBytes,
                    }),
                  ),
                );
                controller.close();
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

                  controller.enqueue(
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
                  controller.enqueue(
                    encoder.encode(
                      createEvent("chunk", {
                        value: tail,
                        sizeBytes,
                      }),
                    ),
                  );
                }

                controller.enqueue(
                  encoder.encode(
                    createEvent("done", {
                      durationMs: Math.round(performance.now() - startedAt),
                      sizeBytes,
                    }),
                  ),
                );
                controller.close();
              } catch (error) {
                controller.enqueue(
                  encoder.encode(
                    createEvent("error", {
                      message: error instanceof Error ? error.message : "Unknown stream error",
                      durationMs: Math.round(performance.now() - startedAt),
                      sizeBytes,
                    }),
                  ),
                );
                controller.close();
              }
            },
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        set.status = 500;
        set.headers["content-type"] = "text/event-stream; charset=utf-8";
        set.headers["cache-control"] = "no-store";
        set.headers.connection = "keep-alive";

        return new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                createEvent("error", {
                  message: error instanceof Error ? error.message : "Unknown error",
                  durationMs: Math.round(performance.now() - startedAt),
                  sizeBytes: 0,
                  requestedAt: new Date().toISOString(),
                }),
              ),
            );
            controller.close();
          },
        });
      }
    },
    {
      body: requestSchema,
    },
  )
  .get("/", async () => {
    if (process.env.NODE_ENV !== "production") {
      await buildClient();
    }

    return new Response(renderPage(getClientBuildVersion()), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  })
  .get("/*", async () => {
    if (process.env.NODE_ENV !== "production") {
      await buildClient();
    }

    return new Response(renderPage(getClientBuildVersion()), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  })
  .listen(port);

console.log(`Requestman running at http://localhost:${app.server?.port ?? port}`);
