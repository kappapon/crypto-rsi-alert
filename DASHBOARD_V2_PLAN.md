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

## ⬜ Phase D1 — โครงตารางหลัก + RSI Day + 1D%
- [ ] `dashboard.js`: ฟังก์ชัน `wilderRSI(closes)` (logic เดียวกับ scan.py — ewm alpha 1/14, ตัดแท่งยังไม่ปิด)
- [ ] ดึง daily klines ต่อเหรียญ (reuse `fetchKlines` เปลี่ยน interval เป็น 1d, limit 50)
- [ ] เปลี่ยน main grid จาก card ใหญ่ → ตารางแถวกระชับ: Symbol | (เว้นที่ Theme) | (เว้นที่ Pattern) | 1D% | RSI(D) — คลิกแถวเปิดการ์ดรายละเอียดเดิม (levels/analyze/calc/OHLCV/remove ทำงานเหมือนเดิมทุกปุ่ม)
- [ ] `index.html` + `styles.css`: โครง layout ใหม่ (เผื่อคอลัมน์ขวาไว้แต่ยังว่าง) + **เปลี่ยนธีมทั้งหน้าเป็น Matrix ตาม Design spec ด้านบน** (รวม modal/ปุ่มเดิมทั้งหมดให้เข้าธีม)
- **Verify:** RSI(D) ตรง TradingView ±0.1 ทุกเหรียญใน watchlist / ปุ่มเดิมครบ / มือถือใน WiFi เปิดได้
- **ไม่แตะ:** server, workflows

## ⬜ Phase D2 — Theme
- [ ] `themes.json` (symbol → theme) + script `update_themes.py`: ลองหา category จาก CoinGecko (`/search` + `/coins/{id}`), เหรียญที่ไม่เจอ (Gate เล็ก) → "Unclassified" แล้วผู้ใช้/Claude แก้มือได้
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
- [ ] badge pattern ในตาราง (Parabolic=ส้ม, Breakout=เขียว, อื่น=เทา)
- **Verify:** spot-check กับกราฟจริง ≥5 เหรียญ ตรงตาสมเหตุผล (กฎปรับจูนได้ภายหลัง — บันทึกเกณฑ์ไว้ในโค้ด)

## ⬜ Phase D4 — Theme Mover panel (แผงขวาบน)
- [ ] layout 2 คอลัมน์ (main 60% / sidebar 40%, มือถือ stack แนวตั้ง)
- [ ] ดึง CoinGecko `/api/v3/coins/categories` (1 call — มี `market_cap_change_24h` ของทุก category ทั้งตลาด) → กรองเฉพาะ theme หลัก ~10 อัน → แสดง bar ± เรียงตามแรงเงินไหล
- [ ] เพิ่ม `api.coingecko.com` เข้า `ALLOWED_HOSTS` ของ proxy ใน `dashboard_server.py` (CoinGecko ไม่มี CORS เหมือน Gate)
- **Verify:** ตัวเลขตรงกับหน้า coingecko.com/en/categories / cache 5 นาทีกัน rate limit

## ⬜ Phase D5 — Top RSI Mover panel (แผงขวาล่าง)
- [ ] `scan.py`: หลังคำนวณ RSI ~400 คู่อยู่แล้วทุก 4 ชม. → เขียน `rsi_snapshot.json` {date, rsi:{sym:val}, prev_daily:{sym:val ของเมื่อวานเวลาเดียวกัน}} + commit ใน workflow (เพิ่มไฟล์เข้า git add ของ rsi-alert.yml)
- [ ] dashboard อ่านไฟล์ → ΔRSI = วันนี้ − เมื่อวาน → top 10 ขึ้น/ลง
- **Verify:** คำนวณมือ 2-3 เหรียญตรง / ไฟล์ snapshot ไม่บวมเกิน (~30KB)

---
**บันทึกความคืบหน้า:** (เติมทุกครั้งที่จบเฟส)
- 2026-06-12: สร้างแผน + mockup อนุมัติแล้ว — ยังไม่เริ่ม D1
