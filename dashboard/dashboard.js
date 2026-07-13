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

// ============ Exchange API — batch: ราคาทั้ง watchlist ใน ≤3 calls ไม่ว่ากี่เหรียญ ============
function tickerFromBinance(t) {
  return { price: parseFloat(t.lastPrice), funding: 0, change24h: parseFloat(t.priceChangePercent),
           volume24h: parseFloat(t.quoteVolume), high24h: parseFloat(t.highPrice), low24h: parseFloat(t.lowPrice) };
}

async function fetchAllTickers(tickers) {
  const out = {};
  const exs = new Set(Object.values(tickers).map(c => c.exchange));
  const jobs = [];
  if (exs.has("binance_spot")) {
    const syms = Object.entries(tickers).filter(([, c]) => c.exchange === "binance_spot").map(([s]) => s);
    const q = encodeURIComponent(JSON.stringify(syms));
    jobs.push(fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${q}`)
      .then(r => r.json())
      .then(arr => { (Array.isArray(arr) ? arr : []).forEach(t => { out[t.symbol] = tickerFromBinance(t); }); })
      .catch(e => console.warn("batch binance_spot:", e)));
  }
  if (exs.has("binance_futures")) {
    jobs.push(Promise.all([
      fetch("https://fapi.binance.com/fapi/v1/ticker/24hr").then(r => r.json()),
      fetch("https://fapi.binance.com/fapi/v1/premiumIndex").then(r => r.json()),
    ]).then(([t24, pi]) => {
      const fmap = {};
      (Array.isArray(pi) ? pi : []).forEach(p => { fmap[p.symbol] = parseFloat(p.lastFundingRate) * 100; });
      (Array.isArray(t24) ? t24 : []).forEach(t => {
        if (tickers[t.symbol]?.exchange === "binance_futures") {
          out[t.symbol] = { ...tickerFromBinance(t), funding: fmap[t.symbol] || 0 };
        }
      });
    }).catch(e => console.warn("batch binance_futures:", e)));
  }
  if (exs.has("gateio_futures")) {
    jobs.push(fetch(px("https://api.gateio.ws/api/v4/futures/usdt/tickers"))
      .then(r => r.json())
      .then(arr => {
        (Array.isArray(arr) ? arr : []).forEach(d => {
          if (tickers[d.contract]?.exchange === "gateio_futures") {
            out[d.contract] = { price: parseFloat(d.last), funding: parseFloat(d.funding_rate) * 100,
                                change24h: parseFloat(d.change_percentage), volume24h: parseFloat(d.volume_24h_quote),
                                high24h: parseFloat(d.high_24h), low24h: parseFloat(d.low_24h) };
          }
        });
      }).catch(e => console.warn("batch gateio:", e)));
  }
  await Promise.all(jobs);
  return out;
}

// ============ RSI Day — Wilder สูตรเดียวกับ scan.py (ewm alpha=1/14, รวมแท่ง live แบบ TradingView) ============
function wilderRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const a = 1 / period;
  let avgGain = Math.max(closes[1] - closes[0], 0);
  let avgLoss = Math.max(closes[0] - closes[1], 0);
  for (let i = 2; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (d > 0 ? d : 0) * a + avgGain * (1 - a);
    avgLoss = (d < 0 ? -d : 0) * a + avgLoss * (1 - a);
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

const rsiCache = {}; // RSI daily ขยับช้า — cache 5 นาที ลดจำนวน kline calls
async function dailyRSI(symbol, exchange) {
  const hit = rsiCache[symbol];
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.rsi;
  const closes = await fetchKlines(symbol, exchange, 120, "1d");
  const rsi = wilderRSI(closes);
  rsiCache[symbol] = { rsi, ts: Date.now() };
  return rsi;
}

async function fetchKlines(symbol, exchange, limit = 24, interval = "1h") {
  try {
    if (exchange === "binance_futures") {
      const rows = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`).then(r => r.json());
      return rows.map(r => parseFloat(r[4])); // close
    }
    if (exchange === "binance_spot") {
      const rows = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`).then(r => r.json());
      return rows.map(r => parseFloat(r[4]));
    }
    if (exchange === "gateio_futures") {
      const rows = await fetch(px(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}&interval=${interval}&limit=${limit}`)).then(r => r.json());
      return rows.map(r => parseFloat(r.c));
    }
    if (exchange === "gateio_spot") {
      // spot format = array: [t, quote_vol, close, high, low, open, ...] (เหรียญที่ futures delisted เช่น SYN)
      const rows = await fetch(px(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${symbol}&interval=${interval}&limit=${limit}`)).then(r => r.json());
      return rows.map(r => parseFloat(r[2]));
    }
  } catch (e) {
    console.warn(`fetchKlines ${symbol}@${exchange}:`, e);
    return [];
  }
}

// ============ 15m divergence watch — list มาจาก worker /health (KV) แบบ dynamic ============
// แก้ list ผ่านปุ่ม add/remove (POST /api/divwatch → worker). FALLBACK ใช้เมื่อไม่มี token/health
// (ต้องตั้ง WEBHOOK_SECRET ฝั่ง dashboard ถึงจะได้ list สดจาก worker + add/remove ได้)
const DIV_WATCH_FALLBACK = [
  { symbol: "DEXE_USDT", exchange: "gateio_futures", label: "DEXE" },
  { symbol: "VELVET_USDT", exchange: "gateio_futures", label: "VELVET" },
  { symbol: "SYRUP_USDT", exchange: "gateio_futures", label: "SYRUP" },
  { symbol: "ACT_USDT", exchange: "gateio_futures", label: "ACT" },
  { symbol: "CAP_USDT", exchange: "gateio_futures", label: "CAP" },
  { symbol: "H_USDT", exchange: "gateio_futures", label: "H" },
  { symbol: "RIF_USDT", exchange: "gateio_futures", label: "RIF" },
  { symbol: "LAB_USDT", exchange: "gateio_futures", label: "LAB" },
  { symbol: "NFP_USDT", exchange: "gateio_futures", label: "NFP" },
  { symbol: "TAIKO_USDT", exchange: "gateio_futures", label: "TAIKO" },
  { symbol: "TLM_USDT", exchange: "gateio_futures", label: "TLM" },
  { symbol: "SYN_USDT", exchange: "gateio_spot", label: "SYN" },
];
const DIV_PIVOT_K = 2, DIV_LOOKBACK = 48, DIV_RSI_MIN = 65, DIV_FRESH = 4;

// Wilder RSI แบบ series (คืนทั้ง array) — ตรง cf_worker wilderRSI: seed ที่ diff แรก (i=1)
function wilderRSISeries(closes, period = 14) {
  const n = closes.length;
  const rsi = new Array(n).fill(NaN);
  if (n < period + 1) return rsi;
  const a = 1 / period;
  let avgG = NaN, avgL = NaN;
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (Number.isNaN(avgG)) { avgG = g; avgL = l; }
    else { avgG = (1 - a) * avgG + a * g; avgL = (1 - a) * avgL + a * l; }
    if (i >= period) rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

function swingHighsIdx(highs, k) {
  const out = [];
  for (let i = k; i < highs.length - k; i++) {
    let ok = true;
    for (let j = 1; j <= k; j++) if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

// bearish divergence: ราคา HH + RSI LH เทียบยอดสูงสุดใน lookback (ตรง cf_worker detectDiv "bearish")
function bearishDivClient(highs, rsi) {
  const piv = swingHighsIdx(highs, DIV_PIVOT_K);
  if (piv.length < 2) return null;
  const p2 = piv[piv.length - 1];
  const win = piv.filter(i => i < p2 && i >= p2 - DIV_LOOKBACK);
  if (!win.length) return null;
  let p1 = win[0];
  for (const i of win) if (highs[i] > highs[p1]) p1 = i;
  if (Number.isNaN(rsi[p1]) || Number.isNaN(rsi[p2])) return null;
  if (!(highs[p2] > highs[p1] && rsi[p2] < rsi[p1] && rsi[p1] >= DIV_RSI_MIN)) return null;
  const age = (highs.length - 1) - p2;
  return { age, fresh: age <= DIV_FRESH, p1, p2 };
}

// OHLC (highs+closes, แท่งปิดเท่านั้น) — generalize จาก fetchOHLC15 เดิม ใช้ได้ทุก TF (E3)
async function fetchOHLC(symbol, exchange, interval = "15m") {
  let rows;
  if (exchange === "binance_spot") {
    rows = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=150`).then(r => r.json());
    if (!Array.isArray(rows)) return null;
    rows = rows.slice(0, -1); // ตัดแท่งกำลังก่อตัว (closed only) ตรงกับ worker
    return { highs: rows.map(r => +r[2]), closes: rows.map(r => +r[4]) };
  }
  if (exchange === "gateio_futures") {
    rows = await fetch(px(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}&interval=${interval}&limit=150`)).then(r => r.json());
    if (!Array.isArray(rows)) return null;
    rows = rows.slice(0, -1);
    return { highs: rows.map(r => +r.h), closes: rows.map(r => +r.c) };
  }
  if (exchange === "gateio_spot") {
    // spot format = array: [t, quote_vol, close, high, low, open, ...] (เหรียญที่ futures delisted เช่น SYN)
    rows = await fetch(px(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${symbol}&interval=${interval}&limit=150`)).then(r => r.json());
    if (!Array.isArray(rows)) return null;
    rows = rows.slice(0, -1);
    return { highs: rows.map(r => +r[3]), closes: rows.map(r => +r[2]) };
  }
  return null;
}

// E3 journey timeline: div ต่อ TF — cache แยก (symbol,TF), TTL ตามจังหวะแท่งปิด (แท่งช้า fetch ถี่ไปก็เปลือง)
const DIV_TFS = ["15m", "1h", "2h", "4h"];
const DIV_TF_TTL_MS = { "15m": 2 * 60 * 1000, "1h": 5 * 60 * 1000, "2h": 5 * 60 * 1000, "4h": 15 * 60 * 1000 };
const divTfCache = {};
async function computeDivTf(d, tf) {
  const key = `${d.symbol}|${tf}`;
  const hit = divTfCache[key];
  if (hit && Date.now() - hit.ts < DIV_TF_TTL_MS[tf]) return hit.res;
  let res;
  try {
    const kl = await fetchOHLC(d.symbol, d.exchange, tf);
    if (!kl || kl.closes.length < 20) res = { ok: false };
    else {
      const rsi = wilderRSISeries(kl.closes, 14);
      res = { ok: true, rsi: rsi[rsi.length - 1], div: bearishDivClient(kl.highs, rsi) };
    }
  } catch { res = { ok: false }; }
  divTfCache[key] = { ts: Date.now(), res };
  return res;
}

// รวมทุก TF — ok/rsi/div ระดับแถวยังมาจาก 15m ล้วน (badge เดิมความหมายไม่เปลี่ยน)
async function computeDivMulti(d) {
  const divByTf = {};
  await Promise.all(DIV_TFS.map(async tf => { divByTf[tf] = await computeDivTf(d, tf); }));
  const m15 = divByTf["15m"];
  return { ...d, ok: m15.ok, rsi: m15.rsi, div: m15.div, divByTf };
}
const srcToExchange = (source) => (source === "gate" ? "gateio_futures" : source === "gate_spot" ? "gateio_spot" : "binance_spot");

// RSI(14) vs RSI-based MA (SMA14 ของ RSI — เส้นเหลือง TradingView) บน 1h/2h แท่งปิด — ตรง worker cross watcher
const crossCache = {}; // cache 2 นาที เท่า divWatchCache
async function computeCross(d) {
  const hit = crossCache[d.symbol];
  if (hit && Date.now() - hit.ts < 2 * 60 * 1000) return hit.res;
  const res = {};
  await Promise.all(["1h", "2h"].map(async tf => {
    try {
      const all = await fetchKlines(d.symbol, d.exchange, 100, tf);
      const closes = Array.isArray(all) ? all.slice(0, -1) : []; // closed only ตรง worker
      if (closes.length < 30) return;
      const rsi = wilderRSISeries(closes, 14);
      const sma = i => { let t = 0; for (let j = i - 13; j <= i; j++) { if (Number.isNaN(rsi[j])) return NaN; t += rsi[j]; } return t / 14; };
      const i = rsi.length - 1;
      const ma = sma(i), maPrev = sma(i - 1);
      if ([rsi[i], rsi[i - 1], ma, maPrev].some(Number.isNaN)) return;
      res[tf] = { rsi: rsi[i], ma, crossed: rsi[i - 1] >= maPrev && rsi[i] < ma, below: rsi[i] < ma, hot: maPrev >= 60 };
    } catch (e) { console.warn(`cross ${d.label} ${tf}:`, e); }
  }));
  crossCache[d.symbol] = { ts: Date.now(), res };
  return res;
}

// list สดจาก worker (health.divwatch) → compute div ทุกตัว → render. ไม่มี token = fallback list
let lastDivHealth = null; // health ล่าสุด — chart modal ใช้วาดเส้น armed/sweep
async function refreshDivWatch() {
  const health = await loadDivHealth();
  lastDivHealth = health;
  const list = (health && Array.isArray(health.divwatch) && health.divwatch.length)
    ? health.divwatch.map(d => ({ symbol: d.symbol, exchange: srcToExchange(d.source), label: d.label }))
    : DIV_WATCH_FALLBACK;
  const rows = await Promise.all(list.map(async d => {
    const [base, cross] = await Promise.all([computeDivMulti(d), computeCross(d)]);
    return { ...base, cross };
  }));
  renderDivWatch(rows, health);
  populateDivWatchDatalist();
}

// datalist ให้ add input autocomplete จากเหรียญใน watchlist (= "เพิ่มจาก watchlist")
function populateDivWatchDatalist() {
  const dl = document.getElementById("dw-wl-options");
  if (!dl || !cache.watchlist) return;
  const names = [...new Set(Object.keys(cache.watchlist.tickers || {}).map(shortName))].sort();
  dl.innerHTML = names.map(n => `<option value="${n}"></option>`).join("");
}

// add/remove ticker → worker ผ่าน proxy (ต้องมี WEBHOOK_SECRET ฝั่ง server)
async function divWatchMutate(action, symbol) {
  const msg = document.getElementById("dw-msg");
  const setMsg = (t, c) => { if (msg) { msg.textContent = t; msg.style.color = c || ""; } };
  setMsg(`${action === "add" ? "กำลังเพิ่ม+ตรวจสอบ" : "กำลังลบ"} ${symbol}...`);
  try {
    const r = await fetch("/api/divwatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, symbol }) });
    const d = await r.json();
    if (d.ok) {
      setMsg(action === "add" ? `✅ เพิ่ม ${d.added?.label || symbol} (${d.added?.source})` : `✅ ลบ ${d.removed || symbol}`, "var(--green)");
      const inp = document.getElementById("dw-add-input"); if (inp && action === "add") inp.value = "";
      await refreshDivWatch();
    } else {
      setMsg(`⚠️ ${d.error || "ล้มเหลว"}`, "var(--red)");
    }
  } catch (e) { setMsg(`⚠️ ${e}`, "var(--red)"); }
}

async function loadDivHealth() {
  try {
    const r = await fetch("/api/div_health?_=" + Date.now());
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// E3: rail แนวนอนต่อ symbol — checkpoint div 15m→1h→2h→4h (live ตาม lookback, stateless เหมือน badge เดิม)
// ปิดท้ายด้วย cross chips 1h/2h ที่มีอยู่แล้ว = จุด confirm สุดท้ายของ journey
function renderDivRail(divByTf, chipsHtml) {
  const cp = (tf) => {
    const r = divByTf ? divByTf[tf] : null;
    let dot = "·", cls = "dw-cp-none", tip = `${tf}: ไม่มี div`;
    if (!r || !r.ok) tip = `${tf}: ไม่มีข้อมูล`;
    else if (r.div && r.div.fresh) { dot = "●"; cls = "dw-cp-fresh"; tip = `${tf}: bearish div สด (${r.div.age} แท่งก่อน)`; }
    else if (r.div) { dot = "○"; cls = "dw-cp-old"; tip = `${tf}: div เก่า ${r.div.age} แท่ง`; }
    return `<span class="dw-cp ${cls}" title="${tip}" data-tip="${tip}"><span class="dw-dot">${dot}</span><span class="dw-cp-tf">${tf}</span></span>`;
  };
  const link = `<span class="dw-link">──</span>`;
  return `<div class="dw-rail"><span class="dw-cps">${DIV_TFS.map(cp).join(link)}<span class="dw-link">─┤</span></span>${chipsHtml}</div>`;
}

const DIV_ERR_STATUS = new Set(["klines_http_error", "too_few_klines", "exception"]);
function renderDivWatch(rows, health) {
  const el = document.getElementById("div-watch-body");
  if (el) {
    el.innerHTML = rows.map(d => {
      const xBtn = `<button class="dw-x" data-divremove="${d.label}" title="remove ${d.label}">✕</button>`;
      const symSpan = `<span class="dw-sym" data-chart="${d.symbol}" data-ex="${d.exchange}" title="📈 chart">${d.label}</span>`;
      if (!d.ok) return `<div class="dw-row">${symSpan}<span></span><span class="dw-status faint">⚠️ fetch</span>${xBtn}</div>`;
      const rsiTxt = (d.rsi == null || Number.isNaN(d.rsi)) ? "-" : d.rsi.toFixed(1);
      // worker lifecycle (armed/swept/confirmed) มาก่อน client-side div — เป็น state ของ 2-stage จริง
      const cw = health && health.confirm ? health.confirm[d.symbol] : null;
      let badge;
      if (cw && cw.state === "confirmed") badge = `<span class="dw-status dw-confirmed">🎯 confirmed${cw.ageMin != null ? ` ${cw.ageMin}m` : ""}</span>`;
      else if (cw && cw.state === "swept") badge = `<span class="dw-status dw-swept">⏳ swept</span>`;
      else if (cw && cw.state === "armed") badge = `<span class="dw-status dw-armed">🔫 armed</span>`;
      else if (d.div && d.div.fresh) badge = `<span class="dw-status pct-down">🐻 bearish div</span>`;
      else if (d.div) badge = `<span class="dw-status faint">div · ${d.div.age}b เก่า</span>`;
      else if (d.rsi >= DIV_RSI_MIN) badge = `<span class="dw-status rsi-hot">RSI hot</span>`;
      else badge = `<span class="dw-status faint">quiet</span>`;
      const rCls = d.rsi >= DIV_RSI_MIN ? "rsi-hot" : "rsi-cool";
      // RSI×MA cross chips (1h/2h) + confluence กับ bearish div ล่าสุด (mirror 🎯 confirmed tier ของ worker)
      const chip = (tf, c) => {
        if (!c) return `<span class="dw-tf faint">${tf.toUpperCase()} –</span>`;
        const arrow = c.crossed ? "✂️" : (c.below ? "↓" : "↑");
        const cls = c.crossed && c.hot ? "pct-down" : (c.below ? "dw-below" : "faint");
        return `<span class="dw-tf ${cls}" title="RSI ${c.rsi.toFixed(1)} / MA ${c.ma.toFixed(1)}${c.hot ? " · โซนร้อน" : ""}">${tf.toUpperCase()} ${arrow}${c.rsi.toFixed(0)}/${c.ma.toFixed(0)}</span>`;
      };
      const ldMin = health && health.lastdiv ? health.lastdiv[d.symbol] : null;
      const c2 = d.cross && d.cross["2h"];
      let confl = "";
      if (ldMin != null && c2 && (c2.crossed || c2.below)) confl = `<span class="dw-tf dw-confl">🎯 div ${(ldMin / 60).toFixed(1)}ชม.+2H</span>`;
      else if (ldMin != null) confl = `<span class="dw-tf faint">🐻 div ${(ldMin / 60).toFixed(1)}ชม.</span>`;
      const chipsHtml = d.cross ? `${chip("1h", d.cross["1h"])}${chip("2h", d.cross["2h"])}${confl}` : confl;
      const railRow = renderDivRail(d.divByTf, chipsHtml);
      return `<div class="dw-row">${symSpan}<span class="dw-rsi ${rCls}">${rsiTxt}</span>${badge}${xBtn}${railRow}</div>`;
    }).join("");
  }
  const hEl = document.getElementById("dw-health");
  if (!hEl) return;
  if (!health || health.configured === false) { hEl.textContent = "health off"; hEl.style.color = ""; }
  else if (health.error) { hEl.textContent = "health ⚠️"; hEl.style.color = "var(--red)"; }
  else if (health.symbols) {
    const syms = Object.values(health.symbols);
    const okN = syms.filter(s => !DIV_ERR_STATUS.has(s.status)).length;
    const age = health.ageMinutes != null ? `${health.ageMinutes}m` : "?";
    const stale = health.ageMinutes != null && health.ageMinutes > 20;
    hEl.textContent = `● ${okN}/${syms.length} · ${age}`;
    hEl.style.color = stale ? "var(--red)" : (okN < syms.length ? "var(--yellow)" : "var(--green)");
  } else { hEl.textContent = ""; }
}

// ============ Daily OHLC + Pattern (D3) ============
const dailyCandlesCache = {};

async function fetchDailyOHLC(symbol, exchange, limit = 50) {
  try {
    if (exchange === "binance_futures") {
      const rows = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=${limit}`).then(r => r.json());
      return Array.isArray(rows) ? rows.map(r => ({ o: +r[1], h: +r[2], l: +r[3], c: +r[4] })) : [];
    }
    if (exchange === "binance_spot") {
      const rows = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`).then(r => r.json());
      return Array.isArray(rows) ? rows.map(r => ({ o: +r[1], h: +r[2], l: +r[3], c: +r[4] })) : [];
    }
    if (exchange === "gateio_futures") {
      const rows = await fetch(px(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}&interval=1d&limit=${limit}`)).then(r => r.json());
      return Array.isArray(rows) ? rows.map(r => ({ o: +r.o, h: +r.h, l: +r.l, c: +r.c })) : [];
    }
  } catch (e) { console.warn(`fetchDailyOHLC ${symbol}:`, e); }
  return [];
}

// Priority: Parabolic > Breakout > Pullback > Downtrend > Range
// Criteria match the training event definition (RSI overbought fade-the-top context)
// ⚠️ มี python port ใน pattern_scan.py (wlmanage/divmanage ใช้) — แก้กติกาที่นี่ต้องแก้ที่นั่นด้วย
function classifyPattern(candles) {
  if (!candles || candles.length < 50) return null;
  const closes = candles.map(c => c.c);
  const opens  = candles.map(c => c.o);
  const highs  = candles.map(c => c.h);
  const n = closes.length;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const last  = closes[n - 1];

  // 1. Parabolic — close > EMA20×1.15 and ≥3 green bars in last 4
  const greenIn4 = [1, 2, 3, 4].filter(i => closes[n - i] > opens[n - i]).length;
  if (last > ema20 * 1.15 && greenIn4 >= 3)
    return { name: "Parabolic", tip: "ราคาพุ่งชันต่อเนื่อง ห่างเส้นค่าเฉลี่ยมากผิดปกติ — เสี่ยงพักตัว/กลับตัวแรง" };

  // 2. Breakout — close > highest high of the 20 bars before current
  const high20 = Math.max(...highs.slice(n - 21, n - 1));
  if (last > high20)
    return { name: "Breakout", tip: "ทะลุจุดสูงสุด 20 วัน — ขาขึ้นเปิดทางต่อ" };

  // 3. Pullback — above EMA50 but ≥2 red bars in last 3
  const redIn3 = [1, 2, 3].filter(i => closes[n - i] < opens[n - i]).length;
  if (last > ema50 && redIn3 >= 2)
    return { name: "Pullback", tip: "ย่อระยะสั้นในโครงขาขึ้น — ดูแนวรับ EMA" };

  // 4. Downtrend — below EMA50 and EMA20 < EMA50
  if (last < ema50 && ema20 < ema50)
    return { name: "Downtrend", tip: "ต่ำกว่าเส้นค่าเฉลี่ยระยะกลาง — ขาลง อย่าเพิ่งสวน" };

  // 5. Range — catch-all
  return { name: "Range", tip: "แกว่งในกรอบแคบ ไร้ทิศชัด — รอเลือกทาง" };
}

async function dailyPattern(symbol, exchange) {
  const hit = dailyCandlesCache[symbol];
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.pattern;
  const candles = await fetchDailyOHLC(symbol, exchange, 50);
  const pattern = classifyPattern(candles);
  dailyCandlesCache[symbol] = { pattern, ts: Date.now() };
  return pattern;
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

// ============ ตารางหลัก (V2) ============
const lastTriggers = {}; // เก็บ trigger ล่าสุดต่อเหรียญ ไว้แสดงใน detail modal

const THEME_ICONS = { AI: "🤖", Meme: "🐸", Gaming: "🎮", DeFi: "🏦", RWA: "🏛️", L1: "⛓️", DePIN: "📡", Unclassified: "❔" };

function rsiClass(r) {
  if (r == null) return "faint";
  return r >= 85 ? "rsi-hot" : r >= 70 ? "rsi-warm" : "rsi-cool";
}

function shortName(symbol) {
  return symbol.replace(/_USDT$|USDT$/, "");
}

function logoHtml(base) {
  const m = (cache.coinMeta || {})[base];
  const letter = base[0];
  if (m?.logo_url) {
    return `<img class="coin-logo" src="${m.logo_url}" alt="${letter}" onerror="this.outerHTML='<span class=\\'coin-ava\\'>${letter}</span>'">`;
  }
  return `<span class="coin-ava">${letter}</span>`;
}

function themeBadge(base) {
  const m = (cache.coinMeta || {})[base];
  const theme = m?.theme || "Unclassified";
  const icon = THEME_ICONS[theme] || "❔";
  const cls = "theme-" + theme.replace(/[^a-zA-Z0-9]/g, "");
  return `<span class="badge ${cls}" title="${theme}">${icon} ${theme}</span>`;
}

const PATTERN_CLS = { Parabolic: "pat-parabolic", Breakout: "pat-breakout", Pullback: "pat-pullback", Downtrend: "pat-downtrend", Range: "pat-range" };

function patternBadge(pattern) {
  if (!pattern) return `<span class="badge pat-range faint">—</span>`;
  const cls = PATTERN_CLS[pattern.name] || "pat-range";
  return `<span class="badge ${cls}" data-tooltip="${pattern.tip}">${pattern.name}</span>`;
}

function renderRow(symbol, cfg, data, rsi, pattern) {
  const base = shortName(symbol);
  const ch = data ? data.change24h : null;
  const chCls = ch == null ? "" : ch >= 0 ? "pct-up" : "pct-down";
  const chTxt = ch == null ? "-" : `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}`;
  const hot = (lastTriggers[symbol] || []).some(t => t.critical);
  return `<tr data-symbol="${symbol}">
    <td class="sym" title="${symbol} · ${cfg.exchange}">${hot ? "⚡" : ""}${base}${logoHtml(base)}</td>
    <td>${themeBadge(base)}</td>
    <td>${patternBadge(pattern)}</td>
    <td class="num ${chCls}">${chTxt}</td>
    <td class="num ${rsiClass(rsi)}">${rsi == null ? "-" : Math.round(rsi)}</td>
    <td><button class="row-x" data-remove="${symbol}" title="remove ${symbol}">✕</button></td>
  </tr>`;
}

// ============ Detail modal — เนื้อหาการ์ดเดิมทั้งหมด ============
function renderDetail(symbol, cfg, data) {
  const { price, funding, change24h, volume24h, high24h } = data;
  const scenario = classifyScenario(price, cfg.levels || {});
  const changeCls = change24h >= 0 ? "up" : "down";
  const alertsHtml = (lastTriggers[symbol] || []).map(t =>
    `<div class="card-alert ${t.critical ? "" : "warn"}">${t.icon} <b>${t.text}</b></div>`
  ).join("");

  return `<div class="card">
    <div class="card-head">
      <div><div class="card-exchange">${cfg.exchange}</div></div>
      <div class="card-scenario scen-${scenario.code}">${scenario.code} · ${scenario.label}</div>
    </div>
    <div>
      <span class="card-price">${fmt(price, 6)}</span>
      <span class="card-change ${changeCls}">${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%</span>
    </div>
    <div class="spark-slot"></div>
    <div class="card-meta">
      <span>Funding: <b>${funding >= 0 ? "+" : ""}${funding.toFixed(3)}%</b></span>
      <span>Vol: <b>$${(volume24h / 1e6).toFixed(1)}M</b></span>
      <span>24h H: <b>${fmt(high24h)}</b></span>
    </div>
    <div class="levels">${buildLevels(symbol, price, cfg.levels || {})}</div>
    ${alertsHtml}
    ${renderAnalysis(symbol)}
    <div class="card-actions">
      <button data-action="chart" data-symbol="${symbol}">📈 Chart</button>
      <button data-action="analyze" data-symbol="${symbol}">📝 Analyze</button>
      <button data-action="calc" data-symbol="${symbol}">💰 Position Calc</button>
      <button data-action="ohlcv" data-symbol="${symbol}">📥 OHLCV + Retrain</button>
    </div>
  </div>`;
}

function openDetail(symbol) {
  const cfg = cache.watchlist?.tickers?.[symbol];
  const data = cache.tickerData?.[symbol];
  if (!cfg || !data) return;
  document.getElementById("detail-symbol").textContent = symbol;
  const body = document.getElementById("detail-body");
  body.innerHTML = renderDetail(symbol, cfg, data);
  document.getElementById("modal-detail").classList.remove("hidden");
  fetchKlines(symbol, cfg.exchange, SPARKLINE_HOURS, "1h").then(kl => {
    const slot = body.querySelector(".spark-slot");
    if (slot && kl.length) slot.innerHTML = renderSparkline(kl, data.change24h);
  });
}

// ============ Chart Modal — lightweight-charts v5 + overlay สถานะบอท ============
// แท่งบน chart รวมแท่งกำลังก่อตัว (นี่คือ chart ไม่ใช่ signal); RSI pane + div ใช้แท่งปิดเท่านั้น = มุมมองเดียวกับ watcher
const CHART_TFS = ["15m", "1h", "4h", "1d"];
const CHART_BARS = 300;
const chartState = { chart: null, symbol: null, exchange: null, tf: "1d", seq: 0 };
let journalCache = { ts: 0, paper: [], blocked: [] };

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function loadJournals() {
  if (Date.now() - journalCache.ts < 60 * 1000) return journalCache;
  const [p, b] = await Promise.all([
    fetch("/paper_trades.json?_=" + Date.now()).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("/blocked_trades.json?_=" + Date.now()).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  journalCache = { ts: Date.now(), paper: p?.trades || [], blocked: b?.trades || [] };
  return journalCache;
}

// OHLC เรียงเก่า→ใหม่, time = unix วินาที — format ต่อ exchange ตามแบบ fetchOHLC
async function fetchCandles(symbol, exchange, interval, limit = CHART_BARS) {
  try {
    if (exchange === "binance_spot" || exchange === "binance_futures") {
      const host = exchange === "binance_spot" ? "https://data-api.binance.vision/api/v3" : "https://fapi.binance.com/fapi/v1";
      const rows = await fetch(`${host}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`).then(r => r.json());
      if (!Array.isArray(rows)) return null;
      return rows.map(r => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4] }));
    }
    if (exchange === "gateio_futures") {
      const rows = await fetch(px(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}&interval=${interval}&limit=${limit}`)).then(r => r.json());
      if (!Array.isArray(rows)) return null;
      return rows.map(r => ({ time: +r.t, open: +r.o, high: +r.h, low: +r.l, close: +r.c }));
    }
    if (exchange === "gateio_spot") {
      // spot format = [t, quote_vol, close, high, low, open, ...] — t วินาที
      const rows = await fetch(px(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${symbol}&interval=${interval}&limit=${limit}`)).then(r => r.json());
      if (!Array.isArray(rows)) return null;
      return rows.map(r => ({ time: +r[0], open: +r[5], high: +r[3], low: +r[4], close: +r[2] }));
    }
  } catch (e) { console.warn(`fetchCandles ${symbol}@${exchange}:`, e); }
  return null;
}

// marker ต้องชี้ time ของแท่งที่มีจริง — snap ลงแท่งสุดท้ายที่เปิดก่อน/พอดี ts
function snapBarTime(candles, tSec) {
  if (!candles.length || tSec < candles[0].time) return null;
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i].time <= tSec) return candles[i].time;
  return null;
}

// overlay จาก journal ของเหรียญนี้: ไม้เปิด = เส้น entry/SL/TP, ไม้ปิด = จุดเข้า/ออก+R, โดน block = 🚫, armed/sweep จาก worker
function tradeOverlays(candles, symbol) {
  const green = cssVar("--green"), red = cssVar("--red"), orange = "#ff9a3b", gray = "#8fa89a";
  const toSec = (iso) => Math.floor(Date.parse(iso) / 1000);
  const markers = [], lines = [];
  for (const t of journalCache.paper.filter(t => t.symbol === symbol)) {
    const ot = snapBarTime(candles, toSec(t.opened_at));
    if (t.status === "open") {
      lines.push({ price: t.entry, color: "#d8e8dc", title: "entry" }, { price: t.sl, color: red, title: "SL" }, { price: t.tp, color: green, title: "TP" });
      if (ot) markers.push({ time: ot, position: "aboveBar", color: "#d8e8dc", shape: "arrowDown", text: `short ${t.prob ?? ""}` });
    } else {
      const r = t.r_net ?? t.r ?? 0;
      const ct = t.closed_at ? snapBarTime(candles, toSec(t.closed_at)) : null;
      if (ot) markers.push({ time: ot, position: "aboveBar", color: gray, shape: "arrowDown", text: "S" });
      if (ct) markers.push({ time: ct, position: "belowBar", color: r > 0 ? green : red, shape: "circle", text: `${r >= 0 ? "+" : ""}${r.toFixed(2)}R` });
    }
  }
  for (const b of journalCache.blocked.filter(b => b.symbol === symbol)) {
    const bt = snapBarTime(candles, toSec(b.blocked_at));
    if (bt) markers.push({ time: bt, position: "aboveBar", color: orange, shape: "square", text: b.rule === "concurrent" ? "🚫NC" : "🚫C" });
  }
  const cw = lastDivHealth?.confirm?.[symbol];
  if (cw && (cw.state === "armed" || cw.state === "swept") && cw.armedHigh) {
    lines.push({ price: cw.armedHigh, color: orange, title: `🔫 ${cw.state}` });
    if (cw.peakHigh && cw.peakHigh > cw.armedHigh) lines.push({ price: cw.peakHigh, color: red, title: "sweep peak" });
  }
  return { markers: markers.sort((a, b) => a.time - b.time), lines };
}

function openChartModal(symbol, exchange, tf) {
  chartState.symbol = symbol;
  chartState.exchange = exchange;
  if (tf) chartState.tf = tf;
  document.getElementById("chart-symbol").textContent = `${symbol} · ${exchange}`;
  document.getElementById("chart-tfs").innerHTML = CHART_TFS.map(t =>
    `<button data-tf="${t}" class="${t === chartState.tf ? "active" : ""}">${t}</button>`).join("");
  document.getElementById("modal-chart").classList.remove("hidden");
  drawChart();
}

async function drawChart() {
  const note = document.getElementById("chart-note");
  const legend = document.getElementById("chart-legend");
  const el = document.getElementById("chart-container");
  if (typeof LightweightCharts === "undefined") { note.textContent = "⚠️ โหลด vendor/lightweight-charts ไม่ได้"; return; }
  const seq = ++chartState.seq;
  note.textContent = "⏳ loading...";
  legend.textContent = "";
  const { symbol, exchange, tf } = chartState;
  const [candles] = await Promise.all([fetchCandles(symbol, exchange, tf), loadJournals()]);
  if (seq !== chartState.seq) return; // มี draw ใหม่กว่าแซงแล้ว
  if (!candles || candles.length < 20) { note.textContent = `⚠️ ดึงแท่ง ${tf} ไม่ได้`; return; }

  if (chartState.chart) { chartState.chart.remove(); chartState.chart = null; }
  const green = cssVar("--green"), red = cssVar("--red"), yellow = cssVar("--yellow");
  const last = candles[candles.length - 1].close;
  const precision = last >= 1000 ? 1 : last >= 10 ? 2 : last >= 0.1 ? 4 : last >= 0.001 ? 6 : 8;

  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: cssVar("--surface") }, textColor: cssVar("--text-dim"),
              panes: { separatorColor: cssVar("--border"), enableResize: false } },
    grid: { vertLines: { color: cssVar("--surface-2") }, horzLines: { color: cssVar("--surface-2") } },
    timeScale: { timeVisible: tf !== "1d", secondsVisible: false, borderColor: cssVar("--border"), rightOffset: 3 },
    rightPriceScale: { borderColor: cssVar("--border") },
  });
  chartState.chart = chart;

  const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: green, downColor: red, borderUpColor: green, borderDownColor: red, wickUpColor: green, wickDownColor: red,
    priceFormat: { type: "price", precision, minMove: Number((10 ** -precision).toFixed(precision)) },
  });
  candleSeries.setData(candles);

  // RSI pane (แท่งปิดเท่านั้น — ตรง watcher)
  const closed = candles.slice(0, -1);
  const rsi = wilderRSISeries(closed.map(c => c.close));
  const rsiSeries = chart.addSeries(LightweightCharts.LineSeries, {
    color: yellow, lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
    priceFormat: { type: "price", precision: 1, minMove: 0.1 },
  }, 1);
  rsiSeries.setData(closed.map((c, i) => ({ time: c.time, value: rsi[i] })).filter(d => !Number.isNaN(d.value)));
  rsiSeries.createPriceLine({ price: 70, color: red, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: "" });
  rsiSeries.createPriceLine({ price: 50, color: cssVar("--text-faint"), lineWidth: 1, lineStyle: LightweightCharts.LineStyle.SparseDotted, axisLabelVisible: false, title: "" });
  chart.panes()[1].setHeight(105);

  // divergence p1→p2 (TF ปัจจุบัน กติกาเดียวกับ badge) — เส้นเชื่อมทั้งบนราคาและบน RSI
  const div = bearishDivClient(closed.map(c => c.high), rsi);
  if (div) {
    const mag = "#e864e8";
    const seg = (pane, v1, v2) => {
      const s = chart.addSeries(LightweightCharts.LineSeries, { color: mag, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, pane);
      s.setData([{ time: closed[div.p1].time, value: v1 }, { time: closed[div.p2].time, value: v2 }]);
    };
    seg(0, closed[div.p1].high, closed[div.p2].high);
    seg(1, rsi[div.p1], rsi[div.p2]);
  }

  const ov = tradeOverlays(candles, symbol);
  for (const l of ov.lines) candleSeries.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: l.title });
  if (ov.markers.length) LightweightCharts.createSeriesMarkers(candleSeries, ov.markers);

  note.textContent = "";
  const parts = ["เหลือง = RSI14 (แท่งปิด)"];
  if (div) parts.push(`ม่วง = bearish div (${div.age}b ก่อน)`);
  if (ov.lines.length) parts.push("เส้นประ = entry/SL/TP · armed/sweep");
  if (ov.markers.length) parts.push("S/R = ไม้ journal · 🚫 = โดน rule block");
  legend.textContent = parts.join("  ·  ");
}

document.getElementById("chart-tfs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tf]");
  if (!b) return;
  chartState.tf = b.dataset.tf;
  document.querySelectorAll("#chart-tfs button").forEach(x => x.classList.toggle("active", x === b));
  drawChart();
});

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

// ============ Theme Mover (D4) ============
let tmCache = { data: null, ts: 0 };

function cgCategoryToTheme(id) {
  const s = id.toLowerCase();
  if (s.includes("artificial-intelligence")) return "AI";
  if (s.includes("meme")) return "Meme";
  if (s.includes("gaming") || s.includes("gamefi") || s.includes("play-to-earn")) return "Gaming";
  if (s.includes("decentralized-finance") || s.includes("-defi")) return "DeFi";
  if (s.includes("real-world-asset") || s.includes("-rwa")) return "RWA";
  if (s.includes("layer-1") || s.includes("smart-contract-platform")) return "L1";
  if (s.includes("depin")) return "DePIN";
  return null;
}

function bestCategoryPerTheme(categories) {
  const byTheme = {};
  for (const cat of categories) {
    const theme = cgCategoryToTheme(cat.id);
    if (!theme || cat.market_cap_change_24h == null) continue;
    if (!byTheme[theme] || (cat.market_cap || 0) > (byTheme[theme].market_cap || 0)) {
      byTheme[theme] = { theme, change: cat.market_cap_change_24h, market_cap: cat.market_cap || 0 };
    }
  }
  return Object.values(byTheme).sort((a, b) => b.change - a.change);
}

function renderThemeMoverContent(rows) {
  const el = document.getElementById("theme-mover-body");
  if (!el) return;
  if (!rows.length) { el.innerHTML = `<p class="faint">ไม่พบข้อมูล category</p>`; return; }
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.change)), 0.1);
  el.innerHTML = rows.map(r => {
    const sign = r.change >= 0 ? "+" : "";
    const barCls = r.change >= 0 ? "tm-pos" : "tm-neg";
    const pctCls = r.change >= 0 ? "pct-up" : "pct-down";
    const w = Math.round(Math.abs(r.change) / maxAbs * 100);
    const icon = THEME_ICONS[r.theme] || "❔";
    return `<div class="tm-row">
      <span class="tm-label">${icon} ${r.theme}</span>
      <div class="tm-track"><div class="tm-bar ${barCls}" style="width:${w}%"></div></div>
      <span class="tm-pct ${pctCls}">${sign}${r.change.toFixed(1)}%</span>
    </div>`;
  }).join("");
}

async function refreshThemeMover() {
  if (tmCache.data && Date.now() - tmCache.ts < 5 * 60 * 1000) {
    renderThemeMoverContent(tmCache.data);
    return;
  }
  const el = document.getElementById("theme-mover-body");
  if (el) el.innerHTML = `<p class="faint">กำลังโหลด...</p>`;
  try {
    const url = "https://api.coingecko.com/api/v3/coins/categories?order=market_cap_change_24h_desc";
    const cats = await fetch(`/proxy?url=${encodeURIComponent(url)}`).then(r => r.json());
    if (!Array.isArray(cats)) throw new Error("unexpected response");
    const rows = bestCategoryPerTheme(cats);
    tmCache = { data: rows, ts: Date.now() };
    renderThemeMoverContent(rows);
    const upEl = document.getElementById("tm-updated");
    if (upEl) upEl.textContent = new Date().toLocaleTimeString();
  } catch (e) {
    if (el) el.innerHTML = `<p class="faint" style="font-size:0.72rem">โหลดไม่ได้ — ${e.message}</p>`;
  }
}

// ============ Theme Heatmap (E2) — % หลายช่วงเวลาจาก theme_history.json ที่ Actions สะสมรายวัน ============
const HEAT_HORIZONS = [["1D", 1], ["2D", 2], ["1W", 7], ["1M", 30]];

async function loadThemeHistory() {
  try {
    const r = await fetch("../theme_history.json?_=" + Date.now());
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function renderThemeHeatmap(hist) {
  const el = document.getElementById("theme-heatmap-body");
  if (!el) return;
  const days = hist?.days ? Object.keys(hist.days).sort() : [];
  if (!days.length) { el.innerHTML = `<p class="faint">รอ snapshot แรกจาก Actions_</p>`; return; }

  const latest = days[days.length - 1];
  const latestCaps = hist.days[latest];
  const DAY = 86400000;
  const dateAt = n => new Date(Date.parse(latest) - n * DAY).toISOString().slice(0, 10);

  // % ต่อ theme ต่อ horizon — ไม่มีข้อมูลย้อนหลังพอ = null (ห้ามโชว์ 0/NaN)
  const themes = Object.keys(latestCaps).sort();
  const cells = {};
  let maxAbs = 0.1;
  for (const t of themes) {
    cells[t] = HEAT_HORIZONS.map(([, n]) => {
      const past = hist.days[dateAt(n)]?.[t];
      if (!past) return null;
      const pct = (latestCaps[t] - past) / past * 100;
      maxAbs = Math.max(maxAbs, Math.abs(pct));
      return pct;
    });
  }

  const head = `<div class="th-row th-head"><span></span>${HEAT_HORIZONS.map(([h]) => `<span>${h}</span>`).join("")}</div>`;
  const rows = themes.map(t => {
    const icon = THEME_ICONS[t] || "❔";
    const tds = cells[t].map(p => {
      if (p == null) return `<span class="th-cell th-empty">·</span>`;
      const a = (Math.min(Math.abs(p) / maxAbs, 1) * 0.5 + 0.08).toFixed(2);
      const bg = p >= 0 ? `rgba(0,230,83,${a})` : `rgba(255,85,68,${a})`;
      return `<span class="th-cell" style="background:${bg}">${p >= 0 ? "+" : ""}${p.toFixed(1)}</span>`;
    }).join("");
    return `<div class="th-row"><span class="tm-label">${icon} ${t}</span>${tds}</div>`;
  }).join("");
  el.innerHTML = head + rows;

  // countdown horizon ที่ยังไม่ครบ — ให้ความว่างอ่านเป็น "กำลังสะสม" ไม่ใช่พัง
  const spanDays = Math.round((Date.parse(latest) - Date.parse(days[0])) / DAY);
  const waiting = HEAT_HORIZONS.filter(([, n]) => n > spanDays).map(([h, n]) => `${h} ใน ${n - spanDays} วัน`);
  const note = document.getElementById("th-note");
  if (note) note.textContent = waiting.length ? waiting.join(" · ") : "";
}

// ============ Top RSI Mover (D5) ============
async function loadRsiSnapshot() {
  try {
    const r = await fetch("../rsi_snapshot.json?_=" + Date.now());
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function renderRsiMover(snap) {
  const el = document.getElementById("rsi-mover-body");
  if (!el) return;
  if (!snap?.rsi || !Object.keys(snap.rsi).length) {
    el.innerHTML = `<p class="faint">รอข้อมูลจาก Actions_</p>`;
    return;
  }

  const hasDelta = snap.prev_daily && Object.keys(snap.prev_daily).length > 0;
  const entries = Object.entries(snap.rsi).map(([sym, rsi]) => {
    const prev = snap.prev_daily?.[sym];
    const delta = (hasDelta && prev != null) ? rsi - prev : null;
    return { sym, rsi, delta };
  });

  entries.sort((a, b) => hasDelta
    ? (b.delta ?? -999) - (a.delta ?? -999)
    : b.rsi - a.rsi);

  const top10 = entries.slice(0, 10);
  el.innerHTML = top10.map(e => {
    const short = e.sym.replace(/\.GATEIO$/, "★").replace(/_?USDT$/, "");
    const rsiCls = e.rsi >= 85 ? "rsi-hot" : e.rsi >= 70 ? "rsi-warm" : "rsi-cool";
    const dHtml = e.delta != null
      ? `<span class="${e.delta >= 0 ? "pct-up" : "pct-down"}">${e.delta >= 0 ? "+" : ""}${e.delta.toFixed(1)}</span>`
      : `<span class="faint">—</span>`;
    return `<div class="rm-row">
      <span class="rm-sym" title="${e.sym}">${short}</span>
      <span class="rm-rsi ${rsiCls}">${Math.round(e.rsi)}</span>
      ${dHtml}
    </div>`;
  }).join("");

  const upEl = document.getElementById("rm-updated");
  if (upEl && snap.date) upEl.textContent = snap.date.slice(11, 16) + " UTC";
}

// ============ Main loop ============
let cache = { watchlist: null, analysis: {}, tickerData: {}, lastFetch: 0, rows: [] };

// ============ Sortable watchlist columns ============
let sortState = { col: null, dir: -1 }; // dir 1 = asc (↑), -1 = desc (↓)
const SORT_KEYS = {
  sym: r => r.base.toLowerCase(),
  theme: r => r.theme.toLowerCase(),
  pattern: r => r.patternName.toLowerCase(),
  change: r => r.change,
  rsi: r => r.rsi,
};
const SORT_NUMERIC = new Set(["change", "rsi"]);

function applySortAndRender() {
  const body = document.getElementById("wl-body");
  if (!body) return;
  const rows = (cache.rows || []).slice();
  if (sortState.col && SORT_KEYS[sortState.col]) {
    const key = SORT_KEYS[sortState.col];
    const numeric = SORT_NUMERIC.has(sortState.col);
    rows.sort((a, b) => {
      const va = key(a), vb = key(b);
      const na = va == null || (numeric && Number.isNaN(va));
      const nb = vb == null || (numeric && Number.isNaN(vb));
      if (na && nb) return a.idx - b.idx;
      if (na) return 1;   // ค่าว่างไปท้ายเสมอ ไม่ว่าทิศไหน
      if (nb) return -1;
      if (numeric) return (va - vb) * sortState.dir;
      return va < vb ? -sortState.dir : va > vb ? sortState.dir : a.idx - b.idx;
    });
  } else {
    rows.sort((a, b) => a.idx - b.idx); // ไม่ได้เลือก = ลำดับใน watchlist.json
  }
  body.innerHTML = rows.map(r => r.html).join("");
  updateSortArrows();
}

function updateSortArrows() {
  document.querySelectorAll("#wl-table th.sortable").forEach(th => {
    const arrow = th.querySelector(".sort-arrow");
    if (th.dataset.sort === sortState.col) {
      if (arrow) arrow.textContent = sortState.dir === 1 ? " ↑" : " ↓";
      th.classList.add("sorted");
    } else {
      if (arrow) arrow.textContent = "";
      th.classList.remove("sorted");
    }
  });
}

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

async function loadCoinMeta() {
  try {
    const r = await fetch("../coin_meta.json?_=" + Date.now());
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
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
  const statusEl = document.getElementById("status");
  statusEl.textContent = "🔄 refreshing...";
  statusEl.className = "status";

  const [watchlist, analysis, coinMeta] = await Promise.all([loadWatchlist(), loadAnalysis(), loadCoinMeta()]);
  cache.watchlist = watchlist;
  cache.analysis = analysis;
  cache.coinMeta = coinMeta;
  const tickers = Object.fromEntries(
    Object.entries(watchlist.tickers || {}).filter(([, cfg]) => cfg.enabled !== false));
  const names = Object.keys(tickers);
  document.getElementById("wl-count").textContent = `${names.length} symbols · unlimited_`;
  const body = document.getElementById("wl-body");

  if (!names.length) {
    cache.rows = [];
    body.innerHTML = `<tr><td colspan="6" class="loading">ยังไม่มี ticker — กด + Add Ticker เพื่อเริ่ม</td></tr>`;
    statusEl.textContent = "✓ ready";
    statusEl.className = "status ok";
    return;
  }

  // ราคา: batch ≤3 calls / RSI + pattern daily: ต่อเหรียญ + cache 5 นาที
  const dataMap = await fetchAllTickers(tickers);
  cache.tickerData = dataMap;
  const [rsis, patterns] = await Promise.all([
    Promise.all(names.map(s => dailyRSI(s, tickers[s].exchange).catch(() => null))),
    Promise.all(names.map(s => dailyPattern(s, tickers[s].exchange).catch(() => null))),
  ]);

  cache.rows = names.map((symbol, i) => {
    const data = dataMap[symbol];
    if (data) {
      const prev = prevState[symbol];
      const triggers = prev ? detectTriggers(symbol, data.price, prev.price, tickers[symbol].levels || {}) : [];
      lastTriggers[symbol] = triggers;
      if (triggers.length) {
        const newTrig = triggers.find(t => !(prev.alertedTriggers || new Set()).has(t.key));
        if (newTrig) {
          beep(newTrig.critical);
          prev.alertedTriggers = prev.alertedTriggers || new Set();
          prev.alertedTriggers.add(newTrig.key);
        }
      }
      prevState[symbol] = { ...prevState[symbol], price: data.price };
    }
    const base = shortName(symbol);
    return {
      symbol, idx: i, base,
      theme: (cache.coinMeta || {})[base]?.theme || "Unclassified",
      patternName: patterns[i]?.name || "",
      change: data ? data.change24h : null,
      rsi: rsis[i],
      html: renderRow(symbol, tickers[symbol], data, rsis[i], patterns[i]),
    };
  });

  applySortAndRender(); // คงลำดับ sort ที่ผู้ใช้เลือกไว้ข้าม auto-refresh
  statusEl.textContent = `✓ ${names.length} tickers`;
  statusEl.className = "status ok";
  document.getElementById("last-update").textContent = new Date().toLocaleTimeString();
  refreshThemeMover(); // sidebar — fire and forget
  loadThemeHistory().then(renderThemeHeatmap);
  loadRsiSnapshot().then(renderRsiMover);
  refreshDivWatch();
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

// คลิกหัวคอลัมน์ → เรียง; คลิกซ้ำ = สลับทิศ (เลข default มาก→น้อย, ตัวอักษร default A→Z)
document.querySelectorAll("#wl-table th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.sort;
    if (sortState.col === col) sortState.dir *= -1;
    else { sortState.col = col; sortState.dir = SORT_NUMERIC.has(col) ? -1 : 1; }
    applySortAndRender();
  });
});

// div watch: add (ปุ่ม/Enter) + remove (✕ ต่อแถว, delegation)
const dwAddInput = document.getElementById("dw-add-input");
const dwAddSubmit = () => { const v = (dwAddInput.value || "").trim(); if (v) divWatchMutate("add", v); };
document.getElementById("dw-add-btn")?.addEventListener("click", dwAddSubmit);
dwAddInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") dwAddSubmit(); });
document.getElementById("div-watch-body")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-divremove]");
  if (btn) { divWatchMutate("remove", btn.dataset.divremove); return; }
  const ds = e.target.closest(".dw-sym[data-chart]");
  if (ds) { openChartModal(ds.dataset.chart, ds.dataset.ex, "15m"); return; }
  // แตะจุด checkpoint บนมือถือ (ไม่มี hover) → โชว์อายุ div ใน dw-msg
  const cp = e.target.closest(".dw-cp[data-tip]");
  if (cp) { const msg = document.getElementById("dw-msg"); if (msg) { msg.textContent = cp.dataset.tip; msg.style.color = ""; } }
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

// คลิกแถว = เปิดรายละเอียด / ✕ = remove
document.getElementById("wl-body").addEventListener("click", (e) => {
  const x = e.target.closest("button[data-remove]");
  if (x) {
    e.stopPropagation();
    const sym = x.dataset.remove;
    if (confirm(`ลบ ${sym} ออกจาก watchlist จริง ๆ? (commit + push ให้เลย)`)) mlStart("remove_ticker", sym);
    return;
  }
  const tr = e.target.closest("tr[data-symbol]");
  if (!tr) return;
  // คลิกช่อง symbol = เปิด chart ตรง; ที่เหลือของแถว = detail เดิม
  if (e.target.closest("td.sym")) {
    const cfg = cache.watchlist?.tickers?.[tr.dataset.symbol];
    if (cfg) { openChartModal(tr.dataset.symbol, cfg.exchange, "1d"); return; }
  }
  openDetail(tr.dataset.symbol);
});

// ปุ่ม action ใน detail modal
document.getElementById("detail-body").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const sym = btn.dataset.symbol;
  const cfg = cache.watchlist.tickers[sym];

  if (btn.dataset.action === "calc") {
    const data = cache.tickerData[sym];
    if (data) renderCalcModal(sym, cfg, data);
  } else if (btn.dataset.action === "ohlcv") {
    if (confirm(`ดึงข้อมูล ${sym} แล้ว retrain model ทั้งชุด (~10 นาที)?`)) mlStart("fetch_retrain", sym);
  } else if (btn.dataset.action === "analyze") {
    openAnalysisModal(sym);
  } else if (btn.dataset.action === "chart") {
    openChartModal(sym, cfg.exchange, "1d");
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
let mlPrevState = null;

function showToast(msg, ok = true) {
  const t = document.createElement("div");
  t.className = `toast ${ok ? "toast-ok" : "toast-err"}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 30);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 400); }, 8000);
}

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
  const head = `[${s.state.toUpperCase()}] ${s.action}${s.symbol ? " " + s.symbol : ""}${s.step ? "  step " + s.step : ""}  (start ${s.started}${s.finished ? " → จบ " + s.finished : ""})`;
  el.textContent = `${head}\n${"─".repeat(46)}\n${s.tail || "(no output yet)"}`;
  el.scrollTop = el.scrollHeight;
  if (mlPrevState === "running" && s.state !== "running") {
    const what = `${s.action}${s.symbol ? " " + s.symbol : ""}`;
    if (s.state === "done") {
      showToast(`✅ DONE — ${what} เสร็จแล้ว (${new Date().toLocaleTimeString()})`);
      beep(false);
    } else {
      showToast(`❌ ERROR — ${what} พังที่ step ${s.step} (ดู log ใน 🧠 ML Pipeline)`, false);
      beep(true);
    }
  }
  mlPrevState = s.state;
  if (s.state === "running") {
    mlPollTimer = setTimeout(mlPoll, 3000);
  } else {
    loadMlSummary();
    refresh();
  }
}

async function loadMlSummary() {
  const parts = [];
  try {
    const m = await fetch("/models/meta.json?_=" + Date.now()).then(r => r.ok ? r.json() : null);
    if (m) {
      document.getElementById("last-train").textContent =
        `🤖 train: ${new Date(m.trained_at).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
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
  try {
    const p = await fetch("/paper_trades.json?_=" + Date.now()).then(r => r.ok ? r.json() : null);
    if (p && Array.isArray(p.trades) && p.trades.length) {
      const closed = p.trades.filter(t => t.status !== "open");
      const open = p.trades.length - closed.length;
      const sumR = closed.reduce((a, t) => a + (t.r || 0), 0);
      const hit = closed.length ? closed.filter(t => (t.r || 0) > 0).length : 0;
      const closedPart = closed.length
        ? ` · ปิดแล้ว ${closed.length} · hit ${hit}/${closed.length} · รวม ${sumR >= 0 ? "+" : ""}${sumR.toFixed(2)}R`
        : " · ยังไม่มีไม้ปิด";
      parts.push(`<div class="ml-card"><b>📒 Paper trades</b> — เปิดอยู่ ${open}${closedPart}<br>
        <span class="hint">สมุดไม้จำลองจาก reversal alert — ตัววัดว่า edge จริงก่อนใช้เงิน</span></div>`);
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
loadMlSummary();
mlPoll();
