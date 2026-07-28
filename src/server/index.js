/* Node + ws adapter: wires the HTTP file server, the room registry and the
   socket lifecycle together, then listens. */
import { fileURLToPath } from "node:url";
import { PORT } from "./config.js";
import { createHttpServer } from "./http.js";
import { rooms } from "./registry.js";
import { attachSockets } from "./sockets.js";

const httpServer = createHttpServer(() => rooms.size);
const wss = attachSockets(httpServer);

// Importable so test/server.test.js can drive the real adapter in-process.
export { httpServer, wss, rooms };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  httpServer.listen(PORT, () => {
    console.log(`\n  TRUMP multiplayer server running.`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Friends on your network join via your machine's LAN IP, e.g. http://<your-ip>:${PORT}`);
    console.log(`  Create or share a room code on the join screen.\n`);
  });
}
