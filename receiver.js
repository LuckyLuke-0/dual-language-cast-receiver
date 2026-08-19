(() => {
  'use strict';

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const video = document.getElementById('media');
  const subtitle = document.getElementById('subtitle');
  const status = document.getElementById('status');

  playerManager.setMediaElement(video);

  let subtitleCues = [];
  let loadGeneration = 0;
  let expectedAudioTrackId = null;
  let expectAlternateAudio = false;

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

  function showStatus(message) {
    document.body.classList.remove('playing');
    status.textContent = message;
    status.style.display = 'block';
  }

  function hideStatus() {
    document.body.classList.add('playing');
    status.style.display = 'none';
  }

  function applySubtitleStyle(style = {}) {
    const size = Math.max(40, Math.min(80, number(style.textSizePercent, 60)));
    const bottom = Math.max(0, Math.min(30, number(style.bottomMarginPercent, 4)));
    const font = String(style.fontFamily || 'Arial').toLowerCase();
    const backgroundOpacity = Math.max(0, Math.min(1, number(style.backgroundOpacity, 0)));
    const outline = style.blackOutline !== false;
    subtitle.style.setProperty('--subtitle-size', String(size));
    subtitle.style.setProperty('--subtitle-bottom', `${bottom}%`);
    subtitle.style.setProperty('--subtitle-color', style.textColor || '#ffffff');
    subtitle.style.setProperty('--subtitle-font', font === 'verdana' ? 'Verdana, Geneva, sans-serif' : 'Arial, Helvetica, sans-serif');
    subtitle.style.setProperty('--subtitle-spacing', font === 'verdana' ? '0.01em' : '0');
    subtitle.style.setProperty('--subtitle-background', backgroundOpacity > 0 ? colourWithAlpha(style.backgroundColor || '#000000', backgroundOpacity) : 'transparent');
    subtitle.style.setProperty('--subtitle-padding-y', backgroundOpacity > 0 ? '0.12em' : '0');
    subtitle.style.setProperty('--subtitle-padding-x', backgroundOpacity > 0 ? '0.28em' : '0');
    subtitle.style.setProperty('--subtitle-shadow', outline ? '-0.055em -0.055em 0 #000, 0.055em -0.055em 0 #000, -0.055em 0.055em 0 #000, 0.055em 0.055em 0 #000, 0 0 0.08em #000' : 'none');
  }

  function clearSubtitles() {
    subtitleCues = [];
    subtitle.textContent = '';
    subtitle.style.display = 'none';
  }

  function parseTimestamp(value) {
    const parts = value.trim().replace(',', '.').split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part))) return NaN;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  function parseVtt(vtt) {
    return vtt.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/).reduce((cues, block) => {
      const lines = block.split('\n').filter(Boolean);
      const timingIndex = lines.findIndex(line => line.includes('-->'));
      if (timingIndex < 0 || /^NOTE(?:\s|$)/.test(lines[0] || '')) return cues;
      const timing = lines[timingIndex].split('-->');
      const start = parseTimestamp(timing[0]);
      const end = parseTimestamp((timing[1] || '').trim().split(/\s+/)[0]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return cues;
      const text = lines.slice(timingIndex + 1).join('\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      if (text) cues.push({ start, end, text });
      return cues;
    }, []);
  }

  function updateSubtitleFromTime() {
    if (!subtitleCues.length) return;
    const now = video.currentTime;
    const active = subtitleCues.filter(cue => now >= cue.start && now < cue.end);
    subtitle.textContent = active.map(cue => cue.text).join('\n');
    subtitle.style.display = active.length ? 'block' : 'none';
  }

  async function configureSubtitles(url, generation) {
    clearSubtitles();
    if (!url) return;
    try {
      const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const cues = parseVtt(await response.text());
      if (generation !== loadGeneration) return;
      subtitleCues = cues;
      updateSubtitleFromTime();
    } catch (error) {
      console.error('Subtitle loading failed', error);
    }
  }

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, request => {
    loadGeneration += 1;
    const generation = loadGeneration;
    const media = request && request.media ? request.media : {};
    const customData = media.customData || {};
    expectAlternateAudio = customData.nativeAlternateAudio === true;
    expectedAudioTrackId = Number.isFinite(Number(customData.audioTrackId)) ? Number(customData.audioTrackId) : null;

    showStatus(expectAlternateAudio ? 'Muxeo: video + gekozen Cast-audiotrack starten…' : 'Muxeo: video starten…');
    applySubtitleStyle(customData.subtitleStyle || {});
    configureSubtitles(customData.subtitleUrl || '', generation);
    return request;
  });

  playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, () => {
    if (!expectAlternateAudio) return;
    try {
      const manager = playerManager.getAudioTracksManager();
      const tracks = manager.getTracks() || [];
      if (!tracks.length) {
        showStatus('Muxeo: Cast vond geen alternatieve audiotrack');
        return;
      }
      const wanted = expectedAudioTrackId !== null
        ? tracks.find(track => Number(track.trackId) === expectedAudioTrackId)
        : tracks[0];
      if (!wanted) {
        showStatus(`Muxeo: audiotrack ${expectedAudioTrackId} werd niet gevonden`);
        return;
      }
      manager.setActiveById(wanted.trackId);
      console.log('Muxeo active audio track', wanted.trackId, wanted.trackContentId, wanted.trackContentType);
    } catch (error) {
      console.error('Could not activate alternate audio track', error);
      showStatus(`Muxeo: audiotrack kon niet worden geactiveerd (${error && error.message ? error.message : error})`);
    }
  });

  video.addEventListener('playing', hideStatus);
  video.addEventListener('timeupdate', updateSubtitleFromTime);
  video.addEventListener('seeked', updateSubtitleFromTime);
  video.addEventListener('error', () => {
    const code = video.error ? video.error.code : 'onbekend';
    showStatus(`De video kon niet worden afgespeeld (fout ${code})`);
  });

  context.addEventListener(cast.framework.system.EventType.SHUTDOWN, () => {
    loadGeneration += 1;
    clearSubtitles();
  });

  const options = new cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = false;
  context.start(options);
})();
