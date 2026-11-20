# SyncFlow Studio

ระบบวางแผนปฏิทินวิดีโอ (สูงสุด 3 ช่อง/แบรนด์), กระจายคิวอัปโหลดล่วงหน้าแบบ Hybrid และสตูดิโอตั้งชื่อ-คำอธิบายแยกตามแพลตฟอร์ม สำหรับ **YouTube (Shorts & คลิปยาว ≤ 15 นาที)**, **TikTok**, **Instagram Reels** และ **Facebook (Reels & วิดีโอเพจ)**

## จุดเด่นเชิงสถาปัตยกรรม

1. **Hybrid Publishing Engine (เลือกวิธีที่ดีที่สุดให้แต่ละ Platform)**:
   - **YouTube (`YOUTUBE_SHORTS`, `YOUTUBE_LONG`)**: ใช้ **Native Pre-Upload** (Resumable Upload + `publishAt`) อัปโหลดขึ้น YouTube ล่วงหน้าทันทีที่จัดตาราง (ตรวจ Shorts อัตโนมัติเมื่อเป็นแนวตั้ง/จัตุรัส ≤ 180 วินาที)
   - **Facebook (`FACEBOOK_REELS`, `FACEBOOK_VIDEO`)**: ใช้ **Native Pre-Upload** ตั้งเวลาล่วงหน้าผ่าน Graph API (Reels สูงสุด 90 วินาที / ตั้งล่วงหน้า 29 วัน; วิดีโอเพจตั้งล่วงหน้าได้ 180 วัน) พร้อมเตือนสลับโหมดทันทีหากคลิปเกิน 90 วินาที
   - **Instagram Reels (`INSTAGRAM_REELS`)**: ใช้ **JIT Pre-Warm + Publish** เพราะ IG Container หมดอายุใน 24 ชม. ระบบจะสร้าง Container และ Poll จน `FINISHED` ล่วงหน้า ~12 นาที แล้วจึงสั่ง `media_publish` ตรงเวลา
   - **TikTok (`TIKTOK`)**: รองรับทั้ง **Direct Post (JIT)** ที่คำนวณ Chunk ด้วย Floor Division ตามสเปก TikTok v2 + UI ครบตาม TikTok Audit UX Guidelines, โหมด **Inbox Draft ล่วงหน้า**, หรือ **Unified API**
2. **Schedule Matrix (แยกเวลาตาม Platform × วันในสัปดาห์)**:
   - กำหนดเวลาโพสต์ประจำวันจันทร์–อาทิตย์ แยกเฉพาะ YouTube / TikTok / IG / Facebook และแยกตามคลิปสั้น/ยาวได้
   - ลากการ์ดคลิปบนปฏิทินไปวันใหม่ → ระบบคำนวณเวลาของทุก Platform ใหม่และอัปเดต `publishAt` บนแพลตฟอร์มที่ Pre-upload ไปแล้วให้อัตโนมัติ
3. **FFmpeg / FFprobe Pipeline**:
   - วิเคราะห์ขนาด, Rotation, Codec, Faststart `moov` atom และดึงภาพปก 4 เฟรมให้อัตโนมัติ
   - กด **Optimize Video** เพื่อสั่ง `-movflags +faststart` หรือแปลงเป็น H.264/AAC มาตรฐาน 1080p/1920px ในคลิกเดียว
4. **Smart Metadata Studio**:
   - กรอก Master Brief ครั้งเดียว → สร้างชื่อคลิป, คำอธิบาย, CTA, Hashtags, Tags แยกเฉพาะแต่ละ Platform (รองรับทั้ง Rule Engine ออฟไลน์ภาษาไทย/อังกฤษ และ Gemini/OpenAI API)
   - ตรวจลิมิตแม่นยำรวมถึง **UTF-8 Bytes (5,000 bytes)** สำหรับภาษาไทยบน YouTube และ **YouTube Tag Budget (500 chars)**

## การเริ่มต้นใช้งาน (Local)

```bash
npm install
npm run dev
```
- Frontend Web UI: `http://localhost:5173`
- Backend API Server: `http://localhost:3001`

หรือรันแบบ Production Build (เปิดที่พอร์ต 3001 เดียว):
```bash
npm run build
npm start
```

## อ่านเพิ่มเติม
- คู่มือเชื่อมต่อ Official API และการยื่น Audit แต่ละแพลตฟอร์ม: [docs/API_AUDIT_GUIDE.md](docs/API_AUDIT_GUIDE.md)
