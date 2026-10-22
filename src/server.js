import { createApp } from './app.js';
import { createLogger } from './logger.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const log = createLogger();
const server = createApp({ log });
server.listen(port, '0.0.0.0', () => log({ level: 'info', message: 'API listening', port }));
server.on('error', (error) => {
  log({ level: 'error', message: error.message });
  process.exitCode = 1;
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log({ level: 'info', message: 'API shutting down', signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
