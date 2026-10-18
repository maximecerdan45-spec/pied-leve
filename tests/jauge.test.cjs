// Test : la jauge d'approche (bandeau et bulle) se remplit-elle de façon régulière ?
// Route droite avec un ralentisseur à 1300 m ; faux GPS bruité (±4 m, vitesse ±1 m/s), une position par seconde,
// comme en vrai. Image par image, la jauge du bandeau doit avancer sans à-coups ni retour en arrière,
// et les mises à jour envoyées à la bulle doivent donner une vitesse de remplissage régulière.
// Lancement : node tests/jauge.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const LAT0 = 47.2184, LON0 = -1.5536, V = 14; // 14 m/s ≈ 50 km/h
const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const N = 251; // 2,5 km, un point tous les 10 m
const geo = []; for (let i = 0; i < N; i++) geo.push({ lat: LAT0 + i * 10 * mLat, lon: LON0 });
const overpass = JSON.stringify({ elements: [
  { type: 'way', id: 1, nodes: geo.map((_, i) => 1000 + i), geometry: geo, tags: { highway: 'primary', maxspeed: '50' } },
  { type: 'node', id: 1130, lat: geo[130].lat, lon: geo[130].lon, tags: { traffic_calming: 'bump' } }] });

function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rsp) => {
      const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
      fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
        if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S},get bub(){return BUB.info},get sent(){return BUB.sent||0}};})();</script></body>');
        rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); rsp.end(b); });
    }).listen(0, () => res(s));
  });
}

(async () => {
  const srv = await serve(), port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  await page.route('**/*', r => { const u = r.request().url();
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    if (u.includes('/interpreter')) return r.fulfill({ status: 200, contentType: 'application/json', body: overpass });
    return r.abort(); });
  await page.addInitScript(({ LAT0, LON0, mLat, V }) => {
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const fix = s => ({ coords: { latitude: LAT0 + (s + 4 * gauss()) * mLat, longitude: LON0 + 4 * gauss() * mLat, accuracy: 6, speed: V + gauss(), heading: 0 }, timestamp: Date.now() });
    navigator.geolocation.watchPosition = ok => { const t0 = performance.now(); const tick = () => { ok(fix(700 + V * (performance.now() - t0) / 1000)); setTimeout(tick, 850 + 300 * rnd()); }; tick(); return 1; };
    navigator.geolocation.clearWatch = () => {};
    try { speechSynthesis.speak = () => {}; } catch (e) {}
  }, { LAT0, LON0, mLat, V });
  await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(800);
  await page.click('#bReal');
  await page.evaluate(() => { window.__rec = []; window.__bub = [];
    const loop = t => { const c = document.getElementById('cue'), prep = /prep/.test(c.className);
      __rec.push([t, prep ? parseFloat(document.getElementById('cP').style.width) : null]);
      requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    // ce que reçoit la bulle Android, à chaque changement
    // et on rejoue le compte à rebours de la bulle Android (mètres qui défilent à la vitesse reçue, jamais de remontée)
    window.__cd = { base: -1, t0: 0, key: '', shown: [] };
    setInterval(() => { const i = window.__PL.bub, now = performance.now(), C = __cd; if (i.meters == null) return;
      const k = JSON.stringify(i); if (__bub.length === 0 || __bub[__bub.length - 1].k !== k) {
        __bub.push({ t: now, k, p: i.progress, r: i.rate, m: i.meters });
        const cur = C.base < 0 ? -1 : Math.max(0, C.base - i.mps * (now - C.t0) / 1000), fresh = cur < 0 || i.key !== C.key || i.meters > cur + 60 || i.meters < cur - 80;
        C.base = fresh ? i.meters : Math.min(cur, i.meters); C.t0 = now; C.key = i.key; }
      C.shown.push([now, Math.max(0, C.base - i.mps * (now - C.t0) / 1000), i.line1]); }, 50);
  });
  await page.waitForTimeout(26000);
  const rec = await page.evaluate(() => __rec), bub = await page.evaluate(() => __bub), sent = await page.evaluate(() => window.__PL.sent), cd = await page.evaluate(() => __cd.shown);
  await browser.close(); srv.close();

  let n = 0, back = 0; const steps = [];
  for (let i = 1; i < rec.length; i++) { const a = rec[i - 1][1], b = rec[i][1]; if (a == null || b == null) continue;
    const dt = (rec[i][0] - rec[i - 1][0]) / 1000; if (dt <= 0) continue; n++; const d = (b - a) / (dt * 60); if (d < -0.01) back++; steps.push(d); }
  const sorted = [...steps].sort((x, y) => x - y), med = sorted[Math.floor(sorted.length / 2)] || 0, p95 = sorted[Math.floor(sorted.length * 0.95)] || 0, max = sorted[sorted.length - 1] || 0;
  console.log(`Bandeau : jauge affichée ${n} images, ${back} retour(s) en arrière, avance médiane ${med.toFixed(3)} %/image, 95 % des images sous ${p95.toFixed(3)}, plus grand bond ${max.toFixed(3)}`);
  const rates = bub.filter(x => x.r > 0).map(x => x.r), rMin = Math.min(...rates), rMax = Math.max(...rates);
  console.log(`Bulle : ${bub.length} mises à jour envoyées, vitesse de remplissage de ${(rMin * 100).toFixed(1)} à ${(rMax * 100).toFixed(1)} %/s`);
  let up = 0, big = 0; for (let i = 1; i < cd.length; i++) { const d = cd[i][1] - cd[i - 1][1]; if (d > 0.5) up++; if (-d > 6) big++; }
  console.log(`Bulle : ${cd.length} relevés du compte à rebours, de ${Math.round(cd[0] ? cd[0][1] : 0)} m à ${Math.round(cd.length ? cd[cd.length - 1][1] : 0)} m, ${up} remontée(s), ${big} saut(s) de plus de 6 m en 50 ms ; ${sent} envois vers Android`);
  const ok = n > 200 && back === 0 && max < Math.max(0.25, med * 3) && rates.length >= 3 && rMax < rMin * 1.6 && cd.length > 100 && up === 0 && big === 0 && sent < 26 * 4;
  console.log(ok ? 'RÉUSSI : la jauge se remplit de façon régulière' : 'ÉCHEC : la jauge avance par à-coups');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
