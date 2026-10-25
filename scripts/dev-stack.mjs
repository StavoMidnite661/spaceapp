#!/usr/bin/env node
/**
 * dev-stack.mjs — One-command development stack for SpaceApp contributors.
 *
 * Starts PostgreSQL (pgvector) and Temporal in Docker, runs database migrations,
 * then starts the API (watch mode), Vite web dev server, Temporal worker, and
 * CLI host from source on the host. All services bind to 127.0.0.1 only.
 *
 * State lives in `.dev-stack/` (git-ignored) so an installed SpaceApp is never
 * disturbed. Ports and directories can be overridden through environment
 * variables.
 *
 * Usage:
 *   npm run dev:stack            # start everything
 *   npm run dev:stack -- down    # stop all services
 *   npm run dev:stack -- reset   # stop and remove state directory
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, createWriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, "..");
const STATE_DIR = resolve(WORKSPACE_ROOT, ".dev-stack");
const COMPOSE_FILE = resolve(STATE_DIR, "docker-compose.yml");
const ENV_FILE = resolve(STATE_DIR, ".env");
const PID_FILE = resolve(STATE_DIR, "dev-stack.pid");

// Default ports — all bound to 127.0.0.1
const DEFAULT_API_PORT = 4910;
const DEFAULT_WEB_PORT = 4911;
const DEFAULT_POSTGRES_PORT = 5432;
const DEFAULT_TEMPORAL_PORT = 7233;

// Compose project name — isolated from any installed SpaceApp
const COMPOSE_PROJECT = "spaceapp-dev-stack";

// Pinned image digests, read from packages/run-spaceapp/templates/compose.yml
const COMPOSE_TEMPLATE = resolve(WORKSPACE_ROOT, "packages/run-spaceapp/templates/compose.yml");

// Child processes started by dev:stack
const children = new Map();
let stopping = false;

function log(message) {
  const ts = new Date().toISOString();
  process.stdout.write(`[dev-stack ${ts}] ${message}\n`);
}

function error(message) {
  process.stderr.write(`[dev-stack ERROR] ${message}\n`);
}

/**
 * Read port and bind-host overrides from environment variables.
 * Port overrides must be integers from 1 through 65535.
 * @returns Resolved port and host configuration
 */
function readEnvOverrides() {
  function portOrDefault(key, fallback) {
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`${key} must be an integer from 1 to 65535, got "${raw}".`);
    }
    return parsed;
  }
  return {
    apiPort: portOrDefault("SPACEAPP_DEV_API_PORT", DEFAULT_API_PORT),
    webPort: portOrDefault("SPACEAPP_DEV_WEB_PORT", DEFAULT_WEB_PORT),
    postgresPort: portOrDefault("SPACEAPP_DEV_POSTGRES_PORT", DEFAULT_POSTGRES_PORT),
    temporalPort: portOrDefault("SPACEAPP_DEV_TEMPORAL_PORT", DEFAULT_TEMPORAL_PORT),
    bindHost: process.env.SPACEAPP_DEV_BIND_HOST ?? "127.0.0.1",
  };
}

/**
 * Generate a random alphanumeric secret using a CSPRNG.
 * @param bytes - Number of random bytes to produce (default 32)
 * @returns Base36-encoded secret string
 */
function generateSecret(bytes = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const random = randomBytes(bytes);
  let result = "";
  for (let i = 0; i < bytes; i++) {
    result += chars.charAt(random[i] % chars.length);
  }
  return result;
}

/**
 * Ensure the state directory and its subdirectories exist.
 * @param stateDir - Path to the state directory
 */
function ensureStateDir(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(resolve(stateDir, "secrets"), { recursive: true });
  mkdirSync(resolve(stateDir, "logs"), { recursive: true });
}

/**
 * Write a secret value to a file with mode 0600.
 * @param stateDir - State directory path
 * @param name - Secret file name
 * @param value - Secret value
 * @returns Path to the written secret file
 */
function writeSecret(stateDir, name, value) {
  const path = resolve(stateDir, "secrets", name);
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}

/**
 * Read pinned image digests from the installer compose template.
 * @returns Object mapping service names to pinned image references
 */
function readPinnedDigests() {
  const content = readFileSync(COMPOSE_TEMPLATE, "utf8");
  const digests = {};

  // Extract pinned digests from image lines like:
  //   image: pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147cc...
  const imageRegex = /image:\s*([^\s]+@sha256:[0-9a-f]+)/gm;
  let match;
  while ((match = imageRegex.exec(content)) !== null) {
    const fullImage = match[1];
    // Map service names based on known image patterns
    if (fullImage.includes("pgvector/pgvector")) digests.postgres = fullImage;
    else if (fullImage.includes("temporalio/auto-setup")) digests.temporal = fullImage;
  }

  return digests;
}

/**
 * Write the generated Docker Compose file into the state directory.
 * @param stateDir - State directory path
 * @param digests - Pinned image digests
 * @param ports - Port configuration
 */
function writeComposeFile(stateDir, digests, ports) {
  const compose = `# Generated by dev-stack.mjs — do not edit by hand.
# Regenerate with: npm run dev:stack (after \`down\` and \`reset\`)
services:
  postgres:
    image: ${digests.postgres ?? "pgvector/pgvector:0.8.3-pg17-trixie@sha256:placeholder"}
    restart: unless-stopped
    mem_limit: 2g
    cpus: "1.0"
    environment:
      POSTGRES_DB: spaceapp
      POSTGRES_USER: spaceapp
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password
    volumes:
      - spaceapp-dev-postgres:/var/lib/postgresql/data
    secrets:
      - postgres-password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]
      interval: 5s
      timeout: 3s
      retries: 30
    ports:
      - "${ports.bindHost}:${ports.postgresPort}:5432"
    networks:
      - spaceapp-dev

  temporal:
    image: ${digests.temporal ?? "temporalio/auto-setup:1.29.1@sha256:placeholder"}
    profiles: ["workflows"]
    restart: unless-stopped
    mem_limit: 2g
    cpus: "1.0"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: spaceapp
      POSTGRES_SEEDS: postgres
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - export POSTGRES_PWD="$$(cat /run/secrets/postgres-password)"; exec /etc/temporal/entrypoint.sh autosetup
    secrets:
      - postgres-password
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"]
      interval: 5s
      timeout: 5s
      retries: 30
    ports:
      - "${ports.bindHost}:${ports.temporalPort}:7233"
    networks:
      - spaceapp-dev

networks:
  spaceapp-dev:
    internal: false

secrets:
  postgres-password:
    file: ./secrets/postgres-password

volumes:
  spaceapp-dev-postgres:
`;
  writeFileSync(COMPOSE_FILE, compose);
}

function writeEnvFile(stateDir, ports, secrets) {
  const lines = [
    `# Generated by dev-stack.mjs — do not edit by hand.`,
    `# Regenerate with: npm run dev:stack (after \`down\` and \`reset\`)`,
    ``,
    `# API`,
    `SPACE_API_HOST=127.0.0.1`,
    `SPACE_API_PORT=${ports.apiPort}`,
    `SPACE_API_ORIGIN=http://127.0.0.1:${ports.apiPort}`,
    ``,
    `# Web (Vite dev server)`,
    `SPACE_WEB_HOST=127.0.0.1`,
    `SPACE_WEB_PORT=${ports.webPort}`,
    ``,
    `# Database`,
    `SPACE_RUNTIME_STORE=postgres`,
    `SPACE_DATABASE_URL=postgres://spaceapp:${secrets.databaseUrl}@127.0.0.1:${ports.postgresPort}/spaceapp`,
    `SPACE_DATABASE_POOL_MAX=10`,
    `SPACE_DATABASE_POOL_IDLE_TIMEOUT_MS=30000`,
    `SPACE_DATABASE_POOL_CONNECTION_TIMEOUT_MS=5000`,
    ``,
    `# Temporal`,
    `SPACE_TEMPORAL_ADDRESS=127.0.0.1:${ports.temporalPort}`,
    `SPACE_TEMPORAL_NAMESPACE=default`,
    `SPACE_TEMPORAL_TASK_QUEUE=default`,
    `SPACEAPP_WORKFLOWS_ENABLED=true`,
    ``,
    `# Session / setup`,
    `SPACE_SESSION_SECRET=${secrets.sessionSecret}`,
    `SPACE_SETUP_TOKEN=${secrets.setupToken}`,
    ``,
    `# CLI host`,
    `SPACE_CLI_ENABLED=true`,
    `SPACE_CLI_HOST_SOCKET=${stateDir}/sockets/cli-host.sock`,
    `SPACE_CLI_WORKSPACE_ROOT=${resolve(WORKSPACE_ROOT, ".dev-stack/workspaces")}`,
    `SPACE_CLI_COMMAND_PATH=/usr/local/bin`,
    ``,
    `# Dev-only settings`,
    `SPACE_DEV_LOGIN=true`,
    `SPACE_PUBLIC_DISTRIBUTION=false`,
    `SPACE_INSTANCE=dev`,
    `SPACE_OPTIONAL_MODULES=all`,
    `SPACE_AGENT_TOOLS_WRITER=disabled`,
    `SPACE_TELEMETRY_ENABLED=false`,
    `SPACE_BROWSER_SESSIONS_ENABLED=false`,
    ``,
  ];
  writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
}

/**
 * Run a docker compose subcommand against the dev-stack Compose file.
 * @param args - Compose subcommand arguments
 * @param options - Options: `silent` suppresses stdio passthrough
 * @returns The spawnSync result
 */
function runCompose(args, options = {}) {
  const result = spawnSync("docker", ["compose", "--profile", "workflows", "-p", COMPOSE_PROJECT, "-f", COMPOSE_FILE, ...args], {
    stdio: options.silent ? "pipe" : "inherit",
    cwd: STATE_DIR,
    env: { ...process.env, COMPOSE_PROJECT_NAME: COMPOSE_PROJECT },
    encoding: "utf8",
  });
  if (result.status !== 0 && !options.silent) {
    error(`docker compose ${args.join(" ")} exited with code ${result.status}`);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result;
}

/**
 * Check whether Docker Compose is available on PATH.
 * @returns True if `docker compose version` succeeds
 */
function dockerAvailable() {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "pipe", encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start Docker services (postgres, temporal) and wait for them to be healthy.
 * @param ports - Port overrides
 * @param secrets - Generated secrets
 */
function startDockerServices(ports, secrets) {
  log("Starting Docker services (postgres, temporal)...");

  // Ensure compose file and env exist
  const digests = readPinnedDigests();
  writeComposeFile(STATE_DIR, digests, ports);
  writeEnvFile(STATE_DIR, ports, secrets);

  // Write postgres password secret
  writeSecret(STATE_DIR, "postgres-password", secrets.postgresPassword);

  // Pull images
  log("Pulling Docker images (this may take a while)...");
  runCompose(["pull"]);

  // Start services and wait for health with a 120-second timeout
  log("Starting services and waiting for health (120s timeout)...");
  const result = runCompose(["up", "--wait", "-d", "--wait-timeout", "120"]);
  if (result.status !== 0) {
    throw new Error("Docker services did not become healthy in time.");
  }
  log("Docker services are healthy.");
}

/**
 * Run database migrations against the dev-stack PostgreSQL instance.
 * @param secrets - Generated secrets containing the database URL
 */
function runMigrations(secrets) {
  log("Running database migrations...");
  const env = {
    ...process.env,
    SPACE_DATABASE_URL: `postgres://spaceapp:${secrets.databaseUrl}@127.0.0.1:${readEnvOverrides().postgresPort}/spaceapp`,
    SPACE_RUNTIME_STORE: "postgres",
  };
  const result = spawnSync("npm", ["run", "db:migrate"], {
    stdio: "inherit",
    cwd: WORKSPACE_ROOT,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Database migrations failed with exit code ${result.status}`);
  }
  log("Database migrations completed.");
}

/**
 * Spawn a host process from source with log forwarding.
 * @param name - Process name used for log files and output prefix
 * @param command - Command to execute
 * @param args - Command arguments
 * @param envOverrides - Additional environment variables
 * @returns The spawned child process
 */
function spawnHostProcess(name, command, args, envOverrides = {}) {
  const env = {
    ...process.env,
    ...envOverrides,
    NODE_ENV: "development",
  };

  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: WORKSPACE_ROOT,
  });

  const logFile = resolve(STATE_DIR, "logs", `${name}.log`);
  const logStream = createWriteStream(logFile, { flags: "a" });

  child.stdout.on("data", (data) => {
    process.stdout.write(`[${name}] ${data}`);
    logStream.write(data);
  });
  child.stderr.on("data", (data) => {
    process.stderr.write(`[${name}] ${data}`);
    logStream.write(data);
  });

  child.once("exit", (code, signal) => {
    logStream.end();
    if (!stopping) {
      error(`Host process exited unexpectedly (${code ?? signal}).`);
      stopAll();
      process.exitCode = code || 1;
    }
  });

  children.set(name, child);
  log(`${name} started (PID ${child.pid}).`);
  return child;
}

/**
 * Start all host processes from source: API, web server, Temporal worker, CLI host.
 * @param secrets - Generated secrets
 * @param ports - Port configuration
 */
function startHostProcesses(secrets, ports) {
  log("Starting host processes from source...");

  // API in watch mode
  spawnHostProcess("api", "npx", ["tsx", "watch", "apps/api/src/server.ts"], {
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(ports.apiPort),
    SPACE_API_ORIGIN: `http://127.0.0.1:${ports.apiPort}`,
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: `postgres://spaceapp:${secrets.databaseUrl}@127.0.0.1:${ports.postgresPort}/spaceapp`,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporalPort}`,
    SPACE_TEMPORAL_NAMESPACE: "default",
    SPACE_TEMPORAL_TASK_QUEUE: "default",
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SETUP_TOKEN: secrets.setupToken,
    SPACE_DEV_LOGIN: "true",
    SPACE_PUBLIC_DISTRIBUTION: "false",
    SPACE_INSTANCE: "dev",
    SPACE_OPTIONAL_MODULES: "all",
    SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_TELEMETRY_ENABLED: "false",
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_HOST_SOCKET: resolve(STATE_DIR, "sockets", "cli-host.sock"),
    SPACE_CLI_WORKSPACE_ROOT: resolve(WORKSPACE_ROOT, ".dev-stack/workspaces"),
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
  });

  // Vite web dev server
  spawnHostProcess("web", "npx", ["vite", "--host", "127.0.0.1", "--port", String(ports.webPort)], {
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(ports.webPort),
  });

  // Temporal worker from source (watch mode)
  spawnHostProcess("worker", "npx", ["tsx", "watch", "apps/worker/src/worker.ts"], {
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporalPort}`,
    SPACE_TEMPORAL_NAMESPACE: "default",
    SPACE_TEMPORAL_TASK_QUEUE: "default",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: `postgres://spaceapp:${secrets.databaseUrl}@127.0.0.1:${ports.postgresPort}/spaceapp`,
    SPACE_SESSION_SECRET: secrets.sessionSecret,
  });

  // CLI host from source
  spawnHostProcess("cli-host", "npx", ["tsx", "packages/cli-host/src/main.ts"], {
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_HOST_SOCKET: resolve(STATE_DIR, "sockets", "cli-host.sock"),
    SPACE_CLI_WORKSPACE_ROOT: resolve(WORKSPACE_ROOT, ".dev-stack/workspaces"),
    SPACE_CLI_COMMAND_PATH: "/usr/local/bin",
  });
}

/**
 * Poll the API /readyz endpoint until it reports ok or the deadline passes.
 * @param ports - Port configuration
 */
async function waitForReadyz(ports) {
  log("Waiting for API /readyz endpoint...");
  const deadline = Date.now() + 120_000;
  const http = await import("node:http");

  while (Date.now() < deadline) {
    try {
      const body = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${ports.apiPort}/readyz`, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        });
        req.on("error", reject);
        req.setTimeout(3000, () => req.destroy(new Error("timeout")));
      });
      if (body.status === 200 && body.body.includes("ok")) {
        log("API /readyz reports ok.");
        return;
      }
    } catch {
      // Service not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("API /readyz did not report ok in time.");
}

/**
 * Stop all running host processes and run `docker compose down`.
 */
function stopAll() {
  stopping = true;
  for (const [, child] of children) {
    log("Stopping host process...");
    child.kill("SIGTERM");
  }
  children.clear();
  runCompose(["down"], { silent: true });
}

/**
 * Print a summary of running services and connection details.
 * @param secrets - Generated secrets
 * @param ports - Port configuration
 */
function printSummary(secrets, ports) {
  const setupTokenFile = resolve(STATE_DIR, "secrets", "setup-token");
  log("");
  log("============================================================");
  log(" SpaceApp dev stack is running.");
  log("");
  log(`   API:        http://127.0.0.1:${ports.apiPort}`);
  log(`   Web:        http://127.0.0.1:${ports.webPort}`);
  log(`   PostgreSQL: 127.0.0.1:${ports.postgresPort}`);
  log(`   Temporal:   127.0.0.1:${ports.temporalPort}`);
  log("");
  log(`   Setup token: ${secrets.setupToken}`);
  log(`   Setup token file: ${setupTokenFile}`);
  log("");
  log("   Open the URL above, create the owner, then start an OpenCode pane.");
  log("");
  log("   Commands:");
  log(`     npm run dev:stack -- down    # stop all services`);
  log(`     npm run dev:stack -- reset   # stop and remove state directory`);
  log("");
  log("   Logs: .dev-stack/logs/*.log");
  log("============================================================");
}

async function cmdUp() {
  if (existsSync(PID_FILE)) {
    error("dev:stack appears to already be running (PID file exists).");
    error("Run `npm run dev:stack -- down` first, or remove .dev-stack/dev-stack.pid.");
    process.exit(1);
  }

  try {
    if (!dockerAvailable()) {
      throw new Error("Docker is not available. Install Docker Desktop or Docker Engine to run dev:stack.");
    }

    const ports = readEnvOverrides();
    ensureStateDir(STATE_DIR);
    mkdirSync(dirname(PID_FILE), { recursive: true });

    // Register signal handlers early so startup interruptions are handled
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.once(signal, () => {
        log(`Received ${signal}, shutting down...`);
        stopAll();
        process.exit(0);
      });
    }

    // Write PID file
    writeFileSync(PID_FILE, String(process.pid), { mode: 0o644 });

    // Generate or load persisted secrets
    const databaseUrlSecretPath = resolve(STATE_DIR, "secrets", "database-url");
    const sessionSecretPath = resolve(STATE_DIR, "secrets", "session-secret");
    const setupTokenPath = resolve(STATE_DIR, "secrets", "setup-token");
    const postgresPasswordSecretPath = resolve(STATE_DIR, "secrets", "postgres-password");

    const readOrCreateSecret = (path, generator) => {
      try { return readFileSync(path, "utf8").trim(); } catch { /* not present */ }
      const value = generator();
      writeFileSync(path, value, { mode: 0o600 });
      return value;
    };

    const secrets = {
      databaseUrl: readOrCreateSecret(databaseUrlSecretPath, () => generateSecret(32)),
      sessionSecret: readOrCreateSecret(sessionSecretPath, () => generateSecret(48)),
      setupToken: readOrCreateSecret(setupTokenPath, () => generateSecret(40)),
      postgresPassword: readOrCreateSecret(postgresPasswordSecretPath, () => generateSecret(32)),
    };

    // Start Docker services
    startDockerServices(ports, secrets);

    // Run migrations
    runMigrations(secrets);

    // Start host processes
    startHostProcesses(secrets, ports);

    // Wait for API to be ready
    await waitForReadyz(ports);

    printSummary(secrets, ports);

    // Wait for all children to exit
    while (children.size > 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    stopAll();
    throw err;
  } finally {
    try { rmSync(PID_FILE); } catch { /* ignore */ }
  }
}

/**
 * Stop all running dev-stack services.
 * Sends SIGTERM to host processes and the recorded stack PID, then runs
 * `docker compose down`.
 */
async function cmdDown() {
  log("Stopping dev stack...");
  stopping = true;
  for (const [, child] of children) {
    child.kill("SIGTERM");
  }
  children.clear();

  // Terminate the recorded stack process if it is not the current one
  try {
    if (existsSync(PID_FILE)) {
      const recordedPid = Number.parseInt(readFileSync(PID_FILE, "utf8"), 10);
      if (Number.isFinite(recordedPid) && recordedPid !== process.pid) {
        try { process.kill(recordedPid, "SIGTERM"); } catch { /* ignore */ }
      }
      rmSync(PID_FILE);
    }
  } catch { /* ignore */ }

  runCompose(["down"], { silent: true });
  log("Dev stack stopped.");
}

/**
 * Stop the stack and remove the state directory and PostgreSQL volume.
 */
async function cmdReset() {
  await cmdDown();
  log("Removing state directory...");
  rmSync(STATE_DIR, { recursive: true, force: true });
  // Remove the PostgreSQL named volume so reset starts with fresh data
  runCompose(["volume", "rm", "spaceapp-dev-postgres"], { silent: true });
  log("State directory removed. Run `npm run dev:stack` to start fresh.");
}

/**
 * Entry point: parse the command (up/down/reset) and dispatch.
 */
async function main() {
  const command = process.argv[2] ?? "up";

  switch (command) {
    case "up":
      await cmdUp();
      break;
    case "down":
      await cmdDown();
      break;
    case "reset":
      await cmdReset();
      break;
    default:
      process.stderr.write(`Usage: dev-stack.mjs <up|down|reset>\n`);
      process.exit(1);
  }
}

// Exported for testing
export {
  readEnvOverrides,
  generateSecret,
  ensureStateDir,
  writeSecret,
  readPinnedDigests,
  writeComposeFile,
  writeEnvFile,
  dockerAvailable,
  stopAll,
};

if (import.meta.href === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    error(err.message);
    stopAll();
    process.exit(1);
  });
}
