(() => {
  'use strict';

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const video = document.getElementById('media');
  playerManager.setMediaElement(video);
  const subtitle = document.getElementById('subtitle');
  const status = document.getElementById('status');
  // Decode only the audio track from the alternate MP4. Using a second video
  // element can exhaust the single hardware video decoder on some TVs and
  // makes the Cast receiver terminate with a generic playback error.
  const audio = document.createElement('audio');

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

  const AUDIO_CHUNK_SIZE = 1024 * 1024;
  const AUDIO_SAMPLES_PER_SEGMENT = 240;

  let trackElement = null;
  let subtitleCues = [];
  let syncTimer = null;
  let pendingStartTime = 0;
  let currentAudioUrl = '';
  let usingAlternateAudio = false;
  let audioGeneration = 0;
  let audioAbortController = null;
  let audioMediaSource = null;
  let audioObjectUrl = '';
  let audioSourceBuffer = null;
  let audioMp4BoxFile = null;
  let audioTrackId = null;
  let audioAppendQueue = [];
  let audioEndRequested = false;

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

  function isAudioBuffered(time) {
    if (!Number.isFinite(time)) return false;
    for (let i = 0; i < audio.buffered.length; i += 1) {
      if (time >= audio.buffered.start(i) - 0.05 && time < audio.buffered.end(i) - 0.05) {
        return true;
      }
    }
    return false;
  }

  function hardSync() {
    if (!usingAlternateAudio || !isAudioBuffered(video.currentTime)) return;
    if (Math.abs(audio.currentTime - video.currentTime) > 0.22) {
      try {
        audio.currentTime = video.currentTime;
      } catch (error) {
        console.warn('Alternate audio seek is not ready yet', error);
      }
    }
  }

  async function playAudioWhenReady() {
    if (!usingAlternateAudio || video.paused || !isAudioBuffered(video.currentTime)) return;
    hardSync();
    audio.playbackRate = video.playbackRate;
    try {
      await audio.play();
    } catch (error) {
      console.warn('Alternate audio is not ready to play yet', error);
    }
  }

  function stopAudioPipeline() {
    audioGeneration += 1;
    audioAbortController?.abort();
    audioAbortController = null;
    try {
      audioMp4BoxFile?.stop();
    } catch (error) {
      console.warn('Could not stop MP4 audio parser', error);
    }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = '';
    audioMediaSource = null;
    audioSourceBuffer = null;
    audioMp4BoxFile = null;
    audioTrackId = null;
    audioAppendQueue = [];
    audioEndRequested = false;
  }

  function usePrimaryAudioFallback(message, error) {
    if (error?.name === 'AbortError') return;
    console.error(message, error);
    usingAlternateAudio = false;
    stopAudioPipeline();
    video.muted = false;
    document.body.classList.remove('playing');
    status.textContent = message + '. De oorspronkelijke audio wordt gebruikt.';
    status.style.display = 'block';
  }

  function pumpAudioQueue(generation) {
    if (generation !== audioGeneration || !audioSourceBuffer || audioSourceBuffer.updating) return;
    if (audioAppendQueue.length) {
      const item = audioAppendQueue.shift();
      audioSourceBuffer.__sampleNumber = item.sampleNumber;
      try {
        audioSourceBuffer.appendBuffer(item.buffer);
      } catch (error) {
        usePrimaryAudioFallback('De gekozen audiotrack kon niet worden verwerkt', error);
      }
      return;
    }
    if (audioEndRequested && audioMediaSource?.readyState === 'open') {
      try {
        audioMediaSource.endOfStream();
      } catch (error) {
        console.warn('Could not close alternate audio stream', error);
      }
    }
  }

  function queueAudioBuffer(buffer, sampleNumber, last, generation) {
    if (generation !== audioGeneration) return;
    audioAppendQueue.push({ buffer, sampleNumber });
    if (last) audioEndRequested = true;
    pumpAudioQueue(generation);
  }

  function parseContentRange(value) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value || '');
    if (!match) return null;
    return {
      start: Number(match[1]),
      total: match[3] === '*' ? null : Number(match[3])
    };
  }

  async function downloadAndDemuxAudio(url, generation, file, controller) {
    let nextStart = 0;
    let totalLength = null;

    while (generation === audioGeneration) {
      const response = await fetch(url, {
        mode: 'cors',
        cache: 'no-store',
        headers: { Range: 'bytes=' + nextStart + '-' + (nextStart + AUDIO_CHUNK_SIZE - 1) },
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Audio HTTP ' + response.status);
      if (response.status === 200 && nextStart !== 0) {
        throw new Error('Audio server stopped supporting byte ranges');
      }

      const contentRange = parseContentRange(response.headers.get('Content-Range'));
      const responseStart = contentRange?.start ?? 0;
      const buffer = await response.arrayBuffer();
      if (generation !== audioGeneration) return;
      if (!buffer.byteLength) throw new Error('Empty audio response');
      buffer.fileStart = responseStart;

      const suggestedNext = file.appendBuffer(buffer);
      const responseEnd = responseStart + buffer.byteLength - 1;
      totalLength = contentRange?.total ?? (response.status === 200 ? buffer.byteLength : totalLength);
      const reachedEnd =
        response.status === 200 ||
        (totalLength !== null && responseEnd + 1 >= totalLength) ||
        (response.status === 206 && buffer.byteLength < AUDIO_CHUNK_SIZE && totalLength === null);
      if (reachedEnd) break;

      nextStart =
        Number.isFinite(suggestedNext) && suggestedNext > responseEnd
          ? suggestedNext
          : responseEnd + 1;
    }

    if (generation === audioGeneration) file.flush();
  }

  function startAudioDemux(url, generation) {
    const controller = new AbortController();
    const file = window.MP4Box.createFile(true);
    audioAbortController = controller;
    audioMp4BoxFile = file;

    file.onError = error => {
      if (generation === audioGeneration) {
        usePrimaryAudioFallback('De gekozen audiotrack kon niet worden gelezen', new Error(error));
      }
    };

    file.onReady = info => {
      if (generation !== audioGeneration || audioSourceBuffer) return;
      const track =
        info.audioTracks?.[0] ||
        info.tracks?.find(candidate => candidate.audio || candidate.type === 'audio');
      if (!track) {
        usePrimaryAudioFallback('De gekozen bron bevat geen audiotrack');
        return;
      }

      const mime = 'audio/mp4; codecs="' + track.codec + '"';
      if (!MediaSource.isTypeSupported(mime)) {
        usePrimaryAudioFallback('Dit Cast-apparaat ondersteunt ' + track.codec + ' niet');
        return;
      }

      try {
        audioTrackId = track.id;
        audioSourceBuffer = audioMediaSource.addSourceBuffer(mime);
        audioSourceBuffer.addEventListener('error', event => {
          usePrimaryAudioFallback('De televisie kon de gekozen audiotrack niet decoderen', event);
        });
        audioSourceBuffer.addEventListener('updateend', () => {
          const sampleNumber = audioSourceBuffer?.__sampleNumber;
          if (sampleNumber && audioTrackId !== null) {
            file.releaseUsedSamples(audioTrackId, sampleNumber);
          }
          pumpAudioQueue(generation);
          playAudioWhenReady();
        });

        file.setSegmentOptions(track.id, null, {
          nbSamples: AUDIO_SAMPLES_PER_SEGMENT,
          rapAlignement: false,
          normalizeAudioSampleEntriesForMSE: true
        });
        const initSegments = file.initializeSegmentation('per-track');
        const init = initSegments.find(segment => segment.id === track.id) || initSegments[0];
        if (!init?.buffer) throw new Error('Audio initialization segment is missing');
        if (Number.isFinite(info.duration) && Number.isFinite(info.timescale) && info.timescale > 0) {
          audioMediaSource.duration = info.duration / info.timescale;
        }
        queueAudioBuffer(init.buffer, 0, false, generation);
        file.start();
      } catch (error) {
        usePrimaryAudioFallback('De gekozen audiotrack kon niet worden voorbereid', error);
      }
    };

    file.onSegment = (id, user, buffer, sampleNumber, last) => {
      if (id === audioTrackId) queueAudioBuffer(buffer, sampleNumber, Boolean(last), generation);
    };

    downloadAndDemuxAudio(url, generation, file, controller).catch(error => {
      if (generation === audioGeneration) {
        usePrimaryAudioFallback('De gekozen audiotrack kon niet worden geladen', error);
      }
    });
  }

  function configureAudio(url) {
    usingAlternateAudio = false;
    stopAudioPipeline();
    currentAudioUrl = url || '';
    usingAlternateAudio = Boolean(currentAudioUrl);
    if (!usingAlternateAudio) {
      video.muted = false;
      return;
    }
    if (!window.MP4Box || typeof MediaSource === 'undefined') {
      usePrimaryAudioFallback('Dit Cast-apparaat ondersteunt geen gescheiden audiotracks');
      return;
    }

    const generation = audioGeneration;
    audioMediaSource = new MediaSource();
    audioObjectUrl = URL.createObjectURL(audioMediaSource);
    audio.src = audioObjectUrl;
    audio.muted = false;
    audio.volume = 1;
    audioMediaSource.addEventListener(
      'sourceopen',
      () => startAudioDemux(currentAudioUrl, generation),
      { once: true }
    );
    audio.load();
  }

  video.addEventListener('play', () => {
    document.body.classList.add('playing');
    playAudioWhenReady();
  });
  video.addEventListener('pause', () => audio.pause());
  video.addEventListener('timeupdate', updateSubtitleFromTime);
  video.addEventListener('seeked', updateSubtitleFromTime);
  video.addEventListener('seeked', () => {
    hardSync();
    playAudioWhenReady();
  });
  video.addEventListener('ratechange', () => {
    audio.playbackRate = video.playbackRate;
  });
  video.addEventListener('ended', () => audio.pause());
  video.addEventListener('error', () => {
    const code = video.error?.code || 0;
    status.textContent = 'De videobron kon niet worden afgespeeld (code ' + code + ')';
    status.style.display = 'block';
    console.error('Primary video playback failed', video.error);
  });
  video.addEventListener('volumechange', () => {
    if (usingAlternateAudio && !video.muted) video.muted = true;
  });
  audio.addEventListener('canplay', playAudioWhenReady);
  audio.addEventListener('error', () => {
    if (usingAlternateAudio) {
      usePrimaryAudioFallback('De televisie kon de gekozen audiotrack niet afspelen', audio.error);
    }
  });

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    loadRequest => {
      const custom = loadRequest.media?.customData || {};
      pendingStartTime = number(loadRequest.currentTime, 0);

      if (!custom.audioUrl) {
        status.textContent = 'De gekozen video bevat geen bruikbare audiobron';
        status.style.display = 'block';
      }

      document.body.classList.remove('playing');
      status.textContent = 'Video en audio voorbereiden…';
      status.style.display = 'block';
      video.muted = Boolean(custom.audioUrl);
      applySubtitleStyle(custom.subtitleStyle || {});
      configureAudio(custom.audioUrl || '');
      configureSubtitles(custom.subtitleUrl || '');

      if (syncTimer) clearInterval(syncTimer);
      syncTimer = setInterval(() => {
        if (!usingAlternateAudio || video.paused) return;
        if (audio.paused) playAudioWhenReady();
        else hardSync();
      }, 750);

      return loadRequest;
    }
  );

  context.addEventListener(
    cast.framework.system.EventType.SHUTDOWN,
    () => {
      stopAudioPipeline();
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

