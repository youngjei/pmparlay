import Redis from "ioredis";
import { config } from "./config";

export async function checkRedis() {
  const redis = new Redis(config.REDIS_URL, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });

  try {
    await redis.connect();
    await redis.ping();
  } finally {
    redis.disconnect();
  }
}
