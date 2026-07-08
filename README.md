# Vynex Referral Bot v1.1 Force Join

Cloudflare Worker Telegram bot with referral tracking, manual orders, force channel join, and admin tools.

## Required environment variables

- `BOT_TOKEN`
- `ADMIN_IDS`
- `SETUP_SECRET`
- `CHANNEL_USERNAME`
- `CARD_TEXT`
- `SUPPORT_USERNAME`

## Required D1 binding

Create a D1 database, then bind it to this Worker with binding name:

```text
DB
```

## Health

`/health` should return:

```text
VYNEX_REFERRAL_BOT_V1_1_FORCE_JOIN_OK
```

## Webhook

Open:

```text
https://YOUR-WORKER.workers.dev/set-webhook?secret=YOUR_SETUP_SECRET
```
