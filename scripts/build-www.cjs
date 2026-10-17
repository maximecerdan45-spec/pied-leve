// Copie les fichiers de l'appli web (à la racine du dépôt) dans www/, utilisé par l'appli Android.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'www');
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
for (const f of FILES) fs.copyFileSync(path.join(root, f), path.join(out, f));
// Bibliothèque Capacitor (accès aux modules natifs : voix, écran allumé, GPS en arrière-plan),
// ajoutée seulement dans la version de l'appli Android
fs.copyFileSync(path.join(root, 'node_modules/@capacitor/core/dist/capacitor.js'), path.join(out, 'capacitor.js'));
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const marker = '<script>\n(() => {';
if (!html.includes(marker)) throw new Error("index.html : script principal introuvable");
fs.writeFileSync(path.join(out, 'index.html'), html.replace(marker, '<script src="capacitor.js"></script>\n' + marker));
// Numéro de version de l'appli Android (fourni par GitHub), pour savoir si une version plus récente existe
const code = parseInt(process.env.VERSION_CODE || '0', 10);
fs.writeFileSync(path.join(out, 'app-version.json'), JSON.stringify({ code }));
console.log(`www/ prêt (${FILES.length} fichiers, version ${code || 'non numérotée'})`);
