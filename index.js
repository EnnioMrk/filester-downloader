import { parse } from 'node-html-parser';
import fs from 'node:fs';
import path from 'path';

const indexHtml = Bun.file('./public/index.html');

function buildDownloadUrl(file) {
    return `${file.server}/v2/${file.file}?token=${file.token}&download=true&n=${encodeURIComponent(file.name)}`;
}

Bun.serve({
    routes: {
        '/': () => new Response(indexHtml, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
        '/api/files': {
            async POST(req) {
                try {
                    const body = await req.json();
                    const pageUrl = new URL(body.url);

                    const pageRes = await fetch(pageUrl.href, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                        },
                    });

                    if (!pageRes.ok) {
                        return Response.json({ error: `Failed to fetch page: ${pageRes.statusText}` }, { status: 400 });
                    }

                    const html = await pageRes.text();
                    const root = parse(html);
                    const items = root.querySelectorAll('.file-item');

                    const apiBase = `${pageUrl.protocol}//${pageUrl.host}`;

                    const fileDataPromises = [];
                    for (const item of items) {
                        const onclick = item.getAttribute('onclick') || '';
                        const match = onclick.match(/window\.location\.href='\/d\/([^']+)'/);
                        if (!match) continue;

                        const fileSlug = match[1];

                        fileDataPromises.push(
                            fetch(`${apiBase}/v2/api/public/download`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                                    'Origin': apiBase,
                                    'Referer': apiBase + '/',
                                },
                                body: JSON.stringify({ file_slug: fileSlug }),
                            }).then(res => res.ok ? res.json() : null)
                              .then(data => (data && data.success) ? {
                                  name: data.name,
                                  server: data.server,
                                  file: data.file,
                                  token: data.token,
                              } : null)
                        );
                    }

                    const fileResults = await Promise.all(fileDataPromises);
                    const files = fileResults.filter(Boolean);

                    return Response.json({ files });
                } catch (err) {
                    return Response.json({ error: err.message }, { status: 400 });
                }
            },
        },
        '/api/download': {
            async GET(req) {
                const url = new URL(req.url);
                const server = url.searchParams.get('server');
                const file = url.searchParams.get('file');
                const token = url.searchParams.get('token');
                const name = url.searchParams.get('name');

                if (!server || !file || !token || !name) {
                    return new Response('Missing parameters', { status: 400 });
                }

                const downloadUrl = `${server}/v2/${file}?token=${token}&download=true&n=${encodeURIComponent(name)}`;

                const upstreamRes = await fetch(downloadUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'Origin': server,
                        'Referer': server + '/',
                    },
                });

                if (!upstreamRes.ok) {
                    return new Response('Failed to download file', { status: 400 });
                }

                const headers = new Headers(upstreamRes.headers);
                headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);

                return new Response(upstreamRes.body, {
                    status: upstreamRes.status,
                    headers,
                });
            },
        },
    },
    async fetch(req) {
        const url = new URL(req.url);
        const fileUrl = new URL('./public/', import.meta.url);
        const publicPath = path.fileURLToPath(fileUrl);

        let requestPath = url.pathname;
        if (requestPath === '/') {
            requestPath = '/index.html';
        }

        const fullPath = path.resolve(publicPath, '.' + requestPath);

        if (fs.existsSync(fullPath)) {
            const file = Bun.file(fullPath);
            return new Response(file);
        }

        return new Response('Not Found', { status: 404 });
    },
});
