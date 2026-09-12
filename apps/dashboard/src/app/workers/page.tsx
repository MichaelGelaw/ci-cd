'use client';

import { useEffect, useState } from 'react';
import type { WorkerRecord } from '@mini-ci/types';
import { listWorkers } from '../../lib/api';

export default function WorkersPage() {
  const [workers, setWorkers] = useState<WorkerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadWorkers() {
    try {
      const data = await listWorkers(100, 0);
      setWorkers(data.workers || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWorkers();
    const interval = setInterval(loadWorkers, 3000);
    return () => clearInterval(interval);
  }, []);

  const readyCount = workers.filter((w) => w.status === 'ready').length;
  const busyCount = workers.filter((w) => w.status === 'busy').length;
  const offlineCount = workers.filter((w) => w.status === 'offline').length;

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Execution Workers</h1>
          <p className="page-subtitle">Distributed Python execution nodes, capabilities, and liveness</p>
        </div>
        <button onClick={loadWorkers} className="btn btn-secondary btn-sm">
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: 'var(--error-bg)', color: '#f87171', borderRadius: '8px', marginBottom: '24px' }}>
          {error}
        </div>
      )}

      {/* Summary Grid */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Workers</div>
          <div className="stat-value">{workers.length}</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Ready (Idle)</div>
          <div className="stat-value" style={{ color: '#34d399' }}>
            {readyCount}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Busy (Executing)</div>
          <div className="stat-value" style={{ color: '#fbbf24' }}>
            {busyCount}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Offline / Stale</div>
          <div className="stat-value" style={{ color: '#94a3b8' }}>
            {offlineCount}
          </div>
        </div>
      </div>

      {/* Worker List Table */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Registered Workers ({workers.length})</h2>
        </div>

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Status</th>
                <th>Address</th>
                <th>Capability Tags</th>
                <th>Registered</th>
                <th>Last Heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {workers.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                    {loading ? 'Discovering workers...' : 'No workers registered in cluster'}
                  </td>
                </tr>
              ) : (
                workers.map((w) => (
                  <tr key={w.id}>
                    <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>{w.id}</td>
                    <td style={{ fontWeight: 600 }}>{w.name}</td>
                    <td>
                      <span className={`badge badge-${w.status}`}>{w.status}</span>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--text-muted)' }}>
                      {w.address || 'internal-queue'}
                    </td>
                    <td>
                      {w.tags && w.tags.length > 0 ? (
                        w.tags.map((t) => (
                          <span
                            key={t}
                            style={{
                              display: 'inline-block',
                              background: 'var(--bg-secondary)',
                              padding: '3px 8px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              marginRight: '4px',
                            }}
                          >
                            {t}
                          </span>
                        ))
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>default</span>
                      )}
                    </td>
                    <td style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      {new Date(w.registered_at).toLocaleString()}
                    </td>
                    <td style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      {w.last_heartbeat_at ? new Date(w.last_heartbeat_at).toLocaleTimeString() : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
