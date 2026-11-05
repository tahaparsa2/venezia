// A stand-in for `vite preview`, and just as forgiving: unknown paths get index.html with a
// 200, and the disk decides case. The host simulator exists to catch what this hides.
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

createServer((request, response) => {
  const url = request.url.split('?')[0];
  const wanted = path.join('dist', url.endsWith('/') ? `${url}index.html` : url);
  const file = fs.existsSync(wanted) && fs.statSync(wanted).isFile() ? wanted : 'dist/index.html';
  response.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(response);
}).listen(Number(process.env.PORT), '127.0.0.1');
