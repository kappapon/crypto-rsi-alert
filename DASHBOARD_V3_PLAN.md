# Dashboard V3 — แผนพัฒนา (สร้าง 2026-07-03)

> **กติกา resume:** หนึ่งเฟส = หนึ่ง session = หนึ่ง commit (อัปเดต checkbox ในไฟล์นี้พร้อมโค้ดเสมอ)
> Session ใหม่: อ่านไฟล์นี้ → ทำเฟสแรกที่ยังไม่ติ๊ก → verify ตามเกณฑ์ → commit + ติ๊ก → จบ session ได้ทุกจุด
> ถ้า session ตายกลางเฟส: โค้ดยังไม่ commit → `git status` แล้วเริ่มเฟสนั้นใหม่ หรือเก็บงานต่อจาก diff ที่ค้าง

**เป้าหมาย:** (1) ถอด Trigger Journal ออกจาก dashboard (2) Div watch เพิ่ม 1h/2h/4h เป็น journey timeline แบบ checkpoint (3) Theme Mover เพิ่ม heatmap 1D/2D/1W/1M (4) กราฟ theme rotation คาดการณ์เงินย้ายธีม

**ตัดสินใจยืนยันกับผู้ใช้แล้ว (2026-07-03):**
- Trigger journal: ถอด **UI เท่านั้น** — `trigger_log.json` เป็นเส้นเลือดของ auto_evict.py + weekly_summary.py ห้ามรื้อ
- Checkpoint timeline: **live ตาม lookback** (stateless เหมือน div badge เดิม) ไม่ latch ไม่มี state ใหม่
- Div 1h/2h/4h: **dashboard-only** ยังไม่ยิง Telegram alert (ถ้าอยากได้ค่อยเพิ่มเฟส Worker ทีหลัง)

**ข้อจำกัดที่บังคับลำดับเฟส:** heatmap หลายช่วงเวลาต้องสะสม `theme_history.json` เอง (CoinGecko ฟรีให้แค่ 24h) → **E2 ต้องเริ่มเร็วที่สุด** — 1D ใช้ได้วันที่ 2, 2D วันที่ 3, 1W วันที่ 8, 1M วันที่ 31, rotation (E4) gate ที่ 14 วัน ทุกวันที่ช้าคือทุกอย่างเลื่อนหนึ่งวัน

**กติกาที่ห้ามลืม:** classifyPattern (dashboard.js) ถูก lock กับ pattern_scan.py ด้วย test_pattern_parity.py + CI — ถ้าเฟสไหนแตะกติกา pattern ต้องแก้สองฝั่ง + fixtures พร้อมกัน / ห้ามแตะ reversal-alert.yml (fragile) — workflow เดียวที่แก้ใน V3 คือ rsi-alert.yml

---

## Phase E1 — ถอด Trigger Journal (UI เท่านั้น)
- [ ] `index.html`: ลบ panel `#trigger-journal` (~บรรทัด 80-86)
- [ ] `dashboard.js`: ลบ `loadTriggerStats` + `renderTriggerStats` (~839-873) + จุดเรียกใน init (~1051)
- [ ] **คง** track_triggers.py / trigger_stats.json ไว้ทั้งหมด (orphan โดยตั้งใจ — จะเลิก generate stats เป็น cleanup แยกทีหลัง เพราะต้องแก้ reversal-alert.yml)
- **Verify:** panel หายเกลี้ยง / ไม่มี console error / side panels ที่เหลือ render ปกติ / mobile stack ปกติ
- **ไม่แตะ:** server, workflows, Python

## Phase E2 — Theme history snapshot + Heatmap (ทำที่สองเพื่อเดินนาฬิกาข้อมูลทันที)
- [ ] `theme_snapshot.py` ใหม่ (โมเดลจาก pattern_scan.py): CoinGecko `/coins/categories` 1 call → map theme ชุดเดียวกับ `cgCategoryToTheme` → เขียน `theme_history.json` prune >35 วัน + `DRY_RUN` guard + เขียนทับ entry ของวันนี้ (update-in-place ต่อวัน UTC — rsi-alert รันทุก 4 ชม. แต่เก็บวันละค่า)
  ```json
  { "updated": "...", "days": { "2026-07-03": { "AI": 1234567890, "Meme": 987654321 } } }
  ```
  เก็บ **market_cap ดิบ** ต่อ theme ต่อวัน (ไม่เก็บ %) — ทุก horizon คำนวณฝั่ง client ได้ และเพิ่ม horizon ใหม่ทีหลังไม่ต้องสะสมใหม่ / ~10 themes × 35 วัน ≈ 7KB
- [ ] `rsi-alert.yml`: เพิ่ม step `python theme_snapshot.py` + เพิ่ม `theme_history.json` เข้า `git add`
- [ ] `dashboard.js`: `loadThemeHistory()` (fetch `../theme_history.json`) → คำนวณ % ต่อ horizon → `renderThemeHeatmap()` — ช่องที่ยังไม่มีข้อมูล = `·` จาง ๆ (ห้ามโชว์ 0%/NaN) + caption countdown เช่น `1W ใน 5 วัน · 1M ใน 28 วัน` ให้ความว่างอ่านเป็น "กำลังสะสม" ไม่ใช่ "พัง"
- [ ] `index.html` + `styles.css`: heatmap ใต้ bar เดิม (**เก็บ bar 24H ไว้** — ใช้ได้ตั้งแต่วันแรก) — rows=themes+icon, cols=1D/2D/1W/1M, cell เขียว `rgba(0,230,83,α)` / แดง `rgba(255,85,68,α)` โดย α ∝ |%|/maxAbs (normalize แบบเดียวกับ renderThemeMoverContent)
- **Verify:** `DRY_RUN=1 python3 theme_snapshot.py` print market cap ต่อ theme สมเหตุผล / ไฟล์ ≤10KB / วันแรก heatmap โชว์ `·` + countdown ไม่ดูพัง / เทียบ 1D% ธีมหนึ่งกับ coingecko.com/en/categories
- **ทรัพยากร:** +1 CoinGecko call/วัน (ฝั่ง Actions — ไม่ติด geo-block) / browser อ่านไฟล์ local ไม่เพิ่ม call

## Phase E3 — Div journey timeline หลาย TF (dashboard-only)
- [ ] `dashboard.js`: generalize `fetchOHLC15` → `fetchOHLC(symbol, exchange, interval)` / เพิ่ม `computeDivMulti` วน 15m/1h/2h/4h ผ่าน `bearishDivClient` เดิม / cache ต่อ (symbol,TF): 15m=2 นาทีเดิม, 1h/2h=5 นาที, 4h=15 นาที (แท่งปิดช้า fetch ถี่ไปก็เปลือง)
- [ ] `renderDivRail(divByTf, cross)` ใน `renderDivWatch`: rail แนวนอนต่อ symbol
  ```
  DEXE  RSI 71  ●───●───●───○──┤ ✂1h ↓2h  🎯 confirmed
               15m   1h   2h   4h    cross chips เดิม
  ```
  `●` = fresh div / `○` = div เก่า (hover/แตะ = อายุกี่แท่ง) / `·` = ไม่มี — จุด confirm สุดท้ายคือ RSI×MA cross chips 1h/2h ที่มีอยู่แล้ว (ตรง confluence 🎯 ของ worker)
- [ ] `styles.css`: จุด + เส้นเชื่อม Matrix theme / mobile: rail ตัดบรรทัดใต้ symbol, จุดยังแตะได้
- **Verify:** จุด 15m ตรงกับ badge เดิมทุกเหรียญ / เทียบ divergence 1h/4h กับ TradingView ด้วยตา ≥3 เหรียญ / นับ kline calls ต่อ refresh ใน console — cold ~4×N, warm ~0 / มือถืออ่านรู้เรื่อง
- **ไม่แตะ:** cf_worker (ยังไม่มี alert TF สูง — ตัดสินใจแล้ว 2026-07-03)

## Phase E4 — Theme rotation list
- [ ] `dashboard.js`: `computeRotation(history, k=1)` — หา top theme (1D%) รายวัน → นับคู่ `(top วันนี้ → top วันถัดไป)` บน window ทั้งไฟล์ / **gate ≥14 วัน**: ก่อนครบแสดง `กำลังสะสม (X/14 วัน)`
- [ ] `renderRotation()` — ranked list `🤖 AI → 🐸 Meme ×5 ▓▓▓▓▓` (~6 อันดับ) ใช้ `.tm-track/.tm-bar` + `THEME_ICONS` เดิม + caption `n=X วัน · สัญญาณอ่อน ใช้ประกอบ ไม่ใช่ยืนยัน`
- [ ] `index.html` + `styles.css`: panel ▮ THEME ROTATION
- **Verify:** นับมือจาก theme_history จริง (หรือ history สังเคราะห์) ตรงกับที่แสดง / gate แสดงถูกก่อนครบ 14 วัน / caption ความซื่อสัตย์อยู่ครบ
- **Deps:** E2 (เริ่มมีประโยชน์จริง ~2 สัปดาห์หลัง E2 ขึ้น)

## Phase E5 (optional — รอข้อมูลสุก ≥30 วัน) — Rotation matrix + lead-lag
- [ ] transition-matrix heatmap (reuse cell renderer ของ E2) + rolling anti-correlation ระหว่างคู่ theme
- **Deps:** E2 สะสม ≥30 วัน + E4 — เฟสนี้ตั้งใจทิ้งไว้จนข้อมูลพอ อย่ารีบ

---
**บันทึกความคืบหน้า:** (เติมทุกครั้งที่จบเฟส)
- 2026-07-03: สร้างแผน — ออกแบบผ่าน orchestration workflow (Opus วิเคราะห์ codebase + ผู้ใช้ยืนยัน 3 ข้อตัดสินใจ) — ต่อไป: E1
