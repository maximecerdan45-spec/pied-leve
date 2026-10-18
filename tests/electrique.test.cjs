// Test : mode véhicule électrique (menu « Ma voiture »).
// Vérifie : réglage retenu, bouton pompe devenu bornes, liste des bornes (OpenStreetMap) avec puissance et prises,
// cagnotte en kWh et en euros (0,30 €/kWh), récupération plus forte (on lève le pied plus près de l'obstacle),
// annonce vocale adaptée, coût du trajet en électricité.
// Lancement : node tests/electrique.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const LAT0 = 47.2184, LON0 = -1.5536, mLat = 1 / 111320;
const chargers = { elements: [
  { type: 'node', id: 1, lat: LAT0 + 800 * mLat, lon: LON0, tags: { amenity: 'charging_station', name: 'Ionity Orvault', 'socket:type2_combo': '4', 'socket:type2_combo:output': '350 kW', capacity: '4' } },
  { type: 'way', id: 2, center: { lat: LAT0 + 2500 * mLat, lon: LON0 }, tags: { amenity: 'charging_station', operator: 'Izivia', 'socket:type2': '2', 'socket:type2:output': '22 kW', capacity: '2' } }] };

function serve() { return new Promise(res => { const s = http.createServer((req, rsp) => {
  const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
    if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S},ecoStep,coastDist,routeLitres,voiceTxt,PRICE};})();</script></body>');
    rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); }); }).listen(0, () => res(s)); }); }

(async () => {
  const srv = await serve(), port = srv.address().port, browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let failed = 0; const check = (ok, msg) => { console.log((ok ? 'OK    ' : 'ÉCHEC ') + msg); if (!ok) failed++; };
  await page.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    if (u.includes('/interpreter') && /charging_station/.test(decodeURIComponent(u))) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(chargers) });
    return r.abort(); });
  await page.addInitScript(({ LAT0, LON0 }) => { navigator.geolocation.getCurrentPosition = ok => setTimeout(() => ok({ coords: { latitude: LAT0, longitude: LON0, accuracy: 5 } }), 5); navigator.geolocation.watchPosition = () => 1; }, { LAT0, LON0 });
  await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(600);
  const before = await page.evaluate(() => ({ d: window.__PL.coastDist(13.9, 8.33), cost: window.__PL.routeLitres({ distance: 20000, duration: 1200 }) * window.__PL.PRICE }));
  await page.click('#bMenu'); await page.click('#bEnergy');
  check(await page.textContent('#mEnergy') === 'Électrique', 'menu « Ma voiture » : Électrique');
  check(await page.evaluate(() => localStorage.getItem('pl-energy')) === 'electrique', 'le choix est retenu');
  check(await page.getAttribute('#bFuel', 'aria-label') === 'Bornes de recharge proches', 'le bouton pompe devient « bornes de recharge »');
  const after = await page.evaluate(() => ({ d: window.__PL.coastDist(13.9, 8.33), cost: window.__PL.routeLitres({ distance: 20000, duration: 1200 }) * window.__PL.PRICE, v: window.__PL.voiceTxt('lift', { what: 'rond-point', d: 100 }) }));
  check(after.d < before.d * 0.8, `récupération : lever le pied plus près de l'obstacle (${Math.round(before.d)} m en thermique → ${Math.round(after.d)} m en électrique, de 50 à 30 km/h)`);
  check(after.cost < before.cost * 0.5 && after.cost > 0.3, `20 km de trajet : ${before.cost.toFixed(2)} € de carburant → ${after.cost.toFixed(2)} € d'électricité`);
  check(/La batterie récupère\./.test(after.v), `voix : « ${after.v} »`);
  await page.click('#bFuelMenu'); await page.waitForTimeout(800);
  const items = await page.$$eval('#fuelList .fst', b => b.map(x => x.innerText.replace(/\s+/g, ' ')));
  check(await page.textContent('#fuelHead') === 'Bornes de recharge' && items.length === 2 && /Ionity Orvault/.test(items[0]) && /CCS/.test(items[0]) && /350 kW rapide/.test(items[0]) && /22 kW normale/.test(items[1]) && /Type 2/.test(items[1]), `bornes : ${items.join(' | ')}`);
  await page.click('#bFuelClose');
  // cagnotte en roulant pied levé
  const eco = await page.evaluate(() => { const S = window.__PL.S; S.eco = { a: 0, fuel: 0, saved: 0, coast: 0, dist: 0 }; let v = 14; for (let i = 0; i < 20; i++) { window.__PL.ecoStep(v, v - 0.5, 1); v -= 0.5; }
    return { kwh: S.eco.kwh, eur: S.eco.saved * window.__PL.PRICE, txt: document.getElementById('hEco').textContent, kitty: document.getElementById('kittyAmt').textContent }; });
  check(eco.kwh > 0 && Math.abs(eco.eur - eco.kwh * 0.30) < 1e-9 && /kWh$/.test(eco.txt), `pied levé : ${eco.txt} gardés = ${eco.eur.toFixed(3)} € (0,30 €/kWh), cagnotte ${eco.kitty}`);
  await browser.close(); srv.close();
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : le mode électrique fonctionne');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
