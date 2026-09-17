# Wallet Alert Bot

Watches specific Solana wallet addresses and posts a Discord alert the moment
one of them buys or sells a token. Alert-only — it never touches your funds
or places trades for you.

## How it works

1. Helius (a Solana data provider) watches the wallets you list and sends a
   webhook to this server the instant one of them makes a transaction.
2. This server figures out what was bought/sold and posts a formatted
   message to your Discord channel via a Discord webhook.

---

## Step 1 — Create a Discord webhook (2 minutes)

1. In Discord, go to the channel you want alerts in → **Edit Channel** →
   **Integrations** → **Webhooks** → **New Webhook**.
2. Name it (e.g. "Wallet Alerts"), click **Copy Webhook URL**. Save it —
   you'll paste it into `DISCORD_WEBHOOK_URL` below.

## Step 2 — Create a free Helius account

1. Go to https://www.helius.dev and sign up (free tier is enough to start).
2. Grab your **API key** from the dashboard — you'll need it in Step 4.

## Step 3 — Deploy this server (Railway, free tier)

You need this code running on a public URL so Helius has somewhere to send
webhooks. Railway is the easiest free option:

1. Push this folder to a new GitHub repo (or use Railway's "deploy from
   local folder" option if you don't want to set up GitHub).
2. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**
   → select your repo.
3. In the Railway project, go to **Variables** and add:
   - `DISCORD_WEBHOOK_URL` = (the URL from Step 1)
   - `HELIUS_WEBHOOK_SECRET` = any random string you make up (optional but
     recommended — write it down, you'll need it again in Step 4)
4. Railway will give you a public URL like `https://your-app.up.railway.app`.
   Your webhook endpoint is `https://your-app.up.railway.app/helius-webhook`.

(Render.com works the same way if you'd rather use that instead.)

## Step 4 — Point Helius at your deployed server

1. In the Helius dashboard, go to **Webhooks** → **Create Webhook**.
2. **Webhook URL**: `https://your-app.up.railway.app/helius-webhook`
3. **Webhook Type**: Enhanced
4. **Transaction Type(s)**: SWAP (this covers DEX buys/sells — the thing
   you actually care about)
5. **Account Addresses**: paste in the wallet address(es) you want to track
6. **Auth Header**: paste the same random string you set as
   `HELIUS_WEBHOOK_SECRET` in Step 3 (if you set one)
7. Save.

## Step 5 — Add the wallets you want to track

Edit `wallets.json` in this project:

```json
[
  { "address": "actual_solana_wallet_address_here", "label": "Friend A" },
  { "address": "another_wallet_address", "label": "Trader B" }
]
```

The `label` is just what shows up in your Discord alert — name it whatever
helps you recognize who's who. Push the change (git push, or re-deploy on
Railway) — the wallet list also needs to match what you entered in the
Helius dashboard in Step 4.

## Testing it

Once deployed, visit `https://your-app.up.railway.app/health` in a browser —
you should see `{"ok":true,"trackedWallets":2}` (or however many you added).
That confirms the server is up and reading your wallet list correctly. The
real test is waiting for one of your tracked wallets to actually trade —
you'll see the alert land in Discord within a few seconds.

## Notes and limits

- **This bot only alerts — it never executes a trade.** You still decide
  and click buy/sell yourself, on Axiom or wherever you trade.
- Helius's free tier has usage limits that can change — check your Helius
  dashboard if webhooks stop firing; you may need to upgrade if you're
  tracking many wallets with high trade volume.
- The BUY/SELL detection is a simplified heuristic based on token transfer
  direction. Complex transactions (multi-hop swaps, LP adds/removes) may
  show up as "TRADE" with less detail — the raw transaction link is always
  included so you can verify manually.
- Running 24/7 on Railway's free tier has monthly usage hour limits; if you
  hit them, either upgrade or move to Render's free tier as a backup.
