import React, { useEffect, useState } from 'react';
import { useToast } from '../components/Toast';
import { PasswordModal } from '../components/PasswordModal';
import { SSEConsole } from '../components/SSEConsole';
import { useNavigate } from 'react-router-dom';

interface EnrichedUser {
  username: string;
  role: string;
  port?: number;
  token?: string;
  gpu_endpoint?: string;
  gpu_ssh_host?: string;
  gpu_ssh_port?: number;
  gpu_ssh_user?: string;
  gpu_streamlit_endpoint?: string;
  gpu_code_server_endpoint?: string;
  gpu_init_status?: string;
  gpu_token?: string;
  is_running: boolean;
  jupyter_url: string;
  code_server_url: string;
}

interface GlobalGpuConfig {
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_key_path?: string;
  remote_base_dir?: string;
  additional_public_keys?: string;
  _dirty?: boolean;
}

interface LogFile {
  name: string;
  type: 'gpu-init' | 'rsync-to' | 'rsync-from';
  size: number;
  mtime: number;
}

const formatPubKey = (key: string) => {
  const parts = key.trim().split(/\s+/);
  if (parts.length >= 3) {
    return `${parts[0]} (${parts.slice(2).join(' ')})`;
  }
  if (parts.length === 2) {
    const keyStr = parts[1];
    const endPart = keyStr.length > 15 ? `...${keyStr.slice(-15)}` : keyStr;
    return `${parts[0]} ${endPart}`;
  }
  return key.length > 25 ? `...${key.slice(-25)}` : key;
};

export const Admin: React.FC = () => {
  const [users, setUsers] = useState<EnrichedUser[]>([]);
  const [logs, setLogs] = useState<LogFile[]>([]);
  const [activeTab, setActiveTab] = useState<'users' | 'logs' | 'config'>('users');
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Expanded row details
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [userGpuForms, setUserGpuForms] = useState<Record<string, any>>({});
  const [lastGpuLogs, setLastGpuLogs] = useState<Record<string, string>>({});
  const [activeDropdownUser, setActiveDropdownUser] = useState<string | null>(null);
  const [deleteUserInfo, setDeleteUserInfo] = useState<{ username: string } | null>(null);
  const [purgeUserData, setPurgeUserData] = useState<boolean>(false);
  const [resetPasswordUser, setResetPasswordUser] = useState<string | null>(null);

  // Global Config form
  const [configForm, setConfigForm] = useState<GlobalGpuConfig>({});
  const [newPubKey, setNewPubKey] = useState<string>('');

  // Modals & SSE
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newUsername, setNewUsername] = useState<string>('');
  const [otpInfo, setOtpInfo] = useState<{ username: string; tempPass: string } | null>(null);
  const [activeInitUser, setActiveInitUser] = useState<string | null>(null);
  const [gpuInitRunning, setGpuInitRunning] = useState<boolean>(false);

  // Log tab view details
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [selectedLogContent, setSelectedLogContent] = useState<string>('');
  const [logFilter, setLogFilter] = useState<string>('all');

  const { addToast } = useToast();
  const navigate = useNavigate();

  const fetchAdminData = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const response = await fetch('/api/admin/users');
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          navigate('/login');
          return;
        }
        throw new Error('Failed to load admin data');
      }
      const data = await response.json();
      setUsers(data.users);
      setConfigForm((prev) => {
        if (prev._dirty) return prev;
        return data.gpu_config;
      });
      setLogs(data.logs);

      // Initialize GPU form states for users if not already modified
      const forms: Record<string, any> = {};
      data.users.forEach((u: EnrichedUser) => {
        forms[u.username] = {
          gpu_ssh_host: u.gpu_ssh_host || '',
          gpu_ssh_port: u.gpu_ssh_port || 22,
          gpu_ssh_user: u.gpu_ssh_user || 'root',
          gpu_endpoint: u.gpu_endpoint || '',
          gpu_streamlit_endpoint: u.gpu_streamlit_endpoint || '',
          gpu_code_server_endpoint: u.gpu_code_server_endpoint || '',
          gpu_token: u.gpu_token || ''
        };
      });
      setUserGpuForms((prev) => {
        const merged = { ...forms };
        // Preserve any unsaved edits currently in user inputs
        Object.keys(prev).forEach((key) => {
          if (prev[key]._dirty) {
            merged[key] = prev[key];
          }
        });
        return merged;
      });
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    fetchAdminData(true);

    const interval = setInterval(() => {
      fetchAdminData(false);
    }, 5000);

    const handleGlobalClick = () => {
      setActiveDropdownUser(null);
    };
    window.addEventListener('click', handleGlobalClick);

    return () => {
      clearInterval(interval);
      window.removeEventListener('click', handleGlobalClick);
    };
  }, []);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim()) return;

    setRefreshing(true);
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to create user');

      setShowCreateModal(false);
      setNewUsername('');
      setOtpInfo({ username: data.username, tempPass: data.tempPass });
      addToast(`User ${data.username} created!`, 'success');
      fetchAdminData();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleDeleteUser = async (username: string, deleteFiles: boolean) => {
    if (!confirm(`Are you sure you want to delete ${username}?`)) return;

    setRefreshing(true);
    try {
      const response = await fetch(`/api/admin/users/${username}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete_files: deleteFiles })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to delete user');

      addToast(data.message || 'User deleted', 'success');
      fetchAdminData();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleResetPassword = async (username: string) => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/admin/users/${username}/reset-password`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to reset password');

      setOtpInfo({ username, tempPass: data.tempPass });
      addToast('Password reset successful', 'success');
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleUserSession = async (username: string, action: 'start' | 'stop' | 'restart') => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/admin/session/${action}/${username}`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Failed to ${action} session`);

      addToast(`Session ${action}ed for ${username}`, 'success');
      fetchAdminData();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveUserGpu = async (username: string) => {
    const formData = userGpuForms[username];
    setRefreshing(true);
    try {
      const response = await fetch(`/api/admin/gpu/assign/${username}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to assign GPU');

      addToast(`GPU config saved for ${username}`, 'success');
      // Mark as not dirty
      setUserGpuForms((prev) => ({
        ...prev,
        [username]: { ...prev[username], _dirty: false }
      }));
      fetchAdminData();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleRemoveUserGpu = async (username: string) => {
    if (!confirm(`Unassign GPU configuration for ${username}?`)) return;

    setRefreshing(true);
    try {
      const response = await fetch(`/api/admin/gpu/unassign/${username}`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to unassign GPU');

      addToast(`GPU unassigned for ${username}`, 'success');
      fetchAdminData();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleStopGpu = async (username: string) => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/admin/gpu/stop/${username}`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to stop GPU session');

      addToast(`GPU session stopped for ${username}`, 'success');
      fetchAdminData();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleResetGpuStatus = async (username: string) => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/admin/gpu/reset/${username}`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to reset GPU setup status');

      addToast(`GPU setup status reset for ${username}`, 'success');
      fetchAdminData();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const loadLastGpuLog = async (username: string) => {
    try {
      const response = await fetch(`/api/admin/gpu/last-log/${username}`);
      if (response.ok) {
        const data = await response.json();
        setLastGpuLogs((prev) => ({ ...prev, [username]: data.log }));
      }
    } catch (e) {
      // Ignored
    }
  };

  const toggleRowExpand = (username: string) => {
    if (expandedUser === username) {
      setExpandedUser(null);
    } else {
      setExpandedUser(username);
      loadLastGpuLog(username);
    }
  };

  const handleSaveGlobalGpu = async (e: React.FormEvent) => {
    e.preventDefault();
    setRefreshing(true);
    try {
      const response = await fetch('/api/admin/gpu/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ssh_key_path: configForm.ssh_key_path,
          remote_base_dir: configForm.remote_base_dir,
          additional_public_keys: configForm.additional_public_keys
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save global config');

      addToast('Global GPU configuration saved!', 'success');
      setConfigForm((prev) => ({ ...prev, _dirty: false }));
      fetchAdminData();
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddKey = () => {
    if (!newPubKey.trim()) return;
    const currentKeys = configForm.additional_public_keys || '';
    const keysArray = currentKeys.split('\n').map((k) => k.trim()).filter(Boolean);
    if (keysArray.includes(newPubKey.trim())) {
      addToast('Key already added to list', 'error');
      return;
    }
    const updated = [...keysArray, newPubKey.trim()].join('\n');
    setConfigForm((prev) => ({ ...prev, additional_public_keys: updated, _dirty: true }));
    setNewPubKey('');
  };

  const handleDeleteKey = (index: number) => {
    const currentKeys = configForm.additional_public_keys || '';
    const keysArray = currentKeys.split('\n').map((k) => k.trim()).filter(Boolean);
    keysArray.splice(index, 1);
    const updated = keysArray.join('\n');
    setConfigForm((prev) => ({ ...prev, additional_public_keys: updated, _dirty: true }));
  };

  const handleViewLog = async (filename: string) => {
    setSelectedLog(filename);
    setSelectedLogContent('Loading log content...');
    try {
      const response = await fetch(`/api/admin/logs/view?filename=${encodeURIComponent(filename)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to read log file');
      setSelectedLogContent(data.content);
    } catch (err: any) {
      setSelectedLogContent(`Error: ${err.message}`);
    }
  };

  const triggerGpuInit = (username: string) => {
    setActiveInitUser(username);
    setGpuInitRunning(true);
  };

  const handleGpuInitComplete = (success: boolean) => {
    setGpuInitRunning(false);
    setActiveInitUser(null);
    if (success) {
      addToast('GPU Environment initialized successfully!', 'success');
    } else {
      addToast('GPU initialization failed. View logs for details.', 'error');
    }
    fetchAdminData();
  };

  const filteredLogs = logs.filter((l) => {
    if (logFilter === 'all') return true;
    return l.type === logFilter;
  });

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <span className="spinner" style={{ width: '2rem', height: '2rem' }}></span>
        <span style={{ fontSize: '1.1rem', color: 'var(--text-secondary)' }}>Loading admin panel...</span>
      </div>
    );
  }

  return (
    <div className="admin-grid">
      {/* Tabs */}
      <div className="tabs-container">
        <button className={`tab-btn ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>
          👥 User Administration
        </button>
        <button className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
          📋 System Logs
        </button>
        <button className={`tab-btn ${activeTab === 'config' ? 'active' : ''}`} onClick={() => setActiveTab('config')}>
          ⚙️ Config
        </button>
      </div>

      {activeTab === 'users' && (
        <div className="card" style={{ width: '100%' }}>
          <div className="section-title">
            <span>Managed User Instances</span>
            <button onClick={() => setShowCreateModal(true)} className="btn btn-primary btn-sm">
              ＋ Create User
            </button>
          </div>

          <table className="user-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Status Local</th>
                <th>Status GPU</th>
                <th>Port</th>
                <th>Local Server Actions</th>
                <th>GPU Config</th>
                <th>More</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <React.Fragment key={u.username}>
                  <tr>
                    <td data-label="User" style={{ fontWeight: 'bold' }}>
                      {u.username} {u.role === 'admin' ? '👑' : ''}
                    </td>
                    <td data-label="Status Local">
                      {u.is_running ? (
                        <span className="badge badge-running">🟢 Running</span>
                      ) : (
                        <span className="badge badge-stopped">🔴 Stopped</span>
                      )}
                    </td>
                    <td data-label="Status GPU">
                      {u.gpu_ssh_host ? (
                        u.gpu_init_status === 'pending' ? (
                          <span className="badge badge-warning" style={{ color: '#d97706', borderColor: '#f59e0b' }}>⏳ Pending</span>
                        ) : u.gpu_init_status === 'running' ? (
                          <span className="badge badge-warning" style={{ color: '#d97706', borderColor: '#f59e0b' }}>⚙️ Spawning</span>
                        ) : u.gpu_init_status === 'ready' ? (
                          <span className="badge badge-success">🟢 Ready</span>
                        ) : u.gpu_init_status === 'failed' ? (
                          <span className="badge badge-danger">🔴 Failed</span>
                        ) : u.gpu_init_status === 'stopped' ? (
                          <span className="badge badge-stopped">🔴 Stopped</span>
                        ) : (
                          <span className="badge badge-stopped" style={{ opacity: 0.6 }}>⚪ Idle</span>
                        )
                      ) : (
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>N/A</span>
                      )}
                    </td>
                    <td data-label="Port">
                      <code>{u.port || 'N/A'}</code>
                    </td>
                    <td data-label="Local Server Actions" onClick={(e) => e.stopPropagation()}>
                      <div className="action-cell" style={{ display: 'flex', gap: '0.5rem' }}>
                        {u.is_running ? (
                          <button onClick={() => handleUserSession(u.username, 'stop')} className="btn btn-danger btn-sm" disabled={refreshing}>
                            Stop
                          </button>
                        ) : (
                          <button onClick={() => handleUserSession(u.username, 'start')} className="btn btn-success btn-sm" disabled={refreshing}>
                            Start
                          </button>
                        )}
                        <button onClick={() => handleUserSession(u.username, 'restart')} className="btn btn-outline btn-sm" disabled={refreshing || !u.is_running}>
                          Restart
                        </button>
                      </div>
                    </td>
                    <td data-label="GPU Config" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => toggleRowExpand(u.username)}
                        className="btn btn-outline btn-sm"
                      >
                        🖥️ Config
                      </button>
                    </td>
                     <td data-label="Actions" onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
                       <button
                         onClick={(e) => {
                           e.stopPropagation();
                           setActiveDropdownUser((prev) => (prev === u.username ? null : u.username));
                         }}
                         className="btn btn-outline btn-sm"
                         style={{ padding: '0.25rem 0.5rem', minWidth: '32px' }}
                       >
                         ⋮
                       </button>
                       {activeDropdownUser === u.username && (
                         <div
                           className="card"
                           style={{
                             position: 'absolute',
                             right: '1rem',
                             top: '2.5rem',
                             zIndex: 10,
                             padding: '0.5rem 0',
                             minWidth: '160px',
                             boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                             border: '1px solid var(--border-color)',
                             backgroundColor: 'var(--bg-card)'
                           }}
                         >
                           <button
                             onClick={() => {
                               setActiveDropdownUser(null);
                               setResetPasswordUser(u.username);
                             }}
                             className="dropdown-item"
                           >
                             🔑 Reset password
                           </button>
                           {u.role !== 'admin' && (
                             <button
                               onClick={() => {
                                 setActiveDropdownUser(null);
                                 setDeleteUserInfo({ username: u.username });
                                 setPurgeUserData(false);
                               }}
                               className="dropdown-item"
                               style={{ color: 'var(--danger-color)' }}
                             >
                               🗑️ Delete User
                             </button>
                           )}
                         </div>
                       )}
                     </td>
                  </tr>


                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'logs' && (
        <div className="logs-container">
          <div className="logs-sidebar">
            <div className="filter-box">
              <select className="filter-select" value={logFilter} onChange={(e) => setLogFilter(e.target.value)}>
                <option value="all">All Log Types</option>
                <option value="gpu-init">GPU provision logs</option>
                <option value="rsync-to">Rsync To logs</option>
                <option value="rsync-from">Rsync From logs</option>
              </select>
            </div>
            <div className="logs-list">
              {filteredLogs.map((log) => (
                <div
                  key={log.name}
                  className={`log-item ${selectedLog === log.name ? 'active' : ''}`}
                  onClick={() => handleViewLog(log.name)}
                >
                  <div className="log-item-header">{log.name}</div>
                  <div className="log-item-meta">
                    <span
                      className={`log-badge ${
                        log.type === 'gpu-init' ? 'badge-gpu' : log.type === 'rsync-to' ? 'badge-rsync-to' : 'badge-rsync-from'
                      }`}
                    >
                      {log.type}
                    </span>
                    <span>{(log.size / 1024).toFixed(1)} KB</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="logs-viewer">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '1rem', margin: 0 }}>Log Content: {selectedLog || 'No file selected'}</h3>
              {selectedLog && (
                <button onClick={() => handleViewLog(selectedLog)} className="btn btn-outline btn-sm">
                  Refresh
                </button>
              )}
            </div>
            <div className="log-content-area">{selectedLogContent || 'Select a log file from the sidebar to view details.'}</div>
          </div>
        </div>
      )}

      {activeTab === 'config' && (
        <div className="card" style={{ maxWidth: '600px', margin: '0 auto', width: '100%' }}>
          <h3 style={{ fontSize: '1.1rem', marginBottom: '1.25rem' }}>Global GPU SSH Config</h3>
          <form onSubmit={handleSaveGlobalGpu}>
            <div className="form-group">
              <label>SSH Key Path on Host disk</label>
              <input
                type="text"
                className="form-control"
                value={configForm.ssh_key_path || ''}
                onChange={(e) => setConfigForm((prev) => ({ ...prev, ssh_key_path: e.target.value, _dirty: true }))}
                placeholder="e.g. /home/hubjupylab/.ssh/id_ed25519"
                required
              />
            </div>
            <div className="form-group">
              <label>Remote Base Directory</label>
              <input
                type="text"
                className="form-control"
                value={configForm.remote_base_dir || '/workspace'}
                onChange={(e) => setConfigForm((prev) => ({ ...prev, remote_base_dir: e.target.value, _dirty: true }))}
                required
              />
            </div>
            <div className="form-group" style={{ marginTop: '1.5rem' }}>
              <label style={{ fontWeight: 600, display: 'block', marginBottom: '0.5rem' }}>Additional SSH Public Keys</label>
              
              {(() => {
                const keysArray = (configForm.additional_public_keys || "")
                  .split("\n")
                  .map((k) => k.trim())
                  .filter(Boolean);

                if (keysArray.length === 0) {
                  return (
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem', fontStyle: 'italic' }}>
                      No additional public keys configured.
                    </div>
                  );
                }

                return (
                  <table className="user-table" style={{ width: '100%', marginBottom: '1.25rem' }}>
                    <thead>
                      <tr>
                        <th style={{ background: '#1c1c1c' }}>Key</th>
                        <th style={{ width: '100px', textAlign: 'center', background: '#1c1c1c' }}>Manage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keysArray.map((key, index) => {
                        const truncatedKey = formatPubKey(key);
                        return (
                          <tr key={index}>
                            <td style={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all' }}>
                              {truncatedKey}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                style={{ padding: '0.15rem 0.4rem', fontSize: '0.75rem' }}
                                onClick={() => handleDeleteKey(index)}
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })()}

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="text"
                  className="form-control"
                  placeholder="Paste new ssh public key (ssh-ed25519 AAA...)"
                  value={newPubKey}
                  onChange={(e) => setNewPubKey(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={handleAddKey}
                  style={{ whiteSpace: 'nowrap', padding: '0.5rem 1rem' }}
                >
                  ＋ Add Key
                </button>
              </div>
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '1rem' }} disabled={refreshing}>
              Save Global Config
            </button>
          </form>
        </div>
      )}

      {/* User creation modal */}
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="card" style={{ maxWidth: '400px', width: '100%' }}>
            <h3 style={{ marginBottom: '1.25rem' }}>Create User Account</h3>
            <form onSubmit={handleCreateUser}>
              <div className="form-group">
                <label>Alphanumeric Username</label>
                <input
                  type="text"
                  className="form-control"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="e.g. alice"
                  pattern="^[a-zA-Z0-9_-]+$"
                  disabled={refreshing}
                  required
                />
              </div>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                <button type="button" onClick={() => setShowCreateModal(false)} className="btn btn-outline" style={{ flex: 1 }} disabled={refreshing}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={refreshing}>
                  {refreshing ? <span className="spinner"></span> : null}
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* OTP Password display modal */}
      {otpInfo && (
        <PasswordModal
          username={otpInfo.username}
          tempPass={otpInfo.tempPass}
          onClose={() => setOtpInfo(null)}
          title="🔑 Temporary Credentials Configured"
        />
      )}

      {/* Delete User Confirmation Modal */}
      {deleteUserInfo && (
        <div className="modal-overlay">
          <div className="card" style={{ maxWidth: '400px', width: '100%' }}>
            <h3 style={{ marginBottom: '1.25rem', color: 'var(--danger-color)' }}>🗑️ Delete User Account</h3>
            <p style={{ fontSize: '0.9rem', marginBottom: '1.25rem', color: 'var(--text-primary)' }}>
              Are you sure you want to permanently delete the user account <strong>{deleteUserInfo.username}</strong>?
            </p>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
              <input
                type="checkbox"
                id="purge-checkbox"
                checked={purgeUserData}
                onChange={(e) => setPurgeUserData(e.target.checked)}
                style={{ cursor: 'pointer', width: '16px', height: '16px' }}
              />
              <label htmlFor="purge-checkbox" style={{ fontSize: '0.85rem', cursor: 'pointer', userSelect: 'none', color: 'var(--text-primary)' }}>
                Purge all user workspace files
              </label>
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                type="button"
                onClick={() => {
                  setDeleteUserInfo(null);
                  setPurgeUserData(false);
                }}
                className="btn btn-outline"
                style={{ flex: 1 }}
                disabled={refreshing}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const targetUser = deleteUserInfo.username;
                  setDeleteUserInfo(null);
                  await handleDeleteUser(targetUser, purgeUserData);
                  setPurgeUserData(false);
                }}
                className="btn btn-danger"
                style={{ flex: 1 }}
                disabled={refreshing}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password Confirmation Modal */}
      {resetPasswordUser && (
        <div className="modal-overlay">
          <div className="card" style={{ maxWidth: '400px', width: '100%' }}>
            <h3 style={{ marginBottom: '1.25rem', color: 'var(--accent-color)' }}>🔑 Reset User Password</h3>
            <p style={{ fontSize: '0.9rem', marginBottom: '1.5rem', color: 'var(--text-primary)' }}>
              Are you sure you want to reset the password for <strong>{resetPasswordUser}</strong>? This will generate a temporary one-time password.
            </p>
            
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                type="button"
                onClick={() => {
                  setResetPasswordUser(null);
                }}
                className="btn btn-outline"
                style={{ flex: 1 }}
                disabled={refreshing}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const targetUser = resetPasswordUser;
                  setResetPasswordUser(null);
                  await handleResetPassword(targetUser);
                }}
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={refreshing}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slide-over Drawer for GPU Configuration */}
      <div className={`drawer-overlay ${expandedUser ? 'open' : ''}`} onClick={() => setExpandedUser(null)} />
      <div className={`drawer-panel ${expandedUser ? 'open' : ''}`}>
        {expandedUser && (() => {
          const u = users.find((user) => user.username === expandedUser);
          if (!u) return null;
          return (
            <>
              <div className="drawer-header">
                <div>
                  <h3 style={{ fontSize: '1.1rem', margin: 0, color: 'var(--accent-color)' }}>🖥️ GPU Config — {u.username}</h3>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Initialize or customize dedicated GPU
                  </span>
                </div>
                <button className="drawer-close" onClick={() => setExpandedUser(null)}>&times;</button>
              </div>

              <div className="drawer-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: '0.75rem' }}>SSH Host / IP</label>
                    <input
                      type="text"
                      className="form-control"
                      value={userGpuForms[u.username]?.gpu_ssh_host || ''}
                      onChange={(e) =>
                        setUserGpuForms((prev) => ({
                          ...prev,
                          [u.username]: { ...prev[u.username], gpu_ssh_host: e.target.value, _dirty: true }
                        }))
                      }
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: '0.75rem' }}>SSH Port</label>
                    <input
                      type="number"
                      className="form-control"
                      value={userGpuForms[u.username]?.gpu_ssh_port || 22}
                      onChange={(e) =>
                        setUserGpuForms((prev) => ({
                          ...prev,
                          [u.username]: { ...prev[u.username], gpu_ssh_port: parseInt(e.target.value, 10), _dirty: true }
                        }))
                      }
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: '0.75rem' }}>SSH User</label>
                    <input
                      type="text"
                      className="form-control"
                      value={userGpuForms[u.username]?.gpu_ssh_user || 'root'}
                      onChange={(e) =>
                        setUserGpuForms((prev) => ({
                          ...prev,
                          [u.username]: { ...prev[u.username], gpu_ssh_user: e.target.value, _dirty: true }
                        }))
                      }
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: '0.75rem' }}>Jupyter HTTP Endpoint</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="e.g. https://xxxx-8888.proxy.runpod.net"
                      value={userGpuForms[u.username]?.gpu_endpoint || ''}
                      onChange={(e) =>
                        setUserGpuForms((prev) => ({
                          ...prev,
                          [u.username]: { ...prev[u.username], gpu_endpoint: e.target.value, _dirty: true }
                        }))
                      }
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: '0.75rem' }}>Streamlit HTTP Endpoint</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="e.g. https://xxxx-8501.proxy.runpod.net"
                      value={userGpuForms[u.username]?.gpu_streamlit_endpoint || ''}
                      onChange={(e) =>
                        setUserGpuForms((prev) => ({
                          ...prev,
                          [u.username]: { ...prev[u.username], gpu_streamlit_endpoint: e.target.value, _dirty: true }
                        }))
                      }
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: '0.75rem' }}>Code Server Endpoint</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="e.g. https://xxxx-8889.proxy.runpod.net"
                      value={userGpuForms[u.username]?.gpu_code_server_endpoint || ''}
                      onChange={(e) =>
                        setUserGpuForms((prev) => ({
                          ...prev,
                          [u.username]: { ...prev[u.username], gpu_code_server_endpoint: e.target.value, _dirty: true }
                        }))
                      }
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: '0.75rem' }}>Session Token / Password (optional)</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="Leave blank to auto-generate"
                      value={userGpuForms[u.username]?.gpu_token || ''}
                      onChange={(e) =>
                        setUserGpuForms((prev) => ({
                          ...prev,
                          [u.username]: { ...prev[u.username], gpu_token: e.target.value, _dirty: true }
                        }))
                      }
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '1.25rem' }}>
                  <button onClick={() => handleSaveUserGpu(u.username)} className="btn btn-primary btn-sm" disabled={refreshing}>
                    Save Config
                  </button>
                  {u.gpu_endpoint && (
                    <>
                      <button onClick={() => triggerGpuInit(u.username)} className="btn btn-success btn-sm" disabled={refreshing || gpuInitRunning}>
                        Initialize GPU
                      </button>
                      <button onClick={() => handleStopGpu(u.username)} className="btn btn-outline btn-sm" style={{ color: 'var(--danger-color)', borderColor: 'var(--danger-color)' }} disabled={refreshing}>
                        Stop Session
                      </button>
                      <button onClick={() => handleResetGpuStatus(u.username)} className="btn btn-outline btn-sm" disabled={refreshing}>
                        Reset Setup Status
                      </button>
                      <button onClick={() => handleRemoveUserGpu(u.username)} className="btn btn-outline btn-sm" style={{ color: 'var(--danger-hover)' }} disabled={refreshing}>
                        Remove GPU Assignment
                      </button>
                    </>
                  )}
                </div>

                {/* Init Log / Console stream display */}
                {gpuInitRunning && activeInitUser === u.username ? (
                  <SSEConsole
                    streamUrl={`/admin/gpu/init-stream/${u.username}`}
                    actionName="GPU Initialization"
                    onComplete={handleGpuInitComplete}
                  />
                ) : (
                  lastGpuLogs[u.username] && (
                    <div style={{ marginTop: '1.25rem' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.25rem' }}>Last GPU Provision Log:</span>
                      <pre
                        style={{
                          background: '#090d16',
                          padding: '0.75rem',
                          borderRadius: '6px',
                          maxHeight: '180px',
                          overflowY: 'auto',
                          fontFamily: 'monospace',
                          fontSize: '0.8rem',
                          color: '#e2e8f0',
                          whiteSpace: 'pre-wrap'
                        }}
                      >
                        {lastGpuLogs[u.username]}
                      </pre>
                    </div>
                  )
                )}
              </div>
            </>
          );
        })()}
      </div>
    </div>
  );
};
