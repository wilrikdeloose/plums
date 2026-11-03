import { StorageError, type Platform, type StorageInfo } from "./platform";
import { appDataSchema, createDefaultData, validateAppData, type AppData } from "./schema";

export type LoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "failed"; problem: "storage" | "invalid"; message: string };

export type SaveState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "saving" }
  | { status: "saved"; at: Date }
  | { status: "failed"; message: string };

export interface DataSnapshot {
  load: LoadState;
  save: SaveState;
  data: AppData | null;
  storage: StorageInfo | null;
  notes: string[];
}

const AUTOSAVE_DELAY_MS = 300;

function describe(error: unknown): string {
  if (error instanceof StorageError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Owns the in-memory AppData, loads it before edits are allowed and autosaves changes.
 * Saves run strictly one after another and always write the newest state, so no update is lost.
 */
export class DataController {
  private snapshot: DataSnapshot = { load: { status: "loading" }, save: { status: "idle" }, data: null, storage: null, notes: [] };
  private listeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly platform: Platform) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DataSnapshot => this.snapshot;

  private set(patch: Partial<DataSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  private get builtInMcp() {
    return this.platform.capabilities.builtInMcp;
  }

  async load(): Promise<void> {
    this.set({ load: { status: "loading" } });
    try {
      const storage = await this.platform.dataStore.info();
      this.set({ storage });
      const raw = await this.platform.dataStore.load();
      if (raw === null) {
        this.set({ data: createDefaultData(this.builtInMcp), load: { status: "ready" }, notes: [] });
        return;
      }
      const result = validateAppData(raw, this.builtInMcp, this.platform.capabilities.canvasTestStudent === true);
      if (!result.ok) {
        this.set({ data: null, load: { status: "failed", problem: "invalid", message: result.error } });
        return;
      }
      this.set({ data: result.data, load: { status: "ready" }, notes: result.notes });
    } catch (error) {
      const invalid = error instanceof StorageError && error.kind === "malformed";
      this.set({ data: null, load: { status: "failed", problem: invalid ? "invalid" : "storage", message: describe(error) } });
    }
  }

  /** Moves unreadable stored data aside and starts with fresh defaults. */
  async startFresh(): Promise<string> {
    const keptAt = await this.platform.dataStore.quarantine();
    this.dirty = false;
    this.set({ data: createDefaultData(this.builtInMcp), load: { status: "ready" }, save: { status: "idle" }, notes: [] });
    return keptAt;
  }

  /** Applies a change to a copy of the data and schedules an autosave. */
  update(mutate: (draft: AppData) => void, options: { immediate?: boolean } = {}): void {
    const current = this.snapshot.data;
    if (this.snapshot.load.status !== "ready" || !current) {
      throw new Error("Gegevens zijn nog niet geladen; wijzigen is niet mogelijk.");
    }
    const draft = structuredClone(current);
    mutate(draft);
    this.dirty = true;
    this.set({ data: draft, save: { status: "pending" } });
    if (options.immediate) void this.flush().catch(() => undefined);
    else this.schedule();
  }

  /** Replaces all data (validated import) and saves immediately. */
  async replace(data: AppData): Promise<void> {
    this.dirty = true;
    this.set({ data, save: { status: "pending" }, notes: [] });
    await this.flush();
  }

  /** Deletes all stored data, then resets to defaults. Existing data stays if deletion fails. */
  async clearAll(): Promise<void> {
    clearTimeout(this.timer);
    const run = this.chain.then(async () => {
      this.set({ save: { status: "saving" } });
      await this.platform.dataStore.clear();
      this.dirty = false;
      this.set({ data: createDefaultData(this.builtInMcp), save: { status: "saved", at: new Date() }, notes: [] });
    });
    this.chain = run.catch((error) => {
      this.set({ save: { status: "failed", message: `Verwijderen mislukt: ${describe(error)}` } });
    });
    await run;
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => undefined), AUTOSAVE_DELAY_MS);
  }

  /** Writes the newest data after any running save. Resolves once written; rejects on failure. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    const run = this.chain.then(() => this.writeLatest());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async writeLatest(): Promise<void> {
    if (!this.dirty || !this.snapshot.data) return;
    const checked = appDataSchema.safeParse(this.snapshot.data);
    if (!checked.success) {
      const message = `Niet opgeslagen: ongeldige invoer (${checked.error.issues[0]?.path.join(".")}).`;
      this.set({ save: { status: "failed", message } });
      throw new Error(message);
    }
    this.dirty = false;
    this.set({ save: { status: "saving" } });
    try {
      await this.platform.dataStore.save(checked.data);
      this.set({ save: this.dirty ? { status: "pending" } : { status: "saved", at: new Date() } });
    } catch (error) {
      this.dirty = true;
      this.set({ save: { status: "failed", message: `Opslaan mislukt: ${describe(error)}` } });
      throw error;
    }
  }
}
