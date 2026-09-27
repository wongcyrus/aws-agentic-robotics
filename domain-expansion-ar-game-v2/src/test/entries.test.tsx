import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderRoot = vi.fn();
const createRoot = vi.fn(() => ({ render: renderRoot }));

vi.mock('react-dom/client', () => ({ createRoot }));
vi.mock('../components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => children
}));
vi.mock('../pages/BattleApp', () => ({ BattleApp: () => <div>battle</div> }));
vi.mock('../pages/MediaApp', () => ({ MediaApp: () => <div>media</div> }));
vi.mock('../pages/PlayerApp', () => ({ PlayerApp: () => <div>player</div> }));
vi.mock('../pages/ShareApp', () => ({ ShareApp: () => <div>share</div> }));

describe('application entry points', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    createRoot.mockClear();
    renderRoot.mockClear();
    vi.resetModules();
  });

  for (const [name, modulePath] of [
    ['battle', '../battle-entry'],
    ['media', '../media-entry'],
    ['player', '../player-entry'],
    ['share', '../share-entry']
  ] as const) {
    it(`mounts the ${name} application`, async () => {
      await import(modulePath);
      expect(createRoot).toHaveBeenCalledWith(document.getElementById('root'));
      expect(renderRoot).toHaveBeenCalledOnce();
    });
  }
});
