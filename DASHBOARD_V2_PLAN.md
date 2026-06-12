# Dashboard V2 — แผนพัฒนา (สร้าง 2026-06-12)

> **กติกา resume:** หนึ่งเฟส = หนึ่ง session = หนึ่ง commit (อัปเดต checkbox ในไฟล์นี้พร้อมโค้ดเสมอ)
> Session ใหม่: อ่านไฟล์นี้ → ทำเฟสแรกที่ยังไม่ติ๊ก → verify ตามเกณฑ์ → commit + ติ๊ก → จบ session ได้ทุกจุด
> ถ้า session ตายกลางเฟส: โค้ดยังไม่ commit → `git status` แล้วเริ่มเฟสนั้นใหม่ หรือเก็บงานต่อจาก diff ที่ค้าง

**เป้าหมาย:** หน้าหลักเป็นตาราง watchlist (Symbol / Theme / Pattern / 1D% / RSI Day) + แผงขวา 2 ช่อง: Theme Mover (เงินไหลเข้าธีมไหน) และ Top RSI Mover (ΔRSI 1 วันทั้งกระดาน)

**ทรัพยากรรวม:** API เดิมทั้งหมด (Binance data-api, Gate v4) + **CoinGecko free API** (ใหม่ — ไม่ต้องมี key, limit ~10-30 calls/นาที, เราใช้จริง ~1-10 calls/วัน) — ไม่มีค่าใช้จ่าย ไม่มี dependency Python ใหม่

## Design spec — ธีม The Matrix (อนุมัติจาก mockup 2026-06-12)
CSS variables ใน `styles.css` (ใช้ชุดนี้เป๊ะ อย่า hardcode กระจาย):
```css
--bg: #050905;          /* พื้นหลังหลัก ดำอมเขียว */
--surface: #081108;     /* พื้น panel/card */
--border: #14471f;      /* เส้นขอบ panel */
--row-line: #0d2f15;    /* เส้นคั่นแถวตาราง */
--green: #00e653;       /* หลัก: ค่า +, bar, หัวข้อ */
--green-soft: #7ddf96;  /* ข้อความรอง, badge theme */
--green-bright: #baffcb;/* symbol, ตัวเลขเด่น */
--green-dim: #2e7a42;   /* หัวคอลัมน์ */
--green-faint: #1f5c30; /* hint, คำพูดประกอบ */
--amber: #ffd23b;       /* RSI 70-85, pattern parabolic */
--red: #ff5544;         /* ค่า −, RSI ≥ 85, SL/danger */
font-family: monospace ทั้งหน้า (SF Mono / Consolas / monospace)
```
กติกา: หัวข้อ panel ใช้ "▮ TITLE" letter-spacing 1-2px ตัวพิมพ์ใหญ่ / badge = ขอบ 1px ไม่มีพื้น / แถบ digital-rain ตกแต่งใต้ header (ตัวอักษร katakana จาง ๆ — static พอ ไม่ต้อง animate ในเฟสแรก, ถ้าจะ animate เป็นของแถมท้าย D4) / เสียง beep + toast เดิมคงไว้ / สี RSI: <70 เขียวอ่อน, 70-85 amber, ≥85 แดง

---

## ✅ Phase D1 — โครงตารางหลัก + RSI Day + 1D% (เสร็จ 2026-06-12)
- [x] `dashboard.js`: ฟังก์ชัน `wilderRSI(closes)` (logic เดียวกับ scan.py — ewm alpha 1/14, ตัดแท่งยังไม่ปิด)
- [x] ดึง daily klines ต่อเหรียญ (reuse `fetchKlines` เปลี่ยน interval เป็น 1d, limit 50)
- [x] เปลี่ยน main grid จาก card ใหญ่ → ตารางแถวกระชับ: Symbol | (เว้นที่ Theme) | (เว้นที่ Pattern) | 1D% | RSI(D) | ✕ — คลิกแถวเปิดการ์ดรายละเอียดเดิม (levels/analyze/calc/OHLCV ทำงานเหมือนเดิมทุกปุ่ม)
- [x] **✕ ท้ายแถว = remove** (confirm แล้วเรียก action `remove_ticker` เดิม) + **ตารางรองรับเหรียญไม่จำกัด**: `max-height` + scrollbar สไตล์ Matrix (`::-webkit-scrollbar` เขียวเข้ม)
- [x] **batch price fetch** — จำเป็นเมื่อเหรียญไม่จำกัด: Binance `/ticker/24hr` ไม่ส่ง symbol = ได้ทุกคู่ใน 1 call, Gate `/futures/usdt/tickers` ไม่ส่ง contract = ได้ทุกตัวใน 1 call → ราคาทั้ง watchlist ใช้แค่ 2 calls/refresh (klines สำหรับ RSI ยังเป็นรายเหรียญ — stagger + cache 5 นาที, เตือนผู้ใช้ถ้าเกิน ~40 เหรียญ)
- [x] `index.html` + `styles.css`: โครง layout ใหม่ (เผื่อคอลัมน์ขวาไว้แต่ยังว่าง) + **เปลี่ยนธีมทั้งหน้าเป็น Matrix ตาม Design spec ด้านบน** (รวม modal/ปุ่มเดิมทั้งหมดให้เข้าธีม)
- **Verify:** RSI(D) ตรง TradingView ±0.1 ทุกเหรียญใน watchlist / ปุ่มเดิมครบ / มือถือใน WiFi เปิดได้
- **ไม่แตะ:** server, workflows

## ⬜ Phase D2 — Theme
- [ ] `coin_meta.json` (symbol → {theme, logo_url}) + script `update_themes.py`: หา category + **รูปโลโก้เหรียญ** จาก CoinGecko (`/search` + `/coins/{id}` field `image.small`), เหรียญที่ไม่เจอ → theme "Unclassified" + โลโก้ fallback เป็นวงกลมอักษรตัวแรก (สร้างด้วย CSS ไม่ต้องมีรูป)
- [ ] **โลโก้เหรียญต่อท้าย symbol** ในตาราง (`<img>` 16px กลม, onerror → letter-avatar)
- [ ] **ไอคอนประจำ theme ต่อท้ายชื่อ theme** — map คงที่ในโค้ด: AI 🤖, Meme 🐸, Gaming 🎮, DeFi 🏦, RWA 🏛️, L1 ⛓️, DePIN 📡, Unclassified ❔ (ใช้ชุดเดียวกันในแผง Theme Mover)
- [ ] ผูกเข้า `refresh-levels.yml`: เหรียญใหม่ใน watchlist ที่ยังไม่มี theme → เติมอัตโนมัติทุกเช้า
- [ ] badge theme ในตาราง (สี: AI=ม่วง, Meme=ชมพู, DeFi=น้ำเงิน, Gaming=ม่วง, RWA=เขียว ฯลฯ)
- **Verify:** ทุกเหรียญใน watchlist มี theme (ดูจริง + curate มือถ้า API จำแนกแปลก)
- **ทรัพยากร:** CoinGecko free API

## ⬜ Phase D3 — Pattern classifier
- [ ] กฎ rule-based ใน `dashboard.js` จาก daily candles 50 แท่ง (เรียงตาม priority):
  1. **Parabolic** — close > EMA20×1.15 และเขียว ≥3 แท่งใน 4 แท่งล่าสุด
  2. **Breakout** — close > จุดสูงสุด 20 แท่งก่อนหน้า
  3. **Pullback** — เหนือ EMA50 แต่แดง 2-3 แท่งล่าสุด
  4. **Downtrend** — ใต้ EMA50 และ EMA20 < EMA50
  5. **Range** — ไม่เข้าเงื่อนไขบน + แกว่งใน ±7% ของค่าเฉลี่ย 14 แท่ง
- [ ] badge pattern ในตาราง (Parabolic=amber, Breakout=เขียวสด, อื่น=เขียวหม่น)
- [ ] **tooltip ภาษาไทยเมื่อ hover badge** (CSS tooltip — มือถือใช้แตะค้าง):
  - Parabolic: "ราคาพุ่งชันต่อเนื่อง ห่างเส้นค่าเฉลี่ยมากผิดปกติ — เสี่ยงพักตัว/กลับตัวแรง"
  - Breakout: "ทะลุจุดสูงสุด 20 วัน — ขาขึ้นเปิดทางต่อ"
  - Pullback: "ย่อระยะสั้นในโครงขาขึ้น — ดูแนวรับ EMA"
  - Downtrend: "ต่ำกว่าเส้นค่าเฉลี่ยระยะกลาง — ขาลง อย่าเพิ่งสวน"
  - Range: "แกว่งในกรอบแคบ ไร้ทิศชัด — รอเลือกทาง"
- **Verify:** spot-check กับกราฟจริง ≥5 เหรียญ ตรงตาสมเหตุผล (กฎปรับจูนได้ภายหลัง — บันทึกเกณฑ์ไว้ในโค้ด) + tooltip อ่านได้ทั้งจอคอมและมือถือ

## ⬜ Phase D4 — Theme Mover panel (แผงขวาบน)
- [ ] layout 2 คอลัมน์ (main 60% / sidebar 40%, มือถือ stack แนวตั้ง)
- [ ] ดึง CoinGecko `/api/v3/coins/categories` (1 call — มี `market_cap_change_24h` ของทุก category ทั้งตลาด) → กรองเฉพาะ theme หลัก ~10 อัน → แสดง bar ± เรียงตามแรงเงินไหล
- [ ] เพิ่ม `api.coingecko.com` เข้า `ALLOWED_HOSTS` ของ proxy ใน `dashboard_server.py` (CoinGecko ไม่มี CORS เหมือน Gate)
- **Verify:** ตัวเลขตรงกับหน้า coingecko.com/en/categories / cache 5 นาทีกัน rate limit

## ⬜ Phase D5 — Top RSI Mover panel (แผงขวาล่าง)
- [ ] `scan.py`: หลังคำนวณ RSI ~400 คู่อยู่แล้วทุก 4 ชม. → เขียน `rsi_snapshot.json` {date, rsi:{sym:val}, prev_daily:{sym:val ของเมื่อวานเวลาเดียวกัน}} + commit ใน workflow (เพิ่มไฟล์เข้า git add ของ rsi-alert.yml)
- [ ] dashboard อ่านไฟล์ → ΔRSI = วันนี้ − เมื่อวาน → **แสดง 10 อันดับ ในกล่อง scroll ได้** (max-height + scrollbar Matrix เหมือนตารางหลัก)
- **Verify:** คำนวณมือ 2-3 เหรียญตรง / ไฟล์ snapshot ไม่บวมเกิน (~30KB)

---
**บันทึกความคืบหน้า:** (เติมทุกครั้งที่จบเฟส)
- 2026-06-12: สร้างแผน + mockup อนุมัติแล้ว
- 2026-06-12: ✅ D1 เสร็จ — ตาราง Matrix + batch fetch (≤3 calls) + RSI(D) ตรง python เป๊ะบนแท่งปิด (diff ≤0.014) + detail modal + ✕ remove + mobile stack — ต่อไป: D2 (theme)
