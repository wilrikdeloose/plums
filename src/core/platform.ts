import type { McpClient } from "./mcp/types";

export type PlatformId = "desktop" | "web";

export type StorageErrorKind = "unavailable" | "read" | "write" | "malformed";

export class StorageError extends Error {
  constructor(
    readonly kind: StorageErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export interface StorageInfo {
  /** Human-readable storage type, e.g. "Lokaal bestand (your.data)". */
  type: string;
  /** Actual location: file path on desktop, database/store name in the browser. */
  location: string;
}

/** Persists one JSON document with the shared AppData schema. */
export interface DataStore {
  info(): Promise<StorageInfo>;
  /** Returns the parsed stored document, or null when nothing is stored yet. */
  load(): Promise<unknown | null>;
  save(data: unknown): Promise<void>;
  clear(): Promise<void>;
  /** Moves unreadable data aside so a fresh document can be started; returns where it was kept. */
  quarantine(): Promise<string>;
}

/** Lets the user pick files for import/export (native dialogs or browser file input/download). */
export interface FileTransfer {
  /** Returns false when the user cancelled. */
  saveJson(suggestedName: string, contents: string): Promise<boolean>;
  /** Returns null when the user cancelled. */
  openJson(): Promise<string | null>;
}

/**
 * Credentials bound to one exact endpoint URL. Values can be written or removed, never read back:
 * only the platform HttpTransport resolves them, and only for requests to that same URL.
 */
export interface SecretStore {
  /** "os": native OS protection, kept across restarts. "session": memory of this page only. */
  persistence: "os" | "session";
  has(endpoint: string): Promise<boolean>;
  save(endpoint: string, secret: string): Promise<void>;
  remove(endpoint: string): Promise<void>;
}

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  /** Adds "Authorization: Bearer <secret stored for exactly this URL>" inside the transport. */
  bearerFromSecret?: boolean;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Body chunks as they arrive; iteration rejects with TransportError on failure or abort. */
  body: AsyncIterable<Uint8Array>;
}

export type TransportErrorKind = "network" | "timeout" | "aborted" | "missing-secret" | "stream" | "invalid-request";

export class TransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface Platform {
  id: PlatformId;
  dataStore: DataStore;
  files: FileTransfer;
  secrets: SecretStore;
  http: HttpTransport;
  mcp: McpClient;
  capabilities: {
    builtInMcp: boolean;
    /** True only in a --testmode=true desktop build whose native code agrees with the frontend flag. */
    canvasTestStudent?: boolean;
    /** Dutch notice when the test build is incomplete (frontend and native flags disagree). */
    testBuildWarning?: string;
  };
}
