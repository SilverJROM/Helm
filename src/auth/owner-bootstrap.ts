import type Database from 'better-sqlite3';

export const NATIVE_OWNER_ID = 1;

interface NativeOwnerRow {
  id: number;
  telegram_id: number;
  active: number;
}

/**
 * Establish the one durable Helm owner exactly once. Existing identities are
 * validated, never repaired or replaced, so a configuration mismatch stops
 * boot before authentication routes are registered.
 */
export function bootstrapNativeOwner(db: Database.Database, ownerTelegramId: number): void {
  if (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0) {
    throw new Error('Native owner Telegram ID must be a positive safe integer');
  }

  const bootstrap = db.transaction(() => {
    const owners = db.prepare(
      "SELECT id, telegram_id, active FROM users WHERE role = 'owner' ORDER BY id"
    ).all() as NativeOwnerRow[];

    if (owners.length === 0) {
      db.prepare(`
        INSERT INTO users (id, telegram_id, role, active)
        VALUES (?, ?, 'owner', 1)
      `).run(NATIVE_OWNER_ID, ownerTelegramId);
      return;
    }

    if (
      owners.length !== 1
      || owners[0].id !== NATIVE_OWNER_ID
      || owners[0].telegram_id !== ownerTelegramId
      || owners[0].active !== 1
    ) {
      throw new Error('Native owner configuration conflicts with the existing owner');
    }
  });

  bootstrap();
}
