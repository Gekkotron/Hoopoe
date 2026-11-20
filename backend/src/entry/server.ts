import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { pool } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { build } from '../buildServer.js';
import { rotateFromPreviousSecret } from './session-secret-migration.js';
import { assertServerAuthMode } from './serverAuthMode.js';

const shutdown = async (app: FastifyInstance, signal: string) => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'error during shutdown');
    process.exit(1);
  }
};

try {
  assertServerAuthMode(env.AUTH_MODE);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const app = await build();

process.on('SIGINT', () => void shutdown(app, 'SIGINT'));
process.on('SIGTERM', () => void shutdown(app, 'SIGTERM'));

try {
  await runMigrations();
  if (env.SESSION_SECRET_PREVIOUS) {
    try {
      const counts = await rotateFromPreviousSecret(env.SESSION_SECRET_PREVIOUS, env.SESSION_SECRET);
      if (counts) {
        app.log.warn({ ...counts }, 'session secret rotated; remove SESSION_SECRET_PREVIOUS from .env');
      }
    } catch (err) {
      app.log.error(
        err,
        'SESSION_SECRET_PREVIOUS rotation failed, nothing was changed. If an earlier boot already ' +
          'rotated the secret, remove SESSION_SECRET_PREVIOUS; otherwise check it holds the old value.',
      );
      process.exit(1);
    }
  }
  if (!process.env.OCR_LANG_PATH) app.log.warn('OCR_LANG_PATH not set — first OCR run will attempt CDN fetch (fine for dev, fails on LAN-only deploy).');
  await app.listen({ host: '0.0.0.0', port: env.PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
