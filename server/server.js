// MariaDB Data Lab entry point: validates the deployment settings, starts the
// HTTP application and handles graceful shutdown.
import { config } from './config.js';
import { createApp } from './app.js';
import { closePool } from './db.js';
import { recoverOnStartup, shutdown } from './jobs/jobManager.js';
import { log } from './logger.js';

// Listening on a network interface without a token would expose database
// credentials and destructive operations to anyone who can reach the port.
if (!config.app.loopback && !config.app.accessToken) {
  log.error('refusing to start: APP_HOST is not a loopback address and APP_ACCESS_TOKEN is not set', { host: config.app.host });
  process.exit(1);
}
if (config.app.accessToken && config.app.accessToken.length < 16) {
  log.error('refusing to start: APP_ACCESS_TOKEN must be at least 16 characters');
  process.exit(1);
}
if (!config.app.loopback && !config.app.allowedHosts.length) {
  log.warn('APP_ALLOWED_HOSTS is empty on a network bind; Host headers are not checked (DNS-rebinding protection relies on the token alone)');
}

const server = createApp();

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  server.close();
  await shutdown();
  await closePool();
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

server.listen(config.app.port, config.app.host, async () => {
  log.info('MariaDB Data Lab listening', {
    url: `http://${config.app.host}:${config.app.port}`, database: config.db.database, tokenRequired: Boolean(config.app.accessToken),
  });
  await recoverOnStartup();
});
