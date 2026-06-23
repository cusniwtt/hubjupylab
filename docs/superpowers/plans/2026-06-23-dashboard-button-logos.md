# Dashboard Button Logos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate selfhst logos inside the JupyterLab and Code Server buttons.

**Architecture:** Embed `<img>` tags inside anchor elements and style with flexbox centering.

**Tech Stack:** HTML, CSS

## Global Constraints
- Target Jupyter logo URL = `https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/jupyter.svg`
- Target Code Server logo URL = `https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/coder.svg`

---

### Task 1: Update HTML Layouts for Local and GPU Buttons

**Files:**
- Modify: `templates/dashboard.html`
- Modify: `templates/partials/_dashboard_status.html`

- [ ] **Step 1: Embed logos in templates**

Update both files to embed logos inside the local and remote button elements.

In `templates/dashboard.html`:
Replace local buttons:
```html
            <!-- Open Buttons -->
            <a href="{{ jupyter_url }}" target="_blank" class="btn btn-primary" style="text-decoration: none; width: 100%; margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/jupyter.svg" alt="Jupyter" style="width: 18px; height: 18px;">
                Open JupyterLab ↗
            </a>
            <a href="{{ code_server_url }}" target="_blank" class="btn btn-outline" style="text-decoration: none; width: 100%; border-color: var(--accent-color); color: var(--accent-color); display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/coder.svg" alt="Code Server" style="width: 18px; height: 18px;">
                Open Code Server ↗
            </a>
```
Replace GPU buttons:
```html
                <div style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; width: 100%;">
                    <a href="{{ gpu_endpoint }}{{ separator }}token={{ user.gpu_token }}" target="_blank" class="btn" style="background: linear-gradient(135deg, #7c3aed, #6366f1); color: white; font-weight: 600; text-decoration: none; text-align: center; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                        <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/jupyter.svg" alt="Jupyter" style="width: 18px; height: 18px; filter: brightness(0) invert(1);">
                        🚀 Launch GPU JupyterLab
                    </a>
                    <a href="{{ gpu_code_server_url }}" target="_blank" class="btn btn-outline" style="border-color: #7c3aed; color: #a78bfa; font-weight: 600; text-decoration: none; text-align: center; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                        <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/coder.svg" alt="Code Server" style="width: 18px; height: 18px;">
                        💻 Launch GPU Code Server
                    </a>
                </div>
```

In `templates/partials/_dashboard_status.html`:
Replace local buttons:
```html
    <!-- Open Buttons -->
    <a href="{{ jupyter_url }}" target="_blank" class="btn btn-primary" style="text-decoration: none; width: 100%; margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
        <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/jupyter.svg" alt="Jupyter" style="width: 18px; height: 18px;">
        Open JupyterLab ↗
    </a>
    <a href="{{ code_server_url }}" target="_blank" class="btn btn-outline" style="text-decoration: none; width: 100%; border-color: var(--accent-color); color: var(--accent-color); display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
        <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/coder.svg" alt="Code Server" style="width: 18px; height: 18px;">
        Open Code Server ↗
    </a>
```
Replace GPU buttons:
```html
    <div style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; width: 100%;">
        {% if gpu_init_status == 'ready' %}
        {% set separator = '&' if '?' in gpu_endpoint else '?' %}
        <a href="{{ gpu_endpoint }}{{ separator }}token={{ gpu_token }}" target="_blank" class="btn" style="background: linear-gradient(135deg, #7c3aed, #6366f1); color: white; font-weight: 600; text-decoration: none; text-align: center; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
            <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/jupyter.svg" alt="Jupyter" style="width: 18px; height: 18px; filter: brightness(0) invert(1);">
            🚀 Launch GPU JupyterLab
        </a>
        <a href="{{ gpu_code_server_url }}" target="_blank" class="btn btn-outline" style="border-color: #7c3aed; color: #a78bfa; font-weight: 600; text-decoration: none; text-align: center; width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
            <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/coder.svg" alt="Code Server" style="width: 18px; height: 18px;">
            💻 Launch GPU Code Server
        </a>
```

- [ ] **Step 2: Run test suite to verify no regressions**

Run: `bun test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add templates/dashboard.html templates/partials/_dashboard_status.html
git commit -m "feat: embed Jupyter and Code Server logos in launcher buttons"
```
