export const PWA_MANIFEST_JSON = JSON.stringify(
  {
    name: 'Don-Bot Cockpit',
    short_name: 'Don-Bot',
    description: 'On-the-Run Dark Factory — A2UI 1.0 Operator Cockpit',
    start_url: '/',
    display: 'standalone',
    background_color: '#090c11',
    theme_color: '#090c11',
    icons: [],
  },
  null,
  2,
);

export const PWA_SERVICE_WORKER_JS = `const CACHE_NAME = 'don-cockpit-shell-v1';
const SHELL_URLS = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  if (event.request.method !== 'GET') {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((res) => res || Response.error())),
  );
});
`;

/**
 * Render the 3-Pane Liquid PWA Cockpit strictly in Don-Bot's Obsidian / Slate /
 * Electric Ice / Signal Orange / Crisp White palette (zero green).
 */
export function renderCockpitHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#090c11" />
  <title>Don-Bot // Dark Factory Cockpit</title>
  <link rel="manifest" href="/manifest.webmanifest" />
  <style>
    :root {
      --obsidian: #090c11;
      --slate: #0f141d;
      --panel: #141b27;
      --metal: rgba(182, 198, 222, 0.22);
      --metal-strong: rgba(208, 222, 240, 0.36);
      --ice: #3fc1ff;
      --ice-soft: rgba(63, 193, 255, 0.14);
      --orange: #ff5a1f;
      --orange-soft: rgba(255, 90, 31, 0.16);
      --white: #f3f5f9;
      --muted: #9aa7bc;
      --radius: 14px;
      --font-sans: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", "SFMono-Regular", ui-monospace, monospace;
    }

    * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
      background:
        radial-gradient(1100px 560px at 14% -10%, rgba(63, 193, 255, 0.12), transparent 60%),
        radial-gradient(900px 520px at 88% -8%, rgba(255, 90, 31, 0.08), transparent 60%),
        var(--obsidian);
      color: var(--white);
      font-family: var(--font-sans);
      -webkit-font-smoothing: antialiased;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 18px;
      background: rgba(15, 20, 29, 0.9);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--metal);
      position: sticky;
      top: 0;
      z-index: 20;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-mark {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--ice-soft), var(--orange-soft));
      border: 1px solid var(--ice);
      display: grid;
      place-items: center;
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 13px;
      color: var(--ice);
    }

    .brand-title {
      font-weight: 700;
      letter-spacing: 0.04em;
      font-size: 14px;
    }

    .brand-sub {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
    }

    .status-strip {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      background: var(--panel);
      border: 1px solid var(--metal);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--white);
    }

    .pill.ice { border-color: rgba(63, 193, 255, 0.45); color: var(--ice); }
    .pill.orange { border-color: rgba(255, 90, 31, 0.55); color: var(--orange); }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--ice);
      box-shadow: 0 0 8px var(--ice);
    }

    .dot.alert {
      background: var(--orange);
      box-shadow: 0 0 8px var(--orange);
    }

    .btn {
      appearance: none;
      border: 1px solid var(--metal-strong);
      background: var(--panel);
      color: var(--white);
      border-radius: 9px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }

    .btn:hover { transform: translateY(-1px); border-color: var(--ice); }
    .btn.primary {
      background: linear-gradient(135deg, rgba(63, 193, 255, 0.22), rgba(63, 193, 255, 0.08));
      border-color: var(--ice);
      color: var(--white);
    }
    .btn.hold {
      background: linear-gradient(135deg, rgba(255, 90, 31, 0.22), rgba(255, 90, 31, 0.08));
      border-color: var(--orange);
      color: var(--white);
    }

    .cockpit-grid {
      display: grid;
      grid-template-columns: 320px minmax(380px, 1.35fr) 360px;
      gap: 14px;
      padding: 14px 18px 28px;
      align-items: start;
    }

    .pane {
      background: rgba(15, 20, 29, 0.92);
      border: 1px solid var(--metal);
      border-top: 2px solid var(--metal-strong);
      border-radius: var(--radius);
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: calc(100vh - 96px);
    }

    .pane-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--metal);
      padding-bottom: 8px;
    }

    .pane-title {
      font-size: 12px;
      font-family: var(--font-mono);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ice);
    }

    .card {
      background: var(--panel);
      border: 1px solid var(--metal);
      border-left: 2px solid var(--ice);
      border-radius: 12px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      transition: border-color 140ms ease;
    }

    .card.alert-card { border-left-color: var(--orange); }

    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .card-kind {
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ice);
    }

    .card.alert-card .card-kind { color: var(--orange); }

    .card-body {
      font-size: 13px;
      line-height: 1.45;
      color: var(--white);
      margin: 0;
    }

    .mono-meta {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      line-height: 1.45;
      word-break: break-word;
    }

    .card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 2px;
    }

    .meter-track {
      position: relative;
      height: 9px;
      border-radius: 999px;
      background: var(--obsidian);
      border: 1px solid var(--metal);
      overflow: hidden;
    }

    .meter-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--ice), #8edcff);
      transition: width 200ms ease;
    }

    .meter-fill.warn {
      background: linear-gradient(90deg, var(--ice), var(--orange));
    }

    .meter-marker {
      position: absolute;
      left: 70%;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--orange);
    }

    .timeline-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .timeline-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 9px;
      border-radius: 8px;
      background: var(--obsidian);
      border: 1px solid var(--metal);
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .preview-frame {
      width: 100%;
      height: 320px;
      border-radius: 10px;
      border: 1px solid var(--metal);
      background: var(--obsidian);
    }

    .auth-gate {
      max-width: 460px;
      margin: 64px auto;
      padding: 20px;
      background: var(--slate);
      border: 1px solid var(--ice);
      border-radius: var(--radius);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .input {
      width: 100%;
      padding: 10px 12px;
      border-radius: 9px;
      border: 1px solid var(--metal-strong);
      background: var(--obsidian);
      color: var(--white);
      font-family: var(--font-mono);
      font-size: 12px;
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(9, 12, 17, 0.78);
      backdrop-filter: blur(8px);
      display: none;
      place-items: center;
      z-index: 50;
      padding: 16px;
    }

    .modal-backdrop.open { display: grid; }

    .modal-card {
      width: 100%;
      max-width: 480px;
      background: var(--slate);
      border: 1px solid var(--ice);
      border-radius: var(--radius);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .mobile-tabs {
      display: none;
      gap: 8px;
      padding: 10px 18px 0;
    }

    @media (max-width: 1080px) {
      .cockpit-grid {
        grid-template-columns: 1fr;
      }
      .pane { min-height: auto; }
      .mobile-tabs { display: flex; }
      .pane.mobile-hidden { display: none; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark">DB</div>
      <div>
        <div class="brand-title">DON-BOT // DARK FACTORY COCKPIT</div>
        <div class="brand-sub">A2UI v1.0 · don.catalog.v1 · SQLite WAL</div>
      </div>
    </div>
    <div class="status-strip">
      <span class="pill ice" id="sse-badge"><span class="dot" id="sse-dot"></span><span id="sse-label">SSE Standby</span></span>
      <span class="pill" id="seq-badge">seq #0</span>
      <span class="pill" id="cost-push-badge">$0.00 LLM push</span>
      <button class="btn" id="steer-btn" type="button">~ Quick Steer</button>
    </div>
  </header>

  <nav class="mobile-tabs" aria-label="Pane Switcher">
    <button class="btn primary" data-pane-tab="center" type="button">Deck & Gates</button>
    <button class="btn" data-pane-tab="left" type="button">Lanes & Timeline</button>
    <button class="btn" data-pane-tab="right" type="button">Preview & CDP</button>
  </nav>

  <section class="auth-gate" id="auth-gate" hidden>
    <div class="card-kind">ACCESS KEY REQUIRED (.don/access-key)</div>
    <p class="card-body">Paste the workspace <code>.don/access-key</code> token to unlock live SSE updates and authenticated approvals.</p>
    <input class="input" id="access-key-input" type="password" placeholder="Paste .don/access-key hex token" autocomplete="off" />
    <button class="btn primary" id="unlock-btn" type="button">Unlock Cockpit</button>
  </section>

  <main class="cockpit-grid" id="cockpit-main">
    <section class="pane" id="pane-left" data-pane="left">
      <div class="pane-header">
        <span class="pane-title">Lanes &amp; Telemetry</span>
        <span class="mono-meta" id="left-count">0 items</span>
      </div>
      <div id="left-cards"></div>
    </section>

    <section class="pane" id="pane-center" data-pane="center">
      <div class="pane-header">
        <span class="pane-title">Decision Deck &amp; Gates</span>
        <span class="mono-meta" id="center-count">0 cards</span>
      </div>
      <div id="center-cards"></div>
    </section>

    <section class="pane" id="pane-right" data-pane="right">
      <div class="pane-header">
        <span class="pane-title">Isolated User Preview</span>
        <span class="mono-meta">sandbox="allow-scripts"</span>
      </div>
      <p class="mono-meta">Untrusted generated prototypes execute without <code>allow-same-origin</code> and under a no-network CSP header.</p>
      <div class="card-actions">
        <button class="btn primary" id="load-demo-preview" type="button">Render Sample Sandbox Preview</button>
      </div>
      <iframe class="preview-frame" id="preview-frame" sandbox="allow-scripts" title="Isolated Project Preview"></iframe>
      <div id="right-cards"></div>
    </section>
  </main>

  <div class="modal-backdrop" id="steer-modal">
    <div class="modal-card">
      <div class="card-head">
        <span class="card-kind">~ Quick Operator Steer</span>
        <button class="btn" id="steer-close" type="button">Esc</button>
      </div>
      <input class="input" id="steer-input" type="text" placeholder="Steer directive (creates authenticated don_turns row)" />
      <div class="card-actions">
        <button class="btn primary" id="steer-submit" type="button">Dispatch Turn</button>
      </div>
    </div>
  </div>

  <script>
    (() => {
      const STORAGE_KEY = 'don_access_key';
      let lastSeq = 0;
      let streamAbort = null;

      const elAuthGate = document.getElementById('auth-gate');
      const elMain = document.getElementById('cockpit-main');
      const elLeft = document.getElementById('left-cards');
      const elCenter = document.getElementById('center-cards');
      const elRight = document.getElementById('right-cards');
      const elLeftCount = document.getElementById('left-count');
      const elCenterCount = document.getElementById('center-count');
      const elSeqBadge = document.getElementById('seq-badge');
      const elSseLabel = document.getElementById('sse-label');
      const elSseDot = document.getElementById('sse-dot');
      const elPreviewFrame = document.getElementById('preview-frame');
      const elSteerModal = document.getElementById('steer-modal');
      const elSteerInput = document.getElementById('steer-input');

      function getToken() {
        return sessionStorage.getItem(STORAGE_KEY) || '';
      }

      function clearChildren(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
      }

      function createTextEl(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        el.textContent = text;
        return el;
      }

      async function apiFetch(path, init = {}) {
        const token = getToken();
        const headers = new Headers(init.headers || {});
        if (token) headers.set('Authorization', 'Bearer ' + token);
        return fetch(path, { ...init, headers });
      }

      async function dispatchAction(actionId, payload = {}) {
        const res = await apiFetch('/api/a2ui/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actionId, ...payload }),
        });
        if (res.ok) {
          await loadSurface();
        }
      }

      function renderComponent(node) {
        const card = document.createElement('article');
        const isAlert =
          node.component === 'GuardAlert' ||
          (node.component === 'DecisionCard' && node.props.status === 'pending') ||
          (node.component === 'SkillEvalCard' && node.props.status === 'failed');
        card.className = isAlert ? 'card alert-card' : 'card';

        const head = document.createElement('div');
        head.className = 'card-head';
        head.appendChild(createTextEl('span', 'card-kind', node.component));
        head.appendChild(createTextEl('span', 'mono-meta', node.id));
        card.appendChild(head);

        const p = node.props || {};
        if (node.component === 'DecisionCard') {
          card.appendChild(createTextEl('p', 'card-body', String(p.question || '')));
          card.appendChild(
            createTextEl(
              'div',
              'mono-meta',
              'status=' + String(p.status) + ' · kind=' + String(p.kind) + ' · task=' + String(p.taskId),
            ),
          );
          if (p.status === 'pending') {
            const actions = document.createElement('div');
            actions.className = 'card-actions';
            const opts = Array.isArray(p.options) && p.options.length > 0 ? p.options : ['Approve', 'Hold'];
            opts.forEach((optLabel, idx) => {
              const btn = createTextEl('button', idx === 0 ? 'btn primary' : 'btn hold', String(optLabel));
              btn.type = 'button';
              btn.addEventListener('click', () => {
                void dispatchAction(idx === 0 ? 'decision.resolve' : 'decision.defer', {
                  cardId: p.cardId,
                  taskId: p.taskId,
                  answer: String(optLabel),
                });
              });
              actions.appendChild(btn);
            });
            card.appendChild(actions);
          } else if (p.answer) {
            card.appendChild(createTextEl('div', 'mono-meta', 'resolved: ' + String(p.answer)));
          }
        } else if (node.component === 'BudgetGauge') {
          const pct = p.taskMaxUsd > 0 ? Math.min(100, Math.round((p.taskUsd / p.taskMaxUsd) * 100)) : 0;
          card.appendChild(
            createTextEl(
              'div',
              'card-body',
              'Task $' + Number(p.taskUsd).toFixed(2) + ' / $' + Number(p.taskMaxUsd).toFixed(2) + ' · Daily $' + Number(p.dailyUsd).toFixed(2),
            ),
          );
          const track = document.createElement('div');
          track.className = 'meter-track';
          const fill = document.createElement('div');
          fill.className = pct >= 70 ? 'meter-fill warn' : 'meter-fill';
          fill.style.width = pct + '%';
          track.appendChild(fill);
          track.appendChild(createTextEl('div', 'meter-marker', ''));
          card.appendChild(track);
          card.appendChild(createTextEl('div', 'mono-meta', 'status=' + String(p.status) + ' · 70% downshift gate'));
        } else if (node.component === 'RunTimeline') {
          const events = Array.isArray(p.events) ? p.events.slice(-8).reverse() : [];
          const list = document.createElement('div');
          list.className = 'timeline-list';
          events.forEach((ev) => {
            const row = document.createElement('div');
            row.className = 'timeline-row';
            row.appendChild(createTextEl('span', '', '#' + String(ev.seq) + ' ' + String(ev.kind)));
            row.appendChild(createTextEl('span', '', String(ev.agentId || ev.runId || '')));
            list.appendChild(row);
          });
          card.appendChild(list);
        } else {
          const summary = Object.entries(p)
            .slice(0, 6)
            .map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v)))
            .join(' · ');
          card.appendChild(createTextEl('div', 'mono-meta', summary));
        }

        return card;
      }

      function renderSurface(surface) {
        clearChildren(elLeft);
        clearChildren(elCenter);
        clearChildren(elRight);

        const components = Array.isArray(surface.components) ? surface.components : [];
        let leftCount = 0;
        let centerCount = 0;

        components.forEach((node) => {
          const rendered = renderComponent(node);
          if (node.component === 'BudgetGauge' || node.component === 'WorktreeLane' || node.component === 'RunTimeline') {
            elLeft.appendChild(rendered);
            leftCount += 1;
          } else if (node.component === 'OutcomeReceipt') {
            elRight.appendChild(rendered);
          } else {
            elCenter.appendChild(rendered);
            centerCount += 1;
          }
        });

        elLeftCount.textContent = leftCount + ' widgets';
        elCenterCount.textContent = centerCount + ' cards';
        lastSeq = Math.max(lastSeq, Number(surface.seq || 0));
        elSeqBadge.textContent = 'seq #' + String(lastSeq);
      }

      async function loadSurface() {
        if (!getToken()) {
          elAuthGate.hidden = false;
          elMain.style.display = 'none';
          return false;
        }
        const res = await apiFetch('/api/a2ui/surface');
        if (res.status === 401) {
          sessionStorage.removeItem(STORAGE_KEY);
          elAuthGate.hidden = false;
          elMain.style.display = 'none';
          return false;
        }
        elAuthGate.hidden = true;
        elMain.style.display = 'grid';
        const data = await res.json();
        renderSurface(data);
        return true;
      }

      async function connectSse() {
        if (!getToken()) return;
        if (streamAbort) streamAbort.abort();
        streamAbort = new AbortController();

        try {
          const res = await apiFetch('/api/events?afterSeq=' + encodeURIComponent(String(lastSeq)), {
            signal: streamAbort.signal,
            headers: lastSeq > 0 ? { 'Last-Event-ID': String(lastSeq) } : {},
          });
          if (!res.ok || !res.body) {
            elSseLabel.textContent = 'SSE Auth Needed';
            elSseDot.classList.add('alert');
            return;
          }
          elSseLabel.textContent = 'SSE Live';
          elSseDot.classList.remove('alert');

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split('\\n\\n');
            buffer = blocks.pop() || '';
            for (const block of blocks) {
              const idMatch = /^id:\\s*(\\d+)/m.exec(block);
              if (idMatch) {
                lastSeq = Math.max(lastSeq, Number(idMatch[1]));
                elSeqBadge.textContent = 'seq #' + String(lastSeq);
                void loadSurface();
              }
            }
          }
        } catch {
          elSseLabel.textContent = 'SSE Reconnecting';
        }
      }

      document.getElementById('unlock-btn').addEventListener('click', async () => {
        const val = document.getElementById('access-key-input').value.trim();
        if (!val) return;
        sessionStorage.setItem(STORAGE_KEY, val);
        const ok = await loadSurface();
        if (ok) void connectSse();
      });

      document.getElementById('load-demo-preview').addEventListener('click', async () => {
        const html = '<!doctype html><body style="margin:0;padding:16px;background:#090c11;color:#3fc1ff;font-family:monospace"><h3>Isolated Sandboxed Preview</h3><p style="color:#f3f5f9">No host origin · Zero network CSP active.</p></body>';
        const res = await apiFetch('/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html }),
        });
        if (!res.ok) return;
        const { url } = await res.json();
        const htmlRes = await apiFetch(url);
        if (htmlRes.ok) {
          elPreviewFrame.srcdoc = await htmlRes.text();
        }
      });

      const closeModal = () => { elSteerModal.classList.remove('open'); };
      document.getElementById('steer-btn').addEventListener('click', () => {
        elSteerModal.classList.add('open');
        elSteerInput.focus();
      });
      document.getElementById('steer-close').addEventListener('click', closeModal);
      document.getElementById('steer-submit').addEventListener('click', async () => {
        const txt = elSteerInput.value.trim();
        if (!txt) return;
        elSteerInput.value = '';
        closeModal();
        await dispatchAction('run.resume_step', { ownerText: txt });
      });

      window.addEventListener('keydown', (ev) => {
        if (ev.key === '~' || ev.key === '\`') {
          if (document.activeElement !== elSteerInput) {
            ev.preventDefault();
            elSteerModal.classList.add('open');
            elSteerInput.focus();
          }
        } else if (ev.key === 'Escape') {
          closeModal();
        }
      });

      document.querySelectorAll('[data-pane-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = btn.getAttribute('data-pane-tab');
          document.querySelectorAll('[data-pane]').forEach((pane) => {
            pane.classList.toggle('mobile-hidden', pane.getAttribute('data-pane') !== target);
          });
        });
      });

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      }

      void loadSurface().then((ok) => {
        if (ok) void connectSse();
      });
    })();
  </script>
</body>
</html>`;
}
