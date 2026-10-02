/**
 * Tiny static file server for local play, with no dependencies. ES modules need HTTP, not file://.
 *
 *   npm start                          # http://localhost:8140
 *   node tools/serve.mjs 9000          # another port
 *   node tools/serve.mjs 9000 ../dir   # another folder
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.argv[3] ? resolve(process.argv[3]) : resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8140);
const TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml",
    ".png": "image/png", ".glb": "model/gltf-binary", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
    try {
        let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
        if (path.endsWith("/")) path += "index.html";
        const file = normalize(join(ROOT, path));
        if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end("Forbidden"); return; }
        if (!(await stat(file)).isFile()) throw new Error("not a file");
        res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
        res.end(await readFile(file));
    } catch (e) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    }
}).listen(PORT, () => console.log(`BREACH (static, Practice only) running at http://localhost:${PORT}`));
