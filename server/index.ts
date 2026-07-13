import { buildApp } from "./app";
import { config } from "./config";

const app = buildApp();

try {
  await app.listen({
    host: config.API_HOST,
    port: config.API_PORT
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
