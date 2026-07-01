import React, { useEffect, useState } from 'react';
import { useToast } from '../components/Toast';
import { FolderTree } from '../components/FolderTree';
import { SSEConsole } from '../components/SSEConsole';
import { useNavigate } from 'react-router-dom';

interface DashboardStatus {
  username: string;
  port: number;
  is_running: boolean;
  jupyter_url: string;
  code_server_url: string;
  ssh_host: string;
  ssh_port: number;
  has_gpu: boolean;
  gpu_endpoint: string;
  gpu_streamlit_url: string;
  gpu_code_server_url: string;
  gpu_init_status: string;
  gpu_token: string;
  token?: string;
}

export const Dashboard: React.FC = () => {
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [showJupyterUrl, setShowJupyterUrl] = useState<boolean>(false);
  const [showCodeServerUrl, setShowCodeServerUrl] = useState<boolean>(false);

  // GPU states
  const [syncSubpath, setSyncSubpath] = useState<string>('');
  const [showTree, setShowTree] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [activeStreamUrl, setActiveStreamUrl] = useState<string>('');
  const [activeStreamName, setActiveStreamName] = useState<string>('');

  const { addToast } = useToast();
  const navigate = useNavigate();

  const fetchStatus = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const response = await fetch('/api/session/status');
      if (!response.ok) {
        if (response.status === 401) {
          navigate('/login');
          return;
        }
        throw new Error('Failed to fetch status');
      }
      const data = await response.json();
      setStatus(data);
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus(true);

    // Polling status every 5 seconds
    const interval = setInterval(() => {
      fetchStatus(false);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const handleStart = async () => {
    setActionLoading(true);
    try {
      const response = await fetch('/api/session/start', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to start session');
      addToast('JupyterLab started successfully', 'success');
      fetchStatus();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      const response = await fetch('/api/session/stop', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to stop session');
      addToast('JupyterLab stopped successfully', 'success');
      fetchStatus();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestart = async () => {
    setActionLoading(true);
    try {
      const response = await fetch('/api/session/restart', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to restart session');
      addToast('JupyterLab restarted successfully', 'success');
      fetchStatus();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const startSync = (direction: 'to' | 'from') => {
    const pathParam = encodeURIComponent(syncSubpath.trim());
    const url = `/session/gpu/sync-${direction}-stream?path=${pathParam}`;
    setActiveStreamUrl(url);
    setActiveStreamName(direction === 'to' ? 'Sync to GPU' : 'Sync from GPU');
    setSyncing(true);
  };

  const handleSyncComplete = (success: boolean) => {
    setSyncing(false);
    setActiveStreamUrl('');
    if (success) {
      addToast('Sync completed successfully!', 'success');
    } else {
      addToast('Sync execution failed.', 'error');
    }
    fetchStatus();
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      addToast(`${label} copied!`, 'success');
    });
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <span className="spinner" style={{ width: '2rem', height: '2rem' }}></span>
        <span style={{ fontSize: '1.1rem', color: 'var(--text-secondary)' }}>Loading dashboard...</span>
      </div>
    );
  }

  if (!status) return null;

  const gpuInitStatusBadge = () => {
    switch (status.gpu_init_status) {
      case 'ready':
        return <span className="badge" style={{ backgroundColor: 'rgba(16, 185, 129, 0.15)', color: '#10b981' }}>🟢 Ready</span>;
      case 'running':
        return <span className="badge" style={{ backgroundColor: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa' }}>⏳ Initializing...</span>;
      case 'failed':
        return <span className="badge" style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', color: '#f87171' }}>🔴 Setup Failed</span>;
      case 'stopped':
        return <span className="badge" style={{ backgroundColor: 'rgba(156, 163, 175, 0.15)', color: '#9ca3af' }}>⚪ Stopped by Admin</span>;
      default:
        return <span className="badge" style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24' }}>🟡 Pending Setup</span>;
    }
  };

  return (
    <div className="user-card card">
      <div className="status-section">
        <div>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>Your JupyterLab Server</h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            Port Assignment: <code>{status.port}</code>
          </p>
        </div>
        <div>
          {status.is_running ? (
            <span className="badge badge-running" style={{ fontSize: '0.875rem', padding: '0.4rem 0.8rem' }}>🟢 Running</span>
          ) : (
            <span className="badge badge-stopped" style={{ fontSize: '0.875rem', padding: '0.4rem 0.8rem' }}>🔴 Stopped</span>
          )}
        </div>
      </div>

      {status.is_running && status.jupyter_url ? (
        <div style={{ marginBottom: '1.5rem' }}>
          {/* Session Token Display */}
          {status.token && (
            <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(15, 23, 42, 0.6)', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.25rem' }}>
                Local Session Password / Token (JupyterLab &amp; local Code Server only):
              </span>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <code style={{ fontSize: '0.95rem', color: 'var(--accent-color)', fontWeight: 'bold', letterSpacing: '0.05em' }}>{status.token}</code>
                <button onClick={() => copyToClipboard(status.token || '', 'Token')} className="copy-btn" title="Copy password/token">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Launch Buttons */}
          <a href={status.jupyter_url} target="_blank" rel="noreferrer" className="btn btn-primary" style={{ textDecoration: 'none', width: '100%', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
            <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/jupyter.svg" alt="Jupyter" style={{ width: '18px', height: '18px' }} />
            Open JupyterLab ↗
          </a>
          <a href={status.code_server_url} target="_blank" rel="noreferrer" className="btn btn-outline" style={{ textDecoration: 'none', width: '100%', borderColor: 'var(--accent-color)', color: 'var(--accent-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
            <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/coder.svg" alt="Code Server" style={{ width: '18px', height: '18px' }} />
            Open Code Server ↗
          </a>

          {/* Toggle Display Links */}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
            <button onClick={() => setShowJupyterUrl(!showJupyterUrl)} className="btn btn-outline" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', flex: 1, height: 'auto' }}>
              {showJupyterUrl ? '🙈 Hide Jupyter URL' : '🔗 Show Jupyter URL'}
            </button>
            <button onClick={() => setShowCodeServerUrl(!showCodeServerUrl)} className="btn btn-outline" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', flex: 1, height: 'auto' }}>
              {showCodeServerUrl ? '🙈 Hide Coder URL' : '🔗 Show Coder URL'}
            </button>
          </div>

          {showJupyterUrl && (
            <div style={{ marginTop: '0.75rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Direct JupyterLab Link:</label>
              <div className="jupyter-url-box" style={{ marginBottom: 0 }}>
                <code>{status.jupyter_url}</code>
                <button onClick={() => copyToClipboard(status.jupyter_url, 'Jupyter URL')} className="copy-btn" title="Copy to clipboard">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
              </div>
            </div>
          )}

          {showCodeServerUrl && (
            <div style={{ marginTop: '0.75rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Direct Code Server Link:</label>
              <div className="jupyter-url-box" style={{ marginBottom: 0 }}>
                <code>{status.code_server_url}</code>
                <button onClick={() => copyToClipboard(status.code_server_url, 'Code Server URL')} className="copy-btn" title="Copy to clipboard">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="jupyter-url-box" style={{ justifyContent: 'center', padding: '2rem', marginBottom: '1.5rem' }}>
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center' }}>JupyterLab server is stopped. Click Start to boot up your instance.</p>
        </div>
      )}

      {/* Local Server controls */}
      <div className="controls-section">
        {!status.is_running ? (
          <button onClick={handleStart} className="btn btn-primary" style={{ flex: 1 }} disabled={actionLoading}>
            {actionLoading ? <span className="spinner"></span> : null}
            Start Server
          </button>
        ) : (
          <>
            <button onClick={handleRestart} className="btn btn-outline" style={{ flex: 1 }} disabled={actionLoading}>
              {actionLoading ? <span className="spinner"></span> : null}
              Restart Server
            </button>
            <button onClick={handleStop} className="btn btn-danger" style={{ flex: 1 }} disabled={actionLoading}>
              {actionLoading ? <span className="spinner"></span> : null}
              Stop Server
            </button>
          </>
        )}
      </div>

      {/* GPU Server Section */}
      {status.has_gpu && (
        <div style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div>
              <h3 style={{ fontSize: '1.1rem', marginBottom: '0.25rem' }}>🖥️ GPU Server Session</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Manual sync files before launching</p>
            </div>
            {gpuInitStatusBadge()}
          </div>

          {status.gpu_init_status === 'ready' ? (
            <>
              {/* GPU Password Card */}
              <div style={{ marginBottom: '0.75rem', padding: '0.6rem 0.75rem', background: 'rgba(124, 58, 237, 0.1)', border: '1px solid rgba(124, 58, 237, 0.3)', borderRadius: '6px' }}>
                <span style={{ fontSize: '0.75rem', color: '#a78bfa', display: 'block', marginBottom: '0.2rem' }}>
                  🔑 GPU Session Password — use this to log into GPU Code Server &amp; GPU JupyterLab:
                </span>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                  <code style={{ fontSize: '0.85rem', color: '#c4b5fd', fontWeight: 'bold', letterSpacing: '0.04em', wordBreak: 'break-all' }}>{status.gpu_token}</code>
                  <button onClick={() => copyToClipboard(status.gpu_token, 'GPU password')} className="copy-btn" title="Copy GPU password" style={{ color: '#a78bfa', flexShrink: 0 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </button>
                </div>
              </div>

              {/* GPU launchers */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem', width: '100%' }}>
                <a
                  href={`${status.gpu_endpoint}${status.gpu_endpoint.includes('?') ? '&' : '?'}token=${status.gpu_token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn"
                  style={{ background: 'linear-gradient(135deg, #e3651d, #f97316)', color: 'white', fontWeight: 600, textDecoration: 'none', textAlign: 'center', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                >
                  <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/jupyter.svg" alt="Jupyter" style={{ width: '18px', height: '18px', filter: 'brightness(0) invert(1)' }} />
                  Launch GPU JupyterLab
                </a>

                {status.gpu_code_server_url && (
                  <a
                    href={status.gpu_code_server_url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn"
                    style={{ background: 'linear-gradient(135deg, #7c3aed, #6366f1)', color: 'white', fontWeight: 600, textDecoration: 'none', textAlign: 'center', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                  >
                    <img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/coder.svg" alt="Code Server" style={{ width: '18px', height: '18px', filter: 'brightness(0) invert(1)' }} />
                    Launch GPU Code Server
                  </a>
                )}

                {status.gpu_streamlit_url && (
                  <a
                    href={status.gpu_streamlit_url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-outline"
                    style={{ borderColor: '#7c3aed', color: '#a78bfa', fontWeight: 600, textDecoration: 'none', textAlign: 'center', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L2 19h20L12 2z"/></svg>
                    Launch GPU Streamlit
                  </a>
                )}
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem', width: '100%' }}>
              <button className="btn btn-outline" style={{ opacity: 0.5, cursor: 'not-allowed', width: '100%' }} disabled>
                Launch GPU (Not Ready)
              </button>
            </div>
          )}

          {/* Sync control block */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem' }}>
            <div className="form-group" style={{ marginBottom: '0.5rem', width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                <label htmlFor="sync_subpath" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0 }}>Sync subpath only (optional):</label>
                <button type="button" onClick={() => setShowTree(!showTree)} className="btn btn-outline" style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', height: 'auto' }}>
                  {showTree ? '🙈 Hide Folders' : '📁 Browse Folders'}
                </button>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="text"
                  id="sync_subpath"
                  className="form-control"
                  placeholder="e.g. data (leave blank to sync all)"
                  value={syncSubpath}
                  onChange={(e) => setSyncSubpath(e.target.value)}
                  style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem', flex: 1 }}
                  disabled={syncing}
                />
              </div>

              {showTree && (
                <FolderTree
                  onSelect={(path) => {
                    setSyncSubpath(path);
                    setShowTree(false);
                    addToast(path === '' ? 'Selected entire workspace root' : `Selected subpath: ${path}`, 'success');
                  }}
                />
              )}
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <button disabled={syncing} onClick={() => startSync('to')} className="btn btn-outline" style={{ flex: 1, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                {syncing && activeStreamName === 'Sync to GPU' ? <span className="spinner"></span> : null}
                {syncing && activeStreamName === 'Sync to GPU' ? 'Syncing...' : '📤 Sync To GPU'}
              </button>
              <button disabled={syncing} onClick={() => startSync('from')} className="btn btn-outline" style={{ flex: 1, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                {syncing && activeStreamName === 'Sync from GPU' ? <span className="spinner"></span> : null}
                {syncing && activeStreamName === 'Sync from GPU' ? 'Syncing...' : '📥 Sync From GPU'}
              </button>
            </div>

            {/* Sync Progress Console */}
            {syncing && activeStreamUrl && (
              <SSEConsole
                streamUrl={activeStreamUrl}
                actionName={activeStreamName}
                onComplete={handleSyncComplete}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
