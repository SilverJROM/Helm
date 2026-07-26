import path from 'node:path';

export const LIVE_HELM_DB_PATH = path.resolve(process.cwd(), 'data/helm.db');

/** Refuse accidental use of the write-capable product database in tests. */
export function requireIsolatedDefinitionTestDb(dbPath: string): void {
  if (path.resolve(dbPath) === LIVE_HELM_DB_PATH) {
    throw new Error('definition mutation tests must not use live data/helm.db');
  }
}
