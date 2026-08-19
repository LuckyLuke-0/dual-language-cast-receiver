(() => {
  'use strict';
  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const video = document.getElementById('media');
  const status = document.getElementById('status');
  playerManager.setMediaElement(video);

  let generation = 0;
  let pending = null;
  let objectUrl = null;
  let aborters = [];

  function show(message) {
    document.body.classList.remove('playing');
    status.textContent = message;
    status.style.display = 'block';
  }
  function hide() {
    document.body.classList.add('playing');
    status.style.display = 'none';
  }
  function cleanup() {
    aborters.forEach(a => { try { a.abort(); } catch (_) {} });
    aborters = [];
    if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (_) {} objectUrl = null; }
  }
  function waitOpen(ms) {
    if (ms.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ok = () => { off(); resolve(); };
      const bad = () => { off(); reject(new Error('MediaSource sloot voor openen')); };
      const off = () => { ms.removeEventListener('sourceopen', ok); ms.removeEventListener('sourceclose', bad); };
      ms.addEventListener('sourceopen', ok, { once: true });
      ms.addEventListener('sourceclose', bad, { once: true });
    });
  }
  function queue(sb) {
    const items = [];
    let failed = false;
    const pump = () => {
      if (failed || sb.updating || !items.length) return;
      try { sb.appendBuffer(items.shift()); }
      catch (e) { failed = true; show(`MSE append fout: ${e.message || e}`); }
    };
    sb.addEventListener('updateend', pump);
    sb.addEventListener('error', () => { failed = true; show('MSE SourceBuffer fout'); });
    return data => { if (!failed && data && data.byteLength) { items.push(data); pump(); } };
  }
  function streamTrack(url, kind, ms, gen) {
    return new Promise((resolve, reject) => {
      if (!window.MP4Box) return reject(new Error('MP4Box ontbreekt'));
      const controller = new AbortController();
      aborters.push(controller);
      const file = MP4Box.createFile();
      let selected = null;
      let append = null;
      let offset = 0;
      let resolved = false;

      file.onError = e => { if (!resolved) reject(new Error(`MP4Box ${kind}: ${e}`)); };
      file.onReady = info => {
        try {
          if (gen !== generation) return;
          const track = (kind === 'video' ? info.videoTracks : info.audioTracks)?.[0];
          if (!track) throw new Error(`Geen ${kind}track gevonden`);
          selected = track.id;
          const mime = `${kind}/mp4; codecs=\"${track.codec}\"`;
          if (!MediaSource.isTypeSupported(mime)) throw new Error(`Niet ondersteund: ${mime}`);
          const sb = ms.addSourceBuffer(mime);
          append = queue(sb);
          file.setSegmentOptions(track.id, null, { nbSamples: 120, rapAlignement: true });
          file.initializeSegmentation().filter(s => s.id === track.id).forEach(s => append(s.buffer));
          file.start();
          resolved = true;
          resolve(track);
        } catch (e) { reject(e); }
      };
      file.onSegment = (id, user, buffer) => {
        if (gen === generation && id === selected && append) append(buffer);
      };

      (async () => {
        try {
          const response = await fetch(url, { mode: 'cors', cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`${kind} HTTP ${response.status}`);
          if (!response.body?.getReader) throw new Error(`${kind}: streaming fetch ontbreekt`);
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done || gen !== generation) break;
            const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            chunk.fileStart = offset;
            offset += chunk.byteLength;
            file.appendBuffer(chunk);
          }
          file.flush();
        } catch (e) {
          if (e.name !== 'AbortError' && gen === generation) show(`${kind} stream fout: ${e.message || e}`);
        }
      })();
    });
  }
  async function startMse(cfg) {
    if (!window.MediaSource) { show('DIAG: MediaSource ontbreekt op dit Cast-apparaat'); return; }
    if (!window.MP4Box) { show('DIAG: MP4Box kon niet laden'); return; }
    cleanup();
    const gen = cfg.generation;
    const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const ms = new MediaSource();
    objectUrl = URL.createObjectURL(ms);
    video.pause();
    video.src = objectUrl;
    show('Muxeo legacy MSE: openen…');
    await waitOpen(ms);
    if (gen !== generation) return;
    show('Muxeo legacy MSE: video + audio demuxen…');
    const [v, a] = await Promise.all([
      streamTrack(cfg.videoUrl, 'video', ms, gen),
      streamTrack(cfg.audioUrl, 'audio', ms, gen)
    ]);
    if (gen !== generation) return;
    const vd = Number(v.duration || 0) / Math.max(1, Number(v.timescale || 1));
    const ad = Number(a.duration || 0) / Math.max(1, Number(a.timescale || 1));
    const duration = Math.max(vd, ad);
    if (Number.isFinite(duration) && duration > 0 && ms.readyState === 'open') {
      try { ms.duration = duration; } catch (_) {}
    }
    if (current > 0) { try { video.currentTime = current; } catch (_) {} }
    show('Muxeo legacy MSE: afspelen…');
    await video.play();
  }

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, request => {
    generation += 1;
    cleanup();
    const media = request?.media || {};
    const custom = media.customData || {};
    const useMse = custom.mseDemux === true;
    const picture = custom.videoUrl || media.contentUrl || media.contentId || '';
    const audio = custom.audioUrl || '';

    if (useMse && picture && audio) {
      pending = { generation, videoUrl: picture, audioUrl: audio };
      media.contentId = picture;
      media.contentUrl = picture;
      media.contentType = 'video/mp4';
      show(`Muxeo legacy MSE LOAD | MediaSource:${!!window.MediaSource} MP4Box:${!!window.MP4Box}`);
    } else {
      // Preferred Media3 path: one already combined MP4. MP4Box is deliberately irrelevant here.
      pending = null;
      media.contentType = 'video/mp4';
      show('Muxeo v20: gecombineerde MP4 laden…');
    }
    return request;
  });

  playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, () => {
    const cfg = pending;
    pending = null;
    if (!cfg || cfg.generation !== generation) return;
    setTimeout(() => {
      startMse(cfg).catch(e => {
        console.error('MSE activation failed', e);
        show(`Muxeo legacy MSE fout: ${e.message || e}`);
      });
    }, 0);
  });

  video.addEventListener('playing', hide);
  video.addEventListener('error', () => show(`Receiver mediafout ${video.error?.code || 'onbekend'}`));
  context.addEventListener(cast.framework.system.EventType.SHUTDOWN, () => { generation += 1; pending = null; cleanup(); });

  context.start(new cast.framework.CastReceiverOptions());
})();
