// Test : l'appli Android continue-t-elle à conseiller quand elle est en arrière-plan (Waze devant) ?
// On simule l'appli Android (modules natifs factices), une route avec un virage, et un GPS
// qui envoie une position par seconde pendant que l'appli est cachée et que l'écran n'est plus redessiné.
// Lancement : node tests/arriere-plan.test.cjs
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const DIR = path.join(__dirname, '..');
const LAT0 = 47.2184, LON0 = -1.5536, V = 14;
const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const R = []; for (let y = 0; y <= 1000; y += 10) R.push([0, y]);
for (let a = 5; a <= 90; a += 5) { const r = a * Math.PI / 180; R.push([40 - 40 * Math.cos(r), 1000 + 40 * Math.sin(r)]); }
for (let x = 50; x <= 1040; x += 10) R.push([x, 1040]);
const overpass = JSON.stringify({ elements: [{ type: 'way', id: 1, nodes: R.map((_, i) => 1000 + i),
  geometry: R.map(([x, y]) => ({ lat: LAT0 + y * mLat, lon: LON0 + x * mLon })), tags: { highway: 'primary', maxspeed: '50' } }] });

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'OK   ' : 'ÉCHEC'} ${msg}`); if (!ok) failed++; };

(async () => {
  const srv = http.createServer((req, rsp) => {
    const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); } rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); });
  });
  await new Promise(r => srv.listen(0, r)); const url = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch(); const page = await browser.newPage();
  await page.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(url)) return r.continue();
    if (u.includes('/interpreter')) return r.fulfill({ status: 200, contentType: 'application/json', body: overpass });
    return r.abort(); });
  // Appli Android factice : GPS en arrière-plan, voix et écran allumé natifs
  await page.addInitScript(() => {
    window.__log = { spoken: [], watchers: [], removed: [], awake: 0, bubble: [], askedPerm: 0 };
    window.Capacitor = { isNativePlatform: () => true, Plugins: {
      BackgroundGeolocation: {
        addWatcher: (opts, cb) => { __log.watchers.push(opts); window.__gps = cb; return Promise.resolve('w1'); },
        removeWatcher: ({ id }) => { __log.removed.push(id); return Promise.resolve(); },
        openSettings: () => Promise.resolve() },
      TextToSpeech: { speak: o => { __log.spoken.push({ text: o.text, hidden: document.hidden }); return Promise.resolve(); }, stop: () => Promise.resolve() },
      Bubble: { hasPermission: () => Promise.resolve({ granted: __log.askedPerm > 0 }), requestPermission: () => { __log.askedPerm++; return Promise.resolve(); },
        show: o => { __log.bubble.push(['show', o.line1, o.line2]); return Promise.resolve(); },
        update: o => { __log.bubble.push(['update', o.line1, o.line2]); return Promise.resolve(); },
        hide: () => { __log.bubble.push(['hide']); return Promise.resolve(); } },
      KeepAwake: { keepAwake: () => { __log.awake++; return Promise.resolve(); }, allowSleep: () => Promise.resolve() } } };
    navigator.geolocation.watchPosition = () => { window.__webGps = true; return 1; };
  });
  let dialogs = 0; page.on('dialog', d => { dialogs++; d.accept(); });
  await page.goto(url); await page.waitForTimeout(500);
  await page.click('#bReal'); await page.waitForTimeout(300);
  const st = await page.evaluate(() => ({ w: __log.watchers, web: !!window.__webGps, awake: __log.awake }));
  check(st.w.length === 1 && !!st.w[0].backgroundMessage, 'le GPS passe par le module « arrière-plan » (avec notification)');
  check(!st.web, 'le GPS du navigateur n\'est pas utilisé dans l\'appli Android');
  check(st.awake === 1, 'l\'écran reste allumé via le module natif');
  check(dialogs === 1 && (await page.evaluate(() => __log.askedPerm)) === 1, 'au départ : l\'appli propose d\'autoriser la bulle et ouvre le réglage Android');

  // Quelques positions au premier plan, puis l'appli passe derrière Waze
  const fix = s => { const y = Math.min(s, 1000); return { latitude: LAT0 + y * mLat, longitude: LON0, accuracy: 5, speed: V, bearing: 0, time: Date.now() }; };
  let s = 600;
  for (let k = 0; k < 3; k++, s += V) { await page.evaluate(f => __gps(f), fix(s)); await page.waitForTimeout(1000); }
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    window.requestAnimationFrame = () => 0; // en arrière-plan, l'écran n'est plus redessiné
    document.dispatchEvent(new Event('visibilitychange')); __log.spoken = [];
  });
  for (; s < 990; s += V) { await page.evaluate(f => __gps(f), fix(s)); await page.waitForTimeout(150); }
  const spoken = await page.evaluate(() => __log.spoken);
  const bub = await page.evaluate(() => __log.bubble);
  check(bub.length && bub[0][0] === 'show', 'appli passée derrière Waze : la bulle apparaît');
  check(bub.some(b => b[1] === 'LEVEZ LE PIED' && /m$/.test(b[2] || '')), `la bulle affiche le conseil et la distance (${(bub.find(b => b[1] === 'LEVEZ LE PIED') || []).slice(1).join(' · ') || 'rien'})`);
  check(spoken.some(x => x.hidden), `en arrière-plan, la voix donne le conseil avant le virage (${spoken.map(x => '« ' + x.text + ' »').join(', ') || 'rien'})`);

  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  check((await page.evaluate(() => __log.bubble.at(-1)))[0] === 'hide', 'retour dans l\'appli : la bulle disparaît');
  await page.click('#bEnd'); await page.waitForTimeout(300);
  check((await page.evaluate(() => __log.removed)).includes('w1'), 'fin du trajet : le GPS en arrière-plan s\'arrête (plus de notification)');

  await browser.close(); srv.close();
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : l\'appli conseille aussi en arrière-plan');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
