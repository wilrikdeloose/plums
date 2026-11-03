import { SecretError, type SecretStore } from "../core/platform";

const MAX_SECRET_LENGTH = 4096;

/**
 * Keeps credentials only in this page's memory: never in IndexedDB, localStorage or cookies.
 * A reload or new tab starts empty, so the key must be entered again.
 */
export class MemorySecretStore implements SecretStore {
  readonly persistence = "session" as const;
  private secrets = new Map<string, string>();

  async has(endpoint: string): Promise<boolean> {
    return this.secrets.has(endpoint);
  }

  async save(endpoint: string, secret: string): Promise<void> {
    const value = secret.trim();
    if (!value) throw new SecretError("Vul een API-sleutel in.");
    if (value.length > MAX_SECRET_LENGTH || /[\r\n]/.test(value)) throw new SecretError("Deze API-sleutel heeft een ongeldig formaat.");
    this.secrets.set(endpoint, value);
  }

  async remove(endpoint: string): Promise<void> {
    this.secrets.delete(endpoint);
  }

  /** Only for the browser transport: the secret bound to exactly this URL. */
  resolve(endpoint: string): string | undefined {
    return this.secrets.get(endpoint);
  }
}
