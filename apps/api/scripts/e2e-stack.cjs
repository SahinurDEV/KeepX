const { spawn } = require("node:child_process");
const path = require("node:path");
const { MongoMemoryServer } = require("mongodb-memory-server");

const apiRoot = path.resolve(__dirname, "..");
const webRoot = path.resolve(apiRoot, "../web");
const webPort = process.env.E2E_WEB_PORT || "3010";
const apiPort = process.env.E2E_API_PORT || "4010";
const origin = `http://127.0.0.1:${webPort}`;
const children = [];
let mongo;
let stopping = false;

function start(args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    if (signal || code) {
      console.error(`e2e process exited (${signal || code}): ${args.join(" ")}`);
      void shutdown(1);
    }
  });
  return child;
}

async function waitForOk(url) {
  const deadline = Date.now() + 120000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${url} (${lastError})`);
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  if (mongo) await mongo.stop();
  process.exit(code);
}

async function main() {
  mongo = await MongoMemoryServer.create();
  const tsxCli = require.resolve("tsx/cli", { paths: [apiRoot] });
  const nextBin = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
  start([tsxCli, "src/index.ts"], apiRoot, {
    ...process.env,
    PORT: apiPort,
    MONGODB_URI: mongo.getUri(),
    SESSION_SECRET: "e2e-only-session-secret-not-for-production",
    APP_ORIGIN: origin,
    COOKIE_SECURE: "false",
    BCRYPT_COST: "4",
    TRUST_PROXY: "false",
    APP_NAME: "Vela",
    NODE_ENV: "development",
  });
  await waitForOk(`http://127.0.0.1:${apiPort}/api/v1/health`);
  start([nextBin, "dev", "--port", webPort], webRoot, {
    ...process.env,
    PORT: webPort,
    API_PROXY_URL: `http://127.0.0.1:${apiPort}`,
    NEXT_PUBLIC_APP_NAME: "Vela",
    NEXT_DIST_DIR: ".next-e2e",
    NODE_ENV: "development",
  });
  console.log(`e2e stack starting at ${origin}`);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

main().catch((error) => {
  console.error(error);
  void shutdown(1);
});
