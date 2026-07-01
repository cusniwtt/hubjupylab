import React, { useState } from 'react';
import { useToast } from '../components/Toast';

interface LoginProps {
  onLoginSuccess: (role: string, mustChangePassword: boolean) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      addToast('Please enter both username and password.', 'error');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      addToast('Logged in successfully!', 'success');
      onLoginSuccess(data.role, data.must_change_password);
    } catch (err: any) {
      addToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrapper">
      <div className="login-card card">
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ margin: '0 auto 0.5rem' }}>
            <rect x="2" y="2" width="20" height="20" rx="4" fill="#E3651D" fillOpacity="0.2" stroke="#E3651D" strokeWidth="2" />
            <circle cx="8" cy="12" r="2" fill="#750E21" />
            <circle cx="16" cy="12" r="2" fill="#BED754" />
          </svg>
          <h2>
            <span className="logo-hub">Hub</span>
            <span className="logo-jupy">Jupy</span>
            <span className="logo-lab">Lab</span>
          </h2>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              type="text"
              id="username"
              className="form-control"
              placeholder="Enter your username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              autoComplete="username"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              type="password"
              id="password"
              className="form-control"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              autoComplete="current-password"
              required
            />
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }} disabled={loading}>
            {loading ? <span className="spinner" style={{ marginRight: '0.5rem' }}></span> : null}
            {loading ? 'Logging in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};
