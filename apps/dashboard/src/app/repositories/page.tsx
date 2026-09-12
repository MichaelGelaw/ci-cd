'use client';

import { useEffect, useState } from 'react';
import type { RepositoryRecord, RegisteredWorkflowRecord } from '@mini-ci/types';
import {
  listRepositories,
  createRepository,
  listRepositoryWorkflows,
  createRepositoryWorkflow,
} from '../../lib/api';

export default function RepositoriesPage() {
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [repoWorkflows, setRepoWorkflows] = useState<Record<string, RegisteredWorkflowRecord[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New Repo Form State
  const [showNewRepo, setShowNewRepo] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [secret, setSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // New Workflow Form State
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowYaml, setWorkflowYaml] = useState(`name: CI
on:
  push:
    branches: [main]
steps:
  - run: echo "Running CI in container"
`);

  async function loadRepositories() {
    try {
      const data = await listRepositories(50, 0);
      setRepositories(data.repositories || []);

      // Load workflows for each repo
      for (const repo of data.repositories || []) {
        try {
          const wfData = await listRepositoryWorkflows(repo.id);
          setRepoWorkflows((prev) => ({ ...prev, [repo.id]: wfData.workflows || [] }));
        } catch {
          // Ignore
        }
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRepositories();
  }, []);

  async function handleCreateRepository(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await createRepository({
        name: name.trim(),
        url: url.trim() || undefined,
        default_branch: defaultBranch.trim() || 'main',
        webhook_secret: secret.trim() || undefined,
      });
      setName('');
      setUrl('');
      setSecret('');
      setShowNewRepo(false);
      await loadRepositories();
    } catch (err) {
      alert(`Failed to create repository: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddWorkflow(repoId: string, e: React.FormEvent) {
    e.preventDefault();
    if (!workflowYaml.trim()) return;
    try {
      await createRepositoryWorkflow(repoId, {
        name: workflowName.trim() || undefined,
        content: workflowYaml,
        is_active: true,
      });
      setWorkflowName('');
      setActiveRepoId(null);
      const wfData = await listRepositoryWorkflows(repoId);
      setRepoWorkflows((prev) => ({ ...prev, [repoId]: wfData.workflows || [] }));
    } catch (err) {
      alert(`Failed to register workflow: ${(err as Error).message}`);
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Repositories</h1>
          <p className="page-subtitle">Configured Git repositories and webhook-triggered workflows</p>
        </div>
        <button
          onClick={() => setShowNewRepo(!showNewRepo)}
          className="btn btn-primary btn-sm"
        >
          {showNewRepo ? 'Cancel' : '+ Register Repository'}
        </button>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: 'var(--error-bg)', color: '#f87171', borderRadius: '8px', marginBottom: '24px' }}>
          {error}
        </div>
      )}

      {/* Register Repository Form */}
      {showNewRepo && (
        <div className="card" style={{ border: '1px solid var(--primary)', marginBottom: '28px' }}>
          <h2 className="card-title" style={{ marginBottom: '16px' }}>Register New Repository</h2>
          <form onSubmit={handleCreateRepository}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
              <div className="form-group">
                <label className="form-label">Repository Name (owner/repo)</label>
                <input
                  className="form-input"
                  placeholder="e.g. acme/web-app"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Git Clone URL (Optional)</label>
                <input
                  className="form-input"
                  placeholder="https://github.com/acme/web-app"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Default Branch</label>
                <input
                  className="form-input"
                  placeholder="main"
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Webhook Secret (Optional)</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="HMAC secret token"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '12px' }}>
              <button
                type="button"
                onClick={() => setShowNewRepo(false)}
                className="btn btn-secondary btn-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="btn btn-primary btn-sm"
              >
                {submitting ? 'Saving...' : 'Register Repository'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Repositories List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {repositories.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px' }}>
            {loading ? 'Loading repositories...' : 'No repositories registered yet'}
          </div>
        ) : (
          repositories.map((repo) => {
            const workflows = repoWorkflows[repo.id] || [];
            return (
              <div key={repo.id} className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title" style={{ fontSize: '20px', color: '#60a5fa' }}>
                      {repo.name}
                    </h2>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      ID: {repo.id} &bull; Default branch: <strong style={{ color: 'var(--text-main)' }}>{repo.default_branch}</strong>
                      {repo.webhook_secret ? ' &bull; Secret configured' : ''}
                    </div>
                  </div>

                  <button
                    onClick={() => setActiveRepoId(activeRepoId === repo.id ? null : repo.id)}
                    className="btn btn-secondary btn-sm"
                  >
                    {activeRepoId === repo.id ? 'Close' : '+ Add Workflow'}
                  </button>
                </div>

                {/* Add Workflow Form */}
                {activeRepoId === repo.id && (
                  <div
                    style={{
                      background: 'var(--bg-secondary)',
                      padding: '20px',
                      borderRadius: '8px',
                      marginBottom: '20px',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>
                      Register Workflow YAML for {repo.name}
                    </h3>
                    <form onSubmit={(e) => handleAddWorkflow(repo.id, e)}>
                      <div className="form-group">
                        <label className="form-label">Workflow Name (Optional)</label>
                        <input
                          className="form-input"
                          placeholder="CI / Build"
                          value={workflowName}
                          onChange={(e) => setWorkflowName(e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">YAML Workflow Definition</label>
                        <textarea
                          className="form-textarea"
                          rows={6}
                          style={{ fontFamily: 'monospace', fontSize: '13px' }}
                          value={workflowYaml}
                          onChange={(e) => setWorkflowYaml(e.target.value)}
                          required
                        />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                        <button
                          type="button"
                          onClick={() => setActiveRepoId(null)}
                          className="btn btn-secondary btn-sm"
                        >
                          Cancel
                        </button>
                        <button type="submit" className="btn btn-primary btn-sm">
                          Save Workflow
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Workflows Table */}
                <div>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '10px' }}>
                    Registered Workflows ({workflows.length})
                  </h3>
                  {workflows.length === 0 ? (
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      No workflows registered for this repository
                    </div>
                  ) : (
                    <div className="table-container">
                      <table>
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Path</th>
                            <th>Active</th>
                            <th>Updated</th>
                          </tr>
                        </thead>
                        <tbody>
                          {workflows.map((wf) => (
                            <tr key={wf.id}>
                              <td style={{ fontWeight: 600 }}>{wf.name}</td>
                              <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{wf.path}</td>
                              <td>
                                <span className={`badge badge-${wf.is_active ? 'ready' : 'offline'}`}>
                                  {wf.is_active ? 'Active' : 'Disabled'}
                                </span>
                              </td>
                              <td style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                                {new Date(wf.updated_at).toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
