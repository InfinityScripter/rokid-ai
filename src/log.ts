import { pino } from 'pino';

export const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
  },
});

export function log(...parts: unknown[]): void {
  logger.info(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
}

export function logError(context: string, error: unknown): void {
  if (error instanceof Error) {
    logger.error({ err: error }, `[${context}] ${error.message}`);
  } else {
    logger.error(`[${context}] ${String(error)}`);
  }
}
