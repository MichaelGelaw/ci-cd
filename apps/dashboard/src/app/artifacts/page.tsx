'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ArtifactRecord } from '@mini-ci/types';
import { listArtifacts, downloadArtifact } from '../../lib/api';

export default function ArtifactsPage() {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadArtifacts() {
    try {
      const data = await listArtifacts(100, 0);
      setArtifacts(data.artifacts || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadArtifacts();
  }, []);

  const totalBytes = artifacts.reduce((acc, a) => acc + (a.size_bytes || 0), 0);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Artifacts Storage</h1>
          <p className="page-subtitle">Build outputs, reports, logs, and binaries preserved from job runs</p>
        </div>
        <button onClick={loadArtifacts} className="btn btn-secondary btn-sm">
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
          <div className="stat-label">Total Artifacts</div>
          <div className="stat-value">{artifacts.length}</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Total Stored Size</div>
          <div className="stat-value" style={{ color: '#38bdf8' }}>
            {(totalBytes / (1024 * 1024)).toFixed(2)} MB
          </div>
        </div>
      </div>

      {/* Artifacts Table */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">All Stored Artifacts ({artifacts.length})</h2>
        </div>

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Artifact Name</th>
                <th>File Path</th>
                <th>Run ID</th>
                <th>Size</th>
                <th>MIME Type</th>
                <th>Created At</th>
                <th>Download</th>
              </tr>
            </thead>
            <tbody>
              {artifacts.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                    {loading ? 'Loading artifacts...' : 'No artifacts stored yet'}
                  </td>
                </tr>
              ) : (
                artifacts.map((a) => (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 600 }}>{a.name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{a.path}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                      <Link href={`/runs/${a.workflow_run_id}`} style={{ color: '#60a5fa' }}>
                        {a.workflow_run_id.slice(0, 8)}...
                      </Link>
                    </td>
                    <td>{(a.size_bytes / 1024).toFixed(1)} KB</td>
                    <td style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      {a.mime_type || 'application/octet-stream'}
                    </td>
                    <td style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      {new Date(a.created_at).toLocaleString()}
                    </td>
                    <td>
                      <a
                        href="#"
                        onClick={async (event) => {
                          event.preventDefault();
                          try { await downloadArtifact(a.id, a.name); }
                          catch (error) { alert((error as Error).message); }
                        }}
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
