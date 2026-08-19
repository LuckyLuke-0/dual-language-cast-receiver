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
  let objectUrl = null;
  let activeAbortControllers = [];

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
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
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

  function clearSubtitles() {
    subtitleCues = [];
    subtitle.textContent = '';
    subtitle.style.display = 'none';
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

  function resetMse() {
    activeAbortControllers.forEach(controller => {
      try { controller.abort(); } catch (_) {}
    });
    activeAbortControllers = [];
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch (_) {}
      objectUrl = null;
    }
  }

  function sourceBufferQueue(sourceBuffer) {
    const queue = [];
    let failed = false;
    const pump = () => {
      if (failed || sourceBuffer.updating || queue.length === 0) return;
      const next = queue.shift();
      try { sourceBuffer.appendBuffer(next); }
      catch (error) {
        failed = true;
        console.error('SourceBuffer append failed', error);
        showStatus(`MSE append fout: ${error && error.message ? error.message : error}`);
      }
    };
    sourceBuffer.addEventListener('updateend', pump);
    sourceBuffer.addEventListener('error', () => {
      failed = true;
      showStatus('MSE SourceBuffer fout');
    });
    return data => {
      if (!failed && data && data.byteLength) {
        queue.push(data);
        pump();
      }
    };
  }

  async function streamMp4Track(url, wantedKind, mediaSource, generation, onReady) {
    if (!window.MP4Box) throw new Error('MP4Box kon niet worden geladen');
    const controller = new AbortController();
    activeAbortControllers.push(controller);
    const mp4box = MP4Box.createFile();
    let appendSegment = null;
    let selectedTrackId = null;
    let fileOffset = 0;
    let readyResolved = false;

    const readyPromise = new Promise((resolve, reject) => {
      mp4box.onError = error => reject(new Error(`MP4Box ${wantedKind}: ${error}`));
      mp4box.onReady = info => {
        try {
          if (generation !== loadGeneration) return;
          const tracks = wantedKind === 'video' ? info.videoTracks : info.audioTracks;
          const track = tracks && tracks[0];
          if (!track) throw new Error(`Geen ${wantedKind}track gevonden`);
          selectedTrackId = track.id;
          const mime = `${wantedKind}/mp4; codecs=\"${track.codec}\"`;
          if (!MediaSource.isTypeSupported(mime)) throw new Error(`Niet ondersteund op dit Cast-apparaat: ${mime}`);
          const sourceBuffer = mediaSource.addSourceBuffer(mime);
          appendSegment = sourceBufferQueue(sourceBuffer);
          mp4box.setSegmentOptions(track.id, null, { nbSamples: 1000, rapAlignement: true });
          const initSegments = mp4box.initializeSegmentation();
          initSegments.filter(item => item.id === track.id).forEach(item => appendSegment(item.buffer));
          mp4box.start();
          readyResolved = true;
          onReady(track);
          resolve(track);
        } catch (error) {
          reject(error);
        }
      };
      mp4box.onSegment = (id, user, buffer) => {
        if (generation !== loadGeneration || id !== selectedTrackId || !appendSegment) return;
        appendSegment(buffer);
      };
    });

    const response = await fetch(url, {
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Accept': 'video/mp4,*/*' }
    });
    if (!response.ok) throw new Error(`${wantedKind} HTTP ${response.status}`);
    if (!response.body || !response.body.getReader) throw new Error(`${wantedKind}: streaming fetch niet beschikbaar`);

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (generation !== loadGeneration) return;
      const copy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      copy.fileStart = fileOffset;
      fileOffset += copy.byteLength;
      mp4box.appendBuffer(copy);
    }
    mp4box.flush();
    if (!readyResolved) await readyPromise;
    return readyPromise;
  }

  function waitForSourceOpen(mediaSource) {
    if (mediaSource.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('MediaSource kon niet openen')); };
      const cleanup = () => {
        mediaSource.removeEventListener('sourceopen', onOpen);
        mediaSource.removeEventListener('sourceclose', onError);
      };
      mediaSource.addEventListener('sourceopen', onOpen, { once: true });
      mediaSource.addEventListener('sourceclose', onError, { once: true });
    });
  }

  async function prepareMse(videoUrl, audioUrl, generation) {
    resetMse();
    const mediaSource = new MediaSource();
    objectUrl = URL.createObjectURL(mediaSource);
    await waitForSourceOpen(mediaSource);
    if (generation !== loadGeneration) return;

    let videoTrack = null;
    let audioTrack = null;
    showStatus('Muxeo MSE: JW video + gekozen audio analyseren…');

    await Promise.all([
      streamMp4Track(videoUrl, 'video', mediaSource, generation, track => { videoTrack = track; }),
      streamMp4Track(audioUrl, 'audio', mediaSource, generation, track => { audioTrack = track; })
    ]);

    if (videoTrack && audioTrack && mediaSource.readyState === 'open') {
      const duration = Math.max(
        number(videoTrack.duration, 0) / Math.max(1, number(videoTrack.timescale, 1)),
        number(audioTrack.duration, 0) / Math.max(1, number(audioTrack.timescale, 1))
      );
      if (Number.isFinite(duration) && duration > 0) {
        try { mediaSource.duration = duration; } catch (_) {}
      }
    }
    showStatus('Muxeo MSE: tracks klaar — afspelen…');
  }

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, request => {
    loadGeneration += 1;
    const generation = loadGeneration;
    const media = request && request.media ? request.media : {};
    const customData = media.customData || {};
    const mseDemux = customData.mseDemux === true;

    applySubtitleStyle(customData.subtitleStyle || {});
    configureSubtitles(customData.subtitleUrl || '', generation);

    if (!mseDemux) return request;

    const pictureUrl = customData.videoUrl || media.contentId || media.contentUrl || '';
    const audioUrl = customData.audioUrl || '';
    if (!pictureUrl || !audioUrl) throw new Error('MSE_DEMUX_URL_MISSING');
    if (!window.MediaSource || !window.MP4Box) throw new Error('MSE_OR_MP4BOX_UNAVAILABLE');

    const mediaSource = new MediaSource();
    resetMse();
    objectUrl = URL.createObjectURL(mediaSource);
    showStatus('Muxeo MSE v15: één player voorbereiden…');

    media.contentId = objectUrl;
    media.contentUrl = objectUrl;
    media.contentType = 'video/mp4';

    waitForSourceOpen(mediaSource)
      .then(() => {
        if (generation !== loadGeneration) return;
        let videoTrack = null;
        let audioTrack = null;
        showStatus('Muxeo MSE v15: JW video + gekozen audio streamen…');
        return Promise.all([
          streamMp4Track(pictureUrl, 'video', mediaSource, generation, track => { videoTrack = track; }),
          streamMp4Track(audioUrl, 'audio', mediaSource, generation, track => { audioTrack = track; })
        ]).then(() => {
          if (generation !== loadGeneration) return;
          if (videoTrack && audioTrack && mediaSource.readyState === 'open') {
            const duration = Math.max(
              number(videoTrack.duration, 0) / Math.max(1, number(videoTrack.timescale, 1)),
              number(audioTrack.duration, 0) / Math.max(1, number(audioTrack.timescale, 1))
            );
            if (Number.isFinite(duration) && duration > 0) {
              try { mediaSource.duration = duration; } catch (_) {}
            }
          }
          showStatus('Muxeo MSE v15: afspelen…');
        });
      })
      .catch(error => {
        console.error('Muxeo MSE demux failed', error);
        showStatus(`Muxeo MSE fout\n${error && error.message ? error.message : error}`);
      });

    return request;
  });

  video.addEventListener('playing', hideStatus);
  video.addEventListener('timeupdate', updateSubtitleFromTime);
  video.addEventListener('seeked', updateSubtitleFromTime);
  video.addEventListener('error', () => {
    const code = video.error ? video.error.code : 'onbekend';
    showStatus(`De MSE-video kon niet worden afgespeeld (fout ${code})`);
  });

  context.addEventListener(cast.framework.system.EventType.SHUTDOWN, () => {
    loadGeneration += 1;
    resetMse();
    clearSubtitles();
  });

  const options = new cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = false;
  context.start(options);
})();
