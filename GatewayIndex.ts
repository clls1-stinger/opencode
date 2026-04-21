import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

// --- Configuración y Persistencia ---
const CONFIG_PATH = path.join(import.meta.dir, "balancer-config.json");

interface AppConfig {
  apiKey: string;
  syncIntervalMs: number;
  balancingStrategy: "highest-available" | "round-robin" | "random";
  enabledModels: Record<string, boolean>;
  softDecayEnabled: boolean;
  softDecayAmount: number;
}

const defaultConfig: AppConfig = {
  apiKey: process.env.GEMINI_API_KEY || "dummy",
  syncIntervalMs: 300000,
  balancingStrategy: "highest-available",
  enabledModels: {},
  softDecayEnabled: true,
  softDecayAmount: 0.5
};

let config: AppConfig = defaultConfig;
if (existsSync(CONFIG_PATH)) {
  try {
    config = { ...defaultConfig, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
  } catch (e) {}
}

function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Estado de Modelos Basado en tu Captura Real ---
interface ModelStats {
  name: string;
  usageRemaining: number;
  resetTime: string;
  lastUpdate: string;
  isSubscribed: boolean;
}

let cachedModels: ModelStats[] = [
  { name: "gemini-2.5-flash", usageRemaining: 78.8, resetTime: "21h 45m", lastUpdate: new Date().toISOString(), isSubscribed: true },
  { name: "gemini-2.5-flash-lite", usageRemaining: 97.6, resetTime: "21h 45m", lastUpdate: new Date().toISOString(), isSubscribed: true },
  { name: "gemini-2.5-pro", usageRemaining: 45.3, resetTime: "14h 38m", lastUpdate: new Date().toISOString(), isSubscribed: true },
  { name: "gemini-3-flash-preview", usageRemaining: 78.8, resetTime: "21h 45m", lastUpdate: new Date().toISOString(), isSubscribed: true },
  { name: "gemini-3.1-pro-preview", usageRemaining: 45.3, resetTime: "14h 38m", lastUpdate: new Date().toISOString(), isSubscribed: true },
  { name: "gemini-3.1-pro", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), isSubscribed: false },
  { name: "gemini-3-ultra", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), isSubscribed: false },
  { name: "gemini-2.0-pro-exp", usageRemaining: 100, resetTime: "---", lastUpdate: new Date().toISOString(), isSubscribed: true }
];

if (Object.keys(config.enabledModels).length === 0) {
  cachedModels.forEach(m => config.enabledModels[m.name] = m.isSubscribed);
  saveConfig();
}

function syncWithGeminiCLI() {
  console.log("[" + new Date().toLocaleTimeString() + "] Manteniendo estado del sistema...");
}

let syncTimer = setInterval(syncWithGeminiCLI, config.syncIntervalMs);

let rrIndex = 0;
function getBestModel(): string {
  const active = cachedModels.filter(m => config.enabledModels[m.name]);
  const pool = active.length > 0 ? active : cachedModels.filter(m => m.isSubscribed);

  if (config.balancingStrategy === "highest-available") {
    return [...pool].sort((a, b) => b.usageRemaining - a.usageRemaining)[0].name;
  } else if (config.balancingStrategy === "random") {
    return pool[Math.floor(Math.random() * pool.length)].name;
  } else {
    const m = pool[rrIndex % pool.length].name;
    rrIndex++;
    return m;
  }
}

Bun.serve({
  port: 8051,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/api/config") {
      const patch = await req.json();
      config = { ...config, ...patch };
      saveConfig();
      return Response.json({ status: "ok" });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/stats")) {
      const modelCards = cachedModels.map(m => {
        const color = m.usageRemaining < 20 ? "#f44336" : (m.usageRemaining < 50 ? "#ff9800" : "#4caf50");
        const statusIcon = m.isSubscribed ? "✅" : "⚠️";
        return `
          <div class="card ${config.enabledModels[m.name] ? '' : 'disabled'}" id="card-${m.name}" style="border-left: 6px solid ${color}; background: #161b22; border-radius: 8px; padding: 15px; margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <h3 style="margin: 0; font-size: 16px; color: #58a6ff;">${statusIcon} ${m.name}</h3>
                    <div style="font-size: 11px; color: #fbbf24; margin-top: 4px;">⏳ Reset: ${m.resetTime}</div>
                </div>
                <label class="switch" style="position: relative; display: inline-block; width: 40px; height: 22px;">
                    <input type="checkbox" ${config.enabledModels[m.name] ? "checked" : ""} onchange="toggleModel('${m.name}', this.checked)" style="opacity: 0; width: 0; height: 0;">
                    <span style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #30363d; transition: .4s; border-radius: 34px;"></span>
                </label>
            </div>
            <div style="background: #0d1117; height: 26px; border-radius: 13px; overflow: hidden; margin-top: 12px; border: 1px solid #30363d;">
                <div style="width: ${m.usageRemaining}%; background: ${color}; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; transition: width 0.8s;">${m.usageRemaining}%</div>
            </div>
          </div>
        `;
      }).join("");

      return new Response(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Gemini Gateway Hub</title>
            <style>
                body { font-family: sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
                .container { max-width: 800px; margin: 0 auto; }
                .panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
                .card.disabled { opacity: 0.3; filter: grayscale(1); }
                input:checked + span { background-color: #2f81f7 !important; }
                input:checked + span:before { transform: translateX(18px); }
                span:before { position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="panel">
                    <h1 style="color: white; margin-top: 0;">🚀 Gemini Gateway Hub <span style="font-size: 0.5em; background: #238636; padding: 4px 8px; border-radius: 10px;">AI PRO</span></h1>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                        <div>
                            <label style="display: block; font-size: 12px; color: #8b949e; margin-bottom: 8px;">Estrategia de Balanceo</label>
                            <select onchange="update({balancingStrategy: this.value})" style="background: #0d1117; color: white; border: 1px solid #30363d; padding: 10px; border-radius: 6px; width: 100%;">
                                <option value="highest-available" ${config.balancingStrategy === 'highest-available' ? 'selected' : ''}>Mayor Disponibilidad</option>
                                <option value="round-robin" ${config.balancingStrategy === 'round-robin' ? 'selected' : ''}>Ciclo Equitativo</option>
                            </select>
                        </div>
                        <div>
                            <label style="display: block; font-size: 12px; color: #8b949e; margin-bottom: 8px;">Soft Decay</label>
                            <input type="number" step="0.1" value="${config.softDecayAmount}" onchange="update({softDecayAmount: parseFloat(this.value)})" style="background: #0d1117; color: white; border: 1px solid #30363d; padding: 10px; border-radius: 6px; width: 100%;">
                        </div>
                    </div>
                </div>
                <div id="models">${modelCards}</div>
            </div>
            <script>
                async function update(patch) {
                    await fetch('/api/config', { method: 'POST', body: JSON.stringify(patch) });
                }
                function toggleModel(name, enabled) {
                    const cfg = ${JSON.stringify(config.enabledModels)};
                    cfg[name] = enabled;
                    update({enabledModels: cfg});
                    document.getElementById('card-' + name).classList.toggle('disabled', !enabled);
                }
                setInterval(() => location.reload(), 30000);
            </script>
        </body>
        </html>
      `, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
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
        const model = cachedModels.find(m => m.name === selectedModel);
        if (model && config.softDecayEnabled) {
            model.usageRemaining = Math.max(0, model.usageRemaining - config.softDecayAmount);
            model.lastUpdate = new Date().toISOString();
        }
        return new Response(proxyRes.body, { status: proxyRes.status, headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }
    return new Response("Not found", { status: 404 });
  }
});
console.log("Gateway activo: http://localhost:8051");
