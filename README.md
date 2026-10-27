# Cloudflare Failover Notice (free tier)

A maintenance / degraded notice for self-hosted services that **cannot be
served from home during an outage** — because when home is down, nothing at
home can answer. So the notice lives at Cloudflare's edge instead.

No paid Cloudflare features are used: no KV, no Load Balancer, no paid
Worker plan. A plain Worker (fetch + HTMLRewriter) plus tunnel routes.

## What you get

**System 1 — degraded banner.** When the tunnel is alive but home is on its
backup internet link, every HTML page on your covered hostnames gets a fixed
top banner: "Running on backup internet — service is slower than usual, and
mail and VPN are unavailable while on backup. Please bear with us."
Dismissible for the session (X button, remembered via sessionStorage).

**System 2 — maintenance page.** When the tunnel is fully unreachable (power
out, or everything down), visitors to a covered hostname get a real page
(HTTP 503, auto-refreshes every 60 seconds) saying the server is down for
maintenance, with a list of what's affected. No browser connection-error
page.

## How it works

- The Worker sits in front of your public hostnames (Worker routes take
  precedence over the tunnel CNAMEs). It proxies each request to a private
  `origin-` hostname that is an ordinary tunnel route to your reverse proxy.
  The proxy routes by the request's Host header, so each origin hostname
  must be listed in its app's domain list in the proxy.
- If the origin fetch fails, or the edge answers 502/503/504/522/523/524,
  the Worker returns the maintenance page. App errors (500, 404) and WAF
  blocks (403) pass through untouched.
- For HTML pages that load fine, the Worker asks a tiny status endpoint
  whether home is on its backup link, and injects the banner if so. If the
  status endpoint is unreachable, no banner is shown (fail open).
- The status endpoint is a checker on a host at home (`cellular-check.sh`):
  every minute it compares the home's current public egress IP against the
  known primary-link IP. If they differ, home has failed over to backup.
  It publishes `{"degraded": bool}` on port 8899, reached through its own
  tunnel route (`origin-status`).

## The Host problem (read this before you start)

This is the one subtle part, and it decides whether logins work through
the Worker.

Workers fetch **ignores a manually set Host header** and always sends the
URL's hostname. So when the Worker fetches `origin-app.example.com`, your
proxy sees Host `origin-app.example.com` — and if it forwards that Host
upstream, the app builds absolute URLs (login pages, 2FA images, API calls)
pointing at the origin hostname. A page served under the public hostname
whose assets point at the origin hostname gets blocked by the app's strict
CSP, and the app breaks — typically a login stuck on "Signing in..." even
though the page itself loads.

The fix lives in the **proxy**, not the Worker:

- **Best (free):** make the proxy send the app's **public** hostname
  upstream, as both the Host header and X-Forwarded-Host, whenever the
  request arrived on an origin hostname. FeatherWall has a per-app
  "Upstream Host override" field for exactly this; other proxies have
  equivalents (or a header-rewrite rule). This is the mechanism this guide
  assumes.
- **Paid alternative:** a Cloudflare Origin Rule rewriting the Host header
  before the tunnel. Note: the Host-header override is **not entitled on
  the free plan**, so this is not an option there.
- **App-side alternative:** make the app generate relative URLs (or
  trust X-Forwarded-Host and set it correctly). Works, but it is a code
  change per app.

Whichever you choose, the rule is the same: **the app must see its public
hostname, never the origin hostname.** Test a login through the Worker
before calling it done.

## Prerequisites

- A Cloudflare account (free tier is fine) with your zones on Cloudflare DNS.
- A Cloudflare Tunnel already routing your apps, with a reverse proxy
  behind it that routes by Host header.
- A host at home that is always on, for the checker + status endpoint.
- A primary internet link and a backup link (or, for testing only, a way
  to stop the tunnel to simulate a full outage).

## Part A — Cloudflare setup

Example hostnames used below — replace with yours. The `origin-` names are
private Worker-only plumbing; don't advertise them anywhere.

### 1. Add tunnel routes

One tunnel ingress rule per covered app, plus one for the status endpoint:

| Hostname | Upstream |
|---|---|
| `origin-app.example.com` | `http://192.168.1.10:80` (your reverse proxy) |
| `origin-www.example.com` | `http://192.168.1.10:80` |
| `origin-status.example.com` | `http://192.168.1.20:8899` (the status host) |

- If your tunnel is dashboard-managed: Zero Trust -> Networks -> Tunnels ->
  your tunnel -> Public Hostnames -> Add, one row per hostname. Cloudflare
  creates the proxied DNS CNAMEs automatically.
- If your tunnel is config-managed: add the ingress rules to `config.yml`
  and restart cloudflared, then create each CNAME manually (proxied)
  pointing at `<tunnel-id>.cfargotunnel.com`. Keep the catch-all rule
  (`http_status:404`) last, and never remove it.

### 2. Create the Worker

Workers & Pages -> Create Worker -> name it `failover-notice` -> Edit Code ->
replace the whole file with `worker.js` from this repo -> Save and Deploy.
Free tier, no bindings to configure. Edit the `ORIGINS` map first: one line
per covered app (`'public hostname': 'origin hostname'`).

### 3. Attach the Worker routes

On the Worker's page -> Triggers -> Routes -> Add route, one per public
hostname:

- `app.example.com/*` (zone: example.com)
- `www.example.com/*` (zone: example.com)

No DNS change is needed for the public hostnames — their tunnel CNAMEs stay
exactly as they are. The Worker route takes precedence over the tunnel route.

### API alternative (same steps, via curl)

If you prefer the API, use a token with: Account **Workers Scripts** — Edit,
Account **Cloudflare Tunnel** — Edit, Zone **Workers Routes** — Edit, Zone
**DNS** — Edit, scoped to your zones. (Origin Rules is not needed — see
"The Host problem".) Set `CF_TOKEN`, `ACCOUNT_ID`, `ZONE_ID`, `TUNNEL_ID`:

```sh
# Tunnel config: ALWAYS read-modify-write. Never hand-write the rule list.
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  -H "Authorization: Bearer $CF_TOKEN" > tunnel-current.json
# Add your origin- rules before the catch-all, then PUT the whole config back:
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  --data @tunnel-new.json

# DNS (config-managed tunnels only; dashboard-managed routes auto-create these):
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"origin-app","content":"'$TUNNEL_ID'.cfargotunnel.com","proxied":true,"ttl":1}'

# Worker upload (multipart; set compatibility_date to a recent date):
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/failover-notice" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F "metadata={\"main_module\":\"worker.js\",\"compatibility_date\":\"2026-10-26\"};type=application/json" \
  -F "worker.js=@worker.js;type=application/javascript+module"

# Worker route:
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  --data '{"pattern":"app.example.com/*","script":"failover-notice"}'
```

## Part B — status host setup

On an always-on host at home, as root:

```sh
cp cellular-check.sh /usr/local/bin/cellular-check.sh
chmod +x /usr/local/bin/cellular-check.sh
cp cellular-status.service /etc/systemd/system/cellular-status.service
mkdir -p /opt/cellular-status
chmod 755 /opt/cellular-status
systemctl daemon-reload
systemctl enable --now cellular-status.service
```

Then add the checker to root's crontab (`crontab -e`):

```
* * * * * /usr/local/bin/cellular-check.sh
```

Before anything else, set `WAN_IP` in `cellular-check.sh` to your primary
link's public IP (find it on your router's WAN status page). A stale value
shows the degraded banner permanently until fixed.

Sanity check on the host:

```sh
curl -s http://127.0.0.1:8899/status.json
# expect: {"degraded": false, "checked": "..."} while on the primary link
```

## Part C — reverse proxy setup (do this BEFORE the Worker routes go live)

For each covered app, in your proxy:

1. Add the app's `origin-` hostname to its domain list, **on that app only**.
   A misplaced alias serves the wrong app to visitors — check each list
   twice before moving on.
2. Set the app's upstream host handling so the app sees its **public**
   hostname, never the origin hostname (see "The Host problem"). In
   FeatherWall this is the per-app "Upstream Host override" field, set to
   the public hostname.

**Sequencing warning:** do the proxy steps before creating the Worker
routes. A live route for an app whose alias is missing makes the proxy
answer "No application is configured for host origin-..." to every visitor
of that app — a self-inflicted outage on a working app. The tunnel routes,
DNS records, and Worker upload are all inert until a route exists, so do
them first, the proxy steps second, and the routes last.

## Part D — tests (in order)

1. **Normal.** Visit every covered site: no banner, sites work, and logins
   work end to end (including 2FA where present). If a login breaks, remove
   that app's Worker route (instant revert, see below) and check the Host
   handling before anything else.
2. **Degraded banner.** Force failover to the backup link (unplug the
   primary modem, or otherwise switch links). Within about a minute,
   hard-refresh each site: the banner should appear. Restore the primary
   link: within about a minute, the banner should be gone.
3. **Maintenance page.** Stop cloudflared (or stop the apps) and visit each
   site: you should get the "We'll be back soon" page, not a browser
   connection error. Restart cloudflared: the real site comes back (the
   page auto-refreshes every 60 seconds, or just reload).
4. **Status endpoint.** From outside the LAN,
   `https://origin-status.example.com/status.json` should return the same
   small JSON. It reveals only a true/false boolean — nothing sensitive.

## Troubleshooting

- **"No application is configured for host origin-..."** — the origin
  alias is missing, or on the wrong app. Compare the proxy's domain list
  against the hostname in the error before touching anything else.
- **Page loads but shows the wrong app** — an origin alias is misplaced
  onto another app's list. Move it to its own app.
- **Login stuck on "Signing in..." (or similar)** — the Host/CSP problem.
  Open the browser console: blocked cross-host loads (page on the public
  hostname loading assets/APIs from the origin hostname) confirm it. Fix
  the proxy's upstream host handling; do not chase the Worker.
- **Banner stuck on permanently** — stale `WAN_IP` in `cellular-check.sh`.
  Update it to the current primary-link IP.
- **Banner never appears on backup** — the checker isn't running, or the
  status endpoint is unreachable (the Worker fails open: no banner). Check
  the cron line, the service, and the status URL from outside the LAN.
- **Worker 404 "Unknown host"** — the hostname is missing from the
  `ORIGINS` map in `worker.js`. Add it and re-upload.
- **A long-poll / websocket app misbehaves** — websockets and long-polls
  pass through the Worker untouched, but note the Worker converts *any*
  502/503/504/522/523/524 from the origin into the maintenance page, for
  every path. An endpoint that legitimately returns one of those statuses
  will get the maintenance page for that request instead. Test such apps
  explicitly after go-live.

## Known limits (read before relying on this)

- **WAN IP is hardcoded.** `cellular-check.sh` compares against one IP. If
  your ISP changes your primary public IP, update that one line, or the
  banner sticks on permanently.
- **Mail clients see no page.** Workers only handle web traffic. The
  maintenance page *lists* mail as down, and real mail isn't lost (senders
  retry for days), but nothing can pop a notice inside a mail client.
- **Non-tunnel hostnames aren't covered.** Pages on direct port forwards
  have nothing between the visitor and the dead IP during an outage.
  Covering them means moving them behind the tunnel + Worker — a separate
  migration.
- **Inbound services don't work on backup links.** Backup links are
  usually CGNAT with inbound ports blocked, so services that depend on your
  public IP and port forwards (inbound mail, VPN, SIP) stay down on backup
  even though the tunnel works. Outbound via a relay (e.g. a third-party
  SMTP service) still works, because it needs no inbound port or stable
  public IP.
- **Worker free-tier quota is shared.** The free plan allows 100,000
  Worker requests per day, shared across every hostname on the Worker. A
  high-traffic hostname on the same Worker (e.g. a honeypot that attracts
  crawlers) eats that quota; if it is ever exceeded, the Worker errors for
  *all* routed sites until the quota resets at midnight UTC. Watch
  Workers -> Metrics -> Requests, and pull a high-volume hostname's route
  off the Worker if it ever climbs toward the limit (it goes back to the
  direct tunnel, which is unlimited).
- **Banner layout.** The banner is fixed at the top and adds 48px of body
  padding. On narrow screens where the banner wraps to two lines, it may
  briefly overlap the very top of the page.

## Revert (instant)

Delete the Worker routes (Worker -> Triggers -> Routes). Traffic goes
straight back to the tunnel with no Worker in the path. Optionally delete
the Worker, the tunnel origin- routes, the cron line, and the systemd
service.

## Files in this repo

- `worker.js` — the Worker (banner + maintenance page). Edit `ORIGINS`
  and `STATUS_URL` for your setup.
- `cellular-check.sh` — the per-minute egress-IP checker. Set `WAN_IP`.
- `cellular-status.service` — systemd unit serving the status JSON on :8899.

## Tested live

This exact design was verified live on a dual-WAN home network (primary +
cellular backup): logins and 2FA through the Worker on multiple apps,
the banner on backup on every covered site, the maintenance page during a
tunnel outage, and a clean failback with the banner clearing on its own.
