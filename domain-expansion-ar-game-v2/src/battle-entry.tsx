import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client'; import { AuthGate } from './components/AuthGate'; import { BattleApp } from './pages/BattleApp'; import './styles.css';
createRoot(document.getElementById('root')!).render(<StrictMode><AuthGate><BattleApp /></AuthGate></StrictMode>);
