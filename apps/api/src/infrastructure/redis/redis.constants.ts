/** RedisOptions, from the environment by default (tests override the provider). */
export const REDIS_OPTIONS = Symbol('REDIS_OPTIONS');
/** Creates the client; unit specs replace it with a fake. */
export const REDIS_CLIENT_FACTORY = Symbol('REDIS_CLIENT_FACTORY');
