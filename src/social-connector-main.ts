import * as logger from './logger';
import { startSocialConnectorServer, stopSocialConnectorServer } from './social-connector-server';

function shutdown(signal: string): void {
  logger.info(`Social connector stopping after ${signal}`);
  void stopSocialConnectorServer()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

const server = startSocialConnectorServer();
server.once('error', error => {
  logger.error(`Social connector failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
