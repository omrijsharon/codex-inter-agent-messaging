import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { migration001 } from "./migrations/001_initial.js";
import { migration002 } from "./migrations/002_reliability.js";
import { migration003 } from "./migrations/003_security.js";
import { migration004 } from "./migrations/004_async.js";
import { migration005 } from "./migrations/005_groups.js";
import { migration006 } from "./migrations/006_owner_binding.js";

const migrations = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
] as const;

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export class BridgeDatabase {
  readonly database: Database.Database;

  constructor(filename: string) {
    this.database = new Database(filename);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("busy_timeout = 5000");
    this.migrate();
  }

  migrate(): void {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT)",
    );
    const columns = this.database.pragma("table_info('schema_migrations')") as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "checksum")) {
      this.database.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    }
    const known = new Map<number, (typeof migrations)[number]>(
      migrations.map((migration) => [migration.version, migration]),
    );
    const recorded = this.database
      .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string; checksum: string | null }>;
    for (const row of recorded) {
      const migration = known.get(row.version);
      if (!migration) {
        throw new Error(`database schema version ${row.version} is newer than this binary`);
      }
      const checksum = migrationChecksum(migration.sql);
      if (row.name !== migration.name) {
        throw new Error(`database migration ${row.version} name does not match this binary`);
      }
      if (row.checksum !== null && row.checksum !== checksum) {
        throw new Error(`database migration ${row.version} checksum does not match this binary`);
      }
      if (row.checksum === null) {
        this.database
          .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?")
          .run(checksum, row.version);
      }
    }
    const applied = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
    for (const migration of migrations) {
      if (applied.get(migration.version)) continue;
      this.immediateTransaction(() => {
        this.database.exec(migration.sql);
        this.database
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
          )
          .run(
            migration.version,
            migration.name,
            new Date().toISOString(),
            migrationChecksum(migration.sql),
          );
      });
    }
  }

  immediateTransaction<T>(operation: () => T): T {
    if (this.database.inTransaction) return operation();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
