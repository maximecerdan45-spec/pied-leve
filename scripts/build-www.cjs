// Copie les fichiers de l'appli web (à la racine du dépôt) dans www/, utilisé par l'appli Android.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'www');
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
for (const f of FILES) fs.copyFileSync(path.join(root, f), path.join(out, f));
console.log(`www/ prêt (${FILES.length} fichiers)`);
