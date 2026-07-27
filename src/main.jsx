// The API shim must land before anything else touches window.fetch.
import './api-base';

import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './boot.css';
import './onboarding.css';
import './glass.css';
import Boot from './Boot';

// Set before the first render so the window never flashes opaque. The Rust side
// declares this in an init script and retracts it if the material was
// unavailable; in a browser it is simply absent.
if (window.__TSB_GLASS__) {
  document.documentElement.classList.add('tsb-glass');
}

ReactDOM.createRoot(document.getElementById('root')).render(<Boot />);
