import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client'; import { AuthGate } from './components/AuthGate'; import { PlayerApp } from './pages/PlayerApp'; import './styles.css';
createRoot(document.getElementById('root')!).render(<StrictMode><AuthGate><PlayerApp /></AuthGate></StrictMode>);
