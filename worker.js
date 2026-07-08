// Vynex Referral Bot v1.1 - Cloudflare Workers + D1
// Features: referral tracking, forced channel join, manual purchase orders, admin approval, rewards, broadcast, support/tutorial.

const VERSION = 'VYNEX_REFERRAL_BOT_V1_1_FORCE_JOIN_OK';

const DEFAULT_PLANS = [
  { id: 'eco50', title: '50GB | 30 روز', price: '100,000 تومان' },
  { id: 'eco100', title: '100GB | 30 روز', price: '200,000 تومان' },
  { id: 'unlim1', title: 'نامحدود یک کاربره | 30 روز', price: '249,000 تومان' },
  { id: 'unlim2', title: 'نامحدود دو کاربره | 30 روز', price: '375,000 تومان' },
];

const REWARDS = [
  { level: 3, title: '10GB رایگان', desc: 'دعوت 3 نفر = 10GB رایگان' },
  { level: 5, title: '20GB رایگان', desc: 'دعوت 5 نفر = 20GB رایگان' },
  { level: 10, title: '50GB رایگان', desc: 'دعوت 10 نفر = 50GB رایگان' },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function html(text, status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function now() { return new Date().toISOString(); }

function safeName(user = {}) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || user.username || String(user.id || 'کاربر');
}

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function adminIds(env) {
  return String(env.ADMIN_IDS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

function isAdmin(env, id) {
  return adminIds(env).includes(String(id));
}

function botUrl(env, method) {
  return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
}

async function tg(env, method, payload) {
  const r = await fetch(botUrl(env, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) console.log('Telegram error', method, data);
  return data;
}

async function send(env, chat_id, text, opts = {}) {
  return tg(env, 'sendMessage', {
    chat_id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...opts,
  });
}

async function answerCb(env, callback_query_id, text = '', show_alert = false) {
  return tg(env, 'answerCallbackQuery', { callback_query_id, text, show_alert });
}

async function edit(env, chat_id, message_id, text, opts = {}) {
  return tg(env, 'editMessageText', {
    chat_id,
    message_id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...opts,
  });
}

function mainKeyboard(isAdm = false) {
  const rows = [
    [{ text: '⚡️ خرید سرویس', callback_data: 'buy' }, { text: '🎁 دریافت رایگان', callback_data: 'free' }],
    [{ text: '👥 دعوت دوستان', callback_data: 'ref' }, { text: '📊 وضعیت دعوت‌ها', callback_data: 'ref_status' }],
    [{ text: '📦 سرویس‌های من', callback_data: 'services' }, { text: '📚 آموزش اتصال', callback_data: 'guide' }],
    [{ text: '🎧 پشتیبانی', callback_data: 'support' }],
  ];
  if (isAdm) rows.push([{ text: '👑 پنل مدیریت', callback_data: 'admin' }]);
  return { inline_keyboard: rows };
}

function backKeyboard() {
  return { inline_keyboard: [[{ text: '⬅️ بازگشت', callback_data: 'home' }]] };
}

function adminKeyboard() {
  return { inline_keyboard: [
    [{ text: '🧾 سفارش‌های در انتظار', callback_data: 'admin_orders' }],
    [{ text: '🎁 درخواست‌های رفرال', callback_data: 'admin_rewards' }],
    [{ text: '📊 آمار ربات', callback_data: 'admin_stats' }],
    [{ text: '📢 ارسال پیام همگانی', callback_data: 'admin_broadcast' }],
    [{ text: '⬅️ بازگشت', callback_data: 'home' }],
  ] };
}

function planKeyboard() {
  const rows = DEFAULT_PLANS.map(p => [{ text: `${p.title} — ${p.price}`, callback_data: `plan:${p.id}` }]);
  rows.push([{ text: '⬅️ بازگشت', callback_data: 'home' }]);
  return { inline_keyboard: rows };
}

async function initDb(env) {
  await env.DB.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  ref_by TEXT,
  pending_ref TEXT DEFAULT '',
  state TEXT DEFAULT '',
  state_data TEXT DEFAULT '',
  is_blocked INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id TEXT NOT NULL,
  referred_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_title TEXT NOT NULL,
  price TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_receipt',
  receipt_file_id TEXT,
  receipt_type TEXT,
  receipt_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reward_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  reward_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claimed_rewards (
  tg_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tg_id, level)
);
CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  created_at TEXT NOT NULL
);
  `);
  await env.DB.prepare("ALTER TABLE users ADD COLUMN pending_ref TEXT DEFAULT ''").run().catch(() => {});
}

async function upsertUser(env, user, refBy = null) {
  const existing = await env.DB.prepare('SELECT tg_id, ref_by FROM users WHERE tg_id=?').bind(String(user.id)).first();
  if (!existing) {
    await env.DB.prepare(`INSERT INTO users (tg_id, username, first_name, last_name, ref_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(String(user.id), user.username || '', user.first_name || '', user.last_name || '', '', now(), now())
      .run();
  } else {
    await env.DB.prepare(`UPDATE users SET username=?, first_name=?, last_name=?, updated_at=? WHERE tg_id=?`)
      .bind(user.username || '', user.first_name || '', user.last_name || '', now(), String(user.id)).run();
  }
}

async function completeReferral(env, user, refBy) {
  if (!refBy || String(refBy) === String(user.id)) return false;
  const referredId = String(user.id);
  const existingRef = await env.DB.prepare('SELECT 1 FROM referrals WHERE referred_id=?').bind(referredId).first();
  if (existingRef) return false;
  const inviter = await env.DB.prepare('SELECT tg_id FROM users WHERE tg_id=?').bind(String(refBy)).first();
  if (!inviter) return false;
  await env.DB.prepare('INSERT OR IGNORE INTO referrals (inviter_id, referred_id, created_at) VALUES (?, ?, ?)')
    .bind(String(refBy), referredId, now()).run();
  await env.DB.prepare('UPDATE users SET ref_by=?, pending_ref=?, updated_at=? WHERE tg_id=?')
    .bind(String(refBy), '', now(), referredId).run();
  await send(env, String(refBy), `🎉 یک نفر با لینک دعوت شما وارد ربات شد و عضو کانال شد.

👤 کاربر جدید: <b>${esc(safeName(user))}</b>`).catch(() => {});
  return true;
}

async function setState(env, tgId, state, data = '') {
  await env.DB.prepare('UPDATE users SET state=?, state_data=?, updated_at=? WHERE tg_id=?')
    .bind(state, data, now(), String(tgId)).run();
}

async function getUser(env, tgId) {
  return env.DB.prepare('SELECT * FROM users WHERE tg_id=?').bind(String(tgId)).first();
}

async function referralCount(env, tgId) {
  const row = await env.DB.prepare('SELECT COUNT(*) c FROM referrals WHERE inviter_id=?').bind(String(tgId)).first();
  return Number(row?.c || 0);
}

async function channelOk(env, tgId) {
  const ch = String(env.CHANNEL_USERNAME || '').trim();
  if (!ch) return true;
  const data = await tg(env, 'getChatMember', { chat_id: ch.startsWith('@') ? ch : '@' + ch, user_id: tgId });
  const st = data?.result?.status;
  return ['creator', 'administrator', 'member'].includes(st);
}

async function requireChannel(env, chatId) {
  const ch = String(env.CHANNEL_USERNAME || '').trim();
  if (!ch) return true;
  const ok = await channelOk(env, chatId).catch(() => false);
  if (ok) return true;
  const channelUrl = `https://t.me/${ch.replace('@','')}`;
  await send(env, chatId, `🔐 <b>عضویت اجباری در کانال</b>

برای استفاده از ربات Vynex اول باید عضو کانال بشی.

بعد از عضویت روی دکمه «عضو شدم» بزن.`, {
    reply_markup: { inline_keyboard: [
      [{ text: '📢 عضویت در کانال Vynex', url: channelUrl }],
      [{ text: '✅ عضو شدم', callback_data: 'check_join' }]
    ] }
  });
  return false;
}

async function home(env, chatId, from, editMsg = null) {
  const text = `⚡️ <b>Vynex Bot</b>\n\nاینترنت سریع و پایدار مخصوص ایرانسل و همراه اول.\n\n🎁 با دعوت دوستات سرویس رایگان بگیر.\n🛒 خرید سرویس هم به صورت دستی ثبت میشه و بعد از تأیید، کانفیگ ارسال میشه.`;
  const opts = { reply_markup: mainKeyboard(isAdmin(env, chatId)) };
  if (editMsg) return edit(env, chatId, editMsg, text, opts);
  return send(env, chatId, text, opts);
}

async function referralPage(env, chatId, editMsg = null) {
  const me = await tg(env, 'getMe', {});
  const botUser = me?.result?.username || 'YourBot';
  const count = await referralCount(env, chatId);
  const link = `https://t.me/${botUser}?start=ref_${chatId}`;
  const text = `👥 <b>دعوت دوستان</b>\n\nلینک اختصاصی شما:\n<code>${link}</code>\n\n🎁 جوایز دعوت:\n• 3 نفر = 10GB رایگان\n• 5 نفر = 20GB رایگان\n• 10 نفر = 50GB رایگان\n\n📊 دعوت‌های موفق شما: <b>${count}</b> نفر`;
  const kb = { inline_keyboard: [
    [{ text: '🎁 درخواست دریافت جایزه', callback_data: 'claim_reward' }],
    [{ text: '⬅️ بازگشت', callback_data: 'home' }]
  ]};
  if (editMsg) return edit(env, chatId, editMsg, text, { reply_markup: kb });
  return send(env, chatId, text, { reply_markup: kb });
}

async function rewardsStatus(env, chatId, editMsg = null) {
  const count = await referralCount(env, chatId);
  let lines = [`📊 <b>وضعیت دعوت‌ها</b>`, ``, `دعوت‌های موفق شما: <b>${count}</b> نفر`, ``];
  for (const r of REWARDS) {
    const claimed = await env.DB.prepare('SELECT 1 FROM claimed_rewards WHERE tg_id=? AND level=?').bind(String(chatId), r.level).first();
    if (claimed) lines.push(`✅ ${r.desc} — دریافت شده`);
    else if (count >= r.level) lines.push(`🎁 ${r.desc} — قابل دریافت`);
    else lines.push(`🔒 ${r.desc} — نیاز به ${r.level - count} دعوت دیگر`);
  }
  const text = lines.join('\n');
  const kb = { inline_keyboard: [[{ text: '🎁 درخواست دریافت جایزه', callback_data: 'claim_reward' }], [{ text: '⬅️ بازگشت', callback_data: 'home' }]] };
  if (editMsg) return edit(env, chatId, editMsg, text, { reply_markup: kb });
  return send(env, chatId, text, { reply_markup: kb });
}

async function requestReward(env, chatId) {
  const count = await referralCount(env, chatId);
  let available = null;
  for (const r of [...REWARDS].reverse()) {
    const claimed = await env.DB.prepare('SELECT 1 FROM claimed_rewards WHERE tg_id=? AND level=?').bind(String(chatId), r.level).first();
    if (count >= r.level && !claimed) { available = r; break; }
  }
  if (!available) return send(env, chatId, 'فعلاً جایزه قابل دریافت نداری یا قبلاً دریافتش کردی.', { reply_markup: backKeyboard() });
  const existing = await env.DB.prepare('SELECT id FROM reward_requests WHERE tg_id=? AND level=? AND status=?')
    .bind(String(chatId), available.level, 'pending').first();
  if (existing) return send(env, chatId, 'درخواست جایزه شما قبلاً ثبت شده و منتظر بررسیه.', { reply_markup: backKeyboard() });
  const res = await env.DB.prepare(`INSERT INTO reward_requests (tg_id, level, reward_title, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)`)
    .bind(String(chatId), available.level, available.title, now(), now()).run();
  const id = res.meta.last_row_id;
  await send(env, chatId, `🎁 درخواست جایزه <b>${available.title}</b> ثبت شد.\n\nبعد از بررسی ادمین، کانفیگ برات ارسال میشه.`, { reply_markup: backKeyboard() });
  for (const admin of adminIds(env)) {
    await send(env, admin, `🎁 <b>درخواست جایزه رفرال</b>\n\nکاربر: <code>${chatId}</code>\nدعوت موفق: <b>${count}</b> نفر\nجایزه: <b>${available.title}</b>`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ ارسال شد', callback_data: `rw_ok:${id}` },
        { text: '❌ رد', callback_data: `rw_no:${id}` },
      ], [{ text: '📨 ارسال پیام/کانفیگ', callback_data: `sendto:${chatId}` }]] }
    });
  }
}

async function buyPage(env, chatId, editMsg = null) {
  const text = `⚡️ <b>خرید سرویس Vynex</b>\n\nپلن موردنظرت رو انتخاب کن. بعد از پرداخت و ارسال رسید، ادمین بررسی می‌کنه و کانفیگ رو دستی برات می‌فرسته.`;
  if (editMsg) return edit(env, chatId, editMsg, text, { reply_markup: planKeyboard() });
  return send(env, chatId, text, { reply_markup: planKeyboard() });
}

async function selectPlan(env, chatId, planId) {
  const p = DEFAULT_PLANS.find(x => x.id === planId);
  if (!p) return send(env, chatId, 'پلن پیدا نشد.', { reply_markup: backKeyboard() });
  const res = await env.DB.prepare(`INSERT INTO orders (tg_id, plan_id, plan_title, price, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'awaiting_receipt', ?, ?)`)
    .bind(String(chatId), p.id, p.title, p.price, now(), now()).run();
  await setState(env, chatId, 'awaiting_receipt', String(res.meta.last_row_id));
  const card = String(env.CARD_TEXT || 'شماره کارت هنوز تنظیم نشده است.').trim();
  return send(env, chatId, `🧾 <b>ثبت سفارش</b>\n\nپلن: <b>${esc(p.title)}</b>\nمبلغ: <b>${esc(p.price)}</b>\n\nبرای تکمیل خرید، مبلغ را واریز کن و رسید را همینجا ارسال کن.\n\n${esc(card)}`, { reply_markup: backKeyboard() });
}

async function handleReceipt(env, msg, user) {
  const orderId = user.state_data;
  const order = await env.DB.prepare('SELECT * FROM orders WHERE id=? AND tg_id=? AND status=?')
    .bind(orderId, String(msg.from.id), 'awaiting_receipt').first();
  if (!order) return false;
  let fileId = '', type = 'text', text = msg.text || msg.caption || '';
  if (msg.photo?.length) { fileId = msg.photo[msg.photo.length - 1].file_id; type = 'photo'; }
  else if (msg.document) { fileId = msg.document.file_id; type = 'document'; }
  await env.DB.prepare(`UPDATE orders SET receipt_file_id=?, receipt_type=?, receipt_text=?, status='pending', updated_at=? WHERE id=?`)
    .bind(fileId, type, text, now(), order.id).run();
  await setState(env, msg.from.id, '', '');
  await send(env, msg.chat.id, '✅ رسید ثبت شد. بعد از تأیید ادمین، کانفیگ برات ارسال میشه.', { reply_markup: mainKeyboard(isAdmin(env, msg.from.id)) });

  for (const admin of adminIds(env)) {
    await send(env, admin, `🧾 <b>سفارش جدید</b>\n\nشماره سفارش: <code>${order.id}</code>\nکاربر: <code>${msg.from.id}</code>\nیوزرنیم: ${msg.from.username ? '@' + esc(msg.from.username) : '-'}\nپلن: <b>${esc(order.plan_title)}</b>\nمبلغ: <b>${esc(order.price)}</b>\n\nمتن رسید: ${esc(text || '-')}`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ تأیید پرداخت', callback_data: `ord_ok:${order.id}` },
        { text: '❌ رد پرداخت', callback_data: `ord_no:${order.id}` },
      ], [{ text: '📨 ارسال پیام/کانفیگ', callback_data: `sendto:${msg.from.id}` }]] }
    });
    if (fileId && type === 'photo') await tg(env, 'sendPhoto', { chat_id: admin, photo: fileId, caption: `رسید سفارش #${order.id}` });
    if (fileId && type === 'document') await tg(env, 'sendDocument', { chat_id: admin, document: fileId, caption: `رسید سفارش #${order.id}` });
  }
  return true;
}

async function guide(env, chatId, editMsg = null) {
  const text = `📚 <b>آموزش اتصال</b>\n\n1) برنامه Hiddify یا V2RayNG رو نصب کن.\n2) لینک اشتراک/ساب رو کپی کن.\n3) داخل برنامه گزینه Import from clipboard یا Add subscription رو بزن.\n4) کانفیگ مناسب اپراتورت رو انتخاب کن.\n\nبرای ایرانسل: Vynex | Irancell\nبرای همراه اول: Vynex | Hamrah`;
  if (editMsg) return edit(env, chatId, editMsg, text, { reply_markup: backKeyboard() });
  return send(env, chatId, text, { reply_markup: backKeyboard() });
}

async function support(env, chatId, editMsg = null) {
  const s = String(env.SUPPORT_USERNAME || '@realstevennn');
  const text = `🎧 <b>پشتیبانی Vynex</b>\n\nبرای خرید، مشکل اتصال یا دریافت کانفیگ با پشتیبانی پیام بده:\n${esc(s)}`;
  const kb = { inline_keyboard: [[{ text: 'پیام به پشتیبانی', url: `https://t.me/${s.replace('@','')}` }], [{ text: '⬅️ بازگشت', callback_data: 'home' }]] };
  if (editMsg) return edit(env, chatId, editMsg, text, { reply_markup: kb });
  return send(env, chatId, text, { reply_markup: kb });
}

async function services(env, chatId, editMsg = null) {
  const text = `📦 <b>سرویس‌های من</b>\n\nفعلاً سرویس‌ها به صورت دستی توسط ادمین ارسال میشن.\nکانفیگ‌هایی که دریافت کردی رو داخل همین چت نگه دار.\n\nبعداً نمایش خودکار حجم و تاریخ انقضا اضافه میشه.`;
  if (editMsg) return edit(env, chatId, editMsg, text, { reply_markup: backKeyboard() });
  return send(env, chatId, text, { reply_markup: backKeyboard() });
}

async function adminStats(env, chatId, editMsg = null) {
  const u = await env.DB.prepare('SELECT COUNT(*) c FROM users').first();
  const o = await env.DB.prepare("SELECT COUNT(*) c FROM orders WHERE status='pending'").first();
  const r = await env.DB.prepare("SELECT COUNT(*) c FROM reward_requests WHERE status='pending'").first();
  const refs = await env.DB.prepare('SELECT COUNT(*) c FROM referrals').first();
  const text = `📊 <b>آمار ربات</b>\n\n👥 کاربران: <b>${u?.c || 0}</b>\n👥 دعوت‌ها: <b>${refs?.c || 0}</b>\n🧾 سفارش‌های در انتظار: <b>${o?.c || 0}</b>\n🎁 درخواست‌های جایزه: <b>${r?.c || 0}</b>`;
  if (editMsg) return edit(env, chatId, editMsg, text, { reply_markup: adminKeyboard() });
  return send(env, chatId, text, { reply_markup: adminKeyboard() });
}

async function listPendingOrders(env, chatId) {
  const rows = await env.DB.prepare("SELECT * FROM orders WHERE status='pending' ORDER BY id DESC LIMIT 10").all();
  if (!rows.results.length) return send(env, chatId, 'سفارش در انتظار نداریم.', { reply_markup: adminKeyboard() });
  for (const o of rows.results) {
    await send(env, chatId, `🧾 سفارش #${o.id}\nکاربر: <code>${o.tg_id}</code>\nپلن: <b>${esc(o.plan_title)}</b>\nمبلغ: <b>${esc(o.price)}</b>`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ تأیید', callback_data: `ord_ok:${o.id}` },
        { text: '❌ رد', callback_data: `ord_no:${o.id}` }
      ], [{ text: '📨 ارسال پیام/کانفیگ', callback_data: `sendto:${o.tg_id}` }]] }
    });
  }
}

async function listPendingRewards(env, chatId) {
  const rows = await env.DB.prepare("SELECT * FROM reward_requests WHERE status='pending' ORDER BY id DESC LIMIT 10").all();
  if (!rows.results.length) return send(env, chatId, 'درخواست جایزه در انتظار نداریم.', { reply_markup: adminKeyboard() });
  for (const r of rows.results) {
    const count = await referralCount(env, r.tg_id);
    await send(env, chatId, `🎁 درخواست #${r.id}\nکاربر: <code>${r.tg_id}</code>\nدعوت موفق: <b>${count}</b>\nجایزه: <b>${esc(r.reward_title)}</b>`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ ارسال شد', callback_data: `rw_ok:${r.id}` },
        { text: '❌ رد', callback_data: `rw_no:${r.id}` }
      ], [{ text: '📨 ارسال پیام/کانفیگ', callback_data: `sendto:${r.tg_id}` }]] }
    });
  }
}

async function handleAdminText(env, msg, user) {
  const text = msg.text || '';
  if (!isAdmin(env, msg.from.id)) return false;
  if (text.startsWith('/send ')) {
    const parts = text.split(' ');
    const target = parts[1];
    const body = text.slice(('/send ' + target + ' ').length).trim();
    if (!target || !body) return send(env, msg.chat.id, 'فرمت درست:\n/send USER_ID متن یا لینک کانفیگ');
    await send(env, target, `📩 <b>پیام از Vynex</b>\n\n${esc(body)}`);
    return send(env, msg.chat.id, '✅ ارسال شد.');
  }
  if (text.startsWith('/broadcast ')) {
    const body = text.slice('/broadcast '.length).trim();
    if (!body) return send(env, msg.chat.id, 'فرمت درست:\n/broadcast متن پیام');
    const users = await env.DB.prepare('SELECT tg_id FROM users LIMIT 5000').all();
    let ok = 0;
    for (const u of users.results) {
      const r = await send(env, u.tg_id, `📢 <b>اطلاعیه Vynex</b>\n\n${esc(body)}`).catch(() => null);
      if (r?.ok) ok++;
    }
    return send(env, msg.chat.id, `✅ پیام همگانی ارسال شد.\nموفق: ${ok}/${users.results.length}`);
  }
  const st = user?.state;
  if (st === 'admin_sendto') {
    const target = user.state_data;
    if (msg.text) await send(env, target, `📩 <b>پیام از Vynex</b>\n\n${esc(msg.text)}`);
    if (msg.photo?.length) await tg(env, 'sendPhoto', { chat_id: target, photo: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption || '' });
    if (msg.document) await tg(env, 'sendDocument', { chat_id: target, document: msg.document.file_id, caption: msg.caption || '' });
    await setState(env, msg.from.id, '', '');
    return send(env, msg.chat.id, '✅ برای کاربر ارسال شد.');
  }
  if (st === 'admin_broadcast') {
    const body = msg.text || msg.caption || '';
    if (!body && !msg.photo && !msg.document) return send(env, msg.chat.id, 'یه متن یا فایل برای ارسال همگانی بفرست.');
    const users = await env.DB.prepare('SELECT tg_id FROM users LIMIT 5000').all();
    let ok = 0;
    for (const u of users.results) {
      let r = null;
      if (msg.photo?.length) r = await tg(env, 'sendPhoto', { chat_id: u.tg_id, photo: msg.photo[msg.photo.length - 1].file_id, caption: body }).catch(() => null);
      else if (msg.document) r = await tg(env, 'sendDocument', { chat_id: u.tg_id, document: msg.document.file_id, caption: body }).catch(() => null);
      else r = await send(env, u.tg_id, `📢 <b>اطلاعیه Vynex</b>\n\n${esc(body)}`).catch(() => null);
      if (r?.ok) ok++;
    }
    await setState(env, msg.from.id, '', '');
    return send(env, msg.chat.id, `✅ ارسال همگانی انجام شد.\nموفق: ${ok}/${users.results.length}`);
  }
  return false;
}

async function handleCallback(env, cq) {
  const data = cq.data || '';
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const uid = cq.from.id;
  await upsertUser(env, cq.from, null);
  await answerCb(env, cq.id);

  if (data === 'check_join') {
    const ok = await channelOk(env, uid).catch(() => false);
    if (!ok) return answerCb(env, cq.id, 'هنوز عضو کانال نشدی.', true);
    const user = await getUser(env, uid);
    if (user?.pending_ref) await completeReferral(env, cq.from, user.pending_ref);
    await answerCb(env, cq.id, 'عضویت تأیید شد ✅');
    return home(env, chatId, cq.from, msgId);
  }

  if (!(await requireChannel(env, uid))) return;

  if (data === 'home') return home(env, chatId, cq.from, msgId);
  if (data === 'buy') return buyPage(env, chatId, msgId);
  if (data === 'free' || data === 'ref') return referralPage(env, chatId, msgId);
  if (data === 'ref_status') return rewardsStatus(env, chatId, msgId);
  if (data === 'claim_reward') return requestReward(env, uid);
  if (data === 'services') return services(env, chatId, msgId);
  if (data === 'guide') return guide(env, chatId, msgId);
  if (data === 'support') return support(env, chatId, msgId);
  if (data.startsWith('plan:')) return selectPlan(env, uid, data.split(':')[1]);

  if (data === 'admin') {
    if (!isAdmin(env, uid)) return answerCb(env, cq.id, 'دسترسی نداری.', true);
    return edit(env, chatId, msgId, '👑 <b>پنل مدیریت Vynex</b>', { reply_markup: adminKeyboard() });
  }
  if (!isAdmin(env, uid)) return;

  if (data === 'admin_orders') return listPendingOrders(env, chatId);
  if (data === 'admin_rewards') return listPendingRewards(env, chatId);
  if (data === 'admin_stats') return adminStats(env, chatId, msgId);
  if (data === 'admin_broadcast') {
    await setState(env, uid, 'admin_broadcast', '');
    return send(env, chatId, '📢 متن یا عکس/فایل پیام همگانی رو بفرست.');
  }
  if (data.startsWith('sendto:')) {
    const target = data.split(':')[1];
    await setState(env, uid, 'admin_sendto', target);
    return send(env, chatId, `پیام یا کانفیگ را بفرست تا برای کاربر <code>${target}</code> ارسال شود.`);
  }
  if (data.startsWith('ord_ok:') || data.startsWith('ord_no:')) {
    const [act, id] = data.split(':');
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
    if (!order) return send(env, chatId, 'سفارش پیدا نشد.');
    const status = act === 'ord_ok' ? 'approved' : 'rejected';
    await env.DB.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').bind(status, now(), id).run();
    if (status === 'approved') {
      await send(env, order.tg_id, `✅ پرداخت شما تأیید شد.\n\nپلن: <b>${esc(order.plan_title)}</b>\n\nکانفیگ به‌زودی توسط پشتیبانی ارسال میشه.`);
      await send(env, chatId, '✅ سفارش تأیید شد. برای ارسال کانفیگ از دکمه ارسال پیام/کانفیگ استفاده کن.');
    } else {
      await send(env, order.tg_id, '❌ پرداخت شما رد شد. برای پیگیری با پشتیبانی پیام بده.');
      await send(env, chatId, '❌ سفارش رد شد.');
    }
    return;
  }
  if (data.startsWith('rw_ok:') || data.startsWith('rw_no:')) {
    const [act, id] = data.split(':');
    const rr = await env.DB.prepare('SELECT * FROM reward_requests WHERE id=?').bind(id).first();
    if (!rr) return send(env, chatId, 'درخواست پیدا نشد.');
    const status = act === 'rw_ok' ? 'sent' : 'rejected';
    await env.DB.prepare('UPDATE reward_requests SET status=?, updated_at=? WHERE id=?').bind(status, now(), id).run();
    if (status === 'sent') {
      await env.DB.prepare('INSERT OR IGNORE INTO claimed_rewards (tg_id, level, created_at) VALUES (?, ?, ?)')
        .bind(rr.tg_id, rr.level, now()).run();
      await send(env, rr.tg_id, `🎁 جایزه <b>${esc(rr.reward_title)}</b> برای شما تأیید شد.\n\nکانفیگ توسط پشتیبانی ارسال میشه.`);
      await send(env, chatId, '✅ جایزه تأیید/ارسال شد.');
    } else {
      await send(env, rr.tg_id, '❌ درخواست جایزه شما رد شد. برای پیگیری با پشتیبانی پیام بده.');
      await send(env, chatId, '❌ درخواست رد شد.');
    }
    return;
  }
}

async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  await upsertUser(env, from, null);
  let user = await getUser(env, from.id);

  if (msg.text?.startsWith('/start')) {
    const payload = msg.text.split(' ')[1] || '';
    const m = payload.match(/^ref_(\d+)$/);
    if (m && String(m[1]) !== String(from.id)) {
      await env.DB.prepare('UPDATE users SET pending_ref=?, updated_at=? WHERE tg_id=?')
        .bind(String(m[1]), now(), String(from.id)).run();
      user = await getUser(env, from.id);
    }
    if (!(await requireChannel(env, chatId))) return;
    if (m) await completeReferral(env, from, m[1]);
    else if (user?.pending_ref) await completeReferral(env, from, user.pending_ref);
    return home(env, chatId, from);
  }

  if (!(await requireChannel(env, chatId))) return;

  if (await handleAdminText(env, msg, user)) return;
  if (await handleReceipt(env, msg, user)) return;

  if (msg.text === '/admin' && isAdmin(env, from.id)) return send(env, chatId, '👑 پنل مدیریت Vynex', { reply_markup: adminKeyboard() });
  if (msg.text === '/buy') return buyPage(env, chatId);
  if (msg.text === '/ref') return referralPage(env, chatId);

  return home(env, chatId, from);
}

async function handleUpdate(env, update) {
  if (update.callback_query) return handleCallback(env, update.callback_query);
  if (update.message) return handleMessage(env, update.message);
}

export default {
  async fetch(request, env, ctx) {
    if (!env.BOT_TOKEN) return json({ ok: false, error: 'BOT_TOKEN is missing' }, 500);
    await initDb(env);
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (url.pathname === '/health') return json({ ok: true, version: VERSION });
      if (url.pathname === '/set-webhook') {
        const secret = url.searchParams.get('secret');
        if (!env.SETUP_SECRET || secret !== env.SETUP_SECRET) return json({ ok: false, error: 'bad secret' }, 403);
        const webhookUrl = `${url.origin}/webhook`;
        const data = await tg(env, 'setWebhook', { url: webhookUrl, allowed_updates: ['message', 'callback_query'] });
        return json({ ok: true, webhookUrl, telegram: data, version: VERSION });
      }
      return html(`<h2>Vynex Referral Bot v1.1</h2><p>${VERSION}</p><p>Forced channel join is enabled when CHANNEL_USERNAME is set.</p><p>Use /set-webhook?secret=YOUR_SECRET once.</p>`);
    }

    if (request.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/')) {
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(env, update).catch(e => console.log('update error', e.stack || e.message)));
      return json({ ok: true });
    }

    return json({ ok: false, error: 'not found' }, 404);
  }
};
