import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client'; import { AuthGate } from './components/AuthGate'; import { ShareApp } from './pages/ShareApp'; import './styles.css';
createRoot(document.getElementById('root')!).render(<StrictMode><AuthGate><ShareApp /></AuthGate></StrictMode>);
