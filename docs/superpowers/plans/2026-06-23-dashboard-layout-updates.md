# Dashboard Layout Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modify the user dashboard UI to show the session password/token and hide direct URL boxes behind Alpine.js toggles.

**Architecture:** Extend Alpine.js state in the dashboard template and update Jinja HTML structures in `templates/dashboard.html` and `templates/partials/_dashboard_status.html`. Ensure route handlers propagate the updated token.

**Tech Stack:** Bun, Elysia, Alpine.js, Tailwind/Vanilla CSS

## Global Constraints
- Token badge must sit above "Open JupyterLab" button.
- Both URL boxes must sit below "Open Code Server" button and be hidden by default.

---

### Task 1: Update Route Handler Token Assignments

**Files:**
- Modify: `src/index.ts:187-200,280-293`

- [ ] **Step 1: Update token assignment in index.ts**

Modify `src/index.ts` to assign `user.token = token;` after updating it in the DB.
In `/session/start`:
```typescript
    db.updateToken(username, token);
    user.token = token; // ensure render context gets the new token
    if (isHtmx) {
```
In `/session/restart`:
```typescript
    db.updateToken(username, token);
    user.token = token; // ensure render context gets the new token
    if (isHtmx) {
```

- [ ] **Step 2: Run test suite to verify no regressions**

Run: `bun test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: propagate newly generated tokens in session handlers"
```

---

### Task 2: Implement Alpine.js State Extensions

**Files:**
- Modify: `templates/dashboard.html` (inside `<script>` section)

- [ ] **Step 1: Update dashboardState and copyToClipboard**

Modify `templates/dashboard.html` to add `showJupyterUrl` and `showCodeServerUrl` to state and modify `copyToClipboard` method.
```javascript
function dashboardState() {
    return {
        syncing: false,
        showTree: false,
        treeLoaded: false,
        showJupyterUrl: false,
        showCodeServerUrl: false,
        copyToClipboard(id) {
            var urlText = document.getElementById(id).innerText;
            navigator.clipboard.writeText(urlText).then(() => {
                window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: "URL copied to clipboard!", type: "success" } }));
            }, (err) => {
                window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: "Could not copy text to clipboard.", type: "error" } }));
            });
        },
```

- [ ] **Step 2: Commit**

```bash
git add templates/dashboard.html
git commit -m "feat: add Alpine.js state for URL toggles and copyToClipboard support"
```

---

### Task 3: Update HTML Layouts for Local Server Controls

**Files:**
- Modify: `templates/dashboard.html`
- Modify: `templates/partials/_dashboard_status.html`

- [ ] **Step 1: Rewrite local status block in templates**

Update both files to structure local server layout:
Show token block, then Open buttons, then toggle buttons, then collapsible URL boxes.

In `templates/dashboard.html`:
Replace the entire `{% if is_running and jupyter_url %}` block with:
```html
        {% if is_running and jupyter_url %}
        <div style="margin-bottom: 1.5rem;">
            <!-- Session Password/Token Badge -->
            <div style="margin-bottom: 1rem; padding: 0.75rem; background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color); border-radius: 6px;">
                <span style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.25rem;">Session Password / Token:</span>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <code style="font-size: 0.95rem; color: var(--accent-color); font-weight: bold; letter-spacing: 0.05em;">{{ user.token }}</code>
                    <button @click="navigator.clipboard.writeText('{{ user.token }}').then(() => $dispatch('show-toast', { message: 'Token copied!', type: 'success' }))" class="copy-btn" title="Copy password/token" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 0.2rem;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    </button>
                </div>
            </div>

            <!-- Open Buttons -->
            <a href="{{ jupyter_url }}" target="_blank" class="btn btn-primary" style="text-decoration: none; width: 100%; margin-bottom: 0.5rem;">
                Open JupyterLab ↗
            </a>
            <a href="{{ code_server_url }}" target="_blank" class="btn btn-outline" style="text-decoration: none; width: 100%; border-color: var(--accent-color); color: var(--accent-color);">
                Open Code Server ↗
            </a>

            <!-- Toggle Buttons -->
            <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
                <button @click="showJupyterUrl = !showJupyterUrl" class="btn btn-outline" style="font-size: 0.75rem; padding: 0.3rem 0.6rem; flex: 1; height: auto;">
                    <span x-text="showJupyterUrl ? '🙈 Hide Jupyter URL' : '🔗 Show Jupyter URL'"></span>
                </button>
                <button @click="showCodeServerUrl = !showCodeServerUrl" class="btn btn-outline" style="font-size: 0.75rem; padding: 0.3rem 0.6rem; flex: 1; height: auto;">
                    <span x-text="showCodeServerUrl ? '🙈 Hide Coder URL' : '🔗 Show Coder URL'"></span>
                </button>
            </div>

            <!-- Jupyter URL Box -->
            <div x-show="showJupyterUrl" x-transition style="margin-top: 0.75rem;">
                <label style="display: block; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.25rem;">Direct JupyterLab Link:</label>
                <div class="jupyter-url-box" style="margin-bottom: 0;">
                    <code id="jupyterUrl">{{ jupyter_url }}</code>
                    <button @click="copyToClipboard('jupyterUrl')" class="copy-btn" title="Copy to clipboard">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    </button>
                </div>
            </div>

            <!-- Code Server URL Box -->
            <div x-show="showCodeServerUrl" x-transition style="margin-top: 0.75rem;">
                <label style="display: block; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.25rem;">Direct Code Server Link:</label>
                <div class="jupyter-url-box" style="margin-bottom: 0;">
                    <code id="codeServerUrl">{{ code_server_url }}</code>
                    <button @click="copyToClipboard('codeServerUrl')" class="copy-btn" title="Copy to clipboard">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
```

In `templates/partials/_dashboard_status.html`:
Replace the entire `{% if is_running and jupyter_url %}` block with the exact same structure as above.

- [ ] **Step 2: Commit**

```bash
git add templates/dashboard.html templates/partials/_dashboard_status.html
git commit -m "feat: design collapsible URL boxes and session token badge"
```
