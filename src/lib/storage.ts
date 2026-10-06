import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

/**
 * Private object storage boundary. The local adapter keeps files outside the public web root;
 * nothing under STORAGE_DIR is ever served directly. Files are only streamed through the
 * authorized, short-lived download route. Swap in an S3-compatible adapter for production.
 */
export interface StorageAdapter {
  readonly name: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class LocalStorage implements StorageAdapter {
  readonly name = "local-private-disk";
  constructor(private root: string) {}

  private resolve(key: string) {
    if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(key: string, data: Buffer) {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await fs.writeFile(full, data, { mode: 0o600 });
  }

  async get(key: string) {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
}

let storage: StorageAdapter | null = null;
export function getStorage(): StorageAdapter {
  storage ??= new LocalStorage(path.resolve(env.storageDir));
  return storage;
}
