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
        hide: () => { __log.bubble.push(['hide']); return Promise.resolve(); },
        arm: o => { __log.bubble.push(['arm', o.active]); return Promise.resolve(); },
        status: () => Promise.resolve({ granted: true, pauses: 1, shows: 1, lastError: '' }),
        checkSetup: () => Promise.resolve({ location: true, notifications: true, battery: true, overlay: __log.askedPerm > 0, maker: window.__maker || 'samsung', waze: true, usage: false, autostart: false }),
        addListener: (ev, cb) => { (window.__listeners = window.__listeners || {})[ev] = cb; return Promise.resolve({ remove() {} }); },
        consumeAutostart: () => { const p = !!window.__autoPending; window.__autoPending = false; return Promise.resolve({ pending: p }); },
        toBack: () => { __log.toBack = (__log.toBack || 0) + 1; return Promise.resolve(); },
        openSetting: o => { (__log.opened = __log.opened || []).push(o.what); if (o.what === 'overlay') __log.askedPerm++; return Promise.resolve(); } },
      KeepAwake: { keepAwake: () => { __log.awake++; return Promise.resolve(); }, allowSleep: () => Promise.resolve() } } };
    navigator.geolocation.watchPosition = () => { window.__webGps = true; return 1; };
  });
  let dialogs = 0; page.on('dialog', d => { dialogs++; d.accept(); });
  await page.goto(url); await page.waitForTimeout(600);
  check(await page.isVisible('#ovSetup'), 'premier lancement : l\'écran « Préparer votre téléphone » s\'ouvre');
  check((await page.$$('#setupList .srow')).length === 5 && (await page.$$('#setupList .srow.ok')).length === 3, 'il liste 4 réglages obligatoires, dont 3 déjà faits, plus « Démarrer tout seul avec Waze » (facultatif)');
  await page.click('#setupList .srow:nth-child(3) .tbtn'); await page.waitForTimeout(1500);
  check((await page.evaluate(() => __log.opened)).includes('overlay') && (await page.$$('#setupList .srow.ok')).length === 4, 'toucher « Ouvrir » ouvre le réglage de la bulle, puis la ligne passe en ✓ au retour');
  await page.click('#setupList .srow:nth-child(5) .tbtn'); await page.waitForTimeout(200);
  check((await page.evaluate(() => __log.opened)).includes('usage'), '« Démarrer tout seul avec Waze » : ouvre le réglage « Accès aux données d\'utilisation »');
  check((await page.textContent('#bSetupDone')) === 'C’est prêt', 'tout est fait : le bouton devient « C’est prêt »');
  await page.click('#bSetupDone'); await page.waitForTimeout(300);
  check(!(await page.isVisible('#ovSetup')) && /tout est prêt/.test(await page.textContent('#setupTxt')), 'retour à l\'accueil : « Réglages du téléphone · tout est prêt ✓ »');
  await page.click('#bReal'); await page.waitForTimeout(300);
  const st = await page.evaluate(() => ({ w: __log.watchers, web: !!window.__webGps, awake: __log.awake }));
  check(st.w.length === 1 && !!st.w[0].backgroundMessage, 'le GPS passe par le module « arrière-plan » (avec notification)');
  check(!st.web, 'le GPS du navigateur n\'est pas utilisé dans l\'appli Android');
  check(st.awake === 1, 'l\'écran reste allumé via le module natif');

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
  check(bub.some(b => b[0] === 'show'), 'appli passée derrière Waze : la bulle apparaît');
  check(bub.some(b => b[1] === 'LEVEZ LE PIED' && /m$/.test(b[2] || '')), `la bulle affiche le conseil et la distance (${(bub.find(b => b[1] === 'LEVEZ LE PIED') || []).slice(1).join(' · ') || 'rien'})`);
  check(spoken.some(x => x.hidden), `en arrière-plan, la voix donne le conseil avant le virage (${spoken.map(x => '« ' + x.text + ' »').join(', ') || 'rien'})`);

  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  check((await page.evaluate(() => __log.bubble.filter(b => b[0] !== 'update').at(-1)))[0] === 'hide', 'retour dans l\'appli : la bulle disparaît');
  await page.click('#bEnd'); await page.waitForTimeout(300);
  check((await page.evaluate(() => __log.removed)).includes('w1'), 'fin du trajet : le GPS en arrière-plan s\'arrête (plus de notification)');
  await page.waitForTimeout(300);
  const arms = await page.evaluate(() => __log.bubble.filter(b => b[0] === 'arm').map(b => b[1]));
  check(arms[0] === true && arms.at(-1) === false, 'Android est prévenu du début et de la fin du trajet (il affiche la bulle de lui-même)');
  check(/Bulle : autorisée oui, appli quittée 1 fois, bulle affichée 1 fois/.test(await page.inputValue('#eLog')), 'le journal indique ce qu\'a fait la bulle');
  const jl = await page.inputValue('#eLog');
  check(/Fluidité : \d+ images\/s/.test(jl) && /GPS : \d+ positions, une toutes les [\d,]+ s, vitesse fournie par le GPS 100 %/.test(jl), `le journal mesure la fluidité et le GPS (${(jl.match(/GPS : [^\n]*/) || [''])[0]})`);

  // Simulation : la bulle doit aussi apparaître, et la simulation continuer quand l'appli est cachée
  const sim = await browser.newPage();
  await sim.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(url)) return r.continue();
    if (u.includes('/interpreter')) return r.fulfill({ status: 200, contentType: 'application/json', body: overpass });
    return r.abort(); });
  await sim.addInitScript(({ LAT0, LON0 }) => {
    window.__log = { bubble: [], askedPerm: 0 };
    window.Capacitor = { isNativePlatform: () => true, Plugins: {
      Bubble: { hasPermission: () => Promise.resolve({ granted: __log.askedPerm > 0 }), requestPermission: () => { __log.askedPerm++; return Promise.resolve(); },
        show: o => { __log.bubble.push(['show', o.line1, o.line2]); return Promise.resolve(); },
        update: o => { __log.bubble.push(['update', o.line1, o.line2]); return Promise.resolve(); },
        hide: () => { __log.bubble.push(['hide']); return Promise.resolve(); },
        arm: o => { __log.bubble.push(['arm', o.active]); return Promise.resolve(); },
        status: () => Promise.resolve({ granted: true, pauses: 1, shows: 1, lastError: '' }),
        checkSetup: () => Promise.resolve({ location: true, notifications: true, battery: true, overlay: __log.askedPerm > 0, maker: window.__maker || 'samsung', waze: true, usage: false, autostart: false }),
        addListener: (ev, cb) => { (window.__listeners = window.__listeners || {})[ev] = cb; return Promise.resolve({ remove() {} }); },
        consumeAutostart: () => { const p = !!window.__autoPending; window.__autoPending = false; return Promise.resolve({ pending: p }); },
        toBack: () => { __log.toBack = (__log.toBack || 0) + 1; return Promise.resolve(); },
        openSetting: o => { (__log.opened = __log.opened || []).push(o.what); if (o.what === 'overlay') __log.askedPerm++; return Promise.resolve(); } },
      TextToSpeech: { speak: () => Promise.resolve(), stop: () => Promise.resolve() },
      KeepAwake: { keepAwake: () => Promise.resolve(), allowSleep: () => Promise.resolve() } } };
    navigator.geolocation.getCurrentPosition = ok => ok({ coords: { latitude: LAT0 + 300 / 111320, longitude: LON0 } });
  }, { LAT0, LON0 });
  await sim.addInitScript(() => { window.__maker = 'xiaomi'; });
  await sim.goto(url); await sim.waitForTimeout(600);
  check((await sim.$$('#setupList .srow')).length === 6, 'téléphone Xiaomi : une ligne de plus explique les fenêtres pop-up');
  await sim.click('#bSetupDone'); await sim.waitForTimeout(300);
  check(/2 à faire/.test(await sim.textContent('#setupTxt')), 'accueil : « Réglages du téléphone · 2 à faire » tant que ce n\'est pas fini');
  await sim.click('#bSim'); await sim.waitForTimeout(4000);
  // comme dans l'appli Android : aucun signal « page cachée », l'écran cesse simplement d'être redessiné
  await sim.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await sim.waitForTimeout(6500);
  const sb = await sim.evaluate(() => __log.bubble);
  check(new Set(sb.filter(b => b[0] === 'update').map(b => b.slice(1).join(' '))).size >= 3, `simulation, appli cachée sans signal de la page : la simulation continue et le contenu de la bulle suit (${[...new Set(sb.filter(b => b[0] === 'update').map(b => b.slice(1).join(' ')))].slice(0, 4).join(' → ')})`);
  await sim.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await sim.waitForTimeout(300);

  // Démarrage automatique : Android signale que Waze vient de s'ouvrir
  const auto = await browser.newPage();
  await auto.route('**/*', r => r.request().url().startsWith(url) ? r.continue() : r.abort());
  await auto.addInitScript(() => { window.__log = { bubble: [], watchers: [] }; window.__autoPending = false;
    window.Capacitor = { isNativePlatform: () => true, Plugins: {
      Bubble: { checkSetup: () => Promise.resolve({ location: true, notifications: true, battery: true, overlay: true, maker: 'samsung', waze: true, usage: true, autostart: true }),
        addListener: (ev, cb) => { (window.__listeners = window.__listeners || {})[ev] = cb; return Promise.resolve({ remove() {} }); },
        consumeAutostart: () => { const p = !!window.__autoPending; window.__autoPending = false; return Promise.resolve({ pending: p }); },
        toBack: () => { __log.toBack = (__log.toBack || 0) + 1; return Promise.resolve(); },
        arm: () => Promise.resolve(), update: () => Promise.resolve(), hide: () => Promise.resolve(), show: () => Promise.resolve(),
        status: () => Promise.resolve({ granted: true, pauses: 0, shows: 0, lastError: '' }), hasPermission: () => Promise.resolve({ granted: true }) },
      BackgroundGeolocation: { addWatcher: (o, cb) => { __log.watchers.push(o); return Promise.resolve('w'); }, removeWatcher: () => Promise.resolve() },
      TextToSpeech: { speak: () => Promise.resolve(), stop: () => Promise.resolve() }, KeepAwake: { keepAwake: () => Promise.resolve(), allowSleep: () => Promise.resolve() } } }; });
  await auto.addInitScript(() => { try { localStorage.setItem('pl-setup-seen', '1'); } catch (e) {} });
  await auto.goto(url); await auto.waitForTimeout(600);
  check(!(await auto.isVisible('#drive')), 'démarrage auto : rien ne se passe tant que Waze n\'est pas ouvert');
  await auto.evaluate(() => { window.__autoPending = true; window.__listeners.autostart(); }); await auto.waitForTimeout(2200);
  const au = await auto.evaluate(() => ({ drive: !document.getElementById('drive').hidden, gps: __log.watchers.length, back: __log.toBack || 0 }));
  check(au.drive && au.gps === 1, 'Waze s\'ouvre : le trajet démarre tout seul (GPS en arrière-plan lancé)');
  check(au.back === 1, 'puis Pied Levé se remet derrière Waze');
  await auto.evaluate(() => { window.__autoPending = true; window.__listeners.autostart(); }); await auto.waitForTimeout(500);
  check((await auto.evaluate(() => __log.watchers.length)) === 1, 'trajet déjà en cours : pas de second démarrage');

  await browser.close(); srv.close();
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : l\'appli conseille aussi en arrière-plan');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
