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
  let pendingMse = null;
  let objectUrl = null;
  let aborters = [];

  function showStatus(message) {
    document.body.classList.remove('playing');
    status.textContent = message;
    status.style.display = 'block';
  }
  function hideStatus() {
    document.body.classList.add('playing');
    status.style.display = 'none';
  }
  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function colourWithAlpha(colour, alpha) {
    if (typeof colour !== 'string') return `rgba(0,0,0,${alpha})`;
    const hex = colour.trim().replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return colour;
    return `rgba(${parseInt(hex.slice(0,2),16)},${parseInt(hex.slice(2,4),16)},${parseInt(hex.slice(4,6),16)},${alpha})`;
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
  function parseTimestamp(value) {
    const parts = value.trim().replace(',', '.').split(':').map(Number);
    if (parts.some(p => !Number.isFinite(p))) return NaN;
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
  function clearSubtitles() {
    subtitleCues = [];
    subtitle.textContent = '';
    subtitle.style.display = 'none';
  }
  function updateSubtitleFromTime() {
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
  function resetMse() {
    aborters.forEach(a => { try { a.abort(); } catch (_) {} });
    aborters = [];
    if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (_) {} objectUrl = null; }
  }
  function waitSourceOpen(ms) {
    if (ms.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('MediaSource kon niet openen')); };
      const cleanup = () => { ms.removeEventListener('sourceopen', ok); ms.removeEventListener('sourceclose', fail); };
      ms.addEventListener('sourceopen', ok, { once: true });
      ms.addEventListener('sourceclose', fail, { once: true });
    });
  }
  function makeQueue(sb) {
    const queue = [];
    let failed = false;
    const pump = () => {
      if (failed || sb.updating || !queue.length) return;
      try { sb.appendBuffer(queue.shift()); } catch (e) { failed = true; showStatus(`MSE append fout: ${e.message || e}`); }
    };
    sb.addEventListener('updateend', pump);
    sb.addEventListener('error', () => { failed = true; showStatus('MSE SourceBuffer fout'); });
    return data => { if (!failed && data && data.byteLength) { queue.push(data); pump(); } };
  }
  function startTrackStream(url, kind, mediaSource, generation) {
    return new Promise((resolve, reject) => {
      if (!window.MP4Box) return reject(new Error('MP4Box niet geladen'));
      const controller = new AbortController();
      aborters.push(controller);
      const mp4box = MP4Box.createFile();
      let selectedTrackId = null;
      let append = null;
      let fileOffset = 0;
      let resolved = false;

      mp4box.onError = err => { if (!resolved) reject(new Error(`MP4Box ${kind}: ${err}`)); };
      mp4box.onReady = info => {
        try {
          if (generation !== loadGeneration) return;
          const tracks = kind === 'video' ? info.videoTracks : info.audioTracks;
          const track = tracks && tracks[0];
          if (!track) throw new Error(`Geen ${kind}track gevonden`);
          selectedTrackId = track.id;
          const mime = `${kind}/mp4; codecs=\"${track.codec}\"`;
          if (!MediaSource.isTypeSupported(mime)) throw new Error(`Niet ondersteund: ${mime}`);
          const sb = mediaSource.addSourceBuffer(mime);
          append = makeQueue(sb);
          mp4box.setSegmentOptions(track.id, null, { nbSamples: 150, rapAlignement: true });
          mp4box.initializeSegmentation().filter(s => s.id === track.id).forEach(s => append(s.buffer));
          mp4box.start();
          resolved = true;
          resolve(track);
        } catch (e) { reject(e); }
      };
      mp4box.onSegment = (id, user, buffer) => {
        if (generation === loadGeneration && id === selectedTrackId && append) append(buffer);
      };

      (async () => {
        try {
          const response = await fetch(url, { mode: 'cors', cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`${kind} HTTP ${response.status}`);
          if (!response.body || !response.body.getReader) throw new Error(`${kind}: streaming fetch niet beschikbaar`);
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done || generation !== loadGeneration) break;
            const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            buf.fileStart = fileOffset;
            fileOffset += buf.byteLength;
            mp4box.appendBuffer(buf);
          }
          mp4box.flush();
        } catch (e) {
          if (e.name !== 'AbortError') {
            console.error('MSE stream error', kind, e);
            if (!resolved) reject(e); else showStatus(`MSE ${kind} stream fout: ${e.message || e}`);
          }
        }
      })();
    });
  }
  async function activateMse(pending) {
    const generation = pending.generation;
    if (generation !== loadGeneration) return;
    resetMse();
    const ms = new MediaSource();
    objectUrl = URL.createObjectURL(ms);
    showStatus('Muxeo MSE v16: videotrack + gekozen audio voorbereiden…');
    video.pause();
    video.src = objectUrl;
    await waitSourceOpen(ms);
    const [vTrack, aTrack] = await Promise.all([
      startTrackStream(pending.videoUrl, 'video', ms, generation),
      startTrackStream(pending.audioUrl, 'audio', ms, generation)
    ]);
    if (generation !== loadGeneration) return;
    const duration = Math.max(
      number(vTrack.duration, 0) / Math.max(1, number(vTrack.timescale, 1)),
      number(aTrack.duration, 0) / Math.max(1, number(aTrack.timescale, 1))
    );
    if (Number.isFinite(duration) && duration > 0 && ms.readyState === 'open') {
      try { ms.duration = duration; } catch (_) {}
    }
    if (pending.currentTime > 0) {
      try { video.currentTime = pending.currentTime; } catch (_) {}
    }
    showStatus('Muxeo MSE v16: stream gestart…');
    try { await video.play(); } catch (e) { showStatus(`MSE afspelen mislukt: ${e.message || e}`); }
  }

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, request => {
    loadGeneration += 1;
    const generation = loadGeneration;
    const media = request && request.media ? request.media : {};
    const customData = media.customData || {};
    applySubtitleStyle(customData.subtitleStyle || {});
    configureSubtitles(customData.subtitleUrl || '', generation);

    if (customData.mseDemux === true) {
      const pictureUrl = customData.videoUrl || media.contentUrl || media.contentId || '';
      const audioUrl = customData.audioUrl || '';
      if (!pictureUrl || !audioUrl) throw new Error('MSE_DEMUX_URL_MISSING');
      if (!window.MediaSource || !window.MP4Box) throw new Error('MSE_OR_MP4BOX_UNAVAILABLE');
      pendingMse = {
        generation,
        videoUrl: pictureUrl,
        audioUrl,
        currentTime: number(request.currentTime, 0)
      };
      showStatus('Muxeo MSE v16: Cast LOAD accepteren…');
      // Belangrijk: laat CAF eerst de gewone publieke JW-video accepteren.
      // Een blob:-URL in LOAD werd door klassieke Chromecast geweigerd.
      media.contentUrl = pictureUrl;
      media.contentId = pictureUrl;
      media.contentType = 'video/mp4';
    } else {
      pendingMse = null;
    }
    return request;
  });

  playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, () => {
    const pending = pendingMse;
    if (!pending || pending.generation !== loadGeneration) return;
    pendingMse = null;
    activateMse(pending).catch(error => {
      console.error('Muxeo MSE activation failed', error);
      showStatus(`Muxeo MSE fout\n${error && error.message ? error.message : error}`);
    });
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
    pendingMse = null;
    resetMse();
    clearSubtitles();
  });

  const options = new cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = false;
  context.start(options);
})();
