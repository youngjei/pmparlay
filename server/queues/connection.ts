import type { ConnectionOptions } from "bullmq";
import { config } from "../config";

export function redisConnectionOptions(): ConnectionOptions {
  const url = new URL(config.REDIS_URL);

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    username: url.username || undefined
  };
}
