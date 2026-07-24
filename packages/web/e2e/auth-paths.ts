import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Plain module (no test() calls) so the Playwright config can import the
// storageState path without evaluating a setup file that registers tests.
const dir = path.dirname(fileURLToPath(import.meta.url));

/** Where the authenticated browser storageState is written by the setup
 *  project and read by the chromium project. */
export const STORAGE_STATE = path.join(dir, '.auth', 'state.json');
