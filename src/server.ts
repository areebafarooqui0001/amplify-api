import { loadConfig } from './config';
import { createApp } from './app';
import { createDb, createPool } from './db/client';

const config = loadConfig();
const pool = createPool(config);
const app = createApp(createDb(pool), config);

const server = app.listen(config.PORT, () => {
  console.log(`Amplify API listening on port ${config.PORT} (${config.NODE_ENV})`);
});

// Finish in-flight requests and close the database pool on shutdown.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
