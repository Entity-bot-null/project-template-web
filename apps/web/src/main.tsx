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

// After the first render, never in its way, from chunks of their own
// (docs/observability.md#web-vitals).
import('./monitoring/webVitals')
  .then((webVitals) => webVitals.startWebVitals())
  .catch((error: unknown) => {
    console.error('Web Vitals could not start', error);
  });
