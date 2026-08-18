(() => {
  'use strict';

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const video = document.getElementById('media');
  playerManager.setMediaElement(video);
  const subtitle = document.getElementById('subtitle');
  const status = document.getElementById('status');
  // Keep fragments and buffered media deliberately small. Some older Cast
  // receivers have much less memory than Google TV devices.
  const CHUNK_SIZE = 256 * 1024;
  const VIDEO_SAMPLES_PER_SEGMENT = 25;
  const AUDIO_SAMPLES_PER_SEGMENT = 48;
  const MAX_QUEUED_SEGMENTS = 4;
  const MAX_BUFFER_AHEAD_SECONDS = 24;
  const KEEP_BUFFER_BEHIND_SECONDS = 8;

  let trackElement = null;
  let subtitleCues = [];
  let pipelineGeneration = 0;
  let pipelineAbortController = null;
  let pipelineMediaSource = null;
  let pipelineObjectUrl = '';
  let pipelineTracks = [];
  let pipelineFailed = false;

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

  async function configureSubtitles(url) {
    clearSubtitles();
    if (!url) return;

    try {
      const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      subtitleCues = parseVtt(await response.text());
      if (!subtitleCues.length) throw new Error('Geen geldige VTT-regels gevonden');
      updateSubtitleFromTime();
    } catch (error) {
      console.error('Subtitle loading failed', error);
    }
  }

  function stopCombinedPipeline() {
    pipelineGeneration += 1;
    if (pipelineAbortController) pipelineAbortController.abort();
    pipelineAbortController = null;
    pipelineTracks.forEach(state => {
      try {
        if (state.file) state.file.stop();
      } catch (error) {
        console.warn('Could not stop MP4 parser', error);
      }
    });
    pipelineTracks = [];
    if (pipelineObjectUrl) URL.revokeObjectURL(pipelineObjectUrl);
    pipelineObjectUrl = '';
    pipelineMediaSource = null;
    pipelineFailed = false;
  }

  function failCombinedPipeline(message, error, generation) {
    if (generation !== pipelineGeneration || pipelineFailed) return;
    pipelineFailed = true;
    console.error(message, error);
    document.body.classList.remove('playing');
    status.textContent = message;
    status.style.display = 'block';
    if (pipelineAbortController) pipelineAbortController.abort();
  }

  function parseContentRange(value) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value || '');
    if (!match) return null;
    return {
      start: Number(match[1]),
      total: match[3] === '*' ? null : Number(match[3])
    };
  }

  function chooseTrack(info, kind) {
    const candidates = kind === 'video'
      ? (info.videoTracks || ((info.tracks || []).filter(track => track.video)))
      : (info.audioTracks || ((info.tracks || []).filter(track => track.audio)));

    return (candidates || [])
      .filter(track => {
        const mime = kind + '/mp4; codecs="' + track.codec + '"';
        return MediaSource.isTypeSupported(mime);
      })
      .sort((left, right) => {
        if (kind !== 'video') return 0;
        const leftVideo = left.video || {};
        const rightVideo = right.video || {};
        const leftSize = (leftVideo.width || 0) * (leftVideo.height || 0);
        const rightSize = (rightVideo.width || 0) * (rightVideo.height || 0);
        return rightSize - leftSize;
      })[0] || null;
  }

  async function fetchTrackChunk(state, generation) {
    const requestedStart = state.nextStart;
    const requestOptions = {
      mode: 'cors',
      cache: 'no-store',
      headers: { Range: 'bytes=' + requestedStart + '-' + (requestedStart + CHUNK_SIZE - 1) }
    };
    if (pipelineAbortController) requestOptions.signal = pipelineAbortController.signal;
    const response = await fetch(state.url, requestOptions);
    if (!response.ok) throw new Error(state.kind + ' HTTP ' + response.status);
    if (response.status === 200 && requestedStart !== 0) {
      throw new Error(state.kind + ' source stopped supporting byte ranges');
    }

    const contentRange = parseContentRange(response.headers.get('Content-Range'));
    const responseStart = contentRange && contentRange.start !== null
      ? contentRange.start
      : 0;
    const buffer = await response.arrayBuffer();
    if (generation !== pipelineGeneration) return;
    if (!buffer.byteLength) throw new Error('Empty ' + state.kind + ' response');
    buffer.fileStart = responseStart;

    const suggestedNext = state.file.appendBuffer(buffer);
    const responseEnd = responseStart + buffer.byteLength - 1;
    state.totalLength = contentRange && contentRange.total !== null
      ? contentRange.total
      : (response.status === 200 ? buffer.byteLength : state.totalLength);
    state.eof =
      response.status === 200 ||
      (state.totalLength !== null && responseEnd + 1 >= state.totalLength) ||
      (response.status === 206 && buffer.byteLength < CHUNK_SIZE && state.totalLength === null);
    state.nextStart =
      Number.isFinite(suggestedNext) && suggestedNext > responseEnd
        ? suggestedNext
        : responseEnd + 1;
  }

  async function prepareTrack(url, kind, generation) {
    const state = {
      url,
      kind,
      file: window.MP4Box.createFile(true),
      track: null,
      mime: '',
      duration: 0,
      initBuffer: null,
      sourceBuffer: null,
      queue: [],
      pendingSampleNumber: null,
      isTrimming: false,
      nextStart: 0,
      totalLength: null,
      eof: false,
      flushed: false,
      error: null
    };

    state.file.onError = error => {
      state.error = new Error(String(error));
    };
    state.file.onReady = info => {
      if (state.track || state.error || generation !== pipelineGeneration) return;
      try {
        const track = chooseTrack(info, kind);
        if (!track) throw new Error('No supported ' + kind + ' track found');
        state.track = track;
        state.mime = kind + '/mp4; codecs="' + track.codec + '"';
        state.duration =
          Number.isFinite(info.duration) && Number.isFinite(info.timescale) && info.timescale > 0
            ? info.duration / info.timescale
            : 0;
        state.file.setSegmentOptions(track.id, state, {
          nbSamples:
            kind === 'video' ? VIDEO_SAMPLES_PER_SEGMENT : AUDIO_SAMPLES_PER_SEGMENT,
          rapAlignement: kind === 'video',
          normalizeAudioSampleEntriesForMSE: true
        });
        const initializations = state.file.initializeSegmentation('per-track');
        const initialization =
          initializations.find(item => item.id === track.id) || initializations[0];
        if (!initialization || !initialization.buffer) {
          throw new Error('No ' + kind + ' initialization segment was created');
        }
        state.initBuffer = initialization.buffer;
      } catch (error) {
        state.error = error;
      }
    };

    while (
      generation === pipelineGeneration &&
      !state.track &&
      !state.error &&
      !state.eof
    ) {
      await fetchTrackChunk(state, generation);
    }

    if (state.error) throw state.error;
    if (!state.track) throw new Error('The ' + kind + ' metadata could not be read');
    return state;
  }

  function maybeEndCombinedStream(generation) {
    if (
      generation !== pipelineGeneration ||
      pipelineFailed ||
      !pipelineMediaSource ||
      pipelineMediaSource.readyState !== 'open' ||
      !pipelineTracks.length
    ) {
      return;
    }
    const complete = pipelineTracks.every(state =>
      state.flushed &&
      state.queue.length === 0 &&
      state.sourceBuffer &&
      !state.sourceBuffer.updating
    );
    if (!complete) return;
    try {
      pipelineMediaSource.endOfStream();
    } catch (error) {
      console.warn('Could not close combined media stream', error);
    }
  }

  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  function bufferedAheadSeconds(state) {
    const sourceBuffer = state.sourceBuffer;
    if (!sourceBuffer || !sourceBuffer.buffered || !sourceBuffer.buffered.length) return 0;
    const now = Math.max(0, video.currentTime || 0);
    for (let index = 0; index < sourceBuffer.buffered.length; index += 1) {
      const start = sourceBuffer.buffered.start(index);
      const end = sourceBuffer.buffered.end(index);
      if (now >= start - 0.25 && now <= end) return Math.max(0, end - now);
      if (now < start) return Math.max(0, end - now);
    }
    return 0;
  }

  function trimOldBuffer(state) {
    const sourceBuffer = state.sourceBuffer;
    if (
      !sourceBuffer ||
      sourceBuffer.updating ||
      state.isTrimming ||
      !sourceBuffer.buffered ||
      !sourceBuffer.buffered.length
    ) {
      return false;
    }
    const removeBefore = Math.max(0, (video.currentTime || 0) - KEEP_BUFFER_BEHIND_SECONDS);
    const firstStart = sourceBuffer.buffered.start(0);
    if (removeBefore <= firstStart + 0.5) return false;
    try {
      state.isTrimming = true;
      sourceBuffer.remove(firstStart, removeBefore);
      return true;
    } catch (error) {
      state.isTrimming = false;
      console.warn('Could not trim old ' + state.kind + ' buffer', error);
      return false;
    }
  }

  async function waitForDownloadCapacity(state, generation) {
    while (generation === pipelineGeneration && !pipelineFailed) {
      trimOldBuffer(state);
      const hasQueueRoom = state.queue.length < MAX_QUEUED_SEGMENTS;
      const hasBufferRoom = bufferedAheadSeconds(state) < MAX_BUFFER_AHEAD_SECONDS;
      if (hasQueueRoom && hasBufferRoom && !state.isTrimming) return;
      await wait(150);
    }
  }

  function pumpTrackQueue(state, generation) {
    if (
      generation !== pipelineGeneration ||
      pipelineFailed ||
      !state.sourceBuffer ||
      state.sourceBuffer.updating
    ) {
      return;
    }
    if (trimOldBuffer(state)) return;
    if (!state.queue.length) {
      maybeEndCombinedStream(generation);
      return;
    }

    const item = state.queue.shift();
    state.pendingSampleNumber = item.sampleNumber;
    try {
      state.sourceBuffer.appendBuffer(item.buffer);
    } catch (error) {
      failCombinedPipeline(
        'De gecombineerde ' + state.kind + 'track kon niet worden verwerkt',
        error,
        generation
      );
    }
  }

  function queueTrackBuffer(state, buffer, sampleNumber, generation) {
    if (generation !== pipelineGeneration || pipelineFailed) return;
    state.queue.push({ buffer, sampleNumber });
    pumpTrackQueue(state, generation);
  }

  function attachTrackSourceBuffer(state, generation) {
    state.sourceBuffer = pipelineMediaSource.addSourceBuffer(state.mime);
    state.sourceBuffer.addEventListener('error', event => {
      failCombinedPipeline(
        'De televisie kon de ' + state.kind + 'track niet decoderen',
        event,
        generation
      );
    });
    state.sourceBuffer.addEventListener('updateend', () => {
      if (state.isTrimming) {
        state.isTrimming = false;
        pumpTrackQueue(state, generation);
        return;
      }
      const sampleNumber = state.pendingSampleNumber;
      state.pendingSampleNumber = null;
      if (sampleNumber && state.track) {
        state.file.releaseUsedSamples(state.track.id, sampleNumber);
      }
      pumpTrackQueue(state, generation);
    });
    state.file.onSegment = (id, user, buffer, sampleNumber) => {
      if (id === state.track.id) {
        queueTrackBuffer(state, buffer, sampleNumber, generation);
      }
    };
    queueTrackBuffer(state, state.initBuffer, 0, generation);
    state.file.start();
  }

  async function finishTrackDownload(state, generation) {
    while (
      generation === pipelineGeneration &&
      !pipelineFailed &&
      !state.eof
    ) {
      await waitForDownloadCapacity(state, generation);
      if (generation !== pipelineGeneration || pipelineFailed) return;
      await fetchTrackChunk(state, generation);
    }
    if (generation !== pipelineGeneration || pipelineFailed) return;
    state.file.flush();
    state.flushed = true;
    maybeEndCombinedStream(generation);
  }

  async function startCombinedPipeline(videoUrl, audioUrl, generation) {
    try {
      pipelineAbortController = typeof AbortController !== 'undefined'
        ? new AbortController()
        : null;
      const tracks = await Promise.all([
        prepareTrack(videoUrl, 'video', generation),
        prepareTrack(audioUrl, 'audio', generation)
      ]);
      if (generation !== pipelineGeneration) return;
      pipelineTracks = tracks;

      tracks.forEach(state => attachTrackSourceBuffer(state, generation));
      const durations = tracks.map(state => state.duration).filter(value => value > 0);
      if (durations.length) pipelineMediaSource.duration = Math.min(...durations);

      await Promise.all(tracks.map(state => finishTrackDownload(state, generation)));
    } catch (error) {
      if (!error || error.name !== 'AbortError') {
        failCombinedPipeline(
          'Beeld en gekozen audio konden niet samen worden gestart',
          error,
          generation
        );
      }
    }
  }

  function createCombinedMediaUrl(videoUrl, audioUrl) {
    stopCombinedPipeline();
    if (!window.MP4Box || typeof MediaSource === 'undefined') {
      throw new Error('This Cast device does not support combined streaming');
    }
    const generation = pipelineGeneration;
    pipelineMediaSource = new MediaSource();
    pipelineObjectUrl = URL.createObjectURL(pipelineMediaSource);
    pipelineMediaSource.addEventListener(
      'sourceopen',
      () => startCombinedPipeline(videoUrl, audioUrl, generation),
      { once: true }
    );
    return pipelineObjectUrl;
  }

  video.addEventListener('play', () => {
    document.body.classList.add('playing');
  });
  video.addEventListener('timeupdate', updateSubtitleFromTime);
  video.addEventListener('seeked', updateSubtitleFromTime);
  video.addEventListener('error', () => {
    if (!pipelineObjectUrl || video.currentSrc !== pipelineObjectUrl) return;
    const code = video.error && video.error.code ? video.error.code : 0;
    failCombinedPipeline(
      'De gecombineerde videostream kon niet worden afgespeeld (code ' + code + ')',
      video.error,
      pipelineGeneration
    );
  });

  playerManager.setMediaUrlResolver(loadRequest => {
    return (
      pipelineObjectUrl ||
      (loadRequest.media && loadRequest.media.contentUrl) ||
      (loadRequest.media && loadRequest.media.contentId)
    );
  });

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    loadRequest => {
      const media = loadRequest.media || {};
      const custom = media.customData || {};
      const videoUrl = media.contentUrl || media.contentId || '';
      const audioUrl = custom.audioUrl || videoUrl;

      document.body.classList.remove('playing');
      status.textContent = 'v11 · beeld en gekozen audio voorbereiden…';
      status.style.display = 'block';
      applySubtitleStyle(custom.subtitleStyle || {});
      configureSubtitles(custom.subtitleUrl || '');

      try {
        const combinedUrl = createCombinedMediaUrl(videoUrl, audioUrl);
        loadRequest.media.contentUrl = combinedUrl;
        loadRequest.media.contentType = 'video/mp4';
      } catch (error) {
        failCombinedPipeline(
          'Dit Cast-apparaat kan de gekozen tracks niet samenvoegen',
          error,
          pipelineGeneration
        );
      }
      return loadRequest;
    }
  );

  context.addEventListener(
    cast.framework.system.EventType.SHUTDOWN,
    () => stopCombinedPipeline()
  );

  context.start({
    disableIdleTimeout: false,
    supportedCommands:
      cast.framework.messages.Command.PAUSE |
      cast.framework.messages.Command.SEEK |
      cast.framework.messages.Command.STREAM_VOLUME
  });
})();
