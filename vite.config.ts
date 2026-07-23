import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8787";
  const parsedTarget = new URL(apiProxyTarget);
  if (!["http:", "https:"].includes(parsedTarget.protocol)) {
    throw new Error("VITE_API_PROXY_TARGET must use http or https");
  }

  return {
    plugins: [react],
    server: {
      port: 5173,
      proxy: {
        "/api": apiProxyTarget
      }
    }
  };
});
