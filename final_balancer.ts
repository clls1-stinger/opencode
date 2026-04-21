import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

// --- Configuration & Persistence ---
const CONFIG_PATH = path.join(import.meta.dir, "balancer-config.json");

interface AppConfig {
  apiKey: string;
  syncIntervalMs: number;
  balancingStrategy: "highest-available" | "round-robin" | "random";
  enabledModels: Record<string, boolean>;
  softDecayEnabled: boolean;
  softDecayAmount: number;
  autoSyncOnRequest: boolean;
  fallbackModel: string;
}

const defaultConfig: AppConfig = {
  apiKey: process.env.GEMINI_API_KEY || "dummy",
  syncIntervalMs: 300000,
  balancingStrategy: "highest-available",
  enabledModels: {},
  softDecayEnabled: true,
  softDecayAmount: 0.2,
  autoSyncOnRequest: false,
  fallbackModel: "gemini-3.1-flash"
};

let config: AppConfig = defaultConfig;
if (existsSync(CONFIG_PATH)) {
  try {
    config = { ...defaultConfig, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
  } catch (e) {
    console.error("Error reading config.");
  }
}

function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- State & Metrics ---
interface ModelStats {
  name: string;
  usageRemaining: number;
  resetTime: string;
  lastUpdate: string;
  requestsHandled: number;
}

interface RequestLog {
  timestamp: string;
  model: string;
  status: number;
  latency: number;
}

let cachedModels: ModelStats[] = [
  { name: "gemini-3.1-pro-preview", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 },
  { name: "gemini-3.1-pro", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 },
  { name: "gemini-3.1-flash", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 },
  { name: "gemini-3.1-flash-lite", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 },
  { name: "gemini-3-ultra", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 },
  { name: "gemini-3-deepthink", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 },
  { name: "gemini-2.5-pro", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 },
  { name: "gemini-2.5-flash", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 },
  { name: "gemini-2.5-flash-lite", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 },
  { name: "gemini-2.0-pro-exp", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 },
  { name: "gemini-2.0-flash", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), requestsHandled: 0 }
];

let requestLogs: RequestLog[] = [];
const MAX_LOGS = 20;

if (Object.keys(config.enabledModels).length === 0) {
  cachedModels.forEach(m => config.enabledModels[m.name] = true);
  saveConfig();
}

function syncWithGeminiCLI() {
  console.log("[" + new Date().toLocaleTimeString() + "] Syncing with gemini-cli...");
  try {
    const result = spawnSync("gemini", ["--prompt", "/stats", "--allowed-mcp-server-names", "none"], { 
        encoding: "utf8",
        env: { ...process.env, GEMINI_API_KEY: config.apiKey },
        timeout: 20000 
    });
    
    if (result.status === 0 && result.stdout.includes("%")) {
      const lines = result.stdout.split("\n");
      for (const model of cachedModels) {
        const match = lines.find(l => l.includes(model.name));
        if (match) {
          const pctMatch = match.match(/(\d+\.?\d*)%/);
          if (pctMatch) {
            model.usageRemaining = parseFloat(pctMatch[1]);
            model.lastUpdate = new Date().toISOString();
          }
          const resetMatch = match.match(/resets in ([^|]*)/);
          if (resetMatch) model.resetTime = resetMatch[1].trim();
        }
      }
    }
  } catch (e) {
    console.error("Sync error:", e);
  }
}

let syncTimer = setInterval(syncWithGeminiCLI, config.syncIntervalMs);
setTimeout(syncWithGeminiCLI, 1000);

let roundRobinIndex = 0;
function getBestModel(): string {
  const enabledNames = Object.keys(config.enabledModels).filter(k => config.enabledModels[k]);
  const active = cachedModels.filter(m => enabledNames.includes(m.name));
  const pool = active.length > 0 ? active : cachedModels;

  if (config.balancingStrategy === "highest-available") {
    return [...pool].sort((a, b) => b.usageRemaining - a.usageRemaining)[0].name;
  } else if (config.balancingStrategy === "random") {
    return pool[Math.floor(Math.random() * pool.length)].name;
  } else {
    const model = pool[roundRobinIndex % pool.length].name;
    roundRobinIndex++;
    return model;
  }
}

// --- Server ---
Bun.serve({
  port: 8051,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/api/config") {
      const patch = await req.json();
      config = { ...config, ...patch };
      saveConfig();
      if (patch.syncIntervalMs) {
          clearInterval(syncTimer);
          syncTimer = setInterval(syncWithGeminiCLI, config.syncIntervalMs);
      }
      return Response.json({ status: "ok", config });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/stats")) {
      if (url.pathname === "/sync") { syncWithGeminiCLI(); return new Response("OK"); }

      const modelCards = cachedModels.map(m => {
        const color = m.usageRemaining < 20 ? "#f44336" : (m.usageRemaining < 50 ? "#ff9800" : "#4caf50");
        return `
          <div class="card ${config.enabledModels[m.name] ? '' : 'disabled'}" id="card-${m.name}" style="border-left: 6px solid ${color};">
            <div class="card-header">
                <div>
                    <h3 class="model-title">${m.name}</h3>
                    <div class="reset-info">⏳ Reset: ${m.resetTime} | 🎯 Total: ${m.requestsHandled} reqs</div>
                </div>
                <label class="switch">
                    <input type="checkbox" ${config.enabledModels[m.name] ? "checked" : ""} onchange="toggleModel('${m.name}', this.checked)">
                    <span class="slider round"></span>
                </label>
            </div>
            <div class="bar-container">
                <div class="bar-fill" style="width: ${m.usageRemaining}%; background: ${color};">${m.usageRemaining}%</div>
            </div>
          </div>
        `;
      }).join("");

      const logRows = requestLogs.map(l => `
        <tr>
            <td>${new Date(l.timestamp).toLocaleTimeString()}</td>
            <td>${l.model}</td>
            <td style="color: ${l.status === 200 ? '#4caf50' : '#f44336'}">${l.status}</td>
            <td>${l.latency}ms</td>
        </tr>
      `).join("");

      return new Response(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Gemini Gateway Dashboard</title>
            <style>
                :root { --bg: #0b0f1a; --card: #161b22; --text: #e6edf3; --accent: #2f81f7; --border: #30363d; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; }
                .grid { display: grid; grid-template-columns: 1fr 350px; gap: 20px; max-width: 1200px; margin: 0 auto; }
                .panel { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
                h1, h2 { margin-top: 0; color: var(--accent); }
                .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
                label { display: block; font-size: 12px; color: #8b949e; margin-bottom: 5px; }
                select, input { background: #0d1117; color: white; border: 1px solid var(--border); padding: 8px; border-radius: 6px; width: 100%; }
                .card { background: #0d1117; border: 1px solid var(--border); border-radius: 8px; padding: 15px; margin-bottom: 10px; transition: 0.2s; }
                .card.disabled { opacity: 0.3; filter: grayscale(1); }
                .card-header { display: flex; justify-content: space-between; align-items: start; }
                .model-title { margin: 0; font-size: 16px; }
                .reset-info { font-size: 11px; color: #fbbf24; margin-top: 2px; }
                .bar-container { background: #161b22; height: 24px; border-radius: 12px; overflow: hidden; margin-top: 10px; border: 1px solid var(--border); }
                .bar-fill { height: 100%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; transition: width 0.5s; }
                .btn { background: var(--accent); color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; width: 100%; font-weight: bold; margin-bottom: 10px; }
                table { width: 100%; font-size: 12px; border-collapse: collapse; }
                th { text-align: left; color: #8b949e; border-bottom: 1px solid var(--border); padding: 5px; }
                td { padding: 5px; border-bottom: 1px solid #21262d; }
                .switch { position: relative; display: inline-block; width: 34px; height: 20px; }
                .switch input { opacity: 0; width: 0; height: 0; }
                .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #30363d; transition: .4s; border-radius: 34px; }
                .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
                input:checked + .slider { background-color: var(--accent); }
                input:checked + .slider:before { transform: translateX(14px); }
            </style>
        </head>
        <body>
            <div class="grid">
                <div class="main">
                    <div class="panel" style="margin-bottom: 20px;">
                        <h1>🛸 Gemini Load Balancer</h1>
                        <div class="controls">
                            <div>
                                <label>Estrategia de Balanceo</label>
                                <select onchange="update({balancingStrategy: this.value})">
                                    <option value="highest-available" ${config.balancingStrategy === 'highest-available' ? 'selected' : ''}>📈 Mayor Cuota</option>
                                    <option value="round-robin" ${config.balancingStrategy === 'round-robin' ? 'selected' : ''}>🔄 Ciclo</option>
                                    <option value="random" ${config.balancingStrategy === 'random' ? 'selected' : ''}>🎲 Aleatorio</option>
                                </select>
                            </div>
                            <div>
                                <label>Refresco (ms)</label>
                                <input type="number" value="${config.syncIntervalMs}" onchange="update({syncIntervalMs: parseInt(this.value)})">
                            </div>
                            <div>
                                <label>Soft Decay (Inter-sync)</label>
                                <select onchange="update({softDecayEnabled: this.value === 'true'})">
                                    <option value="true" ${config.softDecayEnabled ? 'selected' : ''}>Encendido</option>
                                    <option value="false" ${!config.softDecayEnabled ? 'selected' : ''}>Apagado</option>
                                </select>
                            </div>
                            <div>
                                <label>Auto-Sync on Req</label>
                                <select onchange="update({autoSyncOnRequest: this.value === 'true'})">
                                    <option value="true" ${config.autoSyncOnRequest ? 'selected' : ''}>SÍ</option>
                                    <option value="false" ${!config.autoSyncOnRequest ? 'selected' : ''}>NO</option>
                                </select>
                            </div>
                        </div>
                        <button class="btn" onclick="this.innerHTML='Sincronizando...'; fetch('/sync').then(()=>location.reload())">🔄 Sincronizar Ahora</button>
                    </div>
                    <div id="models">${modelCards}</div>
                </div>
                <div class="sidebar">
                    <div class="panel">
                        <h2>📜 Logs Recientes</h2>
                        <table>
                            <thead><tr><th>Hora</th><th>Modelo</th><th>Res</th><th>Lat</th></tr></thead>
                            <tbody>${logRows}</tbody>
                        </table>
                    </div>
                    <div class="panel" style="margin-top: 20px;">
                        <label>Custom API Key</label>
                        <input type="password" placeholder="••••••••" onchange="update({apiKey: this.value})">
                    </div>
                </div>
            </div>
            <script>
                async function update(patch) {
                    await fetch('/api/config', { 
                        method: 'POST', 
                        body: JSON.stringify(patch),
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                function toggleModel(name, enabled) {
                    const enabledModels = ${JSON.stringify(config.enabledModels)};
                    enabledModels[name] = enabled;
                    update({enabledModels});
                    document.getElementById('card-' + name).classList.toggle('disabled', !enabled);
                }
                setTimeout(() => location.reload(), 60000);
            </script>
        </body>
        </html>
      `, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const startTime = Date.now();
      try {
        const body = await req.json();
        const selectedModel = getBestModel();
        body.model = selectedModel;

        const targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
        const authHeader = req.headers.get("authorization");
        const apiKey = (authHeader && authHeader.replace("Bearer ", "")) || config.apiKey;

        const proxyRes = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
          body: JSON.stringify(body)
        });

        const latency = Date.now() - startTime;
        requestLogs.unshift({ timestamp: new Date().toISOString(), model: selectedModel, status: proxyRes.status, latency });
        requestLogs = requestLogs.slice(0, MAX_LOGS);

        const model = cachedModels.find(m => m.name === selectedModel);
        if (model) {
            model.requestsHandled++;
            if (config.softDecayEnabled) model.usageRemaining = Math.max(0, model.usageRemaining - config.softDecayAmount);
        }

        if (config.autoSyncOnRequest) setTimeout(syncWithGeminiCLI, 500);

        return new Response(proxyRes.body, { status: proxyRes.status, headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }
    return new Response("Not found", { status: 404 });
  }
});

console.log("Gemini Gateway Hub online: http://localhost:8051");
