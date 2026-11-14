import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      port: 5173,
      watch: { usePolling: true, interval: 500 },
      proxy: {
        "/api/v1": {
          target: env.API_PROXY_TARGET || "http://127.0.0.1:8080",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
          ...(env.API_PROXY_TOKEN
            ? { headers: { Authorization: `Bearer ${env.API_PROXY_TOKEN}` } }
            : {}),
        },
        "/api/healthz": {
          target: env.API_PROXY_TARGET || "http://127.0.0.1:8080",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        "/api": {
          target: env.ACCOUNT_PROXY_TARGET || "http://127.0.0.1:3001",
          changeOrigin: true,
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id))
              return "react";
            if (id.includes("motion")) return "motion";
            if (id.includes("radix") || id.includes("floating-ui")) return "ui";
          },
        },
      },
    },
  };
});
