import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/lib/dashboard/App';
import '@/lib/dashboard/dashboard.css';

// The same app the popup renders, in a full tab. Opened from the popup's ↗
// button, which carries the current screen across in the URL hash.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App surface="tab" />
  </React.StrictMode>,
);
