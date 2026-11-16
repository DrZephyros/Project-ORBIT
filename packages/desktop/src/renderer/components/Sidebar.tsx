/**
 * Three tabs: pair the iPad, watch what it is showing, and check the camera
 * preview that drives gesture control.
 */
export type PageId = 'setup' | 'workspace' | 'gestures';

interface Props {
  page: PageId;
  onNavigate: (page: PageId) => void;
  link: 'connecting' | 'online' | 'offline';
  streaming: boolean;
  camera: 'starting' | 'live' | 'off' | 'failed';
}

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'setup', label: 'Setup', icon: 'M4 3h8v10H4zM3 14h10' },
  { id: 'workspace', label: 'Workspace', icon: 'M2 3h12v10H2zM2 7h12M7 7v6' },
  {
    id: 'gestures',
    label: 'Gestures',
    icon: 'M6 7.5V5a1.3 1.3 0 012.6 0v2.2m0-.6a1.3 1.3 0 012.6 0v2m0-.4a1.2 1.2 0 012.4 0v2.9a3.9 3.9 0 01-3.9 3.9h-.9a3.4 3.4 0 01-2.5-1.1L4 11.4a1.3 1.3 0 011.8-1.8l1.2 1.1',
  },
];

export function Sidebar({ page, onNavigate, link, streaming, camera }: Props) {
  return (
    <aside className="sidebar">
      <div className="logo">
        <span className="logo-dot" />
        ORBIT
      </div>

      {NAV.map((item) => (
        <button
          key={item.id}
          className={`nav-item${page === item.id ? ' active' : ''}`}
          onClick={() => onNavigate(item.id)}
          aria-current={page === item.id ? 'page' : undefined}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d={item.icon} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {item.label}
        </button>
      ))}

      <div className="nav-spacer" />

      <div className="link-status">
        <span className={`dot ${link === 'online' ? 'online' : link === 'offline' ? 'offline' : 'warn'}`} />
        <span>
          {link === 'online' ? (streaming ? 'Session live' : 'Connected') : link === 'offline' ? 'Reconnecting' : 'Starting…'}
        </span>
      </div>
      <div className="link-status camera-status">
        <span
          className={`dot ${
            camera === 'live' ? 'online' : camera === 'starting' ? 'warn' : camera === 'failed' ? 'offline' : 'offline'
          }`}
        />
        <span>
          {camera === 'live'
            ? 'Camera on'
            : camera === 'starting'
              ? 'Camera starting…'
              : camera === 'failed'
                ? 'Camera failed'
                : 'Camera off'}
        </span>
      </div>
    </aside>
  );
}
