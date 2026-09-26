# 💳 Apple Pay Expense Tracker

🇬🇧 English · 🇷🇺 [Русский](README.ru.md)

**See where your money goes, without typing anything.**

Every time you pay with Apple Pay, your iPhone sends the purchase (shop, amount, card) to your own spreadsheet. The purchase is sorted into a category (Groceries, Cafés, Taxi, Subscriptions…) automatically, and you get a monthly summary with a pie chart.

```
 You pay with Apple Pay at a shop
            │
            ▼
 iPhone Shortcuts automation sends: shop = "Starbucks", amount = "2 300 ₸", card = "Visa"
            │
            ▼
 Your Google Sheet (or your own server):
   • reads the amount and currency
   • picks a category from the shop name
   • adds a new row
            │
            ▼
 📲 Notification: "Кафе и рестораны: 2 300 ₸ — Starbucks"
 📊 Monthly totals by category + pie chart update automatically
```

---

## Which option should I choose?

| | **A. Google Sheets** (recommended to start) | **B. Your own server** |
|---|---|---|
| Cost | Free | ~$5/month (VPS or hosting) |
| What you need | A Google account | Basic command-line skills, Docker |
| Where your data lives | A Google Sheet in your Drive | A database file on your server |
| How you view it | Google Sheets app / website | A mobile-friendly web dashboard |
| Setup time | ~15 minutes | ~30+ minutes |

**Not sure? Start with A.** You can move to B later.

Both options use the **same iPhone setup** ([step 2](#step-2-set-up-your-iphone)).

---

## What you need

- An **iPhone with iOS 17 or newer** (Settings → General → About → iOS Version)
- Cards added to **Apple Wallet**
- The **Shortcuts** app (built into iOS; if you deleted it, get it from the App Store for free)
- For option A: a **Google account** and a computer (step 1 is much easier on a computer)

---

## Step 0. Make a secret token

The token is a password. It stops strangers from adding fake purchases to your sheet. Make up any long random string of letters and digits, for example:

```
k3P9vXq7Lm2Rt8Yw4Zn6Bc1Hd5Fj0Gs
```

Or, if you have Python, generate one: `python3 -c "import secrets; print(secrets.token_urlsafe(24))"`

Save it somewhere (for example in Notes). You will paste it in **two** places: the script and the iPhone shortcut. **Don't share it with anyone.**

---

## Option A: Google Sheets (free, no server)

### A1. Create a spreadsheet

1. On your computer, open a browser and type **`sheets.new`** in the address bar (like a website address), then press Enter.
   This opens a new blank Google Sheet. (Alternative: go to [sheets.google.com](https://sheets.google.com) → **Blank**.)
2. Click **"Untitled spreadsheet"** at the top left and rename it, for example, **"My spending"**.

### A2. Paste the script

1. In the spreadsheet menu, click **Extensions → Apps Script**. A code editor opens in a new tab.
2. Delete everything in the editor.
3. Open **[Code.gs](https://raw.githubusercontent.com/AdiletNZ/applepay-expense-tracker/main/google-sheets/Code.gs)**, select all (Ctrl+A / Cmd+A), copy, and paste it into the editor.
4. Near the top, find this line:
   ```js
   const TOKEN = 'ВСТАВЬ_СВОЙ_ТОКЕН';
   ```
   Replace `ВСТАВЬ_СВОЙ_ТОКЕН` with **your token** and keep the quotes:
   ```js
   const TOKEN = 'k3P9vXq7Lm2Rt8Yw4Zn6Bc1Hd5Fj0Gs';
   ```
5. *(Optional)* A few lines below you can change your **time zone** and **main currency**:
   ```js
   const TIMEZONE = 'Asia/Almaty';     // e.g. 'Europe/London', 'America/New_York'
   const DEFAULT_CURRENCY = 'KZT';     // e.g. 'USD', 'EUR', 'GBP'
   ```
6. Click the 💾 **Save** icon (or Ctrl+S / Cmd+S).

### A3. Run the setup (once)

1. At the top of the editor there is a toolbar: `▶ Run   Debug   [ function name ▾ ]`.
   Click the **function dropdown** and choose **`setup`** (it's the first one).
   > ⚠️ Always check the dropdown before pressing Run. If you run a different function by mistake you'll see an error like `TypeError: Cannot read properties of undefined`. It does no harm; just pick the right function and run again.
2. Click **▶ Run**.
3. Google will ask for permission. This is normal because you are running your own script:
   - **Review permissions** → pick your Google account
   - You'll see **"Google hasn't verified this app"** → click **Advanced** → **Go to … (unsafe)**
   - Click **Allow**
   (Google also asks to let the script **run on a schedule and when the spreadsheet changes**. That's what keeps the history tabs up to date automatically.)
4. Go back to your spreadsheet tab. You should now see 6 tabs at the bottom: **Итоги, Операции, Категории, Правила, История, История (Диаграммы)** (see [what each tab does](#how-the-spreadsheet-works)), and a new **💳 Трекер** menu at the top (reload the page if you don't see it).

**Optional test:** choose **`testTransaction`** in the dropdown and click **▶ Run**. A test row "Magnum Cash&Carry, 5 400" appears in the **Операции** tab. Delete that row afterwards (right-click the row number → Delete row).

### A4. Publish it as a web app

This gives you a private web address (URL) that your iPhone will send purchases to.

1. In the Apps Script editor, click the blue **Deploy** button (top right) → **New deployment**.
2. Click the ⚙️ **gear icon** next to "Select type" → choose **Web app**.
3. Fill in:
   - **Description:** anything, e.g. `tracker`
   - **Execute as:** **Me**
   - **Who has access:** **Anyone**. It must be exactly "Anyone", *not* "Anyone with Google account", or your iPhone won't be able to connect.
4. Click **Deploy**. If asked, authorize again (same steps as above).
5. Copy the **Web app URL**. It looks like:
   ```
   https://script.google.com/macros/s/AKfycb...long-random-text.../exec
   ```
6. **Check it:** paste the URL into a new browser tab. You should see:
   ```
   {"ok":true,"message":"Трекер трат работает ✅"}
   ```
   > If you see *"Sorry, unable to open the file at this time"* instead, you are probably signed into several Google accounts in that browser. Open the URL in a **private/incognito window**. If it works there, everything is fine: your iPhone doesn't use your browser login.
7. Send this URL to your iPhone (e.g. via Notes, Messages, or email to yourself).

> **"Anyone" access is safe here:** anyone who knows the URL can *send* a request, but without the correct token the script rejects it and writes nothing. Keep both the URL and the token private.

➡️ Now continue with [Step 2: set up your iPhone](#step-2-set-up-your-iphone).

---

## Option B: your own server

A small Python web app (FastAPI + SQLite) with a phone-friendly dashboard: monthly total, pie chart, list of purchases, change categories with a tap, CSV export, light and dark mode.

### B1. Run it

**With Docker (recommended):**

```bash
git clone https://github.com/AdiletNZ/applepay-expense-tracker.git
cd applepay-expense-tracker
cp .env.example .env        # open .env and set API_TOKEN to your token
docker compose up -d --build
```

**Without Docker:**

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # set API_TOKEN
set -a; source .env; set +a
uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000` and enter your token to see the dashboard.

Your data is stored in `data/expenses.db`. Back up that file from time to time.

### B2. Make it reachable from your iPhone

Your iPhone must be able to reach the server over the internet, **using HTTPS**:

| Where | How |
|---|---|
| A VPS (from ~$4/month) | `docker compose up -d` + a domain + HTTPS via Caddy or nginx |
| Your home computer / Raspberry Pi | [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) give you an HTTPS address without opening ports |
| Railway / Fly.io | deploy the Dockerfile and **attach a volume at `/data`**, otherwise your data is lost on restart |

### B3. Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `API_TOKEN` | *(required)* | your secret token |
| `TIMEZONE` | `Asia/Almaty` | used to group purchases by day and month |
| `DEFAULT_CURRENCY` | `KZT` | used when the currency can't be detected |
| `DB_PATH` | `data/expenses.db` | where the database file is stored |

In the iPhone step below, use `https://your-server/api/transactions` as the URL. Put the token in a **header** instead of the body: **Headers → Add new header** → key `Authorization`, value `Bearer YOUR_TOKEN`. (Sending `token` in the JSON body is only needed for Google Sheets.)

---

## Step 2. Set up your iPhone

This creates an automation that runs by itself after every Apple Pay payment.

> Menu names below are for English iOS. Other languages use the same steps with translated names; for example, in Russian "Shortcut Input" is «Входные данные команды».

### 2.1 Create the automation

1. Open the **Shortcuts** app. Use the app itself, **not** Settings → Shortcuts.
2. Tap the **Automation** tab at the bottom.
3. Tap **+** (or **New Automation**).
4. Scroll down and choose **Transaction**.
5. **Cards:** select the cards you want to track.
   **Categories / merchants:** leave **everything selected**. If you untick something, those purchases won't be tracked. The spreadsheet does its own categorizing.
6. If you see **Run Immediately**, select it. (On some iOS versions this option appears later; see [2.4](#24-turn-on-run-immediately).)
7. Tap **Next** → **New Blank Automation** (may be called **Create New Shortcut**).

### 2.2 Send the purchase to your sheet

1. Tap **Add Action**, search for **URL**, and pick **Get Contents of URL**.
   (You'll also see a line at the top like *"Receive Transaction as input"*. Leave it as it is.)
2. Tap the blue word **URL** and paste your web app URL (the one ending in `/exec`).
3. Tap the **›** arrow on the action to show more options:
   - **Method:** change `GET` → **POST**
   - **Request Body:** choose **JSON** (this option only appears after you pick POST)
   - **Headers:** leave empty (Google Sheets option)
4. Tap **Add new field** → **Text** four times and fill them in:

   | Key (you type it) | Value |
   |---|---|
   | `token` | type your token |
   | `merchant` | 🔵 **Merchant** variable (see below) |
   | `amount` | 🔵 **Amount** variable |
   | `card` | 🔵 **Card or Pass** variable |

   **How to insert a variable (🔵):**
   1. Tap the value field. **Don't type anything.**
   2. Above the keyboard, a row of blue suggestions appears. Tap **Shortcut Input**.
   3. A blue bubble "Shortcut Input" appears in the field. **Tap the bubble** and choose **Merchant** (or **Amount**, or **Card or Pass**).
   4. The bubble now says "Merchant". ✅

   > ❗ The value must be a **blue bubble**, not typed text. If you type the word "Merchant", your sheet will literally get the word "Merchant" every time.

   When you're done it should look like this:
   ```
   Request Body: JSON
     token     k3P9vXq7Lm2Rt8Yw4Zn6Bc1Hd5Fj0Gs
     merchant  (Merchant)        ← blue bubble
     amount    (Amount)          ← blue bubble
     card      (Card or Pass)    ← blue bubble
   ```

### 2.3 Show a notification (optional, but nice)

1. Search for **Get Dictionary Value** and add it. It reads: *Get **Value** for **Key** in **Contents of URL***.
   - Tap **Key** and type `message`.
   - Leave **Value** and **Contents of URL** as they are.
2. Search for **Show Notification** and add it. It's usually filled in with **Dictionary Value** automatically. If not, tap the text and insert the **Dictionary Value** variable.
   - *(Optional)* Tap **›** → **Title** and type something like `💳 Purchase`.
3. Tap **Done** (✓) to save.

### 2.4 Turn on "Run Immediately"

1. In the **Automation** tab, tap your new automation ("When I tap … ").
2. Choose **Run Immediately**, not "Run After Confirmation".
3. Turn **off** **Notify When Run** (otherwise you get an extra "automation ran" notification).
4. Tap **Done**.

### 2.5 Test it 🎉

**Without paying (recommended first):**
1. In the **Shortcuts** tab (not Automation), tap **+** to make a normal shortcut.
2. Add **Get Contents of URL** with the same URL, **POST**, **JSON**, and 3 **typed** text fields: `token` = your token, `merchant` = `Starbucks`, `amount` = `100`.
3. Add the **Show Result** action and tap ▶ to run.
4. You should see `{"ok":true,"category":"Кафе и рестораны",...}` and a new row in the sheet. Delete the row and this test shortcut afterwards.

**For real:** pay for something small with Apple Pay. Within a few seconds you get a notification, and a new row appears in your sheet.

---

## How the spreadsheet works

The script creates 6 tabs. Their names are in Russian:

| Tab | Meaning | What's inside |
|---|---|---|
| **Итоги** | Summary | **Current month only**: total, spending per category with %, and a pie chart. Switches to the new month by itself on the 1st. |
| **Операции** | Transactions | Every purchase ever, one row each: date, shop, amount, currency, category, card |
| **Категории** | Categories | Which words in a shop name belong to which category. You can edit this. |
| **Правила** | Rules | Shops you re-categorized by hand. Filled in automatically. |
| **История** | History | Every purchase as a feed, like a banking app: **newest on top**, grouped by month with the month's total. Date, time, shop, category, amount, card. |
| **История (Диаграммы)** | History (charts) | A pie chart for **every month** (like the one on Итоги) with the month's total and category breakdown next to it. Newest months on top. |

All purchases are stored in one list on **Операции**; the other tabs are calculated from it. **Everything updates by itself**: after every purchase, after you change something on Операции (category, amount, deleted row), and once a night as a safety net. You never need to run anything by hand. (The **💳 Трекер → 🔄 Обновить историю** menu item forces a full rebuild if you ever want one.)

**How a category is chosen:**
1. If the shop is on the **Правила** (Rules) tab, use that category.
2. Otherwise, look for keywords from the **Категории** (Categories) tab in the shop name, top to bottom. For example, "MAGNUM CASH&CARRY" contains `magnum`, so it goes to **Продукты** (Groceries).
3. If nothing matches, use **Другое** (Other).

Built-in categories include: Groceries, Cafés & restaurants, Food delivery, Taxi & transport, Car & fuel, Health & pharmacy, Clothes & shopping, Subscriptions, Phone & internet, Entertainment, Sport, Beauty. There are keywords for many popular shops in Kazakhstan and Russia plus global brands (Starbucks, Uber, Netflix, Zara, IKEA…).

**Everyday use:**
- **Wrong category?** On the **Операции** tab, pick another one from the dropdown in the category column. The sheet remembers this shop and updates all its past and future purchases. You can also type a brand-new category name.
- **See a past month:** open **История** (numbers + chart) or **История (Диаграммы)** (just charts).
- **Another currency:** type it in **B2** on the **Итоги** tab (`KZT`, `USD`, `EUR`…). Summary and history are calculated for that currency.
- **Add your own shops:** add keywords (comma-separated) on the **Категории** tab.
- **Add a purchase by hand** (cash, bank transfer, QR payments): just type a new row on the **Операции** tab.

> Prefer English names? Before running `setup`, you can change the tab names in `SHEETS`, the `DEFAULT_CATEGORY`, and the category names in `DEFAULT_CATEGORIES` at the bottom of `Code.gs`. Keywords can stay as they are.

---

## Limitations

- Only **Apple Pay payments made with the iPhone** trigger the automation (tap-to-pay in shops, and sometimes online Apple Pay).
- **Not tracked:** physical card payments, entering your card number on a website, bank transfers, QR payments (e.g. Kaspi QR), cash. Payments with **Apple Watch** may not trigger the iPhone automation either.
- **Refunds** are not tracked. Delete the original row if you need to.
- The amount is exactly what the terminal charged, in the currency shown on your iPhone.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Notification says **"Неверный токен"** (wrong token) | The token in the shortcut and in `Code.gs` must match exactly, character for character. |
| Notification says **"Впиши свой токен…"** | You didn't replace `ВСТАВЬ_СВОЙ_ТОКЕН`, or you edited the script without re-deploying (see below). |
| **"Нет листа…"** (sheet missing) | You didn't run `setup` (step A3). |
| `TypeError: Cannot read properties of undefined` in the editor | You ran the wrong function. Pick `setup` or `testTransaction` in the dropdown. |
| URL shows *"Sorry, unable to open the file"* | Open it in a private/incognito window (multiple Google accounts issue). |
| The sheet shows the word "Merchant" instead of the shop name | In the shortcut, the value must be a blue variable bubble, not typed text. |
| No notification, no new row | Check that the automation is set to **Run Immediately** and the right cards are selected. |
| Empty notification | Open the shortcut and check the **Get Dictionary Value** key is exactly `message`. |

**Changed the script code?** Changes only go live after you update the deployment: **Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy**. The URL stays the same.

### Updating to a new version of the script

1. Copy the new [Code.gs](https://raw.githubusercontent.com/AdiletNZ/applepay-expense-tracker/main/google-sheets/Code.gs) into the Apps Script editor, replacing everything.
2. Put your token back into the `TOKEN` line and save.
3. Choose **`setup`** in the function dropdown → **▶ Run** (allow new permissions if asked). Your purchases, categories and rules are kept; the Summary and History tabs are rebuilt.
4. Update the deployment: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. **Don't** use "New deployment", which would give you a new URL.

Your iPhone automation doesn't need any changes.

---

## Privacy

- **Google Sheets option:** your data stays in your own Google Drive. The script runs under your account.
- **Server option:** your data stays in a file on your own server.
- Nothing is sent to the author of this project or to any third party. Only these fields are sent: shop name, amount, card name, and date.

---

## For developers

**Project layout:**

```
app/                 FastAPI server (option B)
  main.py            API endpoints
  parsing.py         amount / currency / date parsing
  categorize.py      keyword + learned-rule categorization
  categories.json    default categories and keywords
  db.py              SQLite storage
  static/index.html  dashboard
google-sheets/
  Code.gs            Google Apps Script (option A)
  Code.test.js       Node tests for the script
tests/               pytest tests for the server
```

**Run the tests:**

```bash
pip install -r requirements-dev.txt
pytest                                   # server
node --test google-sheets/Code.test.js   # Google Sheets script
```

**Server API.** Every endpoint except `/` and `/health` needs `Authorization: Bearer <API_TOKEN>`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/transactions` | add a purchase: `{merchant, amount, currency?, card?, name?, date?}` |
| `GET` | `/api/transactions?month=2026-09&category=…` | list purchases |
| `PATCH` | `/api/transactions/{id}` | `{category, remember: true}` and/or `{note}` |
| `DELETE` | `/api/transactions/{id}` | delete a purchase |
| `GET` | `/api/summary?month=2026-09` | totals per category and per day |
| `GET` | `/api/categories` | list of categories |
| `GET` | `/api/export.csv?month=2026-09` | CSV export |

Interactive API docs are available at `/docs`.

Amounts are accepted in any common format: `1 250,50 ₸`, `₸1,250.50`, `$12.99`, `12,99 €`, `KZT 5000`, or a plain number.
