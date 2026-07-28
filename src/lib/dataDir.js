import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "9router";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    // Ensure parent directory exists first (helps with volume mount timing)
    const parent = path.dirname(configured);
    if (parent !== configured && parent !== '.' && parent !== '/') {
      fs.mkdirSync(parent, { recursive: true });
    }
    
    // Create the configured directory
    fs.mkdirSync(configured, { recursive: true });
    
    // Verify write access by creating and removing a test file
    const testFile = path.join(configured, '.write-test');
    fs.writeFileSync(testFile, '', 'utf8');
    fs.unlinkSync(testFile);
    
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    console.error(`[DATA_DIR] Failed to create or verify '${configured}': ${e.message}`);
    console.error(`[DATA_DIR] Check permissions and volume mounts (Docker: ensure -v volume is mounted)`);
    throw e;
  }
}

export const DATA_DIR = getDataDir();
