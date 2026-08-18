(() => {
  'use strict';

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const video = document.getElementById('media');
  const audio = document.getElementById('companion-audio');
  const subtitle = document.getElementById('subtitle');
  const status = document.getElementById('status');

  playerManager.setMediaElement(video);

  const HARD_SYNC_DRIFT_SECONDS = 0.35;
  const SOFT_SYNC_DRIFT_SECONDS = 0.12;
  const SYNC_INTERVAL_MS = 500;

  let subtitleCues = [];
  let audioUrl = '';
  let useCompanionAudio = false;
  let syncTimer = null;
  let loadGeneration = 0;

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

    return blocks.reduce((cues, block) => {
      const lines = block.split('\n').filter(Boolean);
      const timingIndex = lines.findIndex(line => line.includes('-->'));
      if (timingIndex < 0 || /^NOTE(?:\s|$)/.test(lines[0] || '')) return cues;

      const timing = lines[timingIndex].split('-->');
      const start = parseTimestamp(timing[0]);
      const end = parseTimestamp((timing[1] || '').trim().split(/\s+/)[0]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return cues;

      const text = lines
        .slice(timingIndex + 1)
        .join('\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

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

  function stopSyncTimer() {
    if (syncTimer !== null) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  function resetCompanionAudio() {
    stopSyncTimer();
    useCompanionAudio = false;
    audioUrl = '';
    try {
      audio.pause();
    } catch (_) {}
    audio.removeAttribute('src');
    audio.load();
    video.muted = false;
  }

  function safeSetAudioTime(target) {
    if (!useCompanionAudio || !Number.isFinite(target) || audio.readyState < 1) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
    const clamped = Math.max(0, Math.min(target, duration));
    try {
      audio.currentTime = clamped;
    } catch (error) {
      console.warn('Could not seek companion audio', error);
    }
  }

  function synchronizeAudio(force = false) {
    if (!useCompanionAudio || audio.readyState < 1 || video.readyState < 1) return;
    const drift = audio.currentTime - video.currentTime;
    if (force || Math.abs(drift) > HARD_SYNC_DRIFT_SECONDS) {
      safeSetAudioTime(video.currentTime);
      audio.playbackRate = video.playbackRate || 1;
      return;
    }

    // For small drift, gently converge without audible seek jumps.
    if (Math.abs(drift) > SOFT_SYNC_DRIFT_SECONDS) {
      const correction = drift > 0 ? -0.02 : 0.02;
      audio.playbackRate = Math.max(0.5, Math.min(2, (video.playbackRate || 1) + correction));
    } else {
      audio.playbackRate = video.playbackRate || 1;
    }
  }

  function startSyncTimer() {
    stopSyncTimer();
    syncTimer = setInterval(() => synchronizeAudio(false), SYNC_INTERVAL_MS);
  }

  async function playCompanionAudio() {
    if (!useCompanionAudio) return;
    synchronizeAudio(true);
    try {
      await audio.play();
      startSyncTimer();
    } catch (error) {
      console.error('Companion audio playback failed', error);
      showStatus('De gekozen audio kon niet worden afgespeeld');
    }
  }

  function configureCompanionAudio(nextAudioUrl, videoUrl) {
    resetCompanionAudio();
    const chosen = String(nextAudioUrl || '').trim();
    const picture = String(videoUrl || '').trim();

    // If picture and sound come from the same MP4, use normal CAF playback.
    if (!chosen || chosen === picture) {
      video.muted = false;
      return;
    }

    audioUrl = chosen;
    useCompanionAudio = true;
    video.muted = true;
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    audio.src = audioUrl;
    audio.load();
  }

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    request => {
      loadGeneration += 1;
      const generation = loadGeneration;
      const media = request && request.media ? request.media : {};
      const customData = media.customData || {};
      const videoUrl = media.contentId || media.contentUrl || '';

      showStatus('Video en gekozen audio worden gestart…');
      applySubtitleStyle(customData.subtitleStyle || {});
      configureSubtitles(customData.subtitleUrl || '', generation);
      configureCompanionAudio(customData.audioUrl || '', videoUrl);

      return request;
    }
  );

  video.addEventListener('loadedmetadata', () => {
    if (useCompanionAudio) synchronizeAudio(true);
  });

  video.addEventListener('playing', () => {
    hideStatus();
    if (useCompanionAudio) playCompanionAudio();
  });

  video.addEventListener('play', () => {
    if (useCompanionAudio) playCompanionAudio();
  });

  video.addEventListener('pause', () => {
    stopSyncTimer();
    if (useCompanionAudio) audio.pause();
  });

  video.addEventListener('seeking', () => {
    if (!useCompanionAudio) return;
    audio.pause();
    synchronizeAudio(true);
  });

  video.addEventListener('seeked', () => {
    if (!useCompanionAudio) return;
    synchronizeAudio(true);
    if (!video.paused && !video.ended) playCompanionAudio();
  });

  video.addEventListener('ratechange', () => {
    if (useCompanionAudio) audio.playbackRate = video.playbackRate || 1;
  });

  video.addEventListener('timeupdate', updateSubtitleFromTime);

  video.addEventListener('ended', () => {
    stopSyncTimer();
    if (useCompanionAudio) audio.pause();
  });

  video.addEventListener('error', () => {
    const code = video.error ? video.error.code : 'onbekend';
    console.error('CAF video element failed', video.error);
    showStatus(`De video kon niet worden afgespeeld (fout ${code})`);
  });

  audio.addEventListener('loadedmetadata', () => {
    if (!useCompanionAudio) return;
    synchronizeAudio(true);
    if (!video.paused && !video.ended) playCompanionAudio();
  });

  audio.addEventListener('error', () => {
    if (!useCompanionAudio) return;
    const code = audio.error ? audio.error.code : 'onbekend';
    console.error('Companion audio element failed', audio.error);
    showStatus(`De gekozen audio kon niet worden afgespeeld (fout ${code})`);
  });

  audio.addEventListener('stalled', () => {
    console.warn('Companion audio stalled');
  });

  audio.addEventListener('waiting', () => {
    console.warn('Companion audio waiting for data');
  });

  context.addEventListener(cast.framework.system.EventType.SHUTDOWN, () => {
    loadGeneration += 1;
    resetCompanionAudio();
    clearSubtitles();
  });

  const options = new cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = false;
  context.start(options);
})();
