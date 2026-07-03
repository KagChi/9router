/**
 * Ensure Camoufox is available for Google bulk automation.
 * Called during server startup to verify/fetch the Firefox binary.
 */
export async function ensureCamoufox() {
  try {
    const camoufox = await import('camoufox-js');
    console.log('[Camoufox] Package installed');
    
    // Check if Firefox binary exists
    try {
      const { execSync } = await import('child_process');
      execSync('npx camoufox-js --version', { stdio: 'ignore', timeout: 5000 });
      console.log('[Camoufox] Firefox binary ready for Google automation');
      return true;
    } catch {
      console.warn('[Camoufox] Firefox binary missing, attempting download...');
      try {
        const { execSync } = await import('child_process');
        execSync('npx camoufox-js fetch', { stdio: 'inherit', timeout: 120000 });
        console.log('[Camoufox] Download complete');
        return true;
      } catch (fetchErr) {
        console.warn('[Camoufox] Download failed:', fetchErr.message);
        console.warn('[Camoufox] Google bulk automation unavailable');
        return false;
      }
    }
  } catch (e) {
    console.warn('[Camoufox] Package not installed, Google bulk automation unavailable');
    console.warn('[Camoufox] To enable: npm install camoufox-js && npx camoufox-js fetch');
    return false;
  }
}
