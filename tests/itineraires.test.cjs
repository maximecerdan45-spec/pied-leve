// Test : quand on choisit une destination, l'appli propose le trajet le plus rapide et le plus court en distance.
// Faux serveurs : OSRM (deux variantes, la plus rapide est la plus longue) et Valhalla (option « le plus court »).
// On vérifie aussi le secours : premier serveur OSRM en panne → second serveur ; et le cas où les deux trajets sont identiques.
// Lancement : node tests/itineraires.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const A = { lat: 47.2184, lon: -1.5536 }, B = { lat: 47.26, lon: -1.50 };

function enc(coords, prec) { const f = Math.pow(10, prec); let out = '', pl = 0, plo = 0;
  const e = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lo, la] of coords) { const a = Math.round(la * f), b = Math.round(lo * f); out += e(a - pl) + e(b - plo); pl = a; plo = b; } return out; }
const line = (via) => [[A.lon, A.lat], via, [B.lon, B.lat]];

function serve() { return new Promise(res => { const s = http.createServer((req, rsp) => {
  const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
    if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get PLAN(){return PLAN}};})();</script></body>');
    rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); }); }).listen(0, () => res(s)); }); }

async function run(browser, port, opt) {
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } }); const seen = [];
  await page.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    const json = o => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    if (u.includes('photon.komoot.io')) return json({ features: [{ geometry: { coordinates: [B.lon, B.lat] }, properties: { name: 'Leclerc', city: 'Orvault', osm_value: 'supermarket' } }] });
    if (u.includes('router.project-osrm.org')) { seen.push('osrm1' + (/alternatives=3/.test(u) ? '+alt' : '')); if (opt.osrmDown) return r.fulfill({ status: 502, body: '' });
      if (opt.annot) return json({ code: 'Ok', routes: [{ geometry: { coordinates: line([-1.53, 47.25]) }, distance: 9800, duration: 840, legs: [{ duration: 840, annotation: { distance: [5000, 4800], duration: [225, 615], maxspeed: [{ speed: 110, unit: 'km/h' }, { speed: 50, unit: 'km/h' }] } }] }] });
      if (opt.same) return json({ code: 'Ok', routes: [{ geometry: { coordinates: line([-1.53, 47.25]) }, distance: 9800, duration: 840 }] });
      return json({ code: 'Ok', routes: [{ geometry: { coordinates: line([-1.53, 47.25]) }, distance: 9800, duration: 840 }, { geometry: { coordinates: line([-1.52, 47.24]) }, distance: 8900, duration: 900 }] }); }
    if (u.includes('routing.openstreetmap.de')) { seen.push('osrm2'); return json({ code: 'Ok', routes: [{ geometry: { coordinates: line([-1.53, 47.25]) }, distance: 9800, duration: 840 }] }); }
    if (u.includes('valhalla1.openstreetmap.de')) { const q = JSON.parse(new URL(u).searchParams.get('json')); seen.push('valhalla' + (q.costing_options.auto.shortest ? '+court' : ''));
      if (opt.same) return json({ trip: { legs: [{ shape: enc(line([-1.53, 47.25]), 6) }], summary: { length: 9.75, time: 860 } } });
      return json({ trip: { legs: [{ shape: enc(line([-1.515, 47.235]), 6) }], summary: { length: 7.6, time: 1020 } } }); }
    return r.abort(); });
  await page.addInitScript(A => { navigator.geolocation.getCurrentPosition = ok => setTimeout(() => ok({ coords: { latitude: A.lat, longitude: A.lon, accuracy: 5 } }), 10); navigator.geolocation.watchPosition = () => 1; }, A);
  await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(600);
  await page.fill('#qDest', 'Leclerc Orvault'); await page.waitForSelector('#destRes button', { timeout: 5000 });
  await page.click('#destRes button'); await page.waitForTimeout(800);
  const out = { seen, text: await page.textContent('#destInfo'), opts: await page.$$eval('.ropt', b => b.map(x => [x.textContent, x.getAttribute('aria-pressed')])),
    plan: await page.evaluate(() => { const P = window.__PL.PLAN; return P && { d: P.distance, mode: P.mode, n: P.coords.length, c1: P.coords[1], dur: P.duration }; }) };
  if (out.opts.length === 2) { await page.click('.ropt:nth-child(2)'); out.after = await page.evaluate(() => { const P = window.__PL.PLAN; return { d: P.distance, mode: P.mode, c1: P.coords[1] }; });
    out.pressed = await page.$$eval('.ropt', b => b.map(x => x.getAttribute('aria-pressed'))); out.saved = await page.evaluate(() => localStorage.getItem('pl-route')); }
  await page.close(); return out;
}

(async () => {
  const srv = await serve(), port = srv.address().port, browser = await chromium.launch();
  let failed = 0; const check = (ok, msg) => { console.log((ok ? 'OK    ' : 'ÉCHEC ') + msg); if (!ok) failed++; };
  const a = await run(browser, port, {}), b = await run(browser, port, { osrmDown: true }), c = await run(browser, port, { same: true }), d = await run(browser, port, { same: true, annot: true });
  await browser.close(); srv.close();
  console.log('Choix proposés :', a.opts.map(o => o[0]).join(' | '));
  check(a.seen.includes('osrm1+alt') && a.seen.includes('valhalla+court'), `variantes OSRM et « plus court » Valhalla demandées (${a.seen.join(', ')})`);
  check(a.opts.length === 2 && /Le plus rapide/.test(a.opts[0][0]) && /14 min · 9,8 km≈/.test(a.opts[0][0]) && /Le plus court/.test(a.opts[1][0]) && /17 min · 7,6 km≈/.test(a.opts[1][0]), 'deux choix : le plus rapide (14 min, 9,8 km) et le plus court (7,6 km)');
  check(a.opts.every(o => /≈ \d+,\d\d €/.test(o[0])), 'chaque choix indique le carburant estimé en euros');
  check(a.plan && a.plan.mode === 'rapide' && a.plan.d === 9800 && a.opts[0][1] === 'true', 'le plus rapide est choisi par défaut');
  check(a.after && a.after.mode === 'court' && a.after.d === 7600 && Math.abs(a.after.c1[0] + 1.515) < 1e-5 && Math.abs(a.after.c1[1] - 47.235) < 1e-5, 'toucher « Le plus court » change le trajet (tracé Valhalla décodé correctement)');
  check(a.pressed && a.pressed.join() === 'false,true' && a.saved === 'court', 'le choix est retenu pour les prochains trajets');
  check(b.seen.includes('osrm2') && b.plan && b.plan.d > 0, `premier serveur en panne : le second prend le relais (${b.seen.join(', ')})`);
  check(c.opts.length === 0 && /le plus rapide est aussi le plus court/.test(c.text), `trajets identiques : un seul choix (« ${c.text.slice(0, 80)}… »)`);
  // 5 km de 2×2 voies à 110 : OSRM compte 80 km/h (225 s) ; on compte 95 % de 110 = 104,5 km/h (172 s). En ville (50), durée OSRM gardée.
  check(d.plan && Math.round(d.plan.dur) === Math.round(5000 / (110 * 0.95 / 3.6) + 615), `durée réaliste sur voie rapide : ${d.plan ? Math.round(d.plan.dur) : '?'} s au lieu de 840 s (OSRM)`);
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : le plus rapide et le plus court sont proposés');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
