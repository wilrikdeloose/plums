import { StorageError, type DataStore, type StorageInfo } from "../core/platform";

const DB_NAME = "plums";
const DB_VERSION = 1;
const STORE = "appdata";
const KEY = "current";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transactie afgebroken"));
  });
}

export class IndexedDbStore implements DataStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new StorageError("unavailable", "IndexedDB is niet beschikbaar in deze browser."));
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () =>
          reject(new StorageError("unavailable", `IndexedDB kon niet worden geopend: ${req.error?.message ?? "onbekende fout"}`));
        req.onblocked = () =>
          reject(new StorageError("unavailable", "IndexedDB is geblokkeerd door een ander tabblad. Sluit andere PLuMS-tabbladen."));
      });
      this.db.catch(() => (this.db = null));
    }
    return this.db;
  }

  async info(): Promise<StorageInfo> {
    return { type: "Browseropslag (IndexedDB)", location: `IndexedDB-database "${DB_NAME}", objectstore "${STORE}", sleutel "${KEY}"` };
  }

  async load(): Promise<unknown | null> {
    const db = await this.open();
    try {
      const value = await request(db.transaction(STORE, "readonly").objectStore(STORE).get(KEY));
      return value ?? null;
    } catch (error) {
      throw new StorageError("read", `Lezen uit IndexedDB mislukt: ${(error as Error)?.message ?? error}`);
    }
  }

  async save(data: unknown): Promise<void> {
    const db = await this.open();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(data, KEY);
      await done(tx);
    } catch (error) {
      throw new StorageError("write", `Schrijven naar IndexedDB mislukt: ${(error as Error)?.message ?? error}`);
    }
  }

  async clear(): Promise<void> {
    const db = await this.open();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      await done(tx);
    } catch (error) {
      throw new StorageError("write", `Verwijderen uit IndexedDB mislukt: ${(error as Error)?.message ?? error}`);
    }
  }

  async quarantine(): Promise<string> {
    const db = await this.open();
    const backupKey = `onleesbaar-${new Date().toISOString()}`;
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const value = await request(store.get(KEY));
      if (value !== undefined) store.put(value, backupKey);
      store.delete(KEY);
      await done(tx);
    } catch (error) {
      throw new StorageError("write", `Apart zetten in IndexedDB mislukt: ${(error as Error)?.message ?? error}`);
    }
    return `IndexedDB-sleutel "${backupKey}"`;
  }
}
