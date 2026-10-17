import { createAppServer } from "./app.js";
import { loadConfig } from "./config.js";
import { CosmosReactionStore, CosmosStore, MemoryReactionStore, MemoryStore } from "./store.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file; configuration comes from the real environment.
}

const config = loadConfig();
const store = config.cosmos
  ? new CosmosStore(config.cosmos.endpoint, config.cosmos.database, config.cosmos.container)
  : new MemoryStore();
const reactions = config.cosmos
  ? new CosmosReactionStore(
      config.cosmos.endpoint,
      config.cosmos.database,
      config.cosmos.reactionsContainer,
      config.cosmos.quotasContainer,
    )
  : new MemoryReactionStore();
console.log(config.cosmos ? `Chat history: Cosmos DB ${config.cosmos.endpoint}` : "Chat history: in memory");

// Reactions saved before they were anonymized still name their thrower; strip that in the background.
if (reactions instanceof CosmosReactionStore) {
  reactions.scrubLegacyUserIds().then(
    (n) => console.log(`Anonymized ${n} older reactions`),
    (err) => console.error("Anonymizing older reactions failed", err),
  );
}

const { server, io } = createAppServer(config, store, reactions);
server.listen(config.port, () => console.log(`balcony listening on :${config.port}`));

function shutdown() {
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
