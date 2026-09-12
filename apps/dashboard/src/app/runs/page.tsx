'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { WorkflowRunRecord, RunStatus } from '@mini-ci/types';
import { listWorkflowRuns } from '../../lib/api';

export default function WorkflowRunsPage() {
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadRuns() {
    try {
      const data = await listWorkflowRuns(100, 0);
      setRuns(data.runs || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRuns();
    const interval = setInterval(loadRuns, 4000);
    return () => clearInterval(interval);
  }, []);

  const filteredRuns =
    statusFilter === 'all'
      ? runs
      : runs.filter((r) => r.status === (statusFilter as RunStatus));

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Workflow Runs</h1>
          <p className="page-subtitle">Track, inspect, and monitor execution across the cluster</p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <select
            className="form-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ width: '160px' }}
          >
            <option value="all">All Statuses</option>
            <option value="running">Running</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button onClick={loadRuns} className="btn btn-secondary btn-sm">
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: 'var(--error-bg)', color: '#f87171', borderRadius: '8px', marginBottom: '24px' }}>
          {error}
        </div>
      )}

      <div className="card">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Workflow</th>
                <th>Status</th>
                <th>Trigger Event</th>
                <th>Branch / Ref</th>
                <th>Commit</th>
                <th>Duration</th>
                <th>Created At</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuns.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                    {loading ? 'Loading workflow runs...' : 'No workflow runs found matching filter'}
                  </td>
                </tr>
              ) : (
                filteredRuns.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                      <Link href={`/runs/${r.id}`} style={{ color: '#60a5fa' }}>
                        {r.id.slice(0, 8)}...
                      </Link>
                    </td>
                    <td style={{ fontWeight: 600 }}>{r.workflow_name}</td>
                    <td>
                      <span className={`badge badge-${r.status}`}>{r.status}</span>
                    </td>
                    <td>{r.trigger_event || 'manual'}</td>
                    <td>
                      {r.commit_ref ? (
                        <span style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                          {r.commit_ref.replace('refs/heads/', '')}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                      {r.commit_sha ? r.commit_sha.slice(0, 7) : '-'}
                    </td>
                    <td>{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(2)}s` : '-'}</td>
                    <td style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td>
                      <Link href={`/runs/${r.id}`} className="btn btn-secondary btn-sm">
                        View Details
                      </Link>
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
