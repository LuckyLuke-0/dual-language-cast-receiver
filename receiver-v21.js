(() => {
  'use strict';

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  const video = document.getElementById('media');
  const subtitle = document.getElementById('subtitle');
  const status = document.getElementById('status');
  playerManager.setMediaElement(video);

  let subtitleCues = [];
  let subtitleGeneration = 0;

  function show(message) {
    document.body.classList.remove('playing');
    status.textContent = message;
    status.style.display = 'block';
  }

  function hideStatus() {
    document.body.classList.add('playing');
    status.style.display = 'none';
  }

  function clearSubtitles() {
    subtitleGeneration += 1;
    subtitleCues = [];
    subtitle.textContent = '';
    subtitle.style.display = 'none';
  }

  function parseTime(value) {
    const parts = String(value || '').trim().split(':').map(Number);
    if (parts.some(Number.isNaN)) return NaN;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  function cleanCueText(lines) {
    return lines.join('\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .trim();
  }

  function parseWebVtt(text) {
    const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
    const blocks = normalized.split(/\n\n+/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(line => line.trimEnd());
      if (!lines.length || lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE')) continue;
      let timeIndex = lines.findIndex(line => line.includes('-->'));
      if (timeIndex < 0) continue;
      const timing = lines[timeIndex].split('-->');
      if (timing.length !== 2) continue;
      const start = parseTime(timing[0]);
      const end = parseTime(timing[1].trim().split(/\s+/)[0]);
      const cueText = cleanCueText(lines.slice(timeIndex + 1));
      if (Number.isFinite(start) && Number.isFinite(end) && end > start && cueText) {
        cues.push({ start, end, text: cueText });
      }
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  function applySubtitleStyle(style = {}) {
    const root = document.documentElement.style;
    const fontKey = String(style.fontFamily || 'sans_serif').toLowerCase();
    const fontMap = {
      sans_serif: 'Arial, Helvetica, sans-serif',
      arial: 'Arial, Helvetica, sans-serif',
      verdana: 'Verdana, Geneva, sans-serif',
      condensed: '"Arial Narrow", "Roboto Condensed", Arial, sans-serif',
      serif: 'Georgia, "Times New Roman", serif',
      serif_monospace: '"Courier New", Courier, monospace',
      monospace: '"Roboto Mono", "Courier New", monospace',
      casual: '"Comic Sans MS", "Trebuchet MS", cursive',
      cursive: 'cursive',
      light: 'Arial, Helvetica, sans-serif',
      medium: 'Arial, Helvetica, sans-serif',
      heavy: 'Arial, Helvetica, sans-serif'
    };

    const size = Math.max(40, Math.min(80, Number(style.textSizePercent) || 60));
    const bottom = Math.max(0, Math.min(30, Number(style.bottomMarginPercent) || 4));
    const opacity = Math.max(0, Math.min(1, Number(style.backgroundOpacity) || 0));
    const background = String(style.backgroundColor || '#000000');
    const textColor = String(style.textColor || '#FFFFFF');
    const blackOutline = style.blackOutline === true;
    const explicitBold = style.isBold;
    const weight = fontKey === 'light' ? 300
      : fontKey === 'medium' ? 500
      : fontKey === 'heavy' ? 900
      : explicitBold === false ? 400 : 700;

    root.setProperty('--subtitle-size', String(size));
    root.setProperty('--subtitle-bottom', `${bottom}%`);
    root.setProperty('--subtitle-color', textColor);
    root.setProperty('--subtitle-font', fontMap[fontKey] || fontMap.sans_serif);
    root.setProperty('--subtitle-weight', String(weight));
    root.setProperty('--subtitle-spacing', fontKey === 'verdana' ? '0.06em' : '0');
    root.setProperty('--subtitle-background', opacity > 0 ? toRgba(background, opacity) : 'transparent');
    root.setProperty('--subtitle-padding-x', opacity > 0 ? '0.38em' : '0');
    root.setProperty('--subtitle-padding-y', opacity > 0 ? '0.12em' : '0');
    root.setProperty('--subtitle-shadow', blackOutline
      ? '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 2px 2px rgba(0,0,0,.85)'
      : 'none');
  }

  function toRgba(hex, alpha) {
    const raw = String(hex || '#000000').replace('#', '');
    const value = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw.padEnd(6, '0').slice(0, 6);
    const num = Number.parseInt(value, 16);
    if (!Number.isFinite(num)) return `rgba(0,0,0,${alpha})`;
    return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${alpha})`;
  }

  async function configureSubtitles(url, style) {
    clearSubtitles();
    applySubtitleStyle(style || {});
    if (!url) return;
    const generation = subtitleGeneration;
    try {
      const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (generation !== subtitleGeneration) return;
      subtitleCues = parseWebVtt(text);
      console.log(`Muxeo: ${subtitleCues.length} ondertitelcues geladen`);
    } catch (error) {
      console.error('Subtitle loading failed', error);
    }
  }

  function renderSubtitle() {
    if (!subtitleCues.length || !Number.isFinite(video.currentTime)) {
      subtitle.style.display = 'none';
      subtitle.textContent = '';
      return;
    }
    const now = video.currentTime;
    const cue = subtitleCues.find(item => now >= item.start && now < item.end);
    if (!cue) {
      subtitle.style.display = 'none';
      subtitle.textContent = '';
      return;
    }
    if (subtitle.textContent !== cue.text) subtitle.textContent = cue.text;
    subtitle.style.display = 'block';
  }

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, request => {
    clearSubtitles();
    const media = request?.media || {};
    const custom = media.customData || {};
    media.contentType = 'video/mp4';
    if (custom.videoUrl) {
      media.contentId = custom.videoUrl;
      media.contentUrl = custom.videoUrl;
    }
    configureSubtitles(custom.subtitleUrl || '', custom.subtitleStyle || {});
    show('Muxeo v21: gecombineerde MP4 + ondertiteling laden…');
    return request;
  });

  video.addEventListener('timeupdate', renderSubtitle);
  video.addEventListener('seeking', renderSubtitle);
  video.addEventListener('playing', () => { hideStatus(); renderSubtitle(); });
  video.addEventListener('error', () => show(`Receiver mediafout ${video.error?.code || 'onbekend'}`));
  context.addEventListener(cast.framework.system.EventType.SHUTDOWN, clearSubtitles);

  context.start(new cast.framework.CastReceiverOptions());
})();
