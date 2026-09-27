import { useEffect, useRef, useState } from 'react';
import { postToPopup, readPopupMessage } from '../services/popupMessaging';

export function MediaApp() {
  const video = useRef<HTMLVideoElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState('Waiting for technique');
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = readPopupMessage(event, window.opener);
      if (!message) return;
      if (message.type === 'PLAY_VIDEO' && video.current) {
        video.current.src = message.videoSrc; void video.current.play(); setStatus(message.videoSrc.split('/').pop() ?? 'Playing');
      }
      if (message.type === 'STOP_VIDEO') video.current?.pause();
    };
    addEventListener('message', listener);
    return () => removeEventListener('message', listener);
  }, []);
  const enable = () => {
    setEnabled(true);
    if (window.opener) postToPopup(window.opener, { type: 'PLAYER_READY' });
  };
  return <main className="media-page" onClick={enable}><video ref={video} autoPlay playsInline controls={enabled} /><div className="media-status"><h1>{enabled ? status : 'Click to enable audio/video'}</h1><p>Origin-validated link: {location.origin}</p></div></main>;
}
