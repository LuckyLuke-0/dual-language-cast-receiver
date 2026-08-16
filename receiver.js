(() => {
  'use strict';

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const video = document.getElementById('media');
  playerManager.setMediaElement(video);
  const subtitle = document.getElementById('subtitle');
  const status = document.getElementById('status');
  const audio = document.createElement('audio');

  audio.preload = 'auto';
  audio.crossOrigin = 'anonymous';
  document.body.appendChild(audio);

  let trackElement = null;
  let syncTimer = null;
  let pendingStartTime = 0;

  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const colourWithAlpha = (colour, alpha) => {
    if (typeof colour !== 'string') return `rgba(0,0,0,${alpha})`;
    const hex = colour.trim().replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return colour;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };

  function applySubtitleStyle(style = {}) {
    const size = Math.max(40, Math.min(80, number(style.textSizePercent, 60)));
    const bottom = Math.max(0, Math.min(30, number(style.bottomMarginPercent, 4)));
    const font = String(style.fontFamily || 'Arial').toLowerCase();
    const backgroundOpacity = Math.max(0, Math.min(1, number(style.backgroundOpacity, 0)));
    const outline = style.blackOutline !== false;

    subtitle.style.setProperty('--subtitle-size', String(size));
    subtitle.style.setProperty('--subtitle-bottom', `${bottom}%`);
    subtitle.style.setProperty('--subtitle-color', style.textColor || '#ffffff');
    subtitle.style.setProperty(
      '--subtitle-font',
      font === 'verdana' ? 'Verdana, Geneva, sans-serif' : 'Arial, Helvetica, sans-serif'
    );
    subtitle.style.setProperty('--subtitle-spacing', font === 'verdana' ? '0.01em' : '0');
    subtitle.style.setProperty(
      '--subtitle-background',
      backgroundOpacity > 0
        ? colourWithAlpha(style.backgroundColor || '#000000', backgroundOpacity)
        : 'transparent'
    );
    subtitle.style.setProperty('--subtitle-padding-y', backgroundOpacity > 0 ? '0.12em' : '0');
    subtitle.style.setProperty('--subtitle-padding-x', backgroundOpacity > 0 ? '0.28em' : '0');
    subtitle.style.setProperty(
      '--subtitle-shadow',
      outline
        ? '-0.055em -0.055em 0 #000, 0.055em -0.055em 0 #000, -0.055em 0.055em 0 #000, 0.055em 0.055em 0 #000, 0 0 0.08em #000'
        : 'none'
    );
  }

  function clearSubtitles() {
    subtitle.textContent = '';
    subtitle.style.display = 'none';
    if (trackElement) {
      trackElement.remove();
      trackElement = null;
    }
  }

  function configureSubtitles(url) {
    clearSubtitles();
    if (!url) return;

    trackElement = document.createElement('track');
    trackElement.kind = 'subtitles';
    trackElement.label = 'English';
    trackElement.srclang = 'en';
    trackElement.src = url;
    video.appendChild(trackElement);

    trackElement.addEventListener('load', () => {
      trackElement.track.mode = 'hidden';
      trackElement.track.addEventListener('cuechange', () => {
        const cues = Array.from(trackElement.track.activeCues || []);
        subtitle.textContent = cues.map(cue => cue.text).join('\n');
        subtitle.style.display = cues.length ? 'block' : 'none';
      });
    });
  }

  function hardSync() {
    if (!audio.src || !Number.isFinite(video.currentTime)) return;
    const drift = Math.abs(audio.currentTime - video.currentTime);
    if (drift > 0.22) audio.currentTime = video.currentTime;
  }

  async function playAudio() {
    if (!audio.src) return;
    hardSync();
    try {
      await audio.play();
    } catch (error) {
      status.textContent = 'Engelse audio kon niet worden gestart';
      console.error('Secondary audio playback failed', error);
    }
  }

  function configureAudio(url) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (!url) return;
    audio.src = url;
    audio.currentTime = pendingStartTime;
    audio.load();
  }

  video.addEventListener('play', () => {
    document.body.classList.add('playing');
    playAudio();
  });
  video.addEventListener('pause', () => audio.pause());
  video.addEventListener('seeking', hardSync);
  video.addEventListener('seeked', hardSync);
  video.addEventListener('ratechange', () => {
    audio.playbackRate = video.playbackRate;
  });
  video.addEventListener('ended', () => audio.pause());
  video.addEventListener('volumechange', () => {
    video.muted = true;
  });

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    loadRequest => {
      const custom = loadRequest.media?.customData || {};
      pendingStartTime = number(loadRequest.currentTime, 0);

      if (!custom.audioUrl) {
        throw new Error('audioUrl ontbreekt in de Cast-aanvraag');
      }

      document.body.classList.remove('playing');
      status.textContent = 'Video voorbereiden…';
      video.muted = true;
      applySubtitleStyle(custom.subtitleStyle || {});
      configureAudio(custom.audioUrl);
      configureSubtitles(custom.subtitleUrl);

      if (syncTimer) clearInterval(syncTimer);
      syncTimer = setInterval(() => {
        if (!video.paused && !audio.paused) hardSync();
      }, 1000);

      return loadRequest;
    }
  );

  context.addEventListener(
    cast.framework.system.EventType.SHUTDOWN,
    () => {
      audio.pause();
      if (syncTimer) clearInterval(syncTimer);
    }
  );

  context.start({
    disableIdleTimeout: true,
    supportedCommands:
      cast.framework.messages.Command.PAUSE |
      cast.framework.messages.Command.SEEK |
      cast.framework.messages.Command.STREAM_VOLUME
  });
})();
