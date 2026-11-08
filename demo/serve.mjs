// @zakkster/lite-loglogn -- demo server (repo-only dev artifact, NEVER in the tarball).
//
//   npm run demo:serve            (then open http://127.0.0.1:8019/)
//   node demo/serve.mjs [port]
//
// A zero-dependency Node http server bound to 127.0.0.1 (loopback only). It serves an
// EXACT-PATH allowlist and denies everything else (deny by default):
//
//   /demo/visuals.html  /demo/Visualize.mjs  /demo/renderers.mjs  /demo/witness-data.mjs
//   /LogLogN.js         /node_modules/@zakkster/lite-logn/LogN.js   (LogN.js imports nothing)
//
//   GET /                      -> 302 /demo/visuals.html (so the page's ./ imports resolve)
//   GET /workload.json?kind=mixed&seed=1&U=65536&n=256
//                              -> 200 {kind, seed, U, n, hash}   (no timing, no-store)
//
// The hash is buildOpStream(kind, seed, U, n).hash from ./Visualize.mjs, imported lazily
// inside the handler, so this file loads even when Visualize.mjs is absent (that request
// then answers 500). Every response the handler writes carries COOP + COEP (not Node's own clientError replies, e.g. 400 / 431).
// Status codes: malformed percent-encoding -> 400; a bad workload query -> 400 JSON
// {error}; not allowlisted (traversal, %2e%2e, package.json, the test, this file) -> 404;
// a method other than GET / HEAD -> 405; a handler failure -> 500.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DEMO_DIR);

/** The default port (distinct from the siblings). Overridable via `node demo/serve.mjs [port]`. */
export const DEFAULT_PORT = 8019;

/** The loopback interface the server binds. */
export const HOST = '127.0.0.1';

const MIME_HTML = 'text/html; charset=utf-8';
const MIME_JS = 'text/javascript; charset=utf-8';
const MIME_JSON = 'application/json; charset=utf-8';
const MIME_TEXT = 'text/plain; charset=utf-8';

/** Exact URL path -> [absolute file, MIME type]. Nothing outside this table is served. */
const ALLOW = new Map([
    ['/demo/visuals.html', [join(ROOT, 'demo', 'visuals.html'), MIME_HTML]],
    ['/demo/Visualize.mjs', [join(ROOT, 'demo', 'Visualize.mjs'), MIME_JS]],
    ['/demo/renderers.mjs', [join(ROOT, 'demo', 'renderers.mjs'), MIME_JS]],
    ['/demo/witness-data.mjs', [join(ROOT, 'demo', 'witness-data.mjs'), MIME_JS]],
    ['/LogLogN.js', [join(ROOT, 'LogLogN.js'), MIME_JS]],
    ['/node_modules/@zakkster/lite-logn/LogN.js',
        [join(ROOT, 'node_modules', '@zakkster', 'lite-logn', 'LogN.js'), MIME_JS]],
]);

/** The allowlisted URL paths (read-only copy, for tests and the CLI banner). */
export const ALLOWED_PATHS = Object.freeze([...ALLOW.keys()]);

// Workload dial bounds -- the CONTRACT dials (U 2^16 .. 2^32, n 2^8 .. 2^16, seed uint32).
const KINDS = new Set(['mixed', 'query', 'churn']);
const QUERY_KEYS = ['kind', 'seed', 'U', 'n'];
const U_MIN = 65536;
const U_MAX = 4294967296;
const N_MIN = 256;
const N_MAX = 65536;
const SEED_MAX = 4294967295;
// Decimal (no sign, no exponent, no fraction) or 0x hex. Anything else is junk.
const INT_RE = /^(?:[0-9]{1,10}|0[xX][0-9a-fA-F]{1,9})$/;

function baseHeaders(type) {
    return {
        'content-type': type,
        'cache-control': 'no-store',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
    };
}

function sendText(res, status, body, extra) {
    const h = baseHeaders(MIME_TEXT);
    if (extra !== undefined) Object.assign(h, extra);
    res.writeHead(status, h);
    res.end(body);
}

function sendJson(res, status, obj) {
    res.writeHead(status, baseHeaders(MIME_JSON));
    res.end(JSON.stringify(obj));
}

/** Parse one integer query value in [lo, hi]; throws a RangeError naming the key. */
function parseIntParam(name, raw, lo, hi) {
    if (raw === null) throw new RangeError('[lite-loglogn-demo] missing query parameter ' + name);
    if (!INT_RE.test(raw)) {
        throw new RangeError('[lite-loglogn-demo] ' + name + ' must be a plain integer, got ' + JSON.stringify(raw));
    }
    const v = Number(raw);
    if (!Number.isInteger(v) || !(v >= lo) || !(v <= hi)) {
        throw new RangeError('[lite-loglogn-demo] ' + name + ' must be an integer in [' + lo + ', ' + hi +
            '], got ' + JSON.stringify(raw));
    }
    return v;
}

/**
 * Validate a /workload.json query string. Fails closed: a missing, duplicated, unknown,
 * non-integer, NaN / Infinity or out-of-range parameter throws a RangeError.
 *
 * @param {string} rawQuery  the part after '?', without the '?'
 * @returns {{kind: string, seed: number, U: number, n: number}}
 */
export function parseWorkloadQuery(rawQuery) {
    const sp = new URLSearchParams(rawQuery);
    const seen = new Set();
    for (const k of sp.keys()) {
        if (!QUERY_KEYS.includes(k)) {
            const lower = k.toLowerCase();
            const hint = QUERY_KEYS.find((q) => q.toLowerCase() === lower);
            throw new RangeError('[lite-loglogn-demo] unknown query parameter ' + JSON.stringify(k) +
                (hint !== undefined ? ' (did you mean ' + JSON.stringify(hint) + '?)' : '') +
                '; expected kind, seed, U, n');
        }
        if (seen.has(k)) throw new RangeError('[lite-loglogn-demo] duplicate query parameter ' + JSON.stringify(k));
        seen.add(k);
    }
    const kind = sp.get('kind');
    if (kind === null) throw new RangeError('[lite-loglogn-demo] missing query parameter kind');
    if (!KINDS.has(kind)) {
        throw new RangeError('[lite-loglogn-demo] kind must be mixed|query|churn, got ' + JSON.stringify(kind));
    }
    const seed = parseIntParam('seed', sp.get('seed'), 0, SEED_MAX);
    const U = parseIntParam('U', sp.get('U'), U_MIN, U_MAX);
    const n = parseIntParam('n', sp.get('n'), N_MIN, N_MAX);
    return { kind, seed, U, n };
}

function loadVisualize() {
    return import('./Visualize.mjs');
}

async function serveWorkload(res, rawQuery, load) {
    let q;
    try {
        q = parseWorkloadQuery(rawQuery);
    } catch (err) {
        sendJson(res, 400, { error: String((err && err.message) || err) });
        return;
    }
    // A missing or throwing Visualize, or a non-integer hash, rejects -> 500 in handle().
    const mod = await load();
    if (mod === null || typeof mod !== 'object' || typeof mod.buildOpStream !== 'function') {
        throw new Error('[lite-loglogn-demo] Visualize.mjs does not export buildOpStream');
    }
    const stream = mod.buildOpStream(q.kind, q.seed, q.U, q.n);
    const hash = stream === null || typeof stream !== 'object' ? undefined : stream.hash;
    if (!Number.isInteger(hash)) {
        throw new Error('[lite-loglogn-demo] buildOpStream returned a non-integer hash');
    }
    sendJson(res, 200, { kind: q.kind, seed: q.seed, U: q.U, n: q.n, hash });
}

async function route(req, res, load) {
    const method = req.method === undefined ? 'GET' : req.method;
    if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, '405 ' + method, { allow: 'GET, HEAD' });
        return;
    }
    // Split the raw request target by hand: new URL() would normalize "/../" and
    // "%2e%2e" segments, and only the exact raw path may match the allowlist.
    const url = typeof req.url === 'string' ? req.url : '';
    const hashAt = url.indexOf('#');
    const target = hashAt === -1 ? url : url.slice(0, hashAt);
    const qAt = target.indexOf('?');
    const rawPath = qAt === -1 ? target : target.slice(0, qAt);
    const rawQuery = qAt === -1 ? '' : target.slice(qAt + 1);

    let path;
    try {
        path = decodeURIComponent(rawPath);
    } catch {
        sendText(res, 400, '400 malformed percent-encoding');
        return;
    }

    if (path === '/workload.json') {
        await serveWorkload(res, rawQuery, load);
        return;
    }
    if (path === '/') {
        const h = baseHeaders(MIME_TEXT);
        h.location = '/demo/visuals.html';
        res.writeHead(302, h);
        res.end();
        return;
    }
    const entry = ALLOW.get(path);
    if (entry === undefined) {
        sendText(res, 404, '404 not found');
        return;
    }
    let data;
    try {
        data = await readFile(entry[0]);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            sendText(res, 404, '404 not found');
            return;
        }
        throw err;
    }
    res.writeHead(200, baseHeaders(entry[1]));
    res.end(method === 'HEAD' ? undefined : data);
}

/**
 * The request handler. Exported so a test can drive it with a mock {url[, method]} and a
 * mock res (writeHead / end / headersSent). Never rejects: any failure answers 500.
 *
 * @param {{url: string, method?: string}} req
 * @param {object} res
 * @param {() => Promise<object>} [load]  Visualize module loader (test seam; default:
 *        a lazy import of ./Visualize.mjs)
 */
export async function handle(req, res, load = loadVisualize) {
    try {
        await route(req, res, load);
    } catch (err) {
        try {
            if (!res.headersSent) {
                sendText(res, 500, '500 ' + String((err && err.message) || err));
            } else {
                res.end();
            }
        } catch {
            /* the response is already gone -- nothing more to do */
        }
    }
}

/**
 * Create (but do not start) the http server. A rejection from `handler` is turned into a
 * 500, never an unhandled rejection.
 *
 * @param {(req: object, res: object) => Promise<void>} [handler]  default: handle
 */
export function createServer(handler = handle) {
    return http.createServer((req, res) => {
        Promise.resolve()
            .then(() => handler(req, res))
            .catch((err) => {
                try {
                    if (!res.headersSent) {
                        sendText(res, 500, '500 ' + String((err && err.message) || err));
                    } else {
                        res.end();
                    }
                } catch {
                    /* the response is already gone */
                }
            });
    });
}

/**
 * Start listening on 127.0.0.1. Port 0 picks a free port (tests). Returns the server;
 * read server.address() after its 'listening' event.
 *
 * @param {number} [port]  integer in [0, 65535]; default DEFAULT_PORT
 */
export function start(port = DEFAULT_PORT) {
    if (!Number.isInteger(port) || !(port >= 0) || !(port <= 65535)) {
        throw new RangeError('[lite-loglogn-demo] port must be an integer in [0, 65535], got ' + String(port));
    }
    const server = createServer();
    server.listen(port, HOST);
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const arg = process.argv[2];
    const port = arg === undefined ? DEFAULT_PORT : (/^[0-9]{1,5}$/.test(arg) ? Number(arg) : NaN);
    let server;
    try {
        server = start(port);
    } catch (err) {
        process.stderr.write(String((err && err.message) || err) + '\n');
        process.exit(2);
    }
    server.on('error', (err) => {
        process.stderr.write('[lite-loglogn-demo] ' + String((err && err.message) || err) + '\n');
        process.exitCode = 1;
    });
    server.on('listening', () => {
        const base = 'http://' + HOST + ':' + server.address().port;
        process.stdout.write('lite-loglogn demo server on ' + base + '/\n');
        process.stdout.write('  page:      ' + base + '/demo/visuals.html\n');
        process.stdout.write('  workload:  ' + base + '/workload.json?kind=mixed&seed=1&U=65536&n=256\n');
    });
}
