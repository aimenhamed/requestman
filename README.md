# requestman

Developer-first API client built with Bun, TypeScript, React, and Elysia.

## Stack

- React frontend with a multi-panel request workspace
- Elysia backend proxy for outbound HTTP requests
- Bun-powered client bundling with no extra Vite layer
- Persistent local workspace state and light/dark themes

## Commands

Install dependencies:

```bash
bun install
```

Run in development:

```bash
bun run dev
```

Create the client bundle:

```bash
bun run build
```

Run the production server:

```bash
bun run start
```

Typecheck:

```bash
bun run typecheck
```

## Features

- Saved request workspace with quick duplication and deletion
- Query params, headers, and raw JSON/text body editors
- Response body, header, and request metadata inspection
- One-click cURL export
- Dark mode and a polished desktop/mobile layout
