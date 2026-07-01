import React from 'react';
import { useToast } from './Toast';

interface PasswordModalProps {
  username: string;
  tempPass: string;
  onClose: () => void;
  title: string;
}

export const PasswordModal: React.FC<PasswordModalProps> = ({ username, tempPass, onClose, title }) => {
  const { addToast } = useToast();

  const handleCopy = () => {
    navigator.clipboard.writeText(tempPass).then(() => {
      addToast('Password copied to clipboard!', 'success');
    });
  };

  return (
    <div className="modal-overlay">
      <div className="card" style={{ maxWidth: '400px', width: '100%', textAlign: 'center' }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>{title}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
          User <strong>{username}</strong> has been configured with the following temporary password. It must be changed upon login:
        </p>
        <div
          style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            padding: '0.75rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1.5rem'
          }}
        >
          <code
            style={{
              fontSize: '1rem',
              color: 'var(--accent-color)',
              fontWeight: 'bold',
              letterSpacing: '0.05em',
              wordBreak: 'break-all'
            }}
          >
            {tempPass}
          </code>
          <button
            onClick={handleCopy}
            className="copy-btn"
            title="Copy Password"
            style={{ padding: '0.4rem', border: 'none', background: 'transparent', cursor: 'pointer' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>
        <button onClick={onClose} className="btn btn-primary" style={{ width: '100%' }}>
          Done
        </button>
      </div>
    </div>
  );
};
