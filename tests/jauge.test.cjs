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
        if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S},bubbleInfo};})();</script></body>');
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
    setInterval(() => { const S = window.__PL.S; if (!S.gauge) return; const i = window.__PL.bubbleInfo({ lvl: 'prep', liftAt: 100, dn: 200, e: {} });
      const k = i.progress + '|' + i.rate; if (__bub.length === 0 || __bub[__bub.length - 1].k !== k) __bub.push({ t: performance.now(), k, p: i.progress, r: i.rate }); }, 50);
  });
  await page.waitForTimeout(26000);
  const rec = await page.evaluate(() => __rec), bub = await page.evaluate(() => __bub);
  await browser.close(); srv.close();

  let n = 0, back = 0; const steps = [];
  for (let i = 1; i < rec.length; i++) { const a = rec[i - 1][1], b = rec[i][1]; if (a == null || b == null) continue;
    const dt = (rec[i][0] - rec[i - 1][0]) / 1000; if (dt <= 0) continue; n++; const d = (b - a) / (dt * 60); if (d < -0.01) back++; steps.push(d); }
  const sorted = [...steps].sort((x, y) => x - y), med = sorted[Math.floor(sorted.length / 2)] || 0, p95 = sorted[Math.floor(sorted.length * 0.95)] || 0, max = sorted[sorted.length - 1] || 0;
  console.log(`Bandeau : jauge affichée ${n} images, ${back} retour(s) en arrière, avance médiane ${med.toFixed(3)} %/image, 95 % des images sous ${p95.toFixed(3)}, plus grand bond ${max.toFixed(3)}`);
  const rates = bub.filter(x => x.r > 0).map(x => x.r), rMin = Math.min(...rates), rMax = Math.max(...rates);
  console.log(`Bulle : ${bub.length} mises à jour envoyées, vitesse de remplissage de ${(rMin * 100).toFixed(1)} à ${(rMax * 100).toFixed(1)} %/s`);
  const ok = n > 200 && back === 0 && max < Math.max(0.25, med * 3) && bub.length >= 3 && bub.length < 40 && rMax < rMin * 1.6;
  console.log(ok ? 'RÉUSSI : la jauge se remplit de façon régulière' : 'ÉCHEC : la jauge avance par à-coups');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
