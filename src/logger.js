import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// Keep the current file and one backup, each at most approximately 10 MiB.
export function createLogger({ file = process.env.LOG_FILE, maxBytes = 10 * 1024 * 1024, output = process.stdout } = {}) {
  if (file) mkdirSync(dirname(file), { recursive: true });
  let size = file && existsSync(file) ? statSync(file).size : 0;
  return (entry) => {
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), service: 'node-api', ...entry })}\n`;
    output.write(line);
    if (!file) return;
    try {
      if (size + Buffer.byteLength(line) > maxBytes && size > 0) {
        rmSync(`${file}.1`, { force: true });
        renameSync(file, `${file}.1`);
        size = 0;
      }
      appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ level: 'error', message: 'Failed to write log file', error: error.message })}\n`);
    }
  };
}
