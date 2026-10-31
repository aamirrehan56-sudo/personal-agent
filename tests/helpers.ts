import 'dotenv/config';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { CreateMessage } from '../src/services/ai/agent.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://agent:agent@localhost:5432/agent_test';
export const TEST_KEY = 'a'.repeat(64);

/** Fresh, empty test database with all migrations applied. */
export async function freshDb(): Promise<Db> {
  if (!/test/.test(TEST_DB_URL)) throw new Error('Refusing to wipe a database whose name does not contain "test"');
  const db = createPool(TEST_DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  return db;
}

export async function makeUser(db: Db, email = 'me@example.com'): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [email]);
  return rows[0].id;
}

export async function testApp(db: Db, createMessage: CreateMessage | null = null) {
  const config = loadConfig({
    databaseUrl: TEST_DB_URL, setupCode: 'setup-123', encryptionKey: TEST_KEY, cookieSecure: false,
    anthropicApiKey: undefined, aiModel: 'claude-opus-5-5', aiEffort: 'low', timezone: 'Australia/Melbourne',
  });
  return buildApp(config, db, { createMessage });
}

export const H = { 'x-requested-with': 'personal-agent' };
