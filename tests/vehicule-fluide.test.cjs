// Test : le véhicule avance-t-il de façon fluide ?
// Lance l'appli dans Chromium avec une route inventée (ligne droite, virage, ligne droite)
// et un faux GPS bruité à 1 position par seconde, puis mesure, image par image,
// les sauts de position et de rotation du véhicule affiché.
// Lancement : node tests/vehicule-fluide.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const LAT0 = 47.2184, LON0 = -1.5536, V = 14; // 14 m/s ≈ 50 km/h
const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));

// Route : 1000 m vers le nord, virage à droite de rayon 80 m, puis 1000 m vers l'est (un point tous les 10 m).
function road() {
  const p = [];
  for (let y = 0; y <= 1000; y += 10) p.push([0, y]);
  for (let a = 5; a <= 90; a += 5) { const r = a * Math.PI / 180; p.push([80 - 80 * Math.cos(r), 1000 + 80 * Math.sin(r)]); }
  for (let x = 90; x <= 1080; x += 10) p.push([x, 1080]);
  return p;
}
const R = road();
const geo = R.map(([x, y]) => ({ lat: LAT0 + y * mLat, lon: LON0 + x * mLon }));
const overpass = JSON.stringify({ elements: [{ type: 'way', id: 1, nodes: R.map((_, i) => 1000 + i), geometry: geo, tags: { highway: 'primary', maxspeed: '50' } }] });

function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rsp) => {
      const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
      fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
        // Le code de l'appli est fermé sur lui-même : on expose son état au test, sans rien changer d'autre.
        if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S},pointAt};})();</script></body>');
        rsp.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); rsp.end(b); });
    }).listen(0, () => res(s));
  });
}

(async () => {
  const srv = await serve(), port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(`http://localhost:${port}`)) return r.continue();
    if (u.includes('/interpreter')) return r.fulfill({ status: 200, contentType: 'application/json', body: overpass });
    return r.abort(); // pas de réseau extérieur : la carte s'affiche en mode dessin simple
  });
  // Faux GPS : position vraie sur la route + bruit de ±3 m, 1 position par seconde.
  await page.addInitScript(({ R, LAT0, LON0, mLat, mLon, V }) => {
    const L = [0]; for (let i = 1; i < R.length; i++) L.push(L[i - 1] + Math.hypot(R[i][0] - R[i - 1][0], R[i][1] - R[i - 1][1]));
    const at = s => { let i = 1; while (i < R.length - 1 && L[i] < s) i++; const f = (s - L[i - 1]) / (L[i] - L[i - 1]);
      return [R[i - 1][0] + (R[i][0] - R[i - 1][0]) * f, R[i - 1][1] + (R[i][1] - R[i - 1][1]) * f, Math.atan2(R[i][0] - R[i - 1][0], R[i][1] - R[i - 1][1])]; };
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const fix = s => { const [x, y, h] = at(s); return { coords: { latitude: LAT0 + (y + 3 * gauss()) * mLat, longitude: LON0 + (x + 3 * gauss()) * mLon,
      accuracy: 6, speed: V + 0.5 * gauss(), heading: ((h * 180 / Math.PI) + 360) % 360 }, timestamp: Date.now() }; };
    navigator.geolocation.watchPosition = (ok) => { const t0 = performance.now(); const tick = () => ok(fix(850 + V * (performance.now() - t0) / 1000)); tick(); return setInterval(tick, 1000); };
    navigator.geolocation.clearWatch = id => clearInterval(id);
  }, { R, LAT0, LON0, mLat, mLon, V });

  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(800);
  await page.evaluate(() => { try { speechSynthesis.speak = () => {}; } catch (e) {} document.getElementById('bReal').click(); });
  if (!(await page.evaluate(() => !!window.__PL))) { console.log('ÉCHEC : le code de l\'appli ne s\'est pas chargé'); process.exit(1); }
  // Enregistre, à chaque image, la position et la rotation affichées du véhicule.
  await page.evaluate(() => {
    window.__rec = [];
    const loop = t => { const { S, pointAt } = window.__PL;
      if (S.veh) __rec.push([t, S.veh.x, S.veh.y, S.veh.h]);
      else if (S.dispXY && S.path) { // ancienne version : position affichée + cap du tronçon
        const off = (S.advOff || 0) * Math.max(0, 1 - (t - (S.advOffT || 0)) / 900);
        const adv = Math.max(0, Math.min(40, Math.max(0, S.v * (t - S.fixT) / 1000)) + off);
        __rec.push([t, S.dispXY[0], S.dispXY[1], pointAt(S.path.pts, adv)[2]]); }
      requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await page.waitForTimeout(16000);
  const rec = await page.evaluate(() => __rec);
  await browser.close(); srv.close();

  const s = rec.filter(r => r[0] - rec[0][0] > 3000); // on laisse 3 s pour le démarrage
  if (s.length < 200) { console.log(`ÉCHEC : trop peu d'images enregistrées (${s.length})`); process.exit(1); }
  const steps = [], turns = [], speeds = [];
  for (let i = 1; i < s.length; i++) {
    const dt = (s[i][0] - s[i - 1][0]) / 1000; if (dt <= 0) continue;
    const d = Math.hypot(s[i][1] - s[i - 1][1], s[i][2] - s[i - 1][2]);
    let a = s[i][3] - s[i - 1][3]; while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI;
    steps.push(d); speeds.push(d / dt); turns.push(Math.abs(a) * 180 / Math.PI / (dt * 60)); // degrés par image à 60 i/s
  }
  const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
  const maxStep = Math.max(...steps), maxTurn = Math.max(...turns), spd99 = pct(speeds, 0.99);
  console.log(`Images analysées : ${s.length}`);
  console.log(`Plus grand saut de position en une image : ${maxStep.toFixed(2)} m (normal ≈ ${(V / 60).toFixed(2)} m)`);
  console.log(`Vitesse affichée (99e centile) : ${(spd99 * 3.6).toFixed(0)} km/h pour ${(V * 3.6).toFixed(0)} km/h réels`);
  console.log(`Plus forte rotation en une image : ${maxTurn.toFixed(1)}°`);
  const ok = maxStep < 1.5 && spd99 < V * 2 && maxTurn < 4;
  console.log(ok ? 'RÉUSSI : le véhicule avance sans à-coups' : 'ÉCHEC : le véhicule fait des à-coups');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
