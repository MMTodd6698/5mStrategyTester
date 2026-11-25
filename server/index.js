import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hardRestart } from "./restart.js";
import { startFeeds } from "./start.js";
import { openBookStream } from "./stream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const port = 8080;
const host = "0.0.0.0";
const isProd = process.env.NODE_ENV === "production";
const app = express();

app.get("/api/stream", (req, res) => {
  openBookStream(req, res);
});

app.post("/api/restart", (_req, res) => {
  res.json({ ok: true, ...hardRestart() });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

if (isProd) {
  const dist = path.join(root, "client/dist");
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(dist, "index.html"));
  });
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.listen(port, host, () => {
  console.log(`http://${host}:${port}`);
});

startFeeds();
