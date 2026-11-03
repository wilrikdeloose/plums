# PLuMS

Personal AI assistant for Fontys ICT students. Plans a day or week from Canvas work, deadlines, announcements and your own availability. Dutch UI. Proof of concept.

## Requirements

- Node.js 20+ and npm
- For desktop: [Rust](https://rustup.rs/) and [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)

## Install

```bash
npm install
```

## Run

**Browser**

```bash
npm run dev:web
```

**Desktop**

```bash
npm run dev:desktop
```

Optional Canvas Test Student build (desktop only):

```bash
npm run dev:desktop -- --testmode=true
```

**Production builds**

```bash
npm run build:web
npm run build:desktop
```

## Architecture

One shared React/TypeScript/Vite app for web and desktop. Tauri 2 (Rust) is the desktop shell only.

| Layer | Role |
| --- | --- |
| `src/ui` | Dutch chat UI, settings, Markdown |
| `src/core` | Chat, AI streaming/tools, Canvas MCP policy, planning |
| `src/web` / `src/desktop` | Platform adapters injected at startup |

Shared code talks to platforms through small async interfaces: **DataStore**, **SecretStore**, **HttpTransport**, **McpClient**. The UI/core never imports Tauri, Node or filesystem APIs.

- **Desktop**: `your.data` next to the executable; OS-backed secrets; built-in Canvas MCP and/or a remote MCP URL.
- **Browser**: IndexedDB; session-only secrets; remote MCP only.

Canvas access is read-only. Credentials stay out of ordinary settings, chat context, logs and exports. Full behaviour lives in `PLUMS_SPEC.md`.
