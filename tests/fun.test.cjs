// Test : côté fun (bravo en direct, note du trajet, euros, badges, styles de voix).
// Simulation sur une route droite avec un ralentisseur tous les 500 m (même route que repere-stable).
// Lancement : node tests/fun.test.cjs   (dossier de l'appli en argument, par défaut le dépôt)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const LAT0 = 47.2184, LON0 = -1.5536;
const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const N = 301; // un point tous les 10 m
const nodes = [], ways = [];
for (let i = 0; i < N; i++) nodes.push({ id: 1000 + i, lat: LAT0 + i * 10 * mLat, lon: LON0 });
const els = [{ type: 'way', id: 1, nodes: nodes.map(n => n.id), geometry: nodes.map(n => ({ lat: n.lat, lon: n.lon })), tags: { highway: 'primary', maxspeed: '50' } }];
for (let i = 50; i < N; i += 50) els.push({ type: 'node', id: 1000 + i, lat: nodes[i].lat, lon: nodes[i].lon, tags: { traffic_calming: 'bump' } });
const overpass = JSON.stringify({ elements: els });

function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rsp) => {
      const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
      fs.readFile(f, (e, b) => { if (e) { rsp.writeHead(404); return rsp.end(); }
        if (f.endsWith('.html')) b = b.toString().replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, 'window.__PL={get S(){return S},SIM,start,bubbleInfo};})();</script></body>');
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
  const spoken = [];
  await page.exposeFunction('__spoke', t => spoken.push(t));
  await page.addInitScript(() => { try { speechSynthesis.speak = u => window.__spoke(u.text); } catch (e) {} });
  let failed = 0; const check = (ok, msg) => { console.log((ok ? 'OK    ' : 'ÉCHEC ') + msg); if (!ok) failed++; };
  await page.goto(`http://localhost:${port}/`); await page.waitForTimeout(800);
  // style de voix « Coach » depuis le menu
  await page.click('#bMenu'); await page.click('#bVoiceStyle');
  check((await page.textContent('#mVoiceStyle')) === 'Coach', 'menu : le style de voix passe à « Coach »');
  await page.click('#bMenuBack');
  await page.evaluate(({ lat, lon }) => { window.__PL.start('sim', { at: { lat, lon, name: 'test' } }); window.__PL.SIM.mult = 4; }, { lat: LAT0 + 1500 * mLat, lon: LON0 });
  await page.evaluate(() => { window.__toast = 0; window.__bub = new Set(); const loop = () => { if (!document.getElementById('toast').hidden) window.__toast++; const b = window.__PL.S.cheer; if (b && performance.now() < b.until) window.__bub.add('cheer'); requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
  await page.waitForTimeout(25000);
  const st = await page.evaluate(() => ({ fol: window.__PL.S.log.fol, cues: window.__PL.S.log.cues, toast: window.__toast }));
  check(st.cues > 0 && st.fol > 0, `conseils suivis pendant la simulation : ${st.fol} sur ${st.cues}`);
  check(st.toast > 10, '« Bien joué ! » s’affiche à l’écran quand un conseil est suivi');
  check(spoken.some(t => /Excellent/.test(t)) && spoken.some(t => /Allez, on lève le pied/.test(t)), `la voix « Coach » parle (${spoken.slice(0, 3).join(' / ')})`);
  // bulle : la cagnotte une fois le pied levé (conseil suivi), mais les mètres reprennent la main si le prochain lever est proche
  const bub = await page.evaluate(() => { const S = window.__PL.S; S.cheer = { until: performance.now() + 2000, txt: '+0,05 €' };
    return [window.__PL.bubbleInfo({ lvl: 'prep', liftAt: 300, dn: 450, e: { key: 'x1' } }), window.__PL.bubbleInfo({ lvl: 'prep', liftAt: 120, dn: 300, e: { key: 'x2' } })]; });
  check(bub[0].line1 === 'CAGNOTTE' && /€$/.test(bub[0].line2), `la bulle montre la cagnotte quand le pied a été levé (${bub[0].line2})`);
  check(bub[1].line1 === 'LEVEZ DANS' && bub[1].line2 === '120 m' && bub[1].meters === 120, `puis repasse aux mètres quand le prochain lever approche (${bub[1].line2})`);
  // fin de la simulation : note, euros, badges montrés mais pas enregistrés
  await page.click('#bEnd'); await page.waitForTimeout(400);
  const note = await page.textContent('#eNote'), saved = await page.textContent('#eSaved');
  check(/^\d+\/100$/.test(note) && (await page.$$('#eStars svg')).length === 3, `bilan : note sur 100 avec étoiles (${note}, « ${await page.textContent('#ePhrase')} »)`);
  check(/€$/.test(saved) && /L de carburant/.test(await page.textContent('#eLit')), `bilan : économie en euros (${saved}, ${await page.textContent('#eLit')})`);
  check(/Premier trajet/.test(await page.textContent('#eBadges')) && /simulation/.test(await page.textContent('#eBadges')), 'simulation : badge « Premier trajet » montré, marqué « non enregistré »');
  check(!(await page.evaluate(() => localStorage.getItem('pl-stats'))), 'simulation : rien n’est enregistré dans les statistiques');
  // un vrai trajet (on fait passer la simulation pour un trajet réel) : tout est enregistré
  await page.click('#bAgain'); await page.waitForTimeout(300);
  await page.evaluate(({ lat, lon }) => { window.__PL.start('sim', { at: { lat, lon, name: 'test' } }); window.__PL.SIM.mult = 4; }, { lat: LAT0 + 1500 * mLat, lon: LON0 });
  await page.waitForTimeout(12000);
  await page.evaluate(() => { window.__PL.S.mode = 'real'; });
  await page.click('#bEnd'); await page.waitForTimeout(400);
  const stats = await page.evaluate(() => JSON.parse(localStorage.getItem('pl-stats') || 'null'));
  check(stats && stats.trips === 1 && stats.badges.premier && stats.streak === 1, 'trajet réel : statistiques et badge « Premier trajet » enregistrés, série de 1 jour');
  await page.click('#bAgain'); await page.waitForTimeout(300);
  check(!(await page.isHidden('#homeSaved')) && /ce mois-ci/.test(await page.textContent('#homeSaved')) && /Encore .* pour un café/.test(await page.textContent('#goalTxt')),
    `accueil : « ${await page.textContent('#homeSaved')} » et « ${await page.textContent('#goalTxt')} »`);
  const nb = Object.keys(stats.badges).length;
  await page.click('#bMenu'); check(new RegExp(`^${nb} sur 10$`).test(await page.textContent('#mBadges')), `menu : « Mes badges · ${nb} sur 10 » (${Object.keys(stats.badges).join(', ')})`);
  await page.click('#bBadges'); await page.waitForTimeout(200);
  check((await page.$$('#bdList .badge')).length === 10 && (await page.$$('#bdList .badge.off')).length === 10 - nb, `écran des badges : 10 badges, ${10 - nb} encore à débloquer`);
  await page.screenshot({ path: process.env.SHOT || '/dev/null' }).catch(() => {});
  await browser.close(); srv.close();
  console.log(failed ? `${failed} vérification(s) en échec` : 'RÉUSSI : bravo en direct, note, euros, badges et voix fonctionnent');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
