import React, { createContext, useContext, useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { ToastProvider, useToast } from './components/Toast';
import { Login } from './pages/Login';
import { ChangePassword } from './pages/ChangePassword';
import { Dashboard } from './pages/Dashboard';
import { Admin } from './pages/Admin';

interface UserInfo {
  authenticated: boolean;
  username?: string;
  role?: string;
  must_change_password?: boolean;
}

interface AuthContextProps {
  user: UserInfo | null;
  loading: boolean;
  checkAuth: () => Promise<void>;
  logout: () => Promise<void>;
  loginSuccess: (role: string, mustChangePassword: boolean) => void;
}

const AuthContext = createContext<AuthContextProps | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};

const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const { addToast } = useToast();

  const checkAuth = async () => {
    try {
      const response = await fetch('/api/me');
      if (response.ok) {
        const data = await response.json();
        setUser(data);
      } else {
        setUser({ authenticated: false });
      }
    } catch (err) {
      setUser({ authenticated: false });
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      const response = await fetch('/api/logout', { method: 'POST' });
      if (response.ok) {
        setUser({ authenticated: false });
        addToast('Logged out successfully', 'success');
      } else {
        addToast('Failed to logout', 'error');
      }
    } catch (err) {
      addToast('Error logging out', 'error');
    }
  };

  const loginSuccess = (role: string, mustChangePassword: boolean) => {
    setUser({
      authenticated: true,
      role,
      must_change_password: mustChangePassword
    });
    checkAuth();
  };

  useEffect(() => {
    checkAuth();
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, checkAuth, logout, loginSuccess }}>
      {children}
    </AuthContext.Provider>
  );
};

const Header: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  if (!user || !user.authenticated) return null;

  return (
    <header>
      <div className="logo-container" style={{ cursor: 'pointer' }} onClick={() => navigate('/')}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="2" width="20" height="20" rx="4" fill="#E3651D" fillOpacity="0.2" stroke="#E3651D" strokeWidth="2" />
          <circle cx="8" cy="12" r="2" fill="#750E21" />
          <circle cx="16" cy="12" r="2" fill="#BED754" />
        </svg>
        <h1>
          <span className="logo-hub">Hub</span>
          <span className="logo-jupy">Jupy</span>
          <span className="logo-lab">Lab</span>
        </h1>
      </div>
      <div className="nav-user">
        {user.role === 'admin' && location.pathname !== '/admin' && (
          <Link to="/admin" className="btn btn-outline btn-sm" style={{ marginRight: '0.5rem' }}>
            ⚙️ Admin Panel
          </Link>
        )}
        {user.role === 'user' && !user.must_change_password && (
          <Link to="/change-password" style={{ color: 'var(--accent-color)', textDecoration: 'none', fontSize: '0.85rem', marginRight: '0.5rem' }}>
            🔑 Change Password
          </Link>
        )}
        <span>Logged in as: <strong>{user.username}</strong> ({user.role})</span>
        <button onClick={logout} className="btn btn-outline btn-sm">
          Logout
        </button>
      </div>
    </header>
  );
};

const AuthenticatedRoute: React.FC<{ children: React.ReactNode; allowedRole?: string }> = ({ children, allowedRole }) => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <span className="spinner" style={{ width: '2rem', height: '2rem' }}></span>
      </div>
    );
  }

  if (!user || !user.authenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user.must_change_password) {
    return <Navigate to="/change-password" replace />;
  }

  if (allowedRole && user.role !== allowedRole) {
    return <Navigate to={user.role === 'admin' ? '/admin' : '/dashboard'} replace />;
  }

  return <>{children}</>;
};

const RootRedirect: React.FC = () => {
  const { user, loading } = useAuth();

  if (loading) return null;

  if (!user || !user.authenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user.must_change_password) {
    return <Navigate to="/change-password" replace />;
  }

  return <Navigate to={user.role === 'admin' ? '/admin' : '/dashboard'} replace />;
};

const AppContent: React.FC = () => {
  const { user, loading, loginSuccess, checkAuth } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <span className="spinner" style={{ width: '2rem', height: '2rem' }}></span>
      </div>
    );
  }

  return (
    <>
      <Header />
      <main>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route
            path="/login"
            element={
              user?.authenticated ? (
                <Navigate to="/" replace />
              ) : (
                <Login onLoginSuccess={loginSuccess} />
              )
            }
          />
          <Route
            path="/change-password"
            element={
              user?.authenticated ? (
                <ChangePassword
                  username={user.username || ''}
                  onPasswordChanged={checkAuth}
                />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route
            path="/dashboard"
            element={
              <AuthenticatedRoute allowedRole="user">
                <Dashboard />
              </AuthenticatedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <AuthenticatedRoute allowedRole="admin">
                <Admin />
              </AuthenticatedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
};

function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Router>
          <AppContent />
        </Router>
      </AuthProvider>
    </ToastProvider>
  );
}

export default App;
