import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';      // <-- must be here, at the top
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);
