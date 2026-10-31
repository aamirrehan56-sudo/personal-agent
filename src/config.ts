import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  return v;
}

export interface Config {
  databaseUrl: string;
  port: number;
  cookieSecure: boolean;
  setupCode: string;
  encryptionKey: string;
  anthropicApiKey: string | undefined;
  aiModel: string;
  aiEffort: 'low' | 'medium' | 'high';
  timezone: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const effort = (process.env.AI_EFFORT ?? 'low') as Config['aiEffort'];
  return {
    databaseUrl: overrides.databaseUrl ?? required('DATABASE_URL'),
    port: overrides.port ?? Number(process.env.PORT ?? 3000),
    cookieSecure: overrides.cookieSecure ?? process.env.COOKIE_SECURE === 'true',
    setupCode: overrides.setupCode ?? required('SETUP_CODE'),
    encryptionKey: overrides.encryptionKey ?? required('ENCRYPTION_KEY'),
    anthropicApiKey: overrides.anthropicApiKey ?? (process.env.ANTHROPIC_API_KEY || undefined),
    aiModel: overrides.aiModel ?? process.env.AI_MODEL ?? 'claude-opus-5-5',
    aiEffort: overrides.aiEffort ?? (['low', 'medium', 'high'].includes(effort) ? effort : 'low'),
    timezone: overrides.timezone ?? process.env.TIMEZONE ?? 'Australia/Melbourne',
  };
}
