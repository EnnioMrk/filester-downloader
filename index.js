import { parse } from 'node-html-parser';
import JSZip from 'jszip';

const indexHtml = Bun.file('./public/index.html');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const progressStreams = new Map();
const sessions = new Map();

function createProgressStream(sessionId) {
    if (sessions.has(sessionId)) {
        return null;
    }
    const controller = new AbortController();
    const { readable, writable } = new TransformStream();
    sessions.set(sessionId, { controller, writable });
    progressStreams.set(sessionId, writable);
    return { readable, writable, signal: controller.signal };
}

function cleanupSession(sessionId, withAbort = false) {
    const session = sessions.get(sessionId);
    if (session) {
        if (withAbort && !session.controller.signal.aborted) {
            session.controller.abort();
        }
        const writable = session.writable;
        progressStreams.delete(sessionId);
        sessions.delete(sessionId);
        if (writable) {
            try {
                writable.getWriter().close();
            } catch {}
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
                    await sendProgress(sessionId, {
                        type: 'info',
                        phase,
                        message: `Attempt ${attempt}/${retries} failed (status: ${res.status}), retrying...`,
                    });
                }
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            if (attempt < retries) {
                if (sessionId && phase) {
                    await sendProgress(sessionId, {
                        type: 'info',
                        phase,
                        message: `Attempt ${attempt}/${retries} failed (${err.message}), retrying...`,
                    });
                }
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }
    return null;
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
                if (!stream) {
                    return new Response('Session already in progress', { status: 409 });
                }

                const { readable, signal } = stream;

                const heartbeat = setInterval(() => {
                    sendProgress(sessionId, { type: 'heartbeat' });
                }, 15000);

                const onAbort = () => {
                    clearInterval(heartbeat);
                    cleanupSession(sessionId, true);
                };

                if (req.signal) {
                    req.signal.addEventListener('abort', onAbort);
                }

                return new Response(readable, {
                    headers: {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                    },
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

                    const fetchPageUrl = async (targetUrl) => {
                        const pageRes = await fetchWithRetry(targetUrl, { headers, signal }, MAX_RETRIES, sessionId, 'fetching_pages');
                        if (!pageRes) return null;
                        const html = await pageRes.text();
                        return parse(html);
                    };

                    await sendProgress(sessionId, {
                        type: 'progress',
                        phase: 'fetching_pages',
                        current: 0,
                        total: 0,
                        message: 'Fetching page 1...',
                        elapsed: 0,
                    });

                    const firstRoot = await fetchPageUrl(pageUrl.href);
                    if (!firstRoot) {
                        cleanupSession(sessionId);
                        return Response.json({ error: 'Failed to fetch initial page' }, { status: 400 });
                    }

                    const pageInfo = firstRoot.querySelector('.page-info');
                    const totalPages = pageInfo ? parseInt(pageInfo.textContent.split('/')[1]) : 1;
                    const itemsOnPage1 = firstRoot.querySelectorAll('.file-item').length;
                    const estimatedTotal = itemsOnPage1 * totalPages;

                    await sendProgress(sessionId, {
                        type: 'progress',
                        phase: 'fetching_pages',
                        current: itemsOnPage1,
                        total: estimatedTotal,
                        message: `Page info: ${totalPages} pages, ~${estimatedTotal} items`,
                        elapsed: 0,
                        totalItemsOnPage1: itemsOnPage1,
                        totalPages,
                    });

                    const roots = [firstRoot];

                    for (let page = 2; page <= totalPages; page++) {
                        if (signal && signal.aborted) {
                            cleanupSession(sessionId);
                            return Response.json({ error: 'Aborted' }, { status: 400 });
                        }

                        await sendProgress(sessionId, {
                            type: 'progress',
                            phase: 'fetching_pages',
                            current: roots.reduce((sum, r) => sum + r.querySelectorAll('.file-item').length, 0),
                            total: estimatedTotal,
                            message: `Fetching page ${page}/${totalPages}...`,
                        });

                        const url = new URL(pageUrl);
                        url.searchParams.set('page', page.toString());
                        const root = await fetchPageUrl(url.toString());
                        if (root) {
                            roots.push(root);
                        }
                    }

                    const apiBase = `${pageUrl.protocol}//${pageUrl.host}`;
                    const allItems = [];
                    for (const root of roots) {
                        allItems.push(...root.querySelectorAll('.file-item'));
                    }

                    const actualTotal = allItems.length;
                    const total = Math.max(estimatedTotal, actualTotal);

                    await sendProgress(sessionId, {
                        type: 'progress',
                        phase: 'fetching_pages',
                        current: actualTotal,
                        total,
                        message: `Discovered ${actualTotal} file-items across all pages`,
                    });

                    const metadataStart = Date.now();
                    const files = [];
                    for (const [index, item] of allItems.entries()) {
                        if (signal && signal.aborted) {
                            cleanupSession(sessionId);
                            return Response.json({ error: 'Aborted' }, { status: 400 });
                        }

                        const onclick = item.getAttribute('onclick') || '';
                        const match = onclick.match(/window\.location\.href='\/d\/([^']+)'/);
                        if (!match) continue;

                        const fileSlug = match[1];
                        const elapsed = ((Date.now() - metadataStart) / 1000).toFixed(1);

                        await sendProgress(sessionId, {
                            type: 'progress',
                            phase: 'resolving_metadata',
                            current: index + 1,
                            total: allItems.length,
                            message: `Resolving ${index + 1}/${allItems.length}: ${fileSlug}`,
                            elapsed: parseFloat(elapsed),
                        });

                        const res = await fetchWithRetry(`${apiBase}/v2/api/public/download`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                ...headers,
                                'Origin': apiBase,
                                'Referer': apiBase + '/',
                            },
                            body: JSON.stringify({ file_slug: fileSlug }),
                            signal,
                        }, MAX_RETRIES, sessionId, 'resolving_metadata');

                        if (res) {
                            const data = await res.json();
                            if (data && data.success) {
                                files.push({
                                    name: data.name,
                                    server: data.server,
                                    file: data.file,
                                    token: data.token,
                                });
                            }
                        }
                    }

                    const metadataElapsed = ((Date.now() - metadataStart) / 1000).toFixed(1);
                    await sendProgress(sessionId, {
                        type: 'progress',
                        phase: 'resolving_metadata',
                        current: files.length,
                        total: allItems.length,
                        message: `Resolved ${files.length}/${allItems.length} files`,
                        elapsed: parseFloat(metadataElapsed),
                    });

                    return Response.json({ files, sessionId });
                } catch (err) {
                    cleanupSession(sessionId);
                    if (err.name !== 'AbortError') {
                        return Response.json({ error: err.message }, { status: 400 });
                    }
                    return Response.json({ error: 'Aborted' }, { status: 400 });
                }
            },
        },
        '/api/download-zip': {
            async POST(req) {
                let sessionId;
                try {
                    const body = await req.json();
                    sessionId = body.sessionId || generateSessionId();
                    const files = body.files;
                    const folderName = body.folderName || 'files';

                    if (!Array.isArray(files) || files.length === 0) {
                        return Response.json({ error: 'No files provided' }, { status: 400 });
                    }

                    const session = getSession(sessionId);
                    const signal = session ? session.controller.signal : null;

                    await sendProgress(sessionId, {
                        type: 'progress',
                        phase: 'downloading',
                        current: 0,
                        total: files.length,
                        message: `Starting download of ${files.length} files...`,
                        elapsed: 0,
                    });

                    const zip = new JSZip();
                    const startTime = Date.now();
                    let completedCount = 0;

                    for (const file of files) {
                        if (signal && signal.aborted) {
                            cleanupSession(sessionId);
                            return Response.json({ error: 'Aborted' }, { status: 400 });
                        }

                        const downloadUrl = `${file.server}/v2/${file.file}?token=${file.token}&download=true&n=${encodeURIComponent(file.name)}`;

                        const res = await fetchWithRetry(downloadUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                                'Origin': file.server,
                                'Referer': file.server + '/',
                            },
                            signal,
                        }, MAX_RETRIES, sessionId, 'downloading');

                        if (!res) {
                            completedCount++;
                            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                            await sendProgress(sessionId, {
                                type: 'progress',
                                phase: 'downloading',
                                current: completedCount,
                                total: files.length,
                                message: `Failed: ${file.name}`,
                                elapsed: parseFloat(elapsed),
                            });
                            continue;
                        }

                        const blob = await res.arrayBuffer();
                        zip.file(file.name, Buffer.from(blob));

                        completedCount++;
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

                        await sendProgress(sessionId, {
                            type: 'progress',
                            phase: 'downloading',
                            current: completedCount,
                            total: files.length,
                            message: `Downloading ${completedCount}/${files.length}: ${file.name}`,
                            elapsed: parseFloat(elapsed),
                        });
                    }

                    await sendProgress(sessionId, {
                        type: 'progress',
                        phase: 'packing',
                        current: Object.keys(zip.files).length,
                        total: Math.max(Object.keys(zip.files).length, files.length),
                        message: `Packed ${Object.keys(zip.files).length} files into archive`,
                    });

                    const { readable, writable } = new TransformStream();

                    const writer = writable.getWriter();
                    const zipStream = zip.generateInternalStream({ type: 'nodebuffer' });

                    zipStream.on('data', async (chunk) => {
                        await writer.write(chunk);
                    });

                    zipStream.on('end', () => {
                        writer.close().catch(() => {});
                    });

                    zipStream.on('error', (err) => {
                        writer.abort(err).catch(() => {});
                    });

                    zipStream.resume();

                    await sendProgress(sessionId, {
                        type: 'done',
                        phase: 'complete',
                        elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
                        zipBytes: null,
                    });

                    cleanupSession(sessionId);
                    return new Response(readable, {
                        headers: {
                            'Content-Type': 'application/zip',
                            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(folderName + '.zip')}`,
                        },
                    });
                } catch (err) {
                    cleanupSession(sessionId);
                    if (err.name !== 'AbortError') {
                        return Response.json({ error: err.message }, { status: 400 });
                    }
                    return Response.json({ error: 'Aborted' }, { status: 400 });
                }
            },
        },
    },
    async fetch(req) {
        const url = new URL(req.url);
        const publicDir = import.meta.dir + '/public/';

        let requestPath = url.pathname;
        if (requestPath === '/') {
            requestPath = 'index.html';
        }

        const fileUrl = new URL(requestPath, 'file://' + publicDir.replace(/\\/g, '/'));
        const fullPath = Bun.file(fileUrl);

        if (await fullPath.exists()) {
            return new Response(fullPath);
        }

        return new Response(null, { status: 404 });
    },
});

console.log(`Server running at ${server.url}`);
