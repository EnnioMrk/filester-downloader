import { parse } from 'node-html-parser';
import JSZip from 'jszip';
import { deflateSync } from 'zlib';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const progressStreams = new Map();
const sessions = new Map();

function createProgressStream(sessionId) {
    if (sessions.has(sessionId)) return null;
    const controller = new AbortController();
    const { readable, writable } = new TransformStream();
    sessions.set(sessionId, { controller, writable });
    progressStreams.set(sessionId, writable);
    return { readable, writable, signal: controller.signal };
}

function cleanupSession(sessionId, withAbort = false) {
    const session = sessions.get(sessionId);
    if (session) {
        if (withAbort && !session.controller.signal.aborted) session.controller.abort();
        const writable = session.writable;
        progressStreams.delete(sessionId);
        sessions.delete(sessionId);
        if (writable) {
            try { writable.getWriter().close(); } catch {}
        }
    }
}

function getSession(sessionId) {
    return sessions.get(sessionId);
}

function generateSessionId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function sendProgress(sessionId, event) {
    const writable = progressStreams.get(sessionId);
    if (!writable) return;
    try {
        const writer = writable.getWriter();
        const data = `data: ${JSON.stringify(event)}\n\n`;
        await writer.write(new TextEncoder().encode(data));
        writer.releaseLock();
    } catch {}
}

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES, sessionId = null, phase = null) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;
            if (attempt < retries) {
                if (sessionId && phase) {
                    await sendProgress(sessionId, { type: 'info', phase, message: `Attempt ${attempt}/${retries} failed (status: ${res.status}), retrying...` });
                }
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            if (attempt < retries) {
                if (sessionId && phase) {
                    await sendProgress(sessionId, { type: 'info', phase, message: `Attempt ${attempt}/${retries} failed (${err.message}), retrying...` });
                }
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }
    return null;
}

async function fetchPage(targetUrl, headers, signal) {
    const res = await fetchWithRetry(targetUrl, { headers, signal });
    if (!res) return null;
    return parse(await res.text());
}

async function fetchMetadata(apiBase, fileSlug, headers, signal, sessionId) {
    const res = await fetchWithRetry(
        `${apiBase}/v2/api/public/download`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers, 'Origin': apiBase, 'Referer': `${apiBase}/` },
            body: JSON.stringify({ file_slug: fileSlug }),
            signal,
        },
        MAX_RETRIES, sessionId, 'resolving_metadata'
    );
    if (!res) return null;
    const data = await res.json();
    if (data && data.success) return { name: data.name, server: data.server, file: data.file, token: data.token };
    return null;
}

function buildLocalFileHeader(name, compressedSize, uncompressedSize, crc32, compressionMethod, dosTime) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const buf = Buffer.alloc(30 + nameBytes.length);

    buf.writeUInt32LE(0x04034b50, 0);
    buf.writeUInt16LE(0x0d, 4);
    buf.writeUInt16LE(compressionMethod, 6);
    buf.writeUInt32LE(dosTime, 8);
    buf.writeUInt32LE(crc32, 12);
    buf.writeUInt32LE(compressedSize, 16);
    buf.writeUInt32LE(uncompressedSize, 20);
    buf.writeUInt16LE(nameBytes.length, 22);
    buf.writeUInt16LE(0, 24);
    nameBytes.copy(buf, 30);

    return buf;
}

function buildCentralDirEntry(name, localOffset, compressedSize, uncompressedSize, crc32, compressionMethod, dosTime) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const buf = Buffer.alloc(46 + nameBytes.length);

    buf.writeUInt32LE(0x02014b50, 0);
    buf.writeUInt16LE(0x0d, 4);
    buf.writeUInt16LE(0x0d, 6);
    buf.writeUInt16LE(compressionMethod, 8);
    buf.writeUInt32LE(dosTime, 10);
    buf.writeUInt32LE(crc32, 14);
    buf.writeUInt32LE(compressedSize, 18);
    buf.writeUInt32LE(uncompressedSize, 22);
    buf.writeUInt16LE(nameBytes.length, 26);
    buf.writeUInt16LE(0, 28);
    buf.writeUInt16LE(0, 30);
    buf.writeUInt16LE(0, 32);
    buf.writeUInt32LE(0, 34);
    buf.writeUInt32LE(localOffset, 38);
    nameBytes.copy(buf, 46);

    return buf;
}

function buildEocd(centralDirOffset, centralDirSize, totalEntries, diskNum = 0) {
    const buf = Buffer.alloc(22);
    buf.writeUInt32LE(0x06054b50, 0);
    buf.writeUInt16LE(diskNum, 4);
    buf.writeUInt16LE(diskNum, 6);
    buf.writeUInt16LE(totalEntries, 8);
    buf.writeUInt16LE(totalEntries, 10);
    buf.writeUInt32LE(centralDirSize, 12);
    buf.writeUInt32LE(centralDirOffset, 16);
    buf.writeUInt16LE(0, 20);
    return buf;
}

function crc32Of(data) {
    let crc = 0xffffffff;
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c;
    }
    for (let i = 0; i < data.length; i++) {
        crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date) {
    return ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) |
           (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) << 16;
}

async function pumpStream(from, to, signal) {
    for await (const chunk of from) {
        if (signal && signal.aborted) return;
        await to.write(chunk);
    }
}

const server = Bun.serve({
    routes: {
        '/api/abort': {
            async POST(req) {
                try {
                    const body = await req.json();
                    const sessionId = body.sessionId;
                    if (!sessionId) return new Response('Missing sessionId', { status: 400 });
                    cleanupSession(sessionId, true);
                    return new Response('OK');
                } catch {
                    return new Response('Error', { status: 400 });
                }
            },
        },

        '/api/stream': {
            async GET(req) {
                const url = new URL(req.url);
                const sessionId = url.searchParams.get('sessionId');
                if (!sessionId) return new Response('Missing sessionId', { status: 400 });

                const stream = createProgressStream(sessionId);
                if (!stream) return new Response('Session already in progress', { status: 409 });

                const { readable, signal } = stream;
                const heartbeat = setInterval(() => sendProgress(sessionId, { type: 'heartbeat' }), 15000);
                const onAbort = () => { clearInterval(heartbeat); cleanupSession(sessionId, true); };
                if (req.signal) req.signal.addEventListener('abort', onAbort);

                return new Response(readable, {
                    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
                });
            },
        },

        '/api/files': {
            async POST(req) {
                let sessionId;
                try {
                    const body = await req.json();
                    sessionId = body.sessionId || generateSessionId();
                    const pageUrl = new URL(body.url);
                    pageUrl.searchParams.delete('page');
                    const headers = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                    };
                    const session = getSession(sessionId);
                    const signal = session ? session.controller.signal : null;

                    await sendProgress(sessionId, { type: 'progress', phase: 'fetching_pages', current: 0, total: 0, message: 'Fetching page 1...', elapsed: 0 });

                    const firstRoot = await fetchPage(pageUrl.href, headers, signal);
                    if (!firstRoot) { cleanupSession(sessionId); return Response.json({ error: 'Failed to fetch initial page' }, { status: 400 }); }

                    const pageInfo = firstRoot.querySelector('.page-info');
                    const totalPages = pageInfo ? parseInt(pageInfo.textContent.split('/')[1]) : 1;
                    const itemsOnPage1 = firstRoot.querySelectorAll('.file-item').length;
                    const estimatedTotal = itemsOnPage1 * totalPages;

                    await sendProgress(sessionId, {
                        type: 'progress', phase: 'fetching_pages', current: itemsOnPage1, total: estimatedTotal,
                        message: `Page info: ${totalPages} pages, ~${estimatedTotal} items`, elapsed: 0,
                        totalItemsOnPage1: itemsOnPage1, totalPages,
                    });

                    const roots = [firstRoot];
                    for (let page = 2; page <= totalPages; page++) {
                        if (signal && signal.aborted) { cleanupSession(sessionId); return Response.json({ error: 'Aborted' }, { status: 400 }); }
                        await sendProgress(sessionId, {
                            type: 'progress', phase: 'fetching_pages',
                            current: roots.reduce((sum, r) => sum + r.querySelectorAll('.file-item').length, 0),
                            total: estimatedTotal, message: `Fetching page ${page}/${totalPages}...`,
                        });
                        const url = new URL(pageUrl);
                        url.searchParams.set('page', page.toString());
                        const root = await fetchPage(url.toString(), headers, signal);
                        if (root) roots.push(root);
                    }

                    const apiBase = `${pageUrl.protocol}//${pageUrl.host}`;
                    const allItems = [];
                    for (const root of roots) allItems.push(...root.querySelectorAll('.file-item'));
                    const actualTotal = allItems.length;
                    const total = Math.max(estimatedTotal, actualTotal);

                    await sendProgress(sessionId, { type: 'progress', phase: 'fetching_pages', current: actualTotal, total, message: `Discovered ${actualTotal} file-items across all pages` });

                    const metadataStart = Date.now();
                    const files = [];
                    for (const [index, item] of allItems.entries()) {
                        if (signal && signal.aborted) { cleanupSession(sessionId); return Response.json({ error: 'Aborted' }, { status: 400 }); }
                        const onclick = item.getAttribute('onclick') || '';
                        const match = onclick.match(/window\.location\.href='\/d\/([^']+)'/);
                        if (!match) continue;
                        const fileSlug = match[1];
                        const elapsed = ((Date.now() - metadataStart) / 1000).toFixed(1);
                        await sendProgress(sessionId, {
                            type: 'progress', phase: 'resolving_metadata',
                            current: index + 1, total: allItems.length,
                            message: `Resolving ${index + 1}/${allItems.length}: ${fileSlug}`,
                            elapsed: parseFloat(elapsed),
                        });
                        const metadata = await fetchMetadata(apiBase, fileSlug, headers, signal, sessionId);
                        if (metadata) files.push(metadata);
                    }

                    const metadataElapsed = ((Date.now() - metadataStart) / 1000).toFixed(1);
                    await sendProgress(sessionId, {
                        type: 'progress', phase: 'resolving_metadata',
                        current: files.length, total: allItems.length,
                        message: `Resolved ${files.length}/${allItems.length} files`,
                        elapsed: parseFloat(metadataElapsed),
                    });
                    return Response.json({ files, sessionId });
                } catch (err) {
                    cleanupSession(sessionId);
                    if (err.name !== 'AbortError') return Response.json({ error: err.message }, { status: 400 });
                    return Response.json({ error: 'Aborted' }, { status: 400 });
                }
            },
        },

        '/api/download-item': {
            async POST(req) {
                let sessionId;
                try {
                    const body = await req.json();
                    sessionId = body.sessionId;
                    const file = body.file;
                    if (!sessionId || !file) return new Response('Missing sessionId or file', { status: 400 });

                    const session = getSession(sessionId);
                    const signal = session ? session.controller.signal : null;
                    if (signal && signal.aborted) return new Response('Aborted', { status: 400 });

                    const downloadUrl = `${file.server}/v2/${file.file}?token=${encodeURIComponent(file.token)}&download=true&n=${encodeURIComponent(file.name)}`;
                    const headers = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'Origin': file.server,
                        'Referer': `${file.server}/`,
                    };

                    const res = await fetchWithRetry(downloadUrl, { headers, signal }, MAX_RETRIES, sessionId, 'downloading_item');
                    if (!res || !res.ok) {
                        await sendProgress(sessionId, { type: 'progress', phase: 'downloading_item', current: 0, total: 1, message: `Failed: ${file.name}` });
                        return Response.json({ error: `Failed to download ${file.name}` }, { status: 400 });
                    }

                    const blob = await res.blob();
                    await sendProgress(sessionId, { type: 'progress', phase: 'downloading_item', current: 1, total: 1, message: `Downloaded: ${file.name}` });
                    return new Response(blob, {
                        headers: {
                            'Content-Type': 'application/octet-stream',
                            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
                        },
                    });
                } catch (err) {
                    cleanupSession(sessionId);
                    if (err.name === 'AbortError') return Response.json({ error: 'Aborted' }, { status: 400 });
                    return Response.json({ error: err.message }, { status: 400 });
                }
            },
        },

        '/api/download-all': {
            async POST(req) {
                let sessionId;
                try {
                    const body = await req.json();
                    sessionId = body.sessionId || generateSessionId();
                    const files = body.files;
                    const folderName = body.folderName || 'files';

                    if (!Array.isArray(files) || files.length === 0) return Response.json({ error: 'No files provided' }, { status: 400 });

                    const session = getSession(sessionId);
                    const signal = session ? session.controller.signal : null;

                    await sendProgress(sessionId, { type: 'progress', phase: 'downloading', current: 0, total: files.length, message: `Starting download of ${files.length} files...`, elapsed: 0 });

                    const startTime = Date.now();
                    let completedCount = 0;

                    await sendProgress(sessionId, { type: 'progress', phase: 'packing', current: 0, total: files.length, message: `Archiving ${files.length} files...` });

                    let aborted = false;
                    const readable = new ReadableStream({
                        start(controller) {
                            handler(controller, { files, signal, sessionId, startTime });
                        },
                        cancel() { cleanupSession(sessionId, true); },
                    });

                    return new Response(readable, {
                        headers: {
                            'Content-Type': 'application/zip',
                            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(folderName + '.zip')}`,
                        },
                    });
                } catch (err) {
                    cleanupSession(sessionId);
                    if (err.name !== 'AbortError') return Response.json({ error: err.message }, { status: 400 });
                    return Response.json({ error: 'Aborted' }, { status: 400 });
                }
            },
        },
    },
    async fetch(req) {
        const url = new URL(req.url);
        const publicDir = import.meta.dir + '/public/';
        let requestPath = url.pathname;
        if (requestPath === '/') requestPath = 'index.html';
        const fileUrl = new URL(requestPath, 'file://' + publicDir.replace(/\\/g, '/'));
        const fullPath = Bun.file(fileUrl);
        if (await fullPath.exists()) return new Response(fullPath);
        return new Response(null, { status: 404 });
    },
});

async function handler(controller, { files, signal, sessionId, startTime }) {
    try {
        const { readable, writable } = new TransformStream();
        const cancelHandler = () => { cleanupSession(sessionId, true); controller.close(); };
        if (signal) signal.addEventListener('abort', cancelHandler);

        const reader = readable.getReader();
        const writer = writable.getWriter();

        const pumpPromise = pumpStream(reader, writer, signal);

        const handleError = (err) => controller.error(err);
        const processNext = async () => {
            try {
                await zipStreamHandler(files, {}, signal, writer, sessionId, startTime);
            } catch (err) {
                handleError(err);
                return;
            }
            try {
                await writer.close();
            } catch {}
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            await sendProgress(sessionId, { type: 'done', phase: 'complete', elapsed });
            cleanupSession(sessionId);
            controller.close();
        };

        processNext();

        try { await pumpPromise; } catch {}
    } catch (err) {
        if (!controller.desiredSize) return;
        controller.error(err);
    }
}

async function pumpStream(from, to, signal) {
    try {
        while (true) {
            const { done, value } = await from.read();
            if (done) break;
            if (signal && signal.aborted) return;
            await to.write(value);
        }
    } catch {
        if (from) try { await from.cancel(); } catch {}
    }
}

async function zipStreamHandler(files, headers, signal, writer, sessionId, startTime) {
    let completedCount = 0;
    const localOffsets = [];
    const localEntries = [];
    const now = new Date();

    const zip = JSZip();
    for (const file of files) {
        zip.file(file.name, '__placeholder__');
    }
    const zipStructure = zip.generateInternalStream({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zipStructureChunks = [];
    await new Promise((resolve, reject) => {
        zipStructure.on('data', (chunk) => zipStructureChunks.push(chunk));
        zipStructure.on('end', resolve);
        zipStructure.on('error', reject);
        zipStructure.resume();
    });

    if (zipStructureChunks.length > 0) await writer.write(Buffer.concat(zipStructureChunks));

    let localDataOffset = 0;
    const nowDOS = dosTimestamp(now);

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const downloadUrl = `${file.server}/v2/${file.file}?token=${encodeURIComponent(file.token)}&download=true&n=${encodeURIComponent(file.name)}`;
        const reqHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': file.server,
            'Referer': `${file.server}/`,
        };

        const res = await fetchWithRetry(downloadUrl, { headers: reqHeaders, signal }, MAX_RETRIES, sessionId, 'downloading');
        let fileBuf = Buffer.alloc(0);
        let crc = 0;

        if (res) {
            fileBuf = Buffer.from(await res.arrayBuffer());
            crc = crc32Of(fileBuf);
        }

        let compressedBuf = Buffer.alloc(0);
        if (fileBuf.length > 0) {
            compressedBuf = deflateSync(fileBuf);
        }

        const localHeader = buildLocalFileHeader(file.name, compressedBuf.length, fileBuf.length, crc, 8, nowDOS);
        localOffsets.push(localDataOffset);

        await writer.write(localHeader);
        localDataOffset += localHeader.length;

        if (compressedBuf.length > 0) {
            await writer.write(compressedBuf);
            localDataOffset += compressedBuf.length;
        }

        localEntries.push({ name: file.name, localOffset: localOffsets[i], compressedSize: compressedBuf.length, uncompressedSize: fileBuf.length, crc, dosTime: nowDOS });

        completedCount++;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        await sendProgress(sessionId, { type: 'progress', phase: 'downloading', current: completedCount, total: files.length, message: `Zipping ${completedCount}/${files.length}: ${file.name}`, elapsed: parseFloat(elapsed) });
    }

    const centralDirOffset = localDataOffset;
    const centralDirChunks = [];
    for (const entry of localEntries) {
        const cdEntry = buildCentralDirEntry(entry.name, entry.localOffset, entry.compressedSize, entry.uncompressedSize, entry.crc, 8, entry.dosTime);
        await writer.write(cdEntry);
        centralDirChunks.push(cdEntry);
    }
    const centralDirSize = Buffer.concat(centralDirChunks).length;

    const eocd = buildEocd(centralDirOffset, centralDirSize, files.length);
    await writer.write(eocd);
}

console.log(`Server running at ${server.url}`);
