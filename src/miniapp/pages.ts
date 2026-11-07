/** Telegram Mini App pages served by the Worker. Self-contained HTML, themed with Telegram's colors. */

const shell = (title: string, body: string, script: string, extraHead = "") => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
${extraHead}
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 20px 16px; font: 16px/1.4 -apple-system, system-ui, sans-serif;
    background: var(--tg-theme-bg-color, #fff); color: var(--tg-theme-text-color, #111); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.hint { color: var(--tg-theme-hint-color, #888); font-size: 14px; margin: 0 0 20px; }
  label { display: block; font-size: 14px; margin: 14px 0 6px; color: var(--tg-theme-hint-color, #666); }
  input { width: 100%; box-sizing: border-box; padding: 12px; font-size: 16px; border-radius: 10px;
    border: 1px solid var(--tg-theme-hint-color, #ccc); background: var(--tg-theme-secondary-bg-color, #f4f4f5);
    color: inherit; }
  button { width: 100%; margin-top: 22px; padding: 14px; font-size: 16px; font-weight: 600; border: 0; border-radius: 10px;
    background: var(--tg-theme-button-color, #2481cc); color: var(--tg-theme-button-text-color, #fff); }
  button:disabled { opacity: .5; }
  #msg { margin-top: 16px; min-height: 1.4em; }
  .err { color: #e53935; } .ok { color: #2e7d32; }
  #payment { margin-top: 16px; }
</style></head><body>${body}<script>${script}</script></body></html>`;

export const loginPage = () =>
  shell(
    "Connect Inflow",
    `<h1>Connect Inflow</h1>
<p class="hint">Your inflowparking.com login. The password is encrypted and only used to book for you. /settings → Logout wipes it.</p>
<form id="f">
  <label for="email">Email</label><input id="email" type="email" autocomplete="username" required>
  <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
  <button id="go" type="submit">Connect</button>
</form><div id="msg"></div>`,
    `const tg = window.Telegram.WebApp; tg.ready(); tg.expand();
const msg = (t, c) => { const m = document.getElementById('msg'); m.textContent = t; m.className = c || ''; };
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = document.getElementById('go'); go.disabled = true; msg('Checking with Inflow…');
  try {
    const r = await fetch('/miniapp/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData, email: document.getElementById('email').value.trim(), password: document.getElementById('pw').value }) });
    const j = await r.json();
    if (j.ok) { msg('✅ Connected! Back to the chat…', 'ok'); setTimeout(() => tg.close(), 1200); }
    else { msg(j.error || 'Login failed', 'err'); go.disabled = false; }
  } catch (err) { msg('Network error — try again.', 'err'); go.disabled = false; }
});`,
  );

export const payPage = () =>
  shell(
    "Finish payment",
    `<h1>Finish payment</h1><p class="hint" id="label">Loading…</p>
<div id="timer"></div><div id="payment"></div>
<button id="go" disabled>Pay</button><div id="msg"></div>`,
    `const tg = window.Telegram.WebApp; tg.ready(); tg.expand();
const t = new URLSearchParams(location.search).get('t');
const msg = (x, c) => { const m = document.getElementById('msg'); m.textContent = x; m.className = c || ''; };
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ initData: tg.initData, t, ...body }) }).then(r => r.json());
(async () => {
  const info = await post('/miniapp/pay/info', {});
  if (!info.ok) { document.getElementById('label').textContent = info.error || 'This hold has expired.'; return; }
  document.getElementById('label').textContent = info.label + ' · $' + info.amount;
  const tick = () => { const s = Math.max(0, Math.round((info.holdUntil - Date.now()) / 1000));
    document.getElementById('timer').textContent = '⏳ Hold expires in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  tick(); setInterval(tick, 1000);
  const stripe = Stripe(info.publishableKey);
  const done = async () => { msg('Confirming with Inflow…'); const r = await post('/miniapp/pay/done', {});
    if (r.ok) { msg('🎉 Booked! Back to the chat…', 'ok'); setTimeout(() => tg.close(), 1500); } else msg('Paid, but Inflow has not confirmed yet — check /bookings in a minute.', 'err'); };
  const retrieve = info.setup ? stripe.retrieveSetupIntent(info.clientSecret) : stripe.retrievePaymentIntent(info.clientSecret);
  const intent = (await retrieve)[info.setup ? 'setupIntent' : 'paymentIntent'];
  if (intent && intent.status === 'succeeded') return done();
  if (intent && intent.status === 'requires_action') {
    msg('Verifying with your bank…');
    const r = await stripe.handleNextAction({ clientSecret: info.clientSecret });
    if (r.error) msg(r.error.message, 'err'); else return done();
  }
  const opts = { clientSecret: info.clientSecret, appearance: { theme: tg.colorScheme === 'dark' ? 'night' : 'stripe' } };
  if (info.customerSessionClientSecret) opts.customerSessionClientSecret = info.customerSessionClientSecret;
  const elements = stripe.elements(opts);
  elements.create('payment').mount('#payment');
  const go = document.getElementById('go'); go.disabled = false; go.textContent = 'Pay $' + info.amount;
  go.addEventListener('click', async () => {
    go.disabled = true; msg('Paying…');
    const fn = info.setup ? stripe.confirmSetup : stripe.confirmPayment;
    const r = await fn.call(stripe, { elements, redirect: 'if_required', confirmParams: { return_url: location.href } });
    if (r.error) { msg(r.error.message, 'err'); go.disabled = false; } else done();
  });
})();`,
    `<script src="https://js.stripe.com/v3/"></script>`,
  );
