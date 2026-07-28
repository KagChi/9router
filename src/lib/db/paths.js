import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
export const LEGACY_FILES = {
  main: path.join(DATA_DIR, "db.json"),
  usage: path.join(DATA_DIR, "usage.json"),
  disabled: path.join(DATA_DIR, "disabledModels.json"),
  details: path.join(DATA_DIR, "request-details.json"),
};
export function ensureDirs() {
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new Error(
        `[DB] Failed to create directory '${dir}': ${e.code || e.message}. ` +
          `Set DATA_DIR env var to a writable path (current DATA_DIR=${DATA_DIR}).`,
      );
    }
  }
}
