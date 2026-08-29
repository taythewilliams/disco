import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Persistent storage is a bonus, never a requirement: everything is
// re-fetchable from the LAN server, and the guest may simply decline (D15).
void navigator.storage?.persist?.().catch(() => {});
