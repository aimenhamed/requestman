import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

type Theme = "light" | "dark";
type RequestTab = "query" | "headers" | "body";
type ResponseTab = "body" | "headers" | "meta";
type BodyType = "none" | "json" | "text";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

type KeyValuePair = {
  id: string;
  enabled: boolean;
  key: string;
  value: string;
};

type RequestDocument = {
  id: string;
  name: string;
  method: Method;
  url: string;
  query: KeyValuePair[];
  headers: KeyValuePair[];
  bodyType: BodyType;
  body: string;
  updatedAt: number;
};

type ResponsePayload = {
  ok: boolean;
  status: number;
  statusText: string;
  url?: string;
  durationMs: number;
  sizeBytes?: number;
  headers: Record<string, string>;
  body: string;
  requestedAt: string;
  error?: string;
};

type ResponseState = {
  loading: boolean;
  streamState?: "idle" | "streaming" | "complete" | "error";
  payload?: ResponsePayload;
};

type StreamEvent =
  | {
      event: "meta";
      data: {
        ok: boolean;
        status: number;
        statusText: string;
        url?: string;
        headers: Record<string, string>;
        requestedAt: string;
      };
    }
  | {
      event: "chunk";
      data: {
        value: string;
        sizeBytes: number;
      };
    }
  | {
      event: "done";
      data: {
        durationMs: number;
        sizeBytes: number;
      };
    }
  | {
      event: "error";
      data: {
        message: string;
        durationMs: number;
        sizeBytes: number;
        requestedAt?: string;
      };
    };

const STORAGE_KEYS = {
  theme: "requestman-theme",
  requests: "requestman-requests",
  activeRequest: "requestman-active-request",
  responses: "requestman-responses",
};

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

const METHOD_TONES: Record<Method, string> = {
  GET: "tone-green",
  POST: "tone-blue",
  PUT: "tone-amber",
  PATCH: "tone-purple",
  DELETE: "tone-red",
  HEAD: "tone-slate",
};

function uid() {
  return crypto.randomUUID();
}

function createRow(key = "", value = ""): KeyValuePair {
  return {
    id: uid(),
    enabled: true,
    key,
    value,
  };
}

function createRequest(seed?: Partial<RequestDocument>): RequestDocument {
  const now = Date.now();

  return {
    id: uid(),
    name: seed?.name ?? "Untitled Request",
    method: seed?.method ?? "GET",
    url: seed?.url ?? "https://jsonplaceholder.typicode.com/todos/1",
    query: seed?.query ?? [createRow()],
    headers: seed?.headers ?? [createRow("accept", "application/json"), createRow()],
    bodyType: seed?.bodyType ?? "none",
    body: seed?.body ?? "",
    updatedAt: now,
  };
}

const sampleRequests: RequestDocument[] = [
  createRequest({
    name: "JSON Placeholder",
    method: "GET",
    url: "https://jsonplaceholder.typicode.com/posts/1",
    headers: [createRow("accept", "application/json"), createRow()],
  }),
  createRequest({
    name: "GitHub User",
    method: "GET",
    url: "https://api.github.com/users/octocat",
    headers: [
      createRow("accept", "application/vnd.github+json"),
      createRow("x-github-api-version", "2022-11-28"),
      createRow(),
    ],
  }),
  createRequest({
    name: "Create Post",
    method: "POST",
    url: "https://jsonplaceholder.typicode.com/posts",
    headers: [createRow("content-type", "application/json"), createRow()],
    bodyType: "json",
    body: JSON.stringify(
      {
        title: "Requestman",
        body: "Ship the UI first. Polish the UX right after.",
        userId: 7,
      },
      null,
      2,
    ),
  }),
];

const fallbackRequest = sampleRequests[0] ?? createRequest();

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);

    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function formatBytes(bytes?: number) {
  if (!bytes) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTimestamp(timestamp?: string) {
  if (!timestamp) {
    return "Not sent yet";
  }

  return new Date(timestamp).toLocaleString();
}

function tryFormatJson(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function labelForTab(tab: RequestTab | ResponseTab) {
  if (tab === "query") {
    return "Query Params";
  }

  if (tab === "meta") {
    return "Overview";
  }

  return tab.charAt(0).toUpperCase() + tab.slice(1);
}

function applyQueryToDraftUrl(rawUrl: string, query: KeyValuePair[]) {
  const enabledQuery = query.filter((item) => item.enabled && item.key.trim());

  if (enabledQuery.length === 0) {
    return rawUrl;
  }

  const queryString = enabledQuery
    .map(
      (item) =>
        `${encodeURIComponent(item.key)}=${encodeURIComponent(item.value)}`,
    )
    .join("&");

  if (!rawUrl.trim()) {
    return `?${queryString}`;
  }

  const separator = rawUrl.includes("?")
    ? rawUrl.endsWith("?") || rawUrl.endsWith("&")
      ? ""
      : "&"
    : "?";

  return `${rawUrl}${separator}${queryString}`;
}

function buildCurl(request: RequestDocument) {
  const parts = [`curl --request ${request.method}`];
  let requestTarget = request.url;

  try {
    const url = new URL(request.url);

    for (const item of request.query) {
      if (item.enabled && item.key.trim()) {
        url.searchParams.set(item.key, item.value);
      }
    }

    requestTarget = url.toString();
  } catch {
    requestTarget = applyQueryToDraftUrl(request.url, request.query);
  }

  for (const item of request.headers) {
    if (item.enabled && item.key.trim()) {
      parts.push(`--header '${item.key}: ${item.value.replaceAll("'", "\\'")}'`);
    }
  }

  if (request.bodyType !== "none" && request.body.trim() && request.method !== "GET" && request.method !== "HEAD") {
    parts.push(`--data '${request.body.replaceAll("'", "\\'")}'`);
  }

  parts.push(`'${requestTarget}'`);
  return parts.join(" \\\n  ");
}

function createPendingPayload(): ResponsePayload {
  return {
    ok: true,
    status: 0,
    statusText: "Connecting",
    durationMs: 0,
    sizeBytes: 0,
    headers: {},
    body: "",
    requestedAt: new Date().toISOString(),
  };
}

function getPersistableResponses(responses: Record<string, ResponseState>) {
  return Object.fromEntries(
    Object.entries(responses).filter(([, responseState]) => responseState.streamState !== "streaming"),
  );
}

function getStreamBadge(responseState?: ResponseState) {
  if (responseState?.streamState === "streaming") {
    return {
      className: "stream-badge stream-badge-live",
      label: "Streaming Live",
    };
  }

  if (responseState?.streamState === "complete") {
    return {
      className: "stream-badge stream-badge-complete",
      label: "Stream Complete",
    };
  }

  if (responseState?.streamState === "error") {
    return {
      className: "stream-badge stream-badge-error",
      label: "Stream Error",
    };
  }

  return {
    className: "stream-badge",
    label: "Idle",
  };
}

function getResponseBodyContent(responseState: ResponseState | undefined, body: string) {
  if (responseState?.payload?.error) {
    return responseState.payload.error;
  }

  if (responseState?.streamState === "streaming") {
    return body || "Waiting for first stream chunk...";
  }

  if (responseState?.loading) {
    return "Sending request...";
  }

  return body || "Response body will appear here.";
}

function RequestmanApp() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);

    if (saved === "light" || saved === "dark") {
      return saved;
    }

    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  });
  const [requests, setRequests] = useState<RequestDocument[]>(() =>
    loadJson(STORAGE_KEYS.requests, sampleRequests),
  );
  const [activeRequestId, setActiveRequestId] = useState<string>(() => {
    const savedId = localStorage.getItem(STORAGE_KEYS.activeRequest);
    const savedRequests = loadJson<RequestDocument[]>(STORAGE_KEYS.requests, sampleRequests);
    return savedId && savedRequests.some((request) => request.id === savedId)
      ? savedId
      : savedRequests[0]?.id ?? fallbackRequest.id;
  });
  const [requestTab, setRequestTab] = useState<RequestTab>("headers");
  const [responseTab, setResponseTab] = useState<ResponseTab>("body");
  const [responses, setResponses] = useState<Record<string, ResponseState>>(() =>
    loadJson(STORAGE_KEYS.responses, {}),
  );
  const [copyState, setCopyState] = useState<"idle" | "done">("idle");
  const [isResponseModalOpen, setIsResponseModalOpen] = useState(false);

  const activeRequest = useMemo(
    () => requests.find((request) => request.id === activeRequestId) ?? requests[0],
    [activeRequestId, requests],
  );

  const activeResponse = activeRequest ? responses[activeRequest.id] : undefined;
  const streamBadge = getStreamBadge(activeResponse);
  const prettyResponseBody = useMemo(() => {
    const body = activeResponse?.payload?.body ?? "";
    const contentType = activeResponse?.payload?.headers["content-type"] ?? "";

    if (contentType.includes("json")) {
      return tryFormatJson(body);
    }

    return body;
  }, [activeResponse]);
  const responseBodyContent = getResponseBodyContent(activeResponse, prettyResponseBody);

  const curlCommand = useMemo(
    () => (activeRequest ? buildCurl(activeRequest) : ""),
    [activeRequest],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEYS.theme, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.requests, JSON.stringify(requests));
  }, [requests]);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEYS.responses,
      JSON.stringify(getPersistableResponses(responses)),
    );
  }, [responses]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.activeRequest, activeRequestId);
  }, [activeRequestId]);

  useEffect(() => {
    if (!activeRequest && requests[0]) {
      setActiveRequestId(requests[0].id);
    }
  }, [activeRequest, requests]);

  useEffect(() => {
    if (!isResponseModalOpen) {
      return;
    }

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsResponseModalOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [isResponseModalOpen]);

  function updateActiveRequest(updater: (request: RequestDocument) => RequestDocument) {
    if (!activeRequest) {
      return;
    }

    setRequests((current) =>
      current.map((request) =>
        request.id === activeRequest.id
          ? {
              ...updater(request),
              updatedAt: Date.now(),
            }
          : request,
      ),
    );
  }

  function updateRows(
    field: "headers" | "query",
    rowId: string,
    patch: Partial<KeyValuePair>,
  ) {
    updateActiveRequest((request) => ({
      ...request,
      [field]: request[field].map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
    }));
  }

  async function sendRequest() {
    if (!activeRequest) {
      return;
    }

    setResponses((current) => ({
      ...current,
      [activeRequest.id]: {
        loading: true,
        streamState: "streaming",
        payload: createPendingPayload(),
      },
    }));

    try {
      const response = await fetch("/api/request", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: activeRequest.url,
          method: activeRequest.method,
          headers: activeRequest.headers,
          query: activeRequest.query,
          bodyType: activeRequest.bodyType,
          body: activeRequest.body,
        }),
      });
      setResponseTab("body");

      if (!response.body) {
        throw new Error("Streaming response body is unavailable.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const applyStreamEvent = (streamEvent: StreamEvent) => {
        const updateResponses = () =>
          setResponses((current) => {
            const existing = current[activeRequest.id]?.payload ?? createPendingPayload();

            if (streamEvent.event === "meta") {
              return {
                ...current,
                [activeRequest.id]: {
                  loading: true,
                  streamState: "streaming",
                  payload: {
                    ...existing,
                    ok: streamEvent.data.ok,
                    status: streamEvent.data.status,
                    statusText: streamEvent.data.statusText,
                    url: streamEvent.data.url,
                    headers: streamEvent.data.headers,
                    requestedAt: streamEvent.data.requestedAt,
                  },
                },
              };
            }

            if (streamEvent.event === "chunk") {
              return {
                ...current,
                [activeRequest.id]: {
                  loading: true,
                  streamState: "streaming",
                  payload: {
                    ...existing,
                    body: `${existing.body}${streamEvent.data.value}`,
                    sizeBytes: streamEvent.data.sizeBytes,
                  },
                },
              };
            }

            if (streamEvent.event === "done") {
              return {
                ...current,
                [activeRequest.id]: {
                  loading: false,
                  streamState: "complete",
                  payload: {
                    ...existing,
                    durationMs: streamEvent.data.durationMs,
                    sizeBytes: streamEvent.data.sizeBytes,
                  },
                },
              };
            }

            return {
              ...current,
              [activeRequest.id]: {
                loading: false,
                streamState: "error",
                payload: {
                  ...existing,
                  ok: false,
                  status: existing.status || 500,
                  statusText:
                    existing.statusText === "Connecting" ? "Request Failed" : existing.statusText,
                  error: streamEvent.data.message,
                  durationMs: streamEvent.data.durationMs,
                  sizeBytes: streamEvent.data.sizeBytes,
                  requestedAt: streamEvent.data.requestedAt ?? existing.requestedAt,
                },
              },
            };
          });

        if (streamEvent.event === "chunk") {
          flushSync(updateResponses);
          return;
        }

        updateResponses();
      };

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split("\n\n");
        buffer = messages.pop() ?? "";

        for (const message of messages) {
          if (!message.trim()) {
            continue;
          }

          const eventLine = message
            .split("\n")
            .find((line) => line.startsWith("event:"));
          const dataLine = message
            .split("\n")
            .find((line) => line.startsWith("data:"));

          if (!eventLine || !dataLine) {
            continue;
          }

          const eventName = eventLine.slice("event:".length).trim();
          const payload = dataLine.slice("data:".length).trim();

          applyStreamEvent({
            event: eventName,
            data: JSON.parse(payload),
          } as StreamEvent);
        }
      }

      buffer += decoder.decode();

      if (buffer.trim()) {
        const eventLine = buffer
          .split("\n")
          .find((line) => line.startsWith("event:"));
        const dataLine = buffer
          .split("\n")
          .find((line) => line.startsWith("data:"));

        if (eventLine && dataLine) {
          applyStreamEvent({
            event: eventLine.slice("event:".length).trim(),
            data: JSON.parse(dataLine.slice("data:".length).trim()),
          } as StreamEvent);
        }
      }
    } catch (error) {
      setResponses((current) => ({
        ...current,
        [activeRequest.id]: {
          loading: false,
          streamState: "error",
          payload: {
            ok: false,
            status: 500,
            statusText: "Client Error",
            durationMs: 0,
            headers: {},
            body: "",
            error: error instanceof Error ? error.message : "Unknown error",
            requestedAt: new Date().toISOString(),
          },
        },
      }));
    }
  }

  async function copyCurl() {
    if (!curlCommand) {
      return;
    }

    await navigator.clipboard.writeText(curlCommand);
    setCopyState("done");
    window.setTimeout(() => setCopyState("idle"), 1200);
  }

  function openResponseFocusView() {
    if (!activeResponse?.payload) {
      return;
    }

    setResponseTab("body");
    setIsResponseModalOpen(true);
  }

  function duplicateActiveRequest() {
    if (!activeRequest) {
      return;
    }

    const duplicated = createRequest({
      ...activeRequest,
      id: uid(),
      name: `${activeRequest.name} Copy`,
      query: activeRequest.query.map((item) => ({ ...item, id: uid() })),
      headers: activeRequest.headers.map((item) => ({ ...item, id: uid() })),
    });

    setRequests((current) => [duplicated, ...current]);
    setActiveRequestId(duplicated.id);
  }

  function createNewRequest() {
    const fresh = createRequest();
    setRequests((current) => [fresh, ...current]);
    setActiveRequestId(fresh.id);
  }

  function deleteActiveRequest() {
    if (!activeRequest || requests.length === 1) {
      return;
    }

    const nextRequests = requests.filter((request) => request.id !== activeRequest.id);
    setRequests(nextRequests);
    setActiveRequestId(nextRequests[0]?.id ?? fallbackRequest.id);
  }

  if (!activeRequest) {
    return null;
  }

  return (
    <>
      <div className="shell">
        <aside className="sidebar panel">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            <p className="eyebrow">Bun + React + Elysia</p>
            <h1>Requestman</h1>
          </div>
        </div>

        <div className="sidebar-actions">
          <button className="button button-primary" onClick={createNewRequest}>
            New Request
          </button>
          <button
            className="button button-ghost"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? "Light Mode" : "Dark Mode"}
          </button>
        </div>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>Workspace</span>
            <span>{requests.length} tabs</span>
          </div>

          <div className="request-list">
            {requests
              .slice()
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((request) => {
                const requestResponse = responses[request.id]?.payload;

                return (
                  <button
                    key={request.id}
                    className={`request-card ${request.id === activeRequest.id ? "request-card-active" : ""}`}
                    onClick={() => setActiveRequestId(request.id)}
                  >
                    <div className="request-card-top">
                      <span className={`method-pill ${METHOD_TONES[request.method]}`}>{request.method}</span>
                      <span className="request-status">
                        {responses[request.id]?.loading
                          ? "Sending"
                          : requestResponse
                            ? `${requestResponse.status} ${requestResponse.statusText}`
                            : "Draft"}
                      </span>
                    </div>
                    <strong>{request.name}</strong>
                    <p>{request.url}</p>
                  </button>
                );
              })}
          </div>
        </section>

        <section className="sidebar-section tips-card">
          <div className="section-heading">
            <span>Flow</span>
            <span>Developer first</span>
          </div>
          <ul className="tips-list">
            <li>Requests persist locally, so refreshes keep the workspace intact.</li>
            <li>The Elysia backend proxies calls to avoid browser CORS issues.</li>
            <li>JSON responses pretty-print automatically and stay copyable.</li>
          </ul>
        </section>
        </aside>

        <main className="main">
          <header className="hero panel">
          <div className="hero-copy">
            <p className="eyebrow">Scratchpad / Active Request</p>
            <input
              className="request-name-input"
              value={activeRequest.name}
              onChange={(event) =>
                updateActiveRequest((request) => ({ ...request, name: event.target.value }))
              }
            />
            <p className="hero-subtitle">
              Tuned for fast iteration: clear hierarchy, keyboard-friendly editors, and no wasted chrome.
            </p>
          </div>

          <div className="hero-metrics">
            <div className="metric-tile">
              <span>Last Status</span>
              <strong>
                {activeResponse?.payload
                  ? `${activeResponse.payload.status} ${activeResponse.payload.statusText}`
                  : "Draft"}
              </strong>
            </div>
            <div className="metric-tile">
              <span>Latency</span>
              <strong>{activeResponse?.payload ? `${activeResponse.payload.durationMs} ms` : "0 ms"}</strong>
            </div>
            <div className="metric-tile">
              <span>Payload</span>
              <strong>{formatBytes(activeResponse?.payload?.sizeBytes)}</strong>
            </div>
          </div>
          </header>

          <section className="composer panel">
          <div className="request-bar">
            <select
              className={`method-select ${METHOD_TONES[activeRequest.method]}`}
              value={activeRequest.method}
              onChange={(event) =>
                updateActiveRequest((request) => ({
                  ...request,
                  method: event.target.value as Method,
                }))
              }
            >
              {METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>

            <input
              className="url-input"
              value={activeRequest.url}
              onChange={(event) =>
                updateActiveRequest((request) => ({ ...request, url: event.target.value }))
              }
              placeholder="https://api.example.com/v1/users"
              spellCheck={false}
            />

            <button className="button button-primary send-button" onClick={sendRequest}>
              {activeResponse?.loading ? "Sending..." : "Send"}
            </button>
          </div>

          <div className="toolbar">
            <div className="toolbar-group">
              <button className="button button-ghost" onClick={duplicateActiveRequest}>
                Duplicate
              </button>
              <button className="button button-ghost" onClick={deleteActiveRequest}>
                Delete
              </button>
            </div>
            <div className="toolbar-group">
              <span className="hint-chip">Proxy via Elysia</span>
              <span className="hint-chip">Saved locally</span>
              <span className="hint-chip">Pretty JSON</span>
            </div>
          </div>
          </section>

          <section className="workspace-grid">
            <section className="panel request-editor">
            <div className="tabs">
              {(["query", "headers", "body"] as RequestTab[]).map((tab) => (
                <button
                  key={tab}
                  className={`tab ${requestTab === tab ? "tab-active" : ""}`}
                  onClick={() => setRequestTab(tab)}
                >
                  {labelForTab(tab)}
                </button>
              ))}
            </div>

            {requestTab === "query" && (
              <KeyValueEditor
                rows={activeRequest.query}
                onChange={(rowId, patch) => updateRows("query", rowId, patch)}
                onAdd={() =>
                  updateActiveRequest((request) => ({
                    ...request,
                    query: [...request.query, createRow()],
                  }))
                }
                description="Compose query string values without touching the base URL."
              />
            )}

            {requestTab === "headers" && (
              <KeyValueEditor
                rows={activeRequest.headers}
                onChange={(rowId, patch) => updateRows("headers", rowId, patch)}
                onAdd={() =>
                  updateActiveRequest((request) => ({
                    ...request,
                    headers: [...request.headers, createRow()],
                  }))
                }
                description="Toggle experimental headers on and off instead of deleting them."
              />
            )}

            {requestTab === "body" && (
              <div className="body-editor">
                <div className="body-controls">
                  {(["none", "json", "text"] as BodyType[]).map((type) => (
                    <button
                      key={type}
                      className={`tab ${activeRequest.bodyType === type ? "tab-active" : ""}`}
                      onClick={() =>
                        updateActiveRequest((request) => ({
                          ...request,
                          bodyType: type,
                        }))
                      }
                    >
                      {type === "none" ? "No Body" : type.toUpperCase()}
                    </button>
                  ))}
                </div>

                <textarea
                  className="code-editor"
                  value={activeRequest.body}
                  onChange={(event) =>
                    updateActiveRequest((request) => ({
                      ...request,
                      body: event.target.value,
                    }))
                  }
                  placeholder={
                    activeRequest.bodyType === "json"
                      ? '{\n  "team": "platform",\n  "status": "shipping"\n}'
                      : "Raw request body"
                  }
                  spellCheck={false}
                />
              </div>
            )}
            </section>

            <section className="response-column">
              <section className="panel response-panel">
                <div className="response-header">
                  <div>
                    <p className="eyebrow">Response</p>
                    <h2>
                      {activeResponse?.payload
                        ? `${activeResponse.payload.status} ${activeResponse.payload.statusText}`
                        : "No response yet"}
                    </h2>
                  </div>

                  <div className="response-stats">
                    <span>{activeResponse?.payload ? `${activeResponse.payload.durationMs} ms` : "0 ms"}</span>
                    <span>{formatBytes(activeResponse?.payload?.sizeBytes)}</span>
                    <span>{formatTimestamp(activeResponse?.payload?.requestedAt)}</span>
                  </div>
                </div>

                <div className="response-actions">
                  <button
                    className="button button-secondary response-focus-button"
                    onClick={openResponseFocusView}
                    disabled={!activeResponse?.payload}
                  >
                    Open Focus View
                  </button>
                  <div className="response-action-meta">
                    <span className={streamBadge.className}>{streamBadge.label}</span>
                    <span className="response-action-hint">
                      Opens the prettified response in a dedicated modal.
                    </span>
                  </div>
                </div>

                <div className="tabs">
                  {(["body", "headers", "meta"] as ResponseTab[]).map((tab) => (
                    <button
                      key={tab}
                      className={`tab ${responseTab === tab ? "tab-active" : ""}`}
                      onClick={() => setResponseTab(tab)}
                    >
                      {labelForTab(tab)}
                    </button>
                  ))}
                </div>

                {responseTab === "body" && (
                  <pre className="response-view">
                    {responseBodyContent}
                  </pre>
                )}

                {responseTab === "headers" && (
                  <div className="key-value-readonly">
                    {activeResponse?.payload &&
                    Object.keys(activeResponse.payload.headers).length > 0 ? (
                      Object.entries(activeResponse.payload.headers).map(([key, value]) => (
                        <div className="readonly-row" key={key}>
                          <span>{key}</span>
                          <code>{value}</code>
                        </div>
                      ))
                    ) : (
                      <p className="empty-state">Headers appear after a request finishes.</p>
                    )}
                  </div>
                )}

                {responseTab === "meta" && (
                  <div className="meta-grid">
                    <div className="meta-card">
                      <span>Resolved URL</span>
                      <strong>{activeResponse?.payload?.url ?? activeRequest.url}</strong>
                    </div>
                    <div className="meta-card">
                      <span>Timestamp</span>
                      <strong>{formatTimestamp(activeResponse?.payload?.requestedAt)}</strong>
                    </div>
                    <div className="meta-card">
                      <span>Transport</span>
                      <strong>Bun fetch through Elysia proxy</strong>
                    </div>
                  </div>
                )}
              </section>

              <section className="panel utility-panel">
                <div className="utility-header">
                  <div>
                    <p className="eyebrow">Generated cURL</p>
                    <h2>Export without friction</h2>
                  </div>
                  <button className="button button-ghost" onClick={copyCurl}>
                    {copyState === "done" ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="response-view">{curlCommand}</pre>
              </section>
            </section>
          </section>
        </main>
      </div>

      {isResponseModalOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setIsResponseModalOpen(false)}
          role="presentation"
        >
          <section
            className="modal-panel panel"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="response-focus-title"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Focused Response</p>
                <h2 id="response-focus-title">
                  {activeResponse?.payload
                    ? `${activeResponse.payload.status} ${activeResponse.payload.statusText}`
                    : "Response"}
                </h2>
              </div>
              <div className="modal-header-actions">
                <span className={streamBadge.className}>{streamBadge.label}</span>
                <button
                  className="button button-primary"
                  onClick={sendRequest}
                >
                  {activeResponse?.loading ? "Sending..." : "Send"}
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => setIsResponseModalOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>

            <div className="modal-meta">
              <span>{activeResponse?.payload ? `${activeResponse.payload.durationMs} ms` : "0 ms"}</span>
              <span>{formatBytes(activeResponse?.payload?.sizeBytes)}</span>
              <span>{formatTimestamp(activeResponse?.payload?.requestedAt)}</span>
            </div>

            <pre className="response-view response-view-modal">
              {responseBodyContent}
            </pre>
          </section>
        </div>
      )}
    </>
  );
}

type KeyValueEditorProps = {
  rows: KeyValuePair[];
  onAdd: () => void;
  onChange: (rowId: string, patch: Partial<KeyValuePair>) => void;
  description: string;
};

function KeyValueEditor({ rows, onAdd, onChange, description }: KeyValueEditorProps) {
  return (
    <div className="kv-editor">
      <p className="editor-description">{description}</p>
      <div className="kv-table">
        {rows.map((row) => (
          <div className="kv-row" key={row.id}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={row.enabled}
                onChange={(event) => onChange(row.id, { enabled: event.target.checked })}
              />
              <span />
            </label>
            <input
              value={row.key}
              onChange={(event) => onChange(row.id, { key: event.target.value })}
              placeholder="key"
              spellCheck={false}
            />
            <input
              value={row.value}
              onChange={(event) => onChange(row.id, { value: event.target.value })}
              placeholder="value"
              spellCheck={false}
            />
          </div>
        ))}
      </div>
      <button className="button button-secondary" onClick={onAdd}>
        Add Row
      </button>
    </div>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <React.StrictMode>
    <RequestmanApp />
  </React.StrictMode>,
);
