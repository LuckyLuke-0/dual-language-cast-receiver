(() => {
  'use strict';

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const video = document.getElementById('media');
  playerManager.setMediaElement(video);
  const subtitle = document.getElementById('subtitle');
  const status = document.getElementById('status');
  // The alternate-language source is a complete MP4 (video + audio), not an
  // audio-only file. Some Cast implementations reject that source in an
  // <audio> element. A visually hidden <video> keeps the MP4 container
  // compatible while only its sound is used.
  const audio = document.createElement('video');

  audio.id = 'alternate-audio-source';
  audio.preload = 'auto';
  audio.crossOrigin = 'anonymous';
  audio.playsInline = true;
  audio.muted = false;
  audio.volume = 1;
  audio.style.position = 'fixed';
  audio.style.width = '1px';
  audio.style.height = '1px';
  audio.style.left = '-10px';
  audio.style.top = '-10px';
  audio.style.opacity = '0';
  audio.style.pointerEvents = 'none';
  document.body.appendChild(audio);

  let trackElement = null;
  let subtitleCues = [];
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
    subtitleCues = [];
    subtitle.textContent = '';
    subtitle.style.display = 'none';
    if (trackElement) {
      trackElement.remove();
      trackElement = null;
    }
  }

  function parseTimestamp(value) {
    const parts = value.trim().replace(',', '.').split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part))) return NaN;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  function parseVtt(vtt) {
    const blocks = vtt
      .replace(/^\uFEFF/, '')
      .replace(/\r/g, '')
      .split(/\n{2,}/);

    return blocks.flatMap(block => {
      const lines = block.split('\n').filter(Boolean);
      const timingIndex = lines.findIndex(line => line.includes('-->'));
      if (timingIndex < 0 || /^NOTE(?:\s|$)/.test(lines[0] || '')) return [];

      const timing = lines[timingIndex].split('-->');
      const start = parseTimestamp(timing[0]);
      const end = parseTimestamp((timing[1] || '').trim().split(/\s+/)[0]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

      const text = lines
        .slice(timingIndex + 1)
        .join('\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

      return text ? [{ start, end, text }] : [];
    });
  }

  function updateSubtitleFromTime() {
    if (!subtitleCues.length) return;
    const now = video.currentTime;
    const active = subtitleCues.filter(cue => now >= cue.start && now < cue.end);
    subtitle.textContent = active.map(cue => cue.text).join('\n');
    subtitle.style.display = active.length ? 'block' : 'none';
  }

  async function configureSubtitles(url) {
    clearSubtitles();
    status.style.display = 'none';
    if (!url) return;

    try {
      const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      subtitleCues = parseVtt(await response.text());
      if (!subtitleCues.length) throw new Error('Geen geldige VTT-regels gevonden');
      updateSubtitleFromTime();
    } catch (error) {
      status.style.display = 'none';
      console.error('Subtitle loading failed', error);
    }
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
      document.body.classList.remove('playing');
      status.textContent = 'De gekozen audiotrack kon niet worden gestart';
      status.style.display = 'block';
      console.error('Secondary audio playback failed', error);
    }
  }

  function configureAudio(url) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (!url) return;
    audio.src = url;
    audio.muted = false;
    audio.volume = 1;
    audio.currentTime = pendingStartTime;
    audio.load();
  }

  video.addEventListener('play', () => {
    document.body.classList.add('playing');
    playAudio();
  });
  video.addEventListener('pause', () => audio.pause());
  video.addEventListener('seeking', hardSync);
  video.addEventListener('timeupdate', updateSubtitleFromTime);
  video.addEventListener('seeked', updateSubtitleFromTime);
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
      configureSubtitles(custom.subtitleUrl || '');

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
    disableIdleTimeout: false,
    supportedCommands:
      cast.framework.messages.Command.PAUSE |
      cast.framework.messages.Command.SEEK |
      cast.framework.messages.Command.STREAM_VOLUME
  });
})();
