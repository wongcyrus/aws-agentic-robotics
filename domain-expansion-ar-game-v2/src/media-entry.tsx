import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client'; import { MediaApp } from './pages/MediaApp'; import './styles.css';
createRoot(document.getElementById('root')!).render(<StrictMode><MediaApp /></StrictMode>);
