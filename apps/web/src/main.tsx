import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { startErrorTracking } from './monitoring/errorTracking';

// Optional, never blocks the first render (docs/observability.md#error-tracking).
void startErrorTracking();

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
