// WebSocket chatbot backed by Claude Code (stream-json).
//
// The browser talks to this server over WebSocket; the server spawns the local
// `claude` CLI per user message with --output-format stream-json --verbose and
// relays each NDJSON event to the browser. Conversation memory is kept with
// --resume <session_id> (captured from the first turn's system/init event).
//
// The weather MCP server is loaded automatically because it was registered in
// Claude Code's user config (claude mcp add -s user weather ...), so the agent
// can call the mcp__weather__* tools on demand.
//
// NOTE on "acp": the official @agentclientprotocol/claude-agent-acp adapter is
// blocked on this Windows machine (its native claude binary spawns fail with
// EFTYPE), so this uses Claude Code's own streaming protocol instead — same
// agent, same weather MCP, streaming over WebSocket.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const readline = require("readline");

let WebSocketServer;
try {
  ({ WebSocketServer } = require("ws"));
} catch {
  console.error("Missing dependency. Run: npm install ws");
  process.exit(1);
}

const PORT = process.env.PORT || 8788;

// Resolve the claude CLI without hardcoding any local path.
function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const out = execSync("where claude", { encoding: "utf8" });
    const p = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (p) return p;
  } catch {}
  throw new Error("claude CLI not found on PATH. Install Claude Code or set CLAUDE_BIN to its path.");
}
const CLAUDE = resolveClaude();

const WEATHER_TOOLS = [
  "mcp__weather__geocode_location",
  "mcp__weather__get_current_weather",
  "mcp__weather__get_daily_forecast",
  "mcp__weather__get_hourly_forecast",
  "mcp__weather__get_air_quality",
].join(",");

// index.html is read per request so HTML edits apply on refresh without a restart.
const INDEX_PATH = path.join(__dirname, "index.html");

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    const html = fs.readFileSync(INDEX_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let sessionId = null;
  let child = null;

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const text = (msg && (msg.text || msg.prompt)) || "";
    if (!text || child) return; // ignore while a turn is running

    const args = ["-p", text, "--output-format", "stream-json", "--verbose",
      "--allowedTools", WEATHER_TOOLS, "--include-partial-messages"];
    if (sessionId) args.splice(1, 0, "--resume", sessionId);

    send({ t: "status", message: sessionId ? "继续会话…" : "启动 Claude agent…" });

    child = spawn(CLAUDE, args, { windowsHide: true });
    const rl = readline.createInterface({ input: child.stdout });
    const srl = readline.createInterface({ input: child.stderr });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let evt;
      try { evt = JSON.parse(line); } catch { send({ t: "raw", line }); return; }
      // Capture the resumable session id from the first init event.
      if (evt.type === "system" && evt.subtype === "init" && evt.session_id) {
        sessionId = evt.session_id;
        send({
          t: "init",
          sessionId,
          model: evt.model,
          tools: evt.tools,
          mcp: evt.mcp_servers,
        });
        return;
      }
      if (evt.type === "stream_event") send({ t: "stream", event: evt.event });
      else if (evt.type === "assistant") send({ t: "assistant", message: evt.message });
      else if (evt.type === "user") send({ t: "user", message: evt.message });
      else if (evt.type === "result") send({ t: "result", evt });
      else if (evt.type !== "system") send({ t: "raw", line });
    });

    srl.on("line", (line) => {
      if (line.trim()) send({ t: "stderr", line });
    });

    const finish = (code) => {
      child = null;
      send({ t: "done", code });
    };
    child.on("exit", finish);
    child.on("error", (e) => {
      send({ t: "error", message: "spawn failed: " + e.message });
      child = null;
    });
  });

  ws.on("close", () => {
    if (child) { try { child.kill(); } catch {} }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Claude Code chatbot ready -> http://127.0.0.1:${PORT}`);
  console.log("claude CLI: resolved via PATH (set CLAUDE_BIN to override)");
});
