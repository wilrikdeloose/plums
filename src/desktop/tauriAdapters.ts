import { invoke } from "@tauri-apps/api/core";
import { StorageError, type DataStore, type FileTransfer, type StorageErrorKind, type StorageInfo } from "../core/platform";

interface NativeError {
  kind: StorageErrorKind;
  message: string;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const native = error as Partial<NativeError>;
    if (native && typeof native.message === "string" && typeof native.kind === "string") {
      throw new StorageError(native.kind, native.message);
    }
    throw new StorageError("unavailable", `Native opdracht "${command}" mislukt: ${String(error)}`);
  }
}

export class TauriFileStore implements DataStore {
  async info(): Promise<StorageInfo> {
    const path = await call<string>("data_path");
    return { type: "Lokaal bestand (your.data)", location: path };
  }

  async load(): Promise<unknown | null> {
    const text = await call<string | null>("data_load");
    if (text === null) return null;
    try {
      return JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new StorageError("malformed", `your.data bevat geen geldige JSON: ${(error as Error).message}`);
    }
  }

  async save(data: unknown): Promise<void> {
    await call<void>("data_save", { contents: JSON.stringify(data, null, 2) + "\n" });
  }

  async clear(): Promise<void> {
    await call<void>("data_clear");
  }

  async quarantine(): Promise<string> {
    return call<string>("data_quarantine");
  }
}

export const tauriFiles: FileTransfer = {
  saveJson: (suggestedName, contents) => call<boolean>("export_json", { suggestedName, contents }),
  openJson: () => call<string | null>("import_json"),
};
