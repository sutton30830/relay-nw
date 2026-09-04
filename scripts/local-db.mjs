// Private PostgreSQL test cluster. Never loads .env or accepts a connection URL.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const state = join(root, ".local/postgres");
const data = join(state, "data");
const socket = join(state, "socket");
const marker = join(state, "relay-test-cluster.json");
const database = "relay_nw_test";
const admin = "relay_test_admin";
const port = "55432"; // Socket suffix only: the server does not listen on TCP.
const bin = ["/opt/homebrew/opt/postgresql@17/bin", "/usr/local/opt/postgresql@17/bin"]
  .find((candidate) => existsSync(join(candidate, "initdb")));
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG")));

function run(program, args, { input, quiet = false, allowFailure = false } = {}) {
  const result = spawnSync(join(bin, program), args, {
    cwd: root, env: childEnv, encoding: "utf8", input, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${program} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  if (!quiet) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
  }
  return result;
}

function checkMarker() {
  if (!existsSync(marker)) throw new Error("No owned local test cluster. Run npm run db:local -- setup.");
  const value = JSON.parse(readFileSync(marker, "utf8"));
  if (value.root !== root || value.database !== database || value.admin !== admin || value.version !== 1) {
    throw new Error("Cluster ownership marker does not match this repository.");
  }
  for (const directory of [state, data, socket]) {
    if (existsSync(directory) && realpathSync(directory) !== directory) {
      throw new Error(`Refusing a redirected cluster directory: ${directory}`);
    }
  }
}

function psql(args, options = {}, db = database) {
  return run("psql", ["-X", "-w", "-h", socket, "-p", port, "-U", admin,
    "-d", db, "-v", "ON_ERROR_STOP=1", ...args], options);
}

function checkConnection(db = database) {
  checkMarker();
  const result = psql(["-At", "-c", "SELECT json_build_object('database', current_database(), 'data', current_setting('data_directory'), 'user', current_user, 'tcp', inet_server_addr(), 'listen', current_setting('listen_addresses'))"], { quiet: true }, db);
  const actual = JSON.parse(result.stdout.trim());
  if (actual.database !== db || actual.data !== data || actual.user !== admin || actual.tcp !== null || actual.listen !== "") {
    throw new Error("Refusing database operation: connection is not this private socket-only test cluster.");
  }
}

function start() {
  checkMarker();
  if (!existsSync(join(data, "PG_VERSION"))) throw new Error("Cluster initialization is incomplete; rerun setup.");
  if (run("pg_ctl", ["-D", data, "status"], { quiet: true, allowFailure: true }).status !== 0) {
    if (existsSync(join(data, "postmaster.pid"))) {
      throw new Error("A PostgreSQL PID file exists but server status could not be inspected. Run with the server's required permissions; inspect a stale PID file before attempting recovery.");
    }
    run("pg_ctl", ["-D", data, "-l", join(state, "server.log"), "-w", "-t", "15", "start"]);
  }
  checkConnection("postgres");
}

function setup() {
  if (!existsSync(marker) && existsSync(data)) throw new Error("Refusing to adopt an unmarked PostgreSQL data directory.");
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  chmodSync(socket, 0o700);
  if (!existsSync(marker)) {
    writeFileSync(marker, JSON.stringify({ version: 1, root, database, admin }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  checkMarker();
  if (!existsSync(join(data, "PG_VERSION"))) {
    run("initdb", ["-D", data, "-U", admin, "--encoding=UTF8", "--locale=C", "--auth-local=trust", "--auth-host=reject"], { quiet: true });
    const socketValue = socket.replaceAll("'", "''");
    writeFileSync(join(data, "postgresql.auto.conf"), [
      "# Private Relay test cluster. No TCP listeners or production credentials.",
      "listen_addresses = ''", `port = ${port}`, `unix_socket_directories = '${socketValue}'`,
      "unix_socket_permissions = 0700", "max_connections = 20", "shared_buffers = '16MB'", "",
    ].join("\n"), { mode: 0o600 });
  }
  start();
  const exists = psql(["-At", "-c", `SELECT 1 FROM pg_database WHERE datname = '${database}'`], { quiet: true }, "postgres").stdout.trim();
  if (exists !== "1") psql(["-c", `CREATE DATABASE ${database}`], { quiet: true }, "postgres");
  checkConnection();
  const output = psql(["--single-transaction", "-f", join(root, "scripts/local-db/bootstrap.sql"), "-f", join(root, "supabase.sql")], { quiet: true });
  writeFileSync(join(state, "schema-load.log"), output.stdout + output.stderr, { mode: 0o600 });
  console.log(`Loaded the checked-in schema into ${database}.`);
  verify();
}

function verify() {
  checkConnection();
  const result = psql(["-f", join(root, "scripts/local-db/verify.sql")]);
  writeFileSync(join(state, "verification.log"), `${new Date().toISOString()}\n${result.stdout}${result.stderr}`, { mode: 0o600 });
}

try {
  const [command = "status", ...args] = process.argv.slice(2);
  if (!bin) throw new Error("PostgreSQL 17 is required: brew install postgresql@17 (no brew service is needed).");
  if (!["setup", "start", "stop", "status", "verify", "sql"].includes(command) || args.length !== (command === "sql" ? 1 : 0)) {
    throw new Error("Usage: npm run db:local -- setup|start|stop|status|verify|sql <repository-file.sql>");
  }
  if (command === "setup") setup();
  if (command === "start") { start(); console.log("Private local PostgreSQL is running."); }
  if (command === "stop") {
    checkConnection("postgres");
    run("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "15", "stop"]);
  }
  if (command === "status") {
    checkConnection();
    psql(["-c", "SELECT version(), current_database(), current_user, inet_server_addr() AS tcp_address"]);
    console.log(`Data: ${data}\nSocket: ${socket}\nLocal database only; no PostgREST/Auth/Storage HTTP services.`);
  }
  if (command === "verify") verify();
  if (command === "sql") {
    checkConnection();
    const file = realpathSync(resolve(root, args[0]));
    const local = relative(root, file);
    if (local.startsWith("..") || isAbsolute(local) || !file.endsWith(".sql")) {
      throw new Error("SQL file must be inside this repository and end in .sql.");
    }
    psql(["--single-transaction", "-f", file]);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
