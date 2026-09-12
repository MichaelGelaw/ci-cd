'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SystemStats, WorkflowRunRecord, WorkerRecord } from '@mini-ci/types';
import { getStats, listWorkflowRuns, listWorkers } from '../lib/api';

export default function OverviewPage() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [workers, setWorkers] = useState<WorkerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadData() {
    try {
      const [statsData, runsData, workersData] = await Promise.all([
        getStats().catch(() => null),
        listWorkflowRuns(10).catch(() => ({ runs: [] })),
        listWorkers(10).catch(() => ({ workers: [] })),
      ]);

      if (statsData) setStats(statsData);
      setRuns(runsData.runs || []);
      setWorkers(workersData.workers || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 4000);
    return () => clearInterval(interval);
  }, []);

  const totalRuns = stats?.runs.total ?? runs.length;
  const activeRuns = stats?.runs.running ?? 0;
  const succeededRuns = stats?.runs.succeeded ?? 0;
  const successRate =
    totalRuns > 0 ? Math.round((succeededRuns / Math.max(totalRuns, 1)) * 100) : 100;
  const readyWorkers = stats?.workers.ready ?? 0;
  const totalRepos = stats?.repositories.total ?? 0;
  const totalArtifacts = stats?.artifacts.total ?? 0;

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-subtitle">Platform health, workflow throughput, and worker allocation</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <a
            href="/api-proxy/metrics"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary btn-sm"
          >
            Prometheus Metrics
          </a>
          <button onClick={loadData} className="btn btn-secondary btn-sm">
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: 'var(--error-bg)', color: '#f87171', borderRadius: '8px', marginBottom: '24px' }}>
          {error}
        </div>
      )}

      {/* Metrics Grid */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Runs</div>
          <div className="stat-value">{loading && !stats ? '-' : totalRuns}</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Active Running</div>
          <div className="stat-value" style={{ color: '#38bdf8' }}>
            {loading && !stats ? '-' : activeRuns}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Success Rate</div>
          <div className="stat-value" style={{ color: '#34d399' }}>
            {loading && !stats ? '-' : `${successRate}%`}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Ready Workers</div>
          <div className="stat-value" style={{ color: '#34d399' }}>
            {loading && !stats ? '-' : `${readyWorkers} / ${stats?.workers.total ?? workers.length}`}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Repositories</div>
          <div className="stat-value">{loading && !stats ? '-' : totalRepos}</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Artifacts Stored</div>
          <div className="stat-value">{loading && !stats ? '-' : totalArtifacts}</div>
        </div>
      </div>

      {/* Recent Workflow Runs */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Recent Workflow Runs</h2>
          <Link href="/runs" className="btn btn-secondary btn-sm">
            View All
          </Link>
        </div>

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Workflow Name</th>
                <th>Status</th>
                <th>Trigger / Ref</th>
                <th>Commit</th>
                <th>Duration</th>
                <th>Created At</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                    {loading ? 'Loading workflow runs...' : 'No workflow runs recorded yet'}
                  </td>
                </tr>
              ) : (
                runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Link href={`/runs/${run.id}`} style={{ fontWeight: 600, color: '#60a5fa' }}>
                        {run.workflow_name}
                      </Link>
                    </td>
                    <td>
                      <span className={`badge badge-${run.status}`}>{run.status}</span>
                    </td>
                    <td>
                      <div style={{ fontSize: '13px' }}>
                        {run.trigger_event || 'manual'}
                        {run.commit_ref && (
                          <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>
                            ({run.commit_ref.replace('refs/heads/', '')})
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                      {run.commit_sha ? run.commit_sha.slice(0, 7) : '-'}
                    </td>
                    <td>{run.duration_ms ? `${(run.duration_ms / 1000).toFixed(2)}s` : '-'}</td>
                    <td style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      {new Date(run.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Registered Workers */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Connected Execution Workers</h2>
          <Link href="/workers" className="btn btn-secondary btn-sm">
            View All
          </Link>
        </div>

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Worker ID</th>
                <th>Name</th>
                <th>Status</th>
                <th>Tags</th>
                <th>Last Heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {workers.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                    {loading ? 'Discovering workers...' : 'No workers registered'}
                  </td>
                </tr>
              ) : (
                workers.map((w) => (
                  <tr key={w.id}>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{w.id}</td>
                    <td style={{ fontWeight: 500 }}>{w.name}</td>
                    <td>
                      <span className={`badge badge-${w.status}`}>{w.status}</span>
                    </td>
                    <td>
                      {w.tags && w.tags.length > 0
                        ? w.tags.map((t) => (
                            <span
                              key={t}
                              style={{
                                display: 'inline-block',
                                background: 'var(--bg-secondary)',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                marginRight: '4px',
                              }}
                            >
                              {t}
                            </span>
                          ))
                        : '-'}
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
