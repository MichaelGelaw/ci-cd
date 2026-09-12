import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'mini-ci | Distributed CI/CD Platform',
  description: 'Real-time distributed workflow execution and monitoring dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="app-container">
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-icon">CI</div>
              <div>
                <div className="brand-title">mini-ci</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Distributed Engine</div>
              </div>
            </div>

            <nav className="nav-links">
              <Link href="/" className="nav-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="7"></rect>
                  <rect x="14" y="3" width="7" height="7"></rect>
                  <rect x="14" y="14" width="7" height="7"></rect>
                  <rect x="3" y="14" width="7" height="7"></rect>
                </svg>
                Overview
              </Link>

              <Link href="/runs" className="nav-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                Workflow Runs
              </Link>

              <Link href="/repositories" className="nav-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                </svg>
                Repositories
              </Link>

              <Link href="/workers" className="nav-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                  <line x1="6" y1="6" x2="6.01" y2="6"></line>
                  <line x1="6" y1="18" x2="6.01" y2="18"></line>
                </svg>
                Workers
              </Link>

              <Link href="/artifacts" className="nav-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                  <line x1="12" y1="22.08" x2="12" y2="12"></line>
                </svg>
                Artifacts
              </Link>
            </nav>

            <div className="sidebar-footer">
              <div>Control Plane: Active</div>
              <div style={{ marginTop: '4px', opacity: 0.7 }}>mini-ci v0.1.0</div>
            </div>
          </aside>

          <div className="main-content">
            <header className="top-bar">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Engine Status:</span>
                <span className="badge badge-ready">Connected</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                  Port 3000 API
                </span>
              </div>
            </header>

            <main>{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
