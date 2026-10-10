// The part of a Redis client the adapters use. A small surface on purpose:
// unit specs fake it in a few lines, and every command an adapter sends is
// visible here. Add a command when an adapter needs it.
export interface RedisCommands {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { expiration?: { type: 'EX' | 'PX'; value: number }; condition?: 'NX' | 'XX' },
  ): Promise<string | null>;
  del(keys: string | string[]): Promise<number>;
  incr(key: string): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  ping(): Promise<string>;
}

/** What RedisService needs from a connection, besides the commands. */
export interface RedisClient extends RedisCommands {
  readonly isReady: boolean;
  on(event: 'ready' | 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  connect(): Promise<unknown>;
  close(): Promise<void>;
  destroy(): void;
}

export type RedisClientFactory = (settings: {
  url: string;
  commandTimeoutMs: number;
}) => RedisClient;

export interface RedisOptions {
  /** REDIS_URL; undefined: Redis is not used. */
  url: string | undefined;
  keyPrefix: string;
  required: boolean;
  commandTimeoutMs: number;
  /** After a stall, how long commands fail at once before a probe (default STALL_COOL_OFF_MS). */
  stallCoolOffMs?: number;
  /** Production: warn about plain-text or password-less URLs. */
  production: boolean;
}
