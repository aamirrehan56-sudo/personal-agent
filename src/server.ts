import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
const app = await buildApp(config, db, { logger: true });
if (!config.anthropicApiKey) app.log.warn('ANTHROPIC_API_KEY is not set: the dashboard works, but AI chat is disabled.');
await app.listen({ port: config.port, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
