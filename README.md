# ♟ Shaxmat Online

Real-time online shaxmat o'yini — Socket.io va Express bilan.

## Xususiyatlar
- 🔐 Login / Sign in (ism bilan)
- 🔍 Foydalanuvchi qidirish
- 💬 Matnli xabarlar yuborish (chat)
- ⚔ O'yinga taklif yuborish (vaqt nazorati + rang tanlash)
- ⏳ 5 soniyalik hisob-kitob
- ♟ To'liq shaxmat mantiq (rokirovka, en passant, piyoda o'zgarishi)
- ⏱ Saat tizimi (increment bilan)
- 🏆 Natija (shoh mat, taslim, vaqt, uzilish)

## O'rnatish

```bash
npm install
npm start
```

Brauzerda: `http://localhost:3000`

---

## Render.com ga Deploy

1. GitHub ga push qiling:
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/SIZNING_USERNAME/chess-online.git
git push -u origin main
```

2. [render.com](https://render.com) ga kiring
3. "New Web Service" bosing
4. GitHub reponi ulang
5. Quyidagilarni kiriting:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
6. "Deploy" bosing

Bir necha daqiqada URL tayyor bo'ladi!

---

## Netlify/Railway

**Railway:**
```bash
# Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```

**Netlify** faqat statik saytlar uchun — bu server kerak, shuning uchun **Render yoki Railway** tavsiya etiladi.

## Fayl tuzilishi

```
chess-online/
├── server/
│   └── index.js       # Express + Socket.io server
├── public/
│   └── index.html     # Barcha frontend
├── package.json
└── render.yaml        # Render.com config
```
