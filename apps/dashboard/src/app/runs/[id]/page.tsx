'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import type { WorkflowRunRecord, JobRecord, ArtifactRecord } from '@mini-ci/types';
import { getWorkflowRun, cancelWorkflowRun, getRunArtifacts, getArtifactDownloadUrl } from '../../../lib/api';

export default function WorkflowRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const runId = resolvedParams.id;

  const [run, setRun] = useState<WorkflowRunRecord | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function loadData() {
    try {
      const [runData, artifactsData] = await Promise.all([
        getWorkflowRun(runId),
        getRunArtifacts(runId).catch(() => ({ artifacts: [] })),
      ]);
      setRun(runData.run);
      setJobs(runData.jobs || []);
      setArtifacts(artifactsData.artifacts || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 3000);
    return () => clearInterval(interval);
  }, [runId]);

  async function handleCancel() {
    if (!confirm('Are you sure you want to cancel this workflow run?')) return;
    setCancelling(true);
    try {
      await cancelWorkflowRun(runId, 'Cancelled from web dashboard');
      await loadData();
    } catch (err) {
      alert(`Cancellation failed: ${(err as Error).message}`);
    } finally {
      setCancelling(false);
    }
  }

  if (loading && !run) {
    return (
      <div className="page-container">
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '60px 0' }}>
          Loading workflow run details...
        </div>
      </div>
    );
  }

  if (error && !run) {
    return (
      <div className="page-container">
        <div style={{ padding: '20px', background: 'var(--error-bg)', color: '#f87171', borderRadius: '8px' }}>
          Failed to load run: {error}
        </div>
        <div style={{ marginTop: '16px' }}>
          <Link href="/runs" className="btn btn-secondary">
            Back to Workflow Runs
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
            <Link href="/runs" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Workflow Runs
            </Link>
            <span style={{ color: 'var(--text-muted)' }}>/</span>
            <span style={{ fontSize: '13px', fontFamily: 'monospace' }}>{runId.slice(0, 8)}</span>
          </div>
          <h1 className="page-title">{run?.workflow_name}</h1>
          <p className="page-subtitle">Run ID: {run?.id}</p>
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          {run && ['pending', 'running'].includes(run.status) && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="btn btn-danger btn-sm"
            >
              {cancelling ? 'Cancelling...' : 'Cancel Run'}
            </button>
          )}
          <button onClick={loadData} className="btn btn-secondary btn-sm">
            Refresh
          </button>
        </div>
      </div>

      {run?.error && (
        <div
          style={{
            padding: '14px 18px',
            backgroundColor: 'var(--error-bg)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            borderRadius: '10px',
            color: '#f87171',
            marginBottom: '24px',
            fontSize: '14px',
          }}
        >
          <strong>Error:</strong> {run.error}
        </div>
      )}

      {/* Overview Cards */}
      <div className="stats-grid" style={{ marginBottom: '24px' }}>
        <div className="stat-card">
          <div className="stat-label">Status</div>
          <div style={{ marginTop: '8px' }}>
            <span className={`badge badge-${run?.status}`}>{run?.status}</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Duration</div>
          <div className="stat-value" style={{ fontSize: '22px' }}>
            {run?.duration_ms ? `${(run.duration_ms / 1000).toFixed(2)}s` : 'Running...'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Trigger Event</div>
          <div className="stat-value" style={{ fontSize: '20px' }}>
            {run?.trigger_event || 'manual'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Branch / Ref</div>
          <div className="stat-value" style={{ fontSize: '16px', fontFamily: 'monospace' }}>
            {run?.commit_ref ? run.commit_ref.replace('refs/heads/', '') : '-'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Commit SHA</div>
          <div className="stat-value" style={{ fontSize: '16px', fontFamily: 'monospace' }}>
            {run?.commit_sha ? run.commit_sha.slice(0, 8) : '-'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Actor</div>
          <div className="stat-value" style={{ fontSize: '18px' }}>
            {run?.trigger_sender || '-'}
          </div>
        </div>
      </div>

      {/* DAG Job Flow */}
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">DAG Execution Graph ({jobs.length} Jobs)</h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Dependency-ordered job scheduling and execution states
            </p>
          </div>
        </div>

        <div className="dag-grid">
          {jobs.map((job) => (
            <Link key={job.id} href={`/jobs/${job.id}`}>
              <div className="dag-card">
                <div className="dag-card-header">
                  <div>
                    <div className="dag-card-title">{job.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                      key: {job.job_key || 'default'}
                    </div>
                  </div>
                  <span className={`badge badge-${job.status}`}>{job.status}</span>
                </div>

                <div className="dag-meta">
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Dependencies: </span>
                    {job.needs && job.needs.length > 0 ? (
                      job.needs.map((dep) => (
                        <span
                          key={dep}
                          style={{
                            background: 'var(--bg-main)',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            marginRight: '4px',
                          }}
                        >
                          {dep}
                        </span>
                      ))
                    ) : (
                      <span style={{ opacity: 0.6 }}>none (root)</span>
                    )}
                  </div>

                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Worker: </span>
                    {job.worker_id ? (
                      <span style={{ fontFamily: 'monospace' }}>{job.worker_id}</span>
                    ) : (
                      <span style={{ opacity: 0.6 }}>unassigned</span>
                    )}
                  </div>

                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Duration: </span>
                    {job.duration_ms ? `${(job.duration_ms / 1000).toFixed(2)}s` : '-'}
                  </div>

                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Attempt: </span>
                    {job.attempt} / {job.max_attempts}
                  </div>
                </div>

                <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end' }}>
                  <span style={{ fontSize: '12px', color: '#60a5fa' }}>View Logs &rarr;</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Artifacts generated by this run */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Run Artifacts ({artifacts.length})</h2>
        </div>

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Artifact Name</th>
                <th>File Path</th>
                <th>Size</th>
                <th>Type</th>
                <th>Created At</th>
                <th>Download</th>
              </tr>
            </thead>
            <tbody>
              {artifacts.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                    No artifacts generated in this workflow run
                  </td>
                </tr>
              ) : (
                artifacts.map((a) => (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 600 }}>{a.name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{a.path}</td>
                    <td>{(a.size_bytes / 1024).toFixed(1)} KB</td>
                    <td style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      {a.mime_type || 'application/octet-stream'}
                    </td>
                    <td style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      {new Date(a.created_at).toLocaleString()}
                    </td>
                    <td>
                      <a
                        href={getArtifactDownloadUrl(a.id)}
                        className="btn btn-secondary btn-sm"
                        download
                      >
                        Download
                      </a>
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
