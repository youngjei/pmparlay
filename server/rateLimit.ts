import Redis from "ioredis";
import { config } from "./config";

export function createRateLimitOptions() {
  const redis =
    config.RATE_LIMIT_BACKEND === "redis"
      ? new Redis(config.REDIS_URL, {
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1
        })
      : undefined;

  return {
    options: {
      max: config.RATE_LIMIT_MAX,
      timeWindow: config.RATE_LIMIT_WINDOW,
      ...(redis
        ? {
            redis,
            skipOnError: config.RATE_LIMIT_SKIP_ON_REDIS_ERROR,
            nameSpace: "legwork:rate-limit:"
          }
        : {})
    },
    redis
  };
}
