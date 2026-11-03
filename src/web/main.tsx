import { start } from "../ui/start";
import { browserFiles } from "./browserFiles";
import { FetchTransport } from "./fetchTransport";
import { IndexedDbStore } from "./indexedDbStore";
import { MemorySecretStore } from "./memorySecretStore";
import { BrowserRemoteMcpClient } from "./remoteMcpClient";

const secrets = new MemorySecretStore();

start({
  id: "web",
  dataStore: new IndexedDbStore(),
  files: browserFiles,
  secrets,
  http: new FetchTransport(secrets),
  mcp: new BrowserRemoteMcpClient(secrets),
  capabilities: { builtInMcp: false },
});
