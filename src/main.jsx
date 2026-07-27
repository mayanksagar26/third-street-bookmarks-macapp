// The API shim must land before anything else touches window.fetch.
import './api-base';

import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './boot.css';
import './onboarding.css';
import Boot from './Boot';

ReactDOM.createRoot(document.getElementById('root')).render(<Boot />);
