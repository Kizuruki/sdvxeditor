// Builds the single-file editor: node build.js  ->  index.html
// Sources live in src/; index.html is self-contained (no network needed) so it can be
// opened straight from disk, hosted on GitHub Pages, or embedded later in a desktop shell.
'use strict';
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
let html = src('template.html');
html = html.replace(/<!-- @inline ([\w.-]+) -->/g, (_, f) => {
	const body = src(f);
	if (f.endsWith('.css')) return '<style>\n' + body + '\n</style>';
	return '<script>\n' + body.replace(/<\/script/gi, '<\\/script') + '\n</script>';
});
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('index.html written (' + Math.round(html.length / 1024) + ' KB)');
