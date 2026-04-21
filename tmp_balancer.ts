import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

// --- Configuration Persistence ---
const CONFIG_PATH = path.join(import.meta.dir, "balancer-config.json");

interface AppConfig {
  apiKey: string;
  syncIntervalMs: number;
  balancingStrategy: "highest-available" | "round-robin" | "random";
  enabledModels: Record<string, boolean>;
}

const defaultConfig: AppConfig = {
  apiKey: process.env.GEMINI_API_KEY || "dummy",
  syncIntervalMs: 300000,
  balancingStrategy: "highest-available",
  enabledModels: {}
};

let config: AppConfig = defaultConfig;

if (existsSync(CONFIG_PATH)) {
  try {
    config = { ...defaultConfig, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
  } catch (e) {
    console.error("Error reading config, using defaults.");
  }
}

function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- State Management ---
interface ModelStats {
  name: string;
  usageRemaining: number;
  resetTime: string;
  lastUpdate: string;
}

let cachedModels: ModelStats[] = [
  { name: "gemini-2.5-flash", usageRemaining: 78.8, resetTime: "Desconocido", lastUpdate: new Date().toISOString() },
  { name: "gemini-2.5-flash-lite", usageRemaining: 97.6, resetTime: "Desconocido", lastUpdate: new Date().toISOString() },
  { name: "gemini-2.5-pro", usageRemaining: 45.3, resetTime: "Desconocido", lastUpdate: new Date().toISOString() },
  { name: "gemini-3-flash-preview", usageRemaining: 78.8, resetTime: "Desconocido", lastUpdate: new Date().toISOString() },
  { name: "gemini-3.1-pro-preview", usageRemaining: 45.3, resetTime: "Desconocido", lastUpdate: new Date().toISOString() },
  { name: "gemini-2.0-pro-exp", usageRemaining: 100, resetTime: "Desconocido", lastUpdate: new Date().toISOString() },
  { name: "gemini-2.0-flash", usageRemaining: 100, resetTime: "Desconocido", lastUpdate: new Date().toISOString() },
  { name: "gemini-1.5-pro", usageRemaining: 100, resetTime: "Desconocido", lastUpdate: new Date().toISOString() }
];

// Initialize enabled models in config if empty
if (Object.keys(config.enabledModels).length === 0) {
  cachedModels.forEach(m => config.enabledModels[m.name] = true);
  saveConfig();
}

function syncWithGeminiCLI() {
  console.log("[" + new Date().toLocaleTimeString() + "] Sincronizando con gemini-cli...");
  try {
    const result = spawnSync("gemini", ["--prompt", "/stats", "--allowed-mcp-server-names", "none"], { 
        encoding: "utf8",
        env: { ...process.env, GEMINI_API_KEY: config.apiKey },
        timeout: 15000 
    });
    
    if (result.status === 0 && result.stdout.includes("%")) {
      const lines = result.stdout.split("\n");
      let foundAny = false;
      for (const model of cachedModels) {
        const match = lines.find(l => l.includes(model.name));
        if (match) {
          // Parse Percentage
          const pctMatch = match.match(/(\d+\.?\d*)%/);
          if (pctMatch) {
            model.usageRemaining = parseFloat(pctMatch[1]);
            model.lastUpdate = new Date().toISOString();
            foundAny = true;
          }
          // Parse Reset Time (e.g., "resets in 21h 45m")
          const resetMatch = match.match(/resets in ([^|]*)/);
          if (resetMatch) {
            model.resetTime = resetMatch[1].trim();
          } else {
            model.resetTime = "Pronto";
          }
        }
      }
      if (foundAny) console.log("Sincronización completada con éxito.");
    }
  } catch (e) {
    console.error("Error en sincronización:", e);
  }
}

// Background sync
let syncTimer = setInterval(syncWithGeminiCLI, config.syncIntervalMs);
setTimeout(syncWithGeminiCLI, 2000);

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
    // Round Robin
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

    // API: Update Config
    if (req.method === "POST" && url.pathname === "/api/config") {
      try {
        const newConfig = await req.json();
        config = { ...config, ...newConfig };
        saveConfig();
        
        // Reset timer if interval changed
        clearInterval(syncTimer);
        syncTimer = setInterval(syncWithGeminiCLI, config.syncIntervalMs);
        
        return Response.json({ status: "ok", config });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 400 });
      }
    }

    // Dashboard
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/stats")) {
      if (url.pathname === "/sync") {
        syncWithGeminiCLI();
        return new Response("Sync triggered");
      }

      const modelCards = cachedModels.map(m => {
        const color = m.usageRemaining < 20 ? "#f44336" : (m.usageRemaining < 50 ? "#ff9800" : "#4caf50");
        const isEnabled = config.enabledModels[m.name] ? "checked" : "";
        return `
          <div class="card ${config.enabledModels[m.name] ? '' : 'disabled'}" id="card-${m.name}" style="border-left: 6px solid ${color}; background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 15px; transition: all 0.3s ease;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;">
                <div>
                    <h3 class="model-title" style="margin: 0; font-size: 1.2rem;">${m.name}</h3>
                    <div style="font-size: 0.8rem; color: #fbbf24; margin-top: 4px; font-weight: 500;">⏳ Resetea en: ${m.resetTime}</div>
                </div>
                <label class="switch">
                    <input type="checkbox" ${isEnabled} onchange="toggleModel('${m.name}', this.checked)">
                    <span class="slider round"></span>
                </label>
            </div>
            <div style="background: #0f172a; height: 30px; border-radius: 20px; overflow: hidden; border: 1px solid #334155;">
                <div style="width: ${m.usageRemaining}%; background: ${color}; height: 100%; transition: width 1s cubic-bezier(0.4, 0, 0.2, 1); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.9rem; text-shadow: 0 1px 2px rgba(0,0,0,0.5);">
                    ${m.usageRemaining}%
                </div>
            </div>
            <div style="margin-top: 10px; font-size: 0.75rem; color: #64748b; text-align: right;">
                Última sincronización: ${new Date(m.lastUpdate).toLocaleTimeString()}
            </div>
          </div>
        `;
      }).join("");

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Gemini Gateway Hub</title>
            <style>
                :root { --bg: #0f172a; --card: #1e293b; --text: #f1f5f9; --accent: #38bdf8; }
                body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; }
                .container { max-width: 900px; width: 100%; }
                h1 { font-size: 2rem; margin-bottom: 10px; color: var(--accent); text-align: center; }
                .controls { background: var(--card); padding: 20px; border-radius: 12px; margin-bottom: 30px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
                .control-group label { display: block; font-size: 0.85rem; color: #94a3b8; margin-bottom: 8px; }
                select, input { background: #0f172a; color: white; border: 1px solid #334155; padding: 10px; border-radius: 6px; width: 100%; box-sizing: border-box; }
                .card.disabled { opacity: 0.4; filter: grayscale(0.8); }
                .btn-sync { background: var(--accent); color: #0f172a; border: none; padding: 12px; border-radius: 8px; font-weight: 700; cursor: pointer; width: 100%; margin-bottom: 20px; font-size: 1rem; }
                .switch { position: relative; display: inline-block; width: 46px; height: 24px; }
                .switch input { opacity: 0; width: 0; height: 0; }
                .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #334155; transition: .4s; border-radius: 34px; }
                .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
                input:checked + .slider { background-color: var(--accent); }
                input:checked + .slider:before { transform: translateX(22px); }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🛸 Gemini Balancer Control Hub</h1>
                
                <div class="controls">
                    <div class="control-group">
                        <label>Estrategia de Balanceo</label>
                        <select onchange="updateConfig({balancingStrategy: this.value})">
                            <option value="highest-available" ${config.balancingStrategy === 'highest-available' ? 'selected' : ''}>📈 Mayor Disponibilidad</option>
                            <option value="round-robin" ${config.balancingStrategy === 'round-robin' ? 'selected' : ''}>🔄 Ciclo (Round Robin)</option>
                            <option value="random" ${config.balancingStrategy === 'random' ? 'selected' : ''}>🎲 Aleatorio</option>
                        </select>
                    </div>
                    <div class="control-group">
                        <label>Refresco del Sistema</label>
                        <select onchange="updateConfig({syncIntervalMs: parseInt(this.value)})">
                            <option value="60000" ${config.syncIntervalMs === 60000 ? 'selected' : ''}>Cada 1 Minuto</option>
                            <option value="300000" ${config.syncIntervalMs === 300000 ? 'selected' : ''}>Cada 5 Minutos</option>
                            <option value="1800000" ${config.syncIntervalMs === 1800000 ? 'selected' : ''}>Cada 30 Minutos</option>
                        </select>
                    </div>
                    <div class="control-group">
                        <label>Nueva API Key</label>
                        <input type="password" placeholder="••••••••" onchange="updateConfig({apiKey: this.value})">
                    </div>
                </div>

                <button class="btn-sync" onclick="this.innerHTML='Sincronizando...'; fetch('/sync').then(()=>setTimeout(()=>location.reload(), 1500))">
                    🔄 Sincronizar Cuotas del Sistema Ahora
                </button>

                <div id="model-list">
                    ${modelCards}
                </div>
            </div>

            <script>
                const currentEnabled = ${JSON.stringify(config.enabledModels)};
                
                async function updateConfig(patch) {
                    await fetch('/api/config', {
                        method: 'POST',
                        body: JSON.stringify(patch),
                        headers: {'Content-Type': 'application/json'}
                    });
                }

                function toggleModel(name, enabled) {
                    currentEnabled[name] = enabled;
                    updateConfig({enabledModels: currentEnabled});
                    document.getElementById('card-' + name).classList.toggle('disabled', !enabled);
                }
            </script>
        </body>
        </html>
      `;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Standard API Proxy
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      try {
        const body = await req.json();
        const selectedModel = getBestModel();
        body.model = selectedModel;

        const targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
        const authHeader = req.headers.get("authorization");
        const apiKey = (authHeader && authHeader.replace("Bearer ", "")) || config.apiKey;

        const proxyReq = new Request(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
          body: JSON.stringify(body)
        });

        const res = await fetch(proxyReq);
        
        // Soft-decay to update UI instantly before next sync
        const model = cachedModels.find(m => m.name === selectedModel);
        if (model) {
            model.usageRemaining = Math.max(0, model.usageRemaining - 0.2);
            model.lastUpdate = new Date().toISOString();
        }

        return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }
});

console.log("Gemini Balancer active on http://localhost:8051");
