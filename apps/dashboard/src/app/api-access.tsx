'use client';

import { useState } from 'react';

export function ApiAccess() {
  const [key, setKey] = useState('');
  return (
    <details>
      <summary>API access</summary>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (key.trim()) sessionStorage.setItem('mini-ci-api-key', key.trim());
        else sessionStorage.removeItem('mini-ci-api-key');
        window.location.reload();
      }}>
        <label>
          API key for this tab
          <input type="password" value={key} autoComplete="off"
            onChange={(event) => setKey(event.target.value)} />
        </label>
        <button type="submit" className="btn btn-secondary btn-sm">Apply</button>
        <p>Leave empty to clear the saved key.</p>
      </form>
    </details>
  );
}
