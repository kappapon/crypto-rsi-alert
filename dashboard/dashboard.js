// Crypto Watchlist Dashboard — fetches watchlist.json + live prices, renders cards
const REFRESH_INTERVAL = 30; // seconds
const SPARKLINE_HOURS = 24;
const EXCHANGES = ["binance_futures", "binance_spot", "gateio_futures"];

// Gate.io API has no CORS header — route through local proxy when served from dashboard_server.py
const USE_PROXY_HOSTS = new Set(["api.gateio.ws"]);
function px(url) {
  try {
    const u = new URL(url);
    if (USE_PROXY_HOSTS.has(u.host)) return `/proxy?url=${encodeURIComponent(url)}`;
  } catch {}
  return url;
}

const prevState = {}; // { symbol: { price, alertedTriggers: Set } }
let countdownTimer = null;
let refreshTimer = null;

// ============ Exchange API ============
async function fetchTicker(symbol, exchange) {
  try {
    if (exchange === "binance_futures") {
      const [pi, t24] = await Promise.all([
        fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`).then(r => r.json()),
        fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`).then(r => r.json()),
      ]);
      return {
        price: parseFloat(pi.markPrice),
        funding: parseFloat(pi.lastFundingRate) * 100,
        change24h: parseFloat(t24.priceChangePercent),
        volume24h: parseFloat(t24.quoteVolume),
        high24h: parseFloat(t24.highPrice),
        low24h: parseFloat(t24.lowPrice),
      };
    }
    if (exchange === "binance_spot") {
      const t = await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`).then(r => r.json());
      return {
        price: parseFloat(t.lastPrice),
        funding: 0,
        change24h: parseFloat(t.priceChangePercent),
        volume24h: parseFloat(t.quoteVolume),
        high24h: parseFloat(t.highPrice),
        low24h: parseFloat(t.lowPrice),
      };
    }
    if (exchange === "gateio_futures") {
      const arr = await fetch(px(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${symbol}`)).then(r => r.json());
      if (!arr || !arr.length) return null;
      const d = arr[0];
      return {
        price: parseFloat(d.last),
        funding: parseFloat(d.funding_rate) * 100,
        change24h: parseFloat(d.change_percentage),
        volume24h: parseFloat(d.volume_24h_quote),
        high24h: parseFloat(d.high_24h),
        low24h: parseFloat(d.low_24h),
      };
    }
  } catch (e) {
    console.warn(`fetchTicker ${symbol}@${exchange}:`, e);
    return null;
  }
}

async function fetchKlines(symbol, exchange, limit = 24) {
  try {
    if (exchange === "binance_futures") {
      const rows = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit}`).then(r => r.json());
      return rows.map(r => parseFloat(r[4])); // close
    }
    if (exchange === "binance_spot") {
      const rows = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`).then(r => r.json());
      return rows.map(r => parseFloat(r[4]));
    }
    if (exchange === "gateio_futures") {
      const rows = await fetch(px(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}&interval=1h&limit=${limit}`)).then(r => r.json());
      return rows.map(r => parseFloat(r.c));
    }
  } catch (e) {
    console.warn(`fetchKlines ${symbol}@${exchange}:`, e);
    return [];
  }
}

// ============ Logic ============
function classifyScenario(price, levels) {
  if (levels.rejection_below && price < levels.rejection_below) return { code: "A", label: "SHORT signal" };
  if (levels.breakout_above && price > levels.breakout_above) return { code: "B", label: "LONG breakout" };
  return { code: "C", label: "Wait / Sideways" };
}

function distanceClass(distPct) {
  const abs = Math.abs(distPct);
  if (abs < 0.5) return "dist-hit";
  if (abs < 2) return "dist-near";
  return "dist-far";
}

function detectTriggers(symbol, price, prevPrice, levels) {
  const triggers = [];
  if (prevPrice == null) return triggers;
  const crossUp = (lv) => lv != null && prevPrice < lv && price >= lv;
  const crossDown = (lv) => lv != null && prevPrice > lv && price <= lv;

  if (crossUp(levels.breakout_above)) triggers.push({ key: "breakout", icon: "⚡", text: `BREAKOUT — ทะลุ ${levels.breakout_above}`, critical: true });
  if (crossDown(levels.rejection_below)) triggers.push({ key: "rejection", icon: "🔻", text: `REJECTION — หลุด ${levels.rejection_below}`, critical: true });
  if (crossDown(levels.support_strong)) triggers.push({ key: "support_break", icon: "💥", text: `SUPPORT BREAK — หลุด ${levels.support_strong}`, critical: true });
  if (crossUp(levels.resistance)) triggers.push({ key: "resistance", icon: "⚠️", text: `RESISTANCE TEST — แตะ ${levels.resistance}`, critical: false });
  return triggers;
}

// ============ Sparkline ============
function renderSparkline(values, change24h) {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 100, h = 30;
  const stepX = w / (values.length - 1);
  const points = values.map((v, i) => `${(i * stepX).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(" ");
  const color = change24h >= 0 ? "var(--green)" : "var(--red)";
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5"/>
  </svg>`;
}

// ============ Sound ============
let audioCtx = null;
function beep(critical = false) {
  if (!document.getElementById("sound-toggle").checked) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = critical ? 880 : 660;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.3);
    if (critical) setTimeout(() => beep(false), 350);
  } catch (e) { console.warn("beep:", e); }
}

// ============ Render ============
function fmt(v, digits = 4) {
  if (v == null) return "-";
  return v.toFixed(digits).replace(/\.?0+$/, "");
}

function buildLevels(symbol, price, levels) {
  const items = [
    ["Breakout", levels.breakout_above, "above"],
    ["ATH", levels.resistance, "above"],
    ["Rejection", levels.rejection_below, "below"],
    ["EMA20", levels.support_strong, "below"],
    ["EMA50", levels.support_extreme, "below"],
  ].filter(([, v]) => v != null);

  return items.map(([label, value]) => {
    const dist = ((value - price) / price) * 100;
    const cls = distanceClass(dist);
    const sign = dist >= 0 ? "+" : "";
    return `<div class="level-label">${label}</div>
      <div class="level-value">${fmt(value)}</div>
      <div class="level-dist ${cls}">${sign}${dist.toFixed(2)}%</div>`;
  }).join("");
}

function renderCard(symbol, cfg, data, klines) {
  const { price, funding, change24h, volume24h, high24h } = data;
  const scenario = classifyScenario(price, cfg.levels);
  const prev = prevState[symbol];
  const triggers = prev ? detectTriggers(symbol, price, prev.price, cfg.levels) : [];

  if (triggers.length) {
    const newTrig = triggers.find(t => !(prev.alertedTriggers || new Set()).has(t.key));
    if (newTrig) {
      beep(newTrig.critical);
      prev.alertedTriggers = prev.alertedTriggers || new Set();
      prev.alertedTriggers.add(newTrig.key);
    }
  }

  const cardCls = triggers.some(t => t.critical) ? "card alert-critical" : (triggers.length ? "card alert" : "card");
  const changeCls = change24h >= 0 ? "up" : "down";
  const priceCls = (prev && price > prev.price) ? "up" : (prev && price < prev.price) ? "down" : "";

  const alertsHtml = triggers.map(t =>
    `<div class="card-alert ${t.critical ? "" : "warn"}">${t.icon} <b>${t.text}</b></div>`
  ).join("");

  return `<div class="card ${cardCls}" data-symbol="${symbol}">
    <div class="card-head">
      <div>
        <div class="card-symbol">${symbol}</div>
        <div class="card-exchange">${cfg.exchange}</div>
      </div>
      <div class="card-scenario scen-${scenario.code}">${scenario.code} · ${scenario.label}</div>
    </div>

    <div>
      <span class="card-price ${priceCls}">${fmt(price, 6)}</span>
      <span class="card-change ${changeCls}">${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%</span>
    </div>

    ${renderSparkline(klines, change24h)}

    <div class="card-meta">
      <span>Funding: <b>${funding >= 0 ? "+" : ""}${funding.toFixed(3)}%</b></span>
      <span>Vol: <b>$${(volume24h / 1e6).toFixed(1)}M</b></span>
      <span>24h H: <b>${fmt(high24h)}</b></span>
    </div>

    <div class="levels">${buildLevels(symbol, price, cfg.levels)}</div>

    ${alertsHtml}

    ${renderAnalysis(symbol)}

    <div class="card-actions">
      <button data-action="analyze" data-symbol="${symbol}">📝 Analyze</button>
      <button data-action="calc" data-symbol="${symbol}">💰 Position Calc</button>
      <button data-action="ohlcv" data-symbol="${symbol}">📥 OHLCV</button>
      <button data-action="remove" data-symbol="${symbol}">🗑️ Remove</button>
    </div>
  </div>`;
}

// ============ Position Calculator ============
function renderCalcModal(symbol, cfg, data) {
  const { levels } = cfg;
  const price = data.price;
  const sections = [];

  // SHORT setup (Scenario A)
  if (levels.rejection_below && levels.support_strong) {
    const entry = levels.rejection_below;
    const sl = levels.breakout_above || price * 1.05;
    const tp1 = levels.support_strong;
    const tp2 = levels.support_extreme || tp1 * 0.9;
    const risk = Math.abs(sl - entry) / entry * 100;
    const reward1 = Math.abs(entry - tp1) / entry * 100;
    const rr = (reward1 / risk).toFixed(2);
    sections.push(`<div class="calc-section">
      <h3>🔻 SHORT Setup (Scenario A — Rejection)</h3>
      <div class="calc-row"><span class="calc-label">Entry</span><span class="calc-value short">${fmt(entry)}</span></div>
      <div class="calc-row"><span class="calc-label">Stop Loss</span><span class="calc-value">${fmt(sl)} (+${risk.toFixed(2)}%)</span></div>
      <div class="calc-row"><span class="calc-label">TP1 (EMA20)</span><span class="calc-value long">${fmt(tp1)} (-${reward1.toFixed(2)}%)</span></div>
      <div class="calc-row"><span class="calc-label">TP2 (EMA50)</span><span class="calc-value long">${fmt(tp2)}</span></div>
      <div class="calc-row"><span class="calc-label">R:R (TP1)</span><span class="calc-value">${rr}:1</span></div>
    </div>`);
  }

  // LONG setup (Scenario B)
  if (levels.breakout_above) {
    const entry = levels.breakout_above;
    const sl = levels.rejection_below || levels.resistance || price * 0.95;
    const tp1 = entry * 1.04;
    const tp2 = entry * 1.08;
    const risk = Math.abs(entry - sl) / entry * 100;
    const reward1 = Math.abs(tp1 - entry) / entry * 100;
    const rr = (reward1 / risk).toFixed(2);
    sections.push(`<div class="calc-section">
      <h3>⚡ LONG Setup (Scenario B — Breakout)</h3>
      <div class="calc-row"><span class="calc-label">Entry</span><span class="calc-value long">${fmt(entry)}</span></div>
      <div class="calc-row"><span class="calc-label">Stop Loss</span><span class="calc-value">${fmt(sl)} (-${risk.toFixed(2)}%)</span></div>
      <div class="calc-row"><span class="calc-label">TP1 (+4%)</span><span class="calc-value long">${fmt(tp1)} (+${reward1.toFixed(2)}%)</span></div>
      <div class="calc-row"><span class="calc-label">TP2 (+8%)</span><span class="calc-value long">${fmt(tp2)}</span></div>
      <div class="calc-row"><span class="calc-label">R:R (TP1)</span><span class="calc-value">${rr}:1</span></div>
    </div>`);
  }

  sections.push(`<div class="calc-section">
    <h3>📌 Current</h3>
    <div class="calc-row"><span class="calc-label">${symbol}</span><span class="calc-value">${fmt(price)}</span></div>
  </div>`);

  document.getElementById("calc-body").innerHTML = sections.join("");
  document.getElementById("modal-calc").classList.remove("hidden");
}

// ============ Suggest (mirror of manage_watchlist.py logic) ============
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function findSwingLows(lows, window = 5) {
  const out = [];
  for (let i = window; i < lows.length - window; i++) {
    let isMin = true;
    for (let j = i - window; j <= i + window; j++) {
      if (lows[j] < lows[i]) { isMin = false; break; }
    }
    if (isMin) out.push(lows[i]);
  }
  return out;
}

async function fetchKlinesFull(symbol, exchange, limit = 500) {
  try {
    if (exchange === "binance_futures") {
      const rows = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit}`).then(r => r.json());
      if (!Array.isArray(rows)) return null;
      return rows.map(r => ({ high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]) }));
    }
    if (exchange === "binance_spot") {
      const rows = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`).then(r => r.json());
      if (!Array.isArray(rows)) return null;
      return rows.map(r => ({ high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]) }));
    }
    if (exchange === "gateio_futures") {
      const rows = await fetch(px(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}&interval=1h&limit=${limit}`)).then(r => r.json());
      if (!Array.isArray(rows) || !rows.length) return null;
      return rows.map(r => ({ high: parseFloat(r.h), low: parseFloat(r.l), close: parseFloat(r.c) }));
    }
  } catch { return null; }
}

async function suggestLevels(symbol, exchange) {
  let ex = exchange;
  let candles = null;
  if (ex === "auto") {
    for (const e of EXCHANGES) {
      candles = await fetchKlinesFull(symbol, e, 500);
      if (candles && candles.length > 50) { ex = e; break; }
    }
  } else {
    candles = await fetchKlinesFull(symbol, ex, 500);
  }
  if (!candles || candles.length < 50) return null;

  const current = candles[candles.length - 1].close;
  const ath = Math.max(...candles.map(c => c.high));
  const closes = candles.map(c => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const lows = candles.map(c => c.low);
  const swings = findSwingLows(lows, 5);
  const candidates = swings.filter(s => e20 < s && s < current);
  const rejection = candidates.length ? Math.max(...candidates) : current * 0.95;

  return {
    exchange: ex,
    current,
    ath,
    breakout_above: +(ath * 1.015).toFixed(4),
    resistance: +ath.toFixed(4),
    rejection_below: +rejection.toFixed(4),
    support_strong: +e20.toFixed(4),
    support_extreme: +e50.toFixed(4),
    funding_high: 0.10,
  };
}

// ============ Main loop ============
let cache = { watchlist: null, analysis: {}, lastFetch: 0 };

async function loadWatchlist() {
  try {
    const r = await fetch("../watchlist.json?_=" + Date.now());
    return await r.json();
  } catch (e) {
    console.error("loadWatchlist:", e);
    return { tickers: {} };
  }
}

async function loadAnalysis() {
  try {
    const r = await fetch("../analysis_log.json?_=" + Date.now());
    if (!r.ok) return {};
    return await r.json();
  } catch (e) {
    return {};
  }
}

function fmtTimeAgo(iso) {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function renderAnalysis(symbol) {
  const a = cache.analysis[symbol];
  if (!a) {
    return `<div class="analysis analysis-empty">
      <div class="analysis-head">
        <span class="analysis-time">📝 ยังไม่มีการวิเคราะห์</span>
      </div>
      <div class="analysis-hint">รอ /loop รอบถัดไป — หรือบันทึกเอง:
<code>python3 log_analysis.py ${symbol} C "label" "ข้อความ"</code></div>
    </div>`;
  }
  const time = new Date(a.timestamp).toLocaleTimeString();
  const scenCls = `scen-${a.scenario}`;
  const escaped = a.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div class="analysis">
    <div class="analysis-head">
      <span class="card-scenario ${scenCls}">${a.scenario} · ${a.scenario_label || ""}</span>
      <span class="analysis-time">${time} · ${fmtTimeAgo(a.timestamp)}</span>
    </div>
    <pre class="analysis-text">${escaped}</pre>
  </div>`;
}

async function refresh() {
  document.getElementById("status").textContent = "🔄 refreshing...";
  document.getElementById("status").className = "status";

  const [watchlist, analysis] = await Promise.all([loadWatchlist(), loadAnalysis()]);
  cache.watchlist = watchlist;
  cache.analysis = analysis;
  const tickers = Object.entries(watchlist.tickers || {}).filter(([, cfg]) => cfg.enabled !== false);

  if (!tickers.length) {
    document.getElementById("grid").innerHTML = `<div class="loading">
      ยังไม่มี ticker ใน watchlist<br><br>
      กด <b>+ Add Ticker</b> เพื่อเริ่ม
    </div>`;
    document.getElementById("status").textContent = "✓ ready";
    document.getElementById("status").className = "status ok";
    return;
  }

  const cards = await Promise.all(tickers.map(async ([symbol, cfg]) => {
    const [data, klines] = await Promise.all([
      fetchTicker(symbol, cfg.exchange),
      fetchKlines(symbol, cfg.exchange, SPARKLINE_HOURS),
    ]);
    if (!data) return `<div class="card"><div class="card-symbol">${symbol}</div><div>❌ no data</div></div>`;
    const html = renderCard(symbol, cfg, data, klines);
    prevState[symbol] = { ...prevState[symbol], price: data.price };
    return html;
  }));

  document.getElementById("grid").innerHTML = cards.join("");
  document.getElementById("status").textContent = `✓ ${tickers.length} tickers`;
  document.getElementById("status").className = "status ok";
  document.getElementById("last-update").textContent = new Date().toLocaleTimeString();
}

function startCountdown() {
  let n = REFRESH_INTERVAL;
  document.getElementById("refresh-countdown").textContent = n;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    n--;
    if (n <= 0) {
      n = REFRESH_INTERVAL;
      refresh();
    }
    document.getElementById("refresh-countdown").textContent = n;
  }, 1000);
}

// ============ Event handlers ============
document.getElementById("refresh-btn").addEventListener("click", () => {
  refresh();
  startCountdown();
});

document.getElementById("add-btn").addEventListener("click", () => {
  document.getElementById("modal-add").classList.remove("hidden");
  document.getElementById("suggest-result").classList.add("hidden");
  document.getElementById("add-symbol").value = "";
});

document.querySelectorAll("[data-close]").forEach(b => {
  b.addEventListener("click", () => document.getElementById(b.dataset.close).classList.add("hidden"));
});

document.querySelectorAll(".modal").forEach(m => {
  m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); });
});

document.getElementById("suggest-btn").addEventListener("click", async () => {
  const symbol = document.getElementById("add-symbol").value.trim().toUpperCase();
  const exchange = document.getElementById("add-exchange").value;
  if (!symbol) return alert("กรอก symbol ก่อน");

  document.getElementById("suggest-btn").textContent = "⏳ analyzing...";
  document.getElementById("suggest-btn").disabled = true;

  const s = await suggestLevels(symbol, exchange);

  document.getElementById("suggest-btn").textContent = "🔍 Suggest Levels";
  document.getElementById("suggest-btn").disabled = false;

  if (!s) {
    alert(`ไม่พบ ${symbol} ใน exchange — ลองระบุ exchange เอง`);
    return;
  }

  const info = `Exchange:    ${s.exchange}
Current:     ${s.current.toFixed(6).replace(/\.?0+$/, "")}
ATH (20d):   ${s.ath.toFixed(6).replace(/\.?0+$/, "")}

  -b ${s.breakout_above}   (breakout)
  -r ${s.resistance}   (resistance/ATH)
  -j ${s.rejection_below}   (rejection)
  -s ${s.support_strong}   (EMA20)
  -x ${s.support_extreme}   (EMA50)
  -f ${s.funding_high}   (funding)`;

  const cmd = `python manage_watchlist.py add ${symbol} \\
  -e ${s.exchange} \\
  -b ${s.breakout_above} \\
  -r ${s.resistance} \\
  -j ${s.rejection_below} \\
  -s ${s.support_strong} \\
  -x ${s.support_extreme} \\
  -f ${s.funding_high}`;

  document.getElementById("suggest-info").textContent = info;
  document.getElementById("suggest-cmd").textContent = cmd;
  document.getElementById("suggest-result").classList.remove("hidden");
});

document.getElementById("copy-cmd-btn").addEventListener("click", () => {
  const cmd = document.getElementById("suggest-cmd").textContent;
  navigator.clipboard.writeText(cmd).then(() => {
    const btn = document.getElementById("copy-cmd-btn");
    const orig = btn.textContent;
    btn.textContent = "✓ Copied!";
    setTimeout(() => btn.textContent = orig, 1500);
  });
});

document.getElementById("grid").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const sym = btn.dataset.symbol;
  const cfg = cache.watchlist.tickers[sym];

  if (btn.dataset.action === "calc") {
    fetchTicker(sym, cfg.exchange).then(data => {
      if (data) renderCalcModal(sym, cfg, data);
    });
  } else if (btn.dataset.action === "ohlcv") {
    mlStart("fetch", sym);
  } else if (btn.dataset.action === "analyze") {
    openAnalysisModal(sym);
  } else if (btn.dataset.action === "remove") {
    const cmd = `python manage_watchlist.py remove ${sym} && git add watchlist.json && git commit -m "watchlist: remove ${sym}" && git push`;
    if (confirm(`Remove ${sym}?\n\nรัน command นี้ใน terminal:\n\n${cmd}`)) {
      navigator.clipboard.writeText(cmd);
      alert("Command copied. รันใน terminal แล้ว refresh dashboard");
    }
  }
});

function openAnalysisModal(symbol) {
  const existing = cache.analysis[symbol];
  document.getElementById("analysis-symbol").textContent = symbol;
  document.getElementById("analysis-scenario").value = existing?.scenario || "C";
  document.getElementById("analysis-label").value = existing?.scenario_label || "";
  document.getElementById("analysis-text").value = existing?.text || "";
  document.getElementById("modal-analysis").classList.remove("hidden");
  document.getElementById("analysis-text").focus();
}

document.getElementById("analysis-save-btn").addEventListener("click", async () => {
  const symbol = document.getElementById("analysis-symbol").textContent;
  const scenario = document.getElementById("analysis-scenario").value;
  const label = document.getElementById("analysis-label").value.trim();
  const text = document.getElementById("analysis-text").value.trim();
  if (!text) return alert("ใส่ details ก่อน");

  const btn = document.getElementById("analysis-save-btn");
  btn.disabled = true;
  btn.textContent = "⏳ saving...";
  try {
    const r = await fetch("/api/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, scenario, scenario_label: label, text }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    document.getElementById("modal-analysis").classList.add("hidden");
    await refresh();
  } catch (e) {
    alert(`Save failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 Save";
  }
});

// ============ ML Pipeline ============
let mlPollTimer = null;

function openMlModal() {
  document.getElementById("modal-ml").classList.remove("hidden");
  loadMlSummary();
  mlPoll();
}

async function mlStart(action, symbol) {
  try {
    const r = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, symbol }),
    });
    const res = await r.json();
    if (!r.ok) {
      alert(res.error || `HTTP ${r.status}`);
      if (r.status !== 409) return;
    }
  } catch (e) {
    return alert(`เรียก /api/run ไม่ได้ — ต้องเปิด dashboard ผ่าน dashboard_server.py (${e.message})`);
  }
  openMlModal();
}

async function mlPoll() {
  if (mlPollTimer) clearTimeout(mlPollTimer);
  let s;
  try {
    s = await fetch("/api/run/status").then(r => r.json());
  } catch { return; }
  const el = document.getElementById("ml-status");
  if (s.state === "idle") {
    el.textContent = "idle — ยังไม่เคยรันใน session นี้";
    return;
  }
  const head = `[${s.state.toUpperCase()}] ${s.action}${s.symbol ? " " + s.symbol : ""}  (start ${s.started}${s.finished ? " → done " + s.finished : ""})`;
  el.textContent = `${head}\n${"─".repeat(46)}\n${s.tail || "(no output yet)"}`;
  el.scrollTop = el.scrollHeight;
  if (s.state === "running") {
    mlPollTimer = setTimeout(mlPoll, 3000);
  } else {
    loadMlSummary();
  }
}

async function loadMlSummary() {
  const parts = [];
  try {
    const m = await fetch("/models/meta.json?_=" + Date.now()).then(r => r.ok ? r.json() : null);
    if (m) {
      const wf = (m.walk_forward || []).map(f => `${f.window}: ${f.precision} (${f.picked} picked)`).join(" · ");
      parts.push(`<div class="ml-card"><b>🤖 Model</b> — trained ${m.trained_at}<br>
        τ=${m.tau} · ${m.events} events · dropped: ${m.dropped_learner}<br>
        <span class="hint">walk-forward: ${wf}</span></div>`);
    }
  } catch {}
  try {
    const b = await fetch("/data/backtest_report.json?_=" + Date.now()).then(r => r.ok ? r.json() : null);
    if (b && b.model_default) {
      const d = b.model_default, base = b.baseline;
      parts.push(`<div class="ml-card"><b>📈 Backtest (OOS)</b> — fee ${(b.fee_pct_roundtrip * 100).toFixed(2)}%/รอบ<br>
        model: ${d.trades} trades · hit ${(d.hit * 100).toFixed(1)}% · avg ${d.avg_r >= 0 ? "+" : ""}${d.avg_r.toFixed(3)}R · total ${d.sum_r >= 0 ? "+" : ""}${d.sum_r.toFixed(1)}R · maxDD ${d.max_dd_r.toFixed(1)}R<br>
        <span class="hint">baseline เข้าทุก event: avg ${base.avg_r >= 0 ? "+" : ""}${base.avg_r.toFixed(3)}R</span></div>`);
    }
  } catch {}
  document.getElementById("ml-summary").innerHTML = parts.join("") ||
    `<div class="ml-card hint">ยังไม่มี model/backtest — รันขั้น 1→4 ตามลำดับ</div>`;
}

document.getElementById("ml-btn").addEventListener("click", openMlModal);
document.querySelectorAll("[data-ml]").forEach(b => {
  b.addEventListener("click", () => mlStart(b.dataset.ml));
});

// ============ Boot ============
refresh();
startCountdown();
