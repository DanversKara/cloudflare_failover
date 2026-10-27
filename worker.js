// Failover-notice Worker — Cloudflare free tier, no bindings needed.
// Paste this whole file into Workers -> Create Worker -> Edit Code.
//
// SYSTEM 2 (maintenance page):
//   The Worker proxies each public hostname to a private "origin-" hostname
//   that is an ordinary Cloudflare Tunnel route to your reverse proxy (this
//   guide uses FeatherWall as the example; any proxy that routes by the
//   request's Host header works). Each origin hostname must be listed in
//   its app's domain list in the proxy, so the origin hostname reaches the
//   right app. NOTE: Workers fetch ignores a manually set Host header and
//   always sends the URL's hostname — do NOT re-add a Host override here;
//   it does not work. The proxy's domain alias is the mechanism, and the
//   proxy must send the app's PUBLIC hostname upstream (see README,
//   "The Host problem") or apps that build absolute URLs from Host will
//   render origin- URLs and break under a strict CSP.
//   If the tunnel is unreachable (fetch throws, or the edge answers
//   502/503/504/522/523/524), the Worker returns its own maintenance page
//   instead of letting the visitor see a browser connection error.
//
// SYSTEM 1 (degraded banner):
//   When the origin answers but the home is on its backup link, the Worker
//   injects a fixed banner into HTML pages. "On backup" is decided by a
//   tiny checker on a host at home (cellular-check.sh in this repo) that
//   publishes {"degraded": bool} at STATUS_URL. If the status endpoint is
//   unreachable, no banner is shown (fail open) — the site just works
//   normally.
//
// REVERT: delete the Worker routes and traffic goes straight back to the
// tunnel, Worker bypassed.

// Public hostname -> private origin hostname (tunnel route, same backend).
// Add one line per app you want covered. Unknown hostnames get a 404.
const ORIGINS = {
  'app.example.com': 'origin-app.example.com',
  'www.example.com': 'origin-www.example.com',
};

// Status endpoint: tunnel route -> the status host's :8899 (see README).
const STATUS_URL = 'https://origin-status.example.com/status.json';
const STATUS_TIMEOUT_MS = 2000;

// Edge/tunnel failure statuses that mean "origin unreachable", not "app error".
// App errors (500, 404, 403 incl. WAF blocks) pass through untouched.
const DOWN_STATUSES = new Set([502, 503, 504, 522, 523, 524]);

function maintenancePage(hostname) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Temporarily unavailable - ${hostname}</title>
<style>
body { font-family: system-ui, -apple-system, sans-serif; background: #111827; color: #f3f4f6; margin: 0; padding: 40px 20px; }
main { max-width: 560px; margin: 0 auto; background: #1f2937; border-radius: 12px; padding: 32px; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
h1 { margin-top: 0; font-size: 28px; }
h2 { font-size: 18px; margin-top: 28px; }
ul { line-height: 1.7; }
.note { color: #d1d5db; font-size: 14px; border-top: 1px solid #374151; padding-top: 16px; }
</style>
</head>
<body>
<main>
<h1>We'll be back soon</h1>
<p><strong>${hostname}</strong> is temporarily unavailable &mdash; the server is down for maintenance.</p>
<p>This page refreshes automatically. Please try again in a few minutes.</p>
<h2>What's affected</h2>
<ul>
<li>Web services &mdash; this site and our other tunnel sites</li>
<li>Mail &mdash; ports 25, 465, 587, 993 and 4190 (submission, IMAP and Sieve)</li>
<li>WireGuard VPN</li>
<li>Phone service (SIP)</li>
</ul>
<p class="note">Email sent to us while we're down isn't lost &mdash; sending servers automatically retry for several days, and it will be delivered once we're back.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Fixed top banner, injected at the end of <body>. Dismissible for the session.
const BANNER = `<div id="cf-degraded-banner"><span>\u26a0\ufe0f Running on backup internet &mdash; service is slower than usual, and mail and VPN are unavailable while on backup. Please bear with us.</span><button type="button" aria-label="Dismiss">\u2715</button></div>
<style>#cf-degraded-banner{position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b45309;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 48px 10px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)}#cf-degraded-banner button{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:transparent;border:1px solid rgba(255,255,255,.6);color:#fff;border-radius:4px;cursor:pointer;padding:2px 8px}body{padding-top:48px !important}</style>
<script>(function(){var b=document.getElementById('cf-degraded-banner');if(!b)return;if(sessionStorage.getItem('cf-degraded-dismissed')){b.style.display='none';document.body.style.paddingTop='0';return;}b.querySelector('button').addEventListener('click',function(){b.style.display='none';document.body.style.paddingTop='0';sessionStorage.setItem('cf-degraded-dismissed','1');});})();</script>`;

async function fetchDegraded() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(STATUS_URL, { signal: controller.signal });
    if (!res.ok) return false;
    const data = await res.json();
    return data.degraded === true;
  } catch {
    return false; // fail open: no banner when status is unknown
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const originHost = ORIGINS[url.hostname];
    if (!originHost) {
      return new Response('Unknown host', { status: 404 });
    }

    const originUrl = new URL(request.url);
    originUrl.hostname = originHost;
    const originRequest = new Request(originUrl, request);
    // The request goes to the reverse proxy with Host = the origin hostname.
    // The proxy routes it via that hostname's entry in the app's domain list
    // (see README). Do not set a Host header here: Workers fetch ignores it
    // and sends the URL's hostname anyway.

    let originResponse;
    try {
      // redirect: 'manual' is required for auth flows. fetch's default
      // redirect-following drops Set-Cookie headers set on redirect
      // responses (e.g. the session cookie on a post-login 302), which
      // leaves the app stuck on a "Signing in..." screen with no session.
      // Passing redirects through untouched lets the browser keep every
      // cookie.
      originResponse = await fetch(originRequest, { redirect: 'manual' });
    } catch {
      return maintenancePage(url.hostname);
    }
    if (DOWN_STATUSES.has(originResponse.status)) {
      return maintenancePage(url.hostname);
    }

    const contentType = originResponse.headers.get('content-type') || '';
    const ok = originResponse.status >= 200 && originResponse.status < 300;
    if (ok && contentType.includes('text/html')) {
      const degraded = await fetchDegraded();
      if (degraded) {
        return new HTMLRewriter()
          .on('body', {
            element(el) {
              el.append(BANNER, { html: true });
            },
          })
          .transform(originResponse);
      }
    }
    return originResponse;
  },
};
