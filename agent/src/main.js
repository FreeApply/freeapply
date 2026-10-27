#!/usr/bin/env node
// FreeApply local agent: an MCP server over stdio (JSON-RPC 2.0, one message per line), the local dashboard and
// background data sharing. Runs on Claude Desktop's bundled Node or the user's own Node 22.13+, no dependencies.
//
//   node src/main.js [--data <dir>] [--db <file>] [--port <n>] [--skills-dir <dir> ...]   MCP server (default)
//   node src/main.js --dashboard [...]                                                    dashboard only
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import * as sharing from "./sharing.js";
import * as dashboard from "./dashboard.js";
import { Guard, parseKeys } from "./workflow.js";
import { TOOLS, callTool } from "./tools.js";
import * as ads from "./ads.js";
import * as updater from "./updater.js";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL = "2025-06-18";

function parseArgs(argv) {
  const o = { skillDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dashboard") o.dashboardOnly = true;
    else if (k === "--skills-dir") o.skillDirs.push(argv[++i]);
    else if (["--data", "--db", "--port"].includes(k)) o[k.slice(2)] = argv[++i];
  }
  const env = process.env.FREEAPPLY_SKILLS_DIRS;
  if (env) o.skillDirs.push(...env.split(path.delimiter));
  o.skillDirs = o.skillDirs.filter(Boolean).map((d) => path.resolve(d));
  return o;
}

function readOr(file, fallback) {
  try {
    return fs.readFileSync(file);
  } catch {
    return fallback;
  }
}

function loadGuard(skillDirs) {
  let keys = new Map();
  try {
    keys = parseKeys(readOr(path.join(AGENT, "keys", "release.pub"), Buffer.alloc(0)).toString("utf8"));
  } catch {
    keys = new Map(); // no valid release key: every bundle fails and FreeApply stays locked
  }
  // An ad-pack key may live on the server, so it must never also be trusted to sign the workflow.
  const adIds = readOr(path.join(AGENT, "keys", "ads.pub"), Buffer.alloc(0)).toString("utf8").split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]);
  for (const id of adIds) keys.delete(id);
  const guard = new Guard({ keys, shipped: readOr(path.join(AGENT, "workflow.signed.json"), Buffer.alloc(0)),
    dataDir: store.paths.data, skillDirs, appVersion: store.VERSION, memory: store.integrityMemory });
  guard.load();
  return guard;
}

const LOCKED_INSTRUCTIONS = "FreeApply is locked: its signed workflow failed verification. Call freeapply_status to see why " +
  "and tell the user. Do not try to repair or edit FreeApply files; updating or reinstalling FreeApply restores it.";

async function handle(msg, ctx) {
  const { method, id, params = {} } = msg;
  const b = ctx.guard.bundle;
  switch (method) {
    case "initialize":
      return { protocolVersion: params.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: "freeapply", version: store.VERSION }, instructions: b ? b.instructions : LOCKED_INSTRUCTIONS };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case "tools/call":
      return callTool(params.name, params.arguments, ctx);
    case "prompts/list":
      return { prompts: Object.entries(b?.procedures || {}).map(([name, p]) => ({ name, description: p.description })) };
    case "prompts/get": {
      const p = b?.procedures?.[params.name];
      if (!p) throw Object.assign(new Error(`unknown prompt ${params.name}`), { code: -32602 });
      return { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text } }] };
    }
  }
  if (id === undefined || id === null) return undefined; // notification
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

function serveStdio(ctx) {
  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  let queue = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // One message at a time, in order, so tool calls never interleave.
    queue = queue.then(async () => {
      const id = msg.id;
      try {
        const result = await handle(msg, ctx);
        if (id !== undefined && id !== null) write({ jsonrpc: "2.0", id, result });
      } catch (e) {
        if (id !== undefined && id !== null) write({ jsonrpc: "2.0", id, error: { code: e.code || -32603, message: e.message } });
      }
    });
  });
  rl.on("close", () => queue.then(() => process.exit(0)));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  store.init(opts);
  store.bootstrap();
  const guard = loadGuard(opts.skillDirs);
  const ctx = { guard, rules: () => guard.bundle?.rules || {} };
  const adKeys = () => readOr(path.join(AGENT, "keys", "ads.pub"), Buffer.alloc(0)).toString("utf8");
  ads.init(adKeys(), guard.bundle?.rules?.ad_link_hosts);
  const adCheck = () => ads.refresh().catch(() => {});
  setTimeout(adCheck, 5000).unref();
  setInterval(adCheck, 3600e3).unref(); // refresh() itself waits 6 hours between real checks
  // Daily check for a newer signed workflow (check() itself waits a day, with jitter, and backs off after failures).
  const updateCheck = async () => {
    const r = await updater.check(guard).catch(() => null);
    if (r?.workflow?.startsWith("updated")) ads.init(adKeys(), guard.bundle?.rules?.ad_link_hosts);
  };
  setTimeout(updateCheck, 8000).unref();
  setInterval(updateCheck, 3600e3).unref();
  // Live user count: a presence signal every 5 minutes while running (sharing.ping sends only with usage statistics on).
  const presence = () => sharing.ping().catch(() => {});
  setTimeout(presence, 20000).unref();
  setInterval(presence, sharing.PING_EVERY_MS).unref();
  if (opts.dashboardOnly) {
    const url = await dashboard.start();
    console.log(`FreeApply dashboard: ${url}  (Ctrl+C to stop)  workflow: ${guard.status.ok ? `ok ${guard.status.version}` : guard.status.problem}`);
    setInterval(() => {}, 1 << 30); // keep running until stopped
    return;
  }
  serveStdio(ctx);
  dashboard.start().catch((e) => console.error(`dashboard: ${e.message}`));
  // Opted-in sharing runs in the background so it never delays the agent.
  setTimeout(() => sharing.sync().catch(() => {}), 2000).unref();
}

main().catch((e) => {
  console.error(`freeapply: ${e.stack || e.message}`);
  process.exit(1);
});
