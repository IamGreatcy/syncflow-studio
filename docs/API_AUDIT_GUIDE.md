# คู่มือเชื่อมต่อ Official API และเตรียมยื่น Audit (2026)

ทุกบัญชีสามารถทดสอบระบบทั้งหมดได้ทันทีในโหมด **Simulation** ก่อน จากนั้นเมื่อพร้อมใช้งานจริงให้ตั้งค่าตัวแปรใน `.env` (ดู `.env.example`) แล้วกด **Connect OAuth** ในหน้า *ช่อง & การเชื่อมต่อ API*

---

## 1. YouTube Data API v3 (Google Cloud Console)

1. สร้างโปรเจกต์ใน Google Cloud Console และเปิดใช้งาน **YouTube Data API v3**
2. ตั้งค่า OAuth Consent Screen และสร้าง OAuth 2.0 Client ID (Web Application):
   - Authorized redirect URI: `http://localhost:3001/api/oauth/youtube/callback` (หรือโดเมนจริงของคุณ)
   - Scopes ที่ใช้:
     - `https://www.googleapis.com/auth/youtube.upload`
     - `https://www.googleapis.com/auth/youtube.force-ssl`
     - `https://www.googleapis.com/auth/youtube.readonly`
3. ใส่ `GOOGLE_CLIENT_ID` และ `GOOGLE_CLIENT_SECRET` ใน `.env`
4. **ข้อควรรู้เรื่อง Quota & Audit**:
   - ตั้งแต่ปี 2026 Google แยก `videos.insert` เป็น Bucket ต่างหาก ได้เริ่มต้น **100 คลิป/วัน**
   - โปรเจกต์ที่ยังไม่ผ่าน OAuth Verification / YouTube API Services Compliance Audit จะถูกล็อกคลิปที่อัปโหลดผ่าน API เป็น **Private** จนกว่าจะผ่านการตรวจสอบ (ให้ทำวิดีโอ Demo หน้าจอ SyncFlow Studio แสดงการจัดการ Metadata และ `publishAt` ส่งให้ทีม YouTube API Services)

---

## 2. Facebook & Instagram Graph API (Meta for Developers)

1. สร้าง App ประเภท Business ใน Meta for Developers และเพิ่มผลิตภัณฑ์ **Facebook Login for Business** / **Instagram Graph API**
2. ตั้ง Redirect URI:
   - Facebook: `http://localhost:3001/api/oauth/facebook/callback`
   - Instagram: `http://localhost:3001/api/oauth/instagram/callback`
3. ใส่ `META_APP_ID` และ `META_APP_SECRET` ใน `.env`
4. Permissions ที่ต้องขอ App Review (Advanced Access) เพื่อใช้กับเพจ/บัญชีจริง:
   - Facebook: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`
   - Instagram: `instagram_basic`, `instagram_content_publish` (ต้องเป็น **Instagram Business Account** ที่เชื่อมกับ Facebook Page)
5. **ข้อจำกัดสำคัญ**:
   - Facebook Reels API จำกัดความยาว **3 – 90 วินาที** (คลิปที่ยาว 91 วินาที – 15 นาที ให้เลือก Format เป็น **Facebook วิดีโอเพจ** แทน ซึ่งรองรับ Pre-upload ล่วงหน้าได้ถึง 6 เดือน)
   - Instagram Reels Container หมดอายุภายใน **24 ชั่วโมง** — SyncFlow Studio จึงจัดการแบบ JIT Pre-warm ล่วงหน้า 12 นาทีให้โดยอัตโนมัติ

---

## 3. TikTok Content Posting API v2 (TikTok for Developers)

1. สร้าง App ใน TikTok for Developers และเปิดใช้งาน **Content Posting API** พร้อม Scopes:
   - `user.info.basic`
   - `video.publish` (Direct Post)
   - `video.upload` (Inbox Draft)
2. ตั้ง Redirect URI: `http://localhost:3001/api/oauth/tiktok/callback`
3. ใส่ `TIKTOK_CLIENT_KEY` และ `TIKTOK_CLIENT_SECRET` ใน `.env`
4. **ข้อควรรู้สำหรับ TikTok Audit**:
   - แอปที่ยังไม่ผ่าน Audit จะโพสต์ได้เฉพาะ `SELF_ONLY` (Private) และจำกัดไม่เกิน 5 บัญชี/24 ชม.
   - ระหว่างรอ Audit หรือถ้าอยากอัปโหลดล่วงหน้าไปพักไว้บนมือถือ ให้เปลี่ยนโหมดของบัญชี TikTok เป็น **Inbox Draft (ล่วงหน้า)** หรือเชื่อมผ่าน **Unified API** ชั่วคราวได้ทันที
   - หน้าจอตั้งค่า TikTok ใน SyncFlow Studio ออกแบบให้ดึง `creator_info/query` และแสดงปุ่ม Privacy, Comment/Duet/Stitch, Commercial Disclosure ตามข้อกำหนด **TikTok UX Guidelines** ครบถ้วนเพื่อใช้บันทึกวิดีโอส่ง Audit

---

## 4. Cloudflare R2 (แนะนำสำหรับการประหยัดค่า Bandwidth)

- หากเปิดใช้งาน **Cloudflare R2** ในหน้า *ตั้งค่า* ระบบจะอัปโหลดวิดีโอขึ้น R2 (Egress = \$0) และใช้ Public URL ร่วมกับ Instagram Graph API เพื่อความเสถียรสูงสุดในการดึงวิดีโอ
