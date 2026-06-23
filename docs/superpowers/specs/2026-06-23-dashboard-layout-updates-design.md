# Design Specification: Dashboard Layout Updates

This document describes the design changes for the user dashboard UI:
1. Show the generated session password/token above the "Open JupyterLab" button.
2. Hide JupyterLab and Code Server direct URL boxes by default.
3. Move the URL boxes below the "Open Code Server" button.
4. Add toggle buttons using Alpine.js state to show/hide the direct URLs dynamically.

## Proposed Changes

### 1. Alpine.js State Variables (`templates/dashboard.html`)
- Add `showJupyterUrl: false` and `showCodeServerUrl: false` to the `dashboardState()` object.
- Generalize `copyToClipboard(id)` helper to accept an element ID parameter.

### 2. Layout Structure (`templates/dashboard.html` & `templates/partials/_dashboard_status.html`)
- Add a session password/token badge section above the buttons:
  ```html
  <div style="margin-bottom: 1rem; padding: 0.75rem; background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color); border-radius: 6px;">
      <span style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.25rem;">Session Password / Token:</span>
      <div style="display: flex; justify-content: space-between; align-items: center;">
          <code style="font-size: 0.95rem; color: var(--accent-color); font-weight: bold; letter-spacing: 0.05em;">{{ user.token }}</code>
          <button @click="navigator.clipboard.writeText('{{ user.token }}').then(() => window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: 'Token copied!', type: 'success' } })))" class="copy-btn" title="Copy password/token" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 0.2rem;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
          </button>
      </div>
  </div>
  ```
- Position the "Open JupyterLab" and "Open Code Server" buttons directly below it.
- Under the buttons, add a wrapper with toggle buttons:
  ```html
  <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
      <button @click="showJupyterUrl = !showJupyterUrl" class="btn btn-outline" style="font-size: 0.75rem; padding: 0.3rem 0.6rem; flex: 1; height: auto;">
          <span x-text="showJupyterUrl ? '🙈 Hide Jupyter URL' : '🔗 Show Jupyter URL'"></span>
      </button>
      <button @click="showCodeServerUrl = !showCodeServerUrl" class="btn btn-outline" style="font-size: 0.75rem; padding: 0.3rem 0.6rem; flex: 1; height: auto;">
          <span x-text="showCodeServerUrl ? '🙈 Hide Code Server URL' : '🔗 Show Code Server URL'"></span>
      </button>
  </div>
  ```
- Display collapsible URL blocks using `x-show="showJupyterUrl"` and `x-show="showCodeServerUrl"`.

### 3. Route Handlers (`src/index.ts`)
- Update `user.token = token;` right after calling `db.updateToken(username, token)` in both `/session/start` and `/session/restart` endpoints, ensuring the rendered templates receive the newly generated token.
