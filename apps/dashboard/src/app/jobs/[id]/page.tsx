'use client';

import { useEffect, useState, useRef, use } from 'react';
import Link from 'next/link';
import type { JobRecord, ArtifactRecord, LogChunk } from '@mini-ci/types';
import {
  getJob,
  cancelJob,
  getJobLogs,
  getJobArtifacts,
  getArtifactDownloadUrl,
  subscribeJobLogs,
} from '../../../lib/api';

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const jobId = resolvedParams.id;

  const [job, setJob] = useState<JobRecord | null>(null);
  const [logs, setLogs] = useState<Array<{ text: string; stream: 'stdout' | 'stderr'; ts: string }>>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  async function loadJob() {
    try {
      const [jobData, artifactsData, initialLogs] = await Promise.all([
        getJob(jobId),
        getJobArtifacts(jobId).catch(() => ({ artifacts: [] })),
        getJobLogs(jobId).catch(() => ({ logs: [] })),
      ]);

      setJob(jobData.job);
      setArtifacts(artifactsData.artifacts || []);

      if (initialLogs.logs && initialLogs.logs.length > 0) {
        setLogs(
          initialLogs.logs.map((line: string) => ({
            text: line,
            stream: 'stdout',
            ts: new Date().toLocaleTimeString(),
          })),
        );
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadJob();
  }, [jobId]);

  // Live log streaming via Server-Sent Events
  useEffect(() => {
    const unsubscribe = subscribeJobLogs(
      jobId,
      (chunk: LogChunk) => {
        setLogs((prev) => [
          ...prev,
          {
            text: chunk.data,
            stream: chunk.stream,
            ts: chunk.timestamp ? new Date(chunk.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString(),
          },
        ]);
      },
      () => {
        // Stream ended, refresh job status
        getJob(jobId).then((data) => setJob(data.job)).catch(() => {});
      },
    );

    return () => {
      unsubscribe();
    };
  }, [jobId]);

  // Auto-scroll terminal
  useEffect(() => {
    if (autoScroll && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  async function handleCancel() {
    if (!confirm('Are you sure you want to cancel this job?')) return;
    setCancelling(true);
    try {
      await cancelJob(jobId, 'Cancelled from web dashboard');
      await loadJob();
    } catch (err) {
      alert(`Job cancellation failed: ${(err as Error).message}`);
    } finally {
      setCancelling(false);
    }
  }

  function handleCopyLogs() {
    const text = logs.map((l) => l.text).join('\n');
    navigator.clipboard.writeText(text);
    alert('Logs copied to clipboard!');
  }

  if (loading && !job) {
    return (
      <div className="page-container">
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '60px 0' }}>
          Loading job details...
        </div>
      </div>
    );
  }

  if (error && !job) {
    return (
      <div className="page-container">
        <div style={{ padding: '20px', background: 'var(--error-bg)', color: '#f87171', borderRadius: '8px' }}>
          Failed to load job: {error}
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
              Runs
            </Link>
            <span style={{ color: 'var(--text-muted)' }}>/</span>
            <Link href={`/runs/${job?.workflow_run_id}`} style={{ fontSize: '13px', color: '#60a5fa', fontFamily: 'monospace' }}>
              {job?.workflow_run_id.slice(0, 8)}
            </Link>
            <span style={{ color: 'var(--text-muted)' }}>/</span>
            <span style={{ fontSize: '13px', fontFamily: 'monospace' }}>{job?.job_key || 'job'}</span>
          </div>
          <h1 className="page-title">{job?.name}</h1>
          <p className="page-subtitle">Job ID: {job?.id}</p>
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          {job && ['queued', 'assigned', 'running', 'retrying'].includes(job.status) && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="btn btn-danger btn-sm"
            >
              {cancelling ? 'Cancelling...' : 'Cancel Job'}
            </button>
          )}
          <button onClick={loadJob} className="btn btn-secondary btn-sm">
            Refresh
          </button>
        </div>
      </div>

      {/* Overview Cards */}
      <div className="stats-grid" style={{ marginBottom: '24px' }}>
        <div className="stat-card">
          <div className="stat-label">Status</div>
          <div style={{ marginTop: '8px' }}>
            <span className={`badge badge-${job?.status}`}>{job?.status}</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Exit Code</div>
          <div className="stat-value" style={{ fontSize: '20px' }}>
            {job?.exit_code !== null && job?.exit_code !== undefined ? job.exit_code : '-'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Duration</div>
          <div className="stat-value" style={{ fontSize: '20px' }}>
            {job?.duration_ms ? `${(job.duration_ms / 1000).toFixed(2)}s` : 'Running...'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Worker</div>
          <div className="stat-value" style={{ fontSize: '15px', fontFamily: 'monospace' }}>
            {job?.worker_id || 'unassigned'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Container Image</div>
          <div className="stat-value" style={{ fontSize: '14px', fontFamily: 'monospace' }}>
            {job?.image || 'native-shell'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Attempts</div>
          <div className="stat-value" style={{ fontSize: '20px' }}>
            {job?.attempt} / {job?.max_attempts}
          </div>
        </div>
      </div>

      {/* Live Terminal Log Stream */}
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Live Execution Logs</h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Real-time stdout/stderr stream from worker container
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              Auto-scroll
            </label>
            <button onClick={handleCopyLogs} className="btn btn-secondary btn-sm">
              Copy Logs
            </button>
          </div>
        </div>

        <div className="terminal-window">
          <div className="terminal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ef4444' }}></div>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#f59e0b' }}></div>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#10b981' }}></div>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '8px' }}>
                terminal &mdash; {job?.command ? job.command.split('\n')[0] : 'job shell'}
              </span>
            </div>
            <span style={{ fontSize: '11px', color: '#64748b' }}>
              {logs.length} lines captured
            </span>
          </div>

          <div className="terminal-body">
            {logs.length === 0 ? (
              <div style={{ color: '#64748b', fontStyle: 'italic' }}>
                Waiting for logs from worker process...
              </div>
            ) : (
              logs.map((l, idx) => (
                <div key={idx} className="log-line">
                  <span className="log-ts">[{l.ts}]</span>
                  <span className={l.stream === 'stderr' ? 'log-stderr' : 'log-stdout'}>
                    {l.text}
                  </span>
                </div>
              ))
            )}
            <div ref={terminalEndRef} />
          </div>
        </div>
      </div>

      {/* Artifacts Table */}
      {artifacts.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Job Artifacts ({artifacts.length})</h2>
          </div>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Path</th>
                  <th>Size</th>
                  <th>Type</th>
                  <th>Download</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((a) => (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 600 }}>{a.name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{a.path}</td>
                    <td>{(a.size_bytes / 1024).toFixed(1)} KB</td>
                    <td style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      {a.mime_type || 'application/octet-stream'}
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
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
