import fs from 'node:fs/promises';
import path from 'node:path';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export class Logger {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  info(message: string, meta?: unknown): void {
    void this.write('INFO', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    void this.write('WARN', message, meta);
  }

  error(message: string, meta?: unknown): void {
    void this.write('ERROR', message, meta);
  }

  private async write(level: LogLevel, message: string, meta?: unknown): Promise<void> {
    const timestamp = new Date().toISOString();
    const suffix = meta === undefined ? '' : ` ${safeSerialize(meta)}`;
    const line = `${timestamp} [${level}] ${message}${suffix}\n`;
    await fs.appendFile(this.filePath, line, 'utf8');

    if (level === 'ERROR') {
      console.error(line.trimEnd());
      return;
    }
    if (level === 'WARN') {
      console.warn(line.trimEnd());
      return;
    }
    console.info(line.trimEnd());
  }
}

function safeSerialize(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack,
    });
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
