import { randomUUID } from "node:crypto";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  DATABASE_TOKEN,
  SCHEMA_TOKEN,
  DatabaseManager,
  Schema,
  SqliteDriver,
} from "@mahiframework/database";
import { DateTime } from "@mahiframework/datetime";
import { Encrypter, Hasher, Signer } from "@mahiframework/encryption";
import { MfaIntent } from "../../src/models/mfa-intent.js";
import createMfaMethodsTable from "../../src/migrations/0001_create_mfa_methods_table.js";
import createMfaIntentsTable from "../../src/migrations/0002_create_mfa_intents_table.js";
import createMfaChallengesTable from "../../src/migrations/0003_create_mfa_challenges_table.js";
import createMfaRecoveryCodesTable from "../../src/migrations/0004_create_mfa_recovery_codes_table.js";

export interface TestDatabase {
  app: Application;
  cleanup: () => void;
}

/**
 * In-memory SQLite with this package's real migrations applied, plus a
 * `users` table standing in for the app-owned one.
 *
 * Runs the migration FILES rather than hand-rolled equivalent schema, so
 * a drift between what a migration creates and what a driver queries
 * fails here instead of only in a real app.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const app = new Application();
  const manager = new DatabaseManager(app, { default: "sqlite", connections: {} });
  manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));
  app.instance(DATABASE_TOKEN, manager);
  app.bind(SCHEMA_TOKEN, () => manager.schema());
  setCurrentApp(app);

  await createMfaMethodsTable.up();
  await createMfaIntentsTable.up();
  await createMfaChallengesTable.up();
  await createMfaRecoveryCodesTable.up();

  await Schema.create("users", (table) => {
    table.string("id").primary();
    table.string("email").unique();
  });

  return { app, cleanup: () => clearCurrentApp() };
}

/**
 * Argon2 at its cheapest LEGAL settings. These are the library's floors,
 * not arbitrary small numbers: `memory` is in KiB and is rejected under
 * 1024, and `time` is rejected under 2.
 *
 * The emailed-code driver hashes on every verify AND on every miss path
 * (deliberately, to keep the two indistinguishable), so default
 * parameters would make this suite take minutes. The hash's strength is
 * not what any of these tests assert.
 */
export function testHasher(): Hasher {
  return new Hasher({ memory: 1024, time: 2, threads: 1 });
}

export function testEncrypter(): Encrypter {
  return new Encrypter(Buffer.alloc(32, 3));
}

export function testSigner(): Signer {
  return new Signer(Buffer.alloc(32, 9));
}

export interface MakeIntentOptions {
  userId?: string;
  purpose?: string | null;
  binding?: string | null;
  driver?: string | null;
  status?: "pending" | "verified" | "locked";
  attempts?: number;
  /** Minutes until the intent deadline. Negative for an already-expired one. */
  expiresInMinutes?: number;
  /** Minutes the verification is good for. Only meaningful with `status: "verified"`. */
  verifiedForMinutes?: number;
}

/** A persisted intent, with everything defaulted to the live/pending case. */
export async function makeIntent(options: MakeIntentOptions = {}): Promise<MfaIntent> {
  const now = DateTime.now();
  const status = options.status ?? "pending";
  const verifiedFor = options.verifiedForMinutes ?? 15;

  return MfaIntent.create({
    id: randomUUID(),
    user_id: options.userId ?? "user-1",
    binding: options.binding ?? null,
    purpose: options.purpose ?? null,
    status,
    driver: options.driver ?? null,
    attempts: options.attempts ?? 0,
    verified_at: status === "verified" ? now : null,
    verification_expires_at: status === "verified" ? now.addMinutes(verifiedFor) : null,
    intent_expires_at: now.addMinutes(options.expiresInMinutes ?? 10),
    created_at: now,
  });
}
