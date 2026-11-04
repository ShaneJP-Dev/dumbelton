import { useEffect } from 'react';
import { ToastHost } from './components/ui';
import { requestPersistence } from './audio/import/pcmStore';
import { flushSaves, refreshLibrary, routeFromHash } from './state/actions';
import { setState, useApp } from './state/store';
import { LibraryView } from './views/LibraryView';
import { SongView } from './views/SongView';
import { SetlistsView, SetlistView } from './views/SetlistsView';
import { OutputsView } from './views/OutputsView';

export default function App() {
  const route = useApp((s) => s.route);

  useEffect(() => {
    const sync = () => setState({ route: routeFromHash(window.location.hash) });
    sync();
    window.addEventListener('hashchange', sync);
    void refreshLibrary();
    void requestPersistence();
    const onHide = () => void flushSaves();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  return (
    <div className="h-full">
      {route.name === 'library' && <LibraryView />}
      {route.name === 'song' && <SongView id={route.id} />}
      {route.name === 'setlists' && <SetlistsView />}
      {route.name === 'setlist' && <SetlistView id={route.id} />}
      {route.name === 'outputs' && <OutputsView />}
      <ToastHost />
    </div>
  );
}
