import { existsSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { authRouter } from "./auth.js";
import { attachChat, sameOrigin } from "./chat.js";
import type { Config } from "./config.js";
import type { MessageStore, ReactionStore } from "./store.js";

export function createAppServer(
  config: Config,
  store: MessageStore,
  reactions: ReactionStore,
): { server: HttpServer; io: Server } {
  const app = express();
  // Container Apps terminates TLS at its ingress and forwards X-Forwarded-Proto/Host.
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.type("text").send("ok");
  });
  app.use(authRouter(config));

  if (existsSync(config.webDist)) {
    // Vite content-hashes everything under /assets, so those can be cached forever.
    app.use("/assets", express.static(path.join(config.webDist, "assets"), { maxAge: "1y", immutable: true }));
    app.use(express.static(config.webDist, { index: false }));
    const indexHtml = path.join(config.webDist, "index.html");
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/auth/")) return next();
      res.setHeader("cache-control", "no-cache");
      res.sendFile(indexHtml);
    });
  }

  const server = createServer(app);
  const io = new Server(server, {
    transports: ["websocket"],
    serveClient: false,
    allowRequest: (req, callback) => callback(null, sameOrigin(config, req)),
  });
  attachChat(io, config, store, reactions);

  return { server, io };
}
