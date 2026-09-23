import { VideoRTC } from '/media/video-rtc.js';

/**
 * CctvPlayer - Pure WebRTC / MSE CCTV Player Element
 * Completely removes native browser controls, hides MSE watermarks,
 * and forces responsive 100% contain fit without off-center letterbox voids.
 */
export class CctvPlayer extends VideoRTC {
  constructor() {
    super();
    this.mode = 'webrtc,mse,mp4';
    this.media = 'video';
    this.background = true;
  }

  oninit() {
    super.oninit();
    if (this.video) {
      // Disable default browser controls and scrubber
      this.video.controls = false;
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.muted = true;
      this.video.preload = 'auto';

      // Clean full-bleed CCTV display
      this.video.style.width = '100%';
      this.video.style.height = '100%';
      this.video.style.objectFit = 'contain';
      this.video.style.display = 'block';
      this.video.style.backgroundColor = '#000000';

      // Forward playback lifecycle events
      this.video.addEventListener('playing', () => {
        this.dispatchEvent(new CustomEvent('cctv-playing', { detail: { video: this.video } }));
      });
      this.video.addEventListener('timeupdate', () => {
        this.dispatchEvent(new CustomEvent('cctv-timeupdate', { detail: { currentTime: this.video.currentTime, video: this.video } }));
      });
      this.video.addEventListener('waiting', () => {
        this.dispatchEvent(new CustomEvent('cctv-waiting', { detail: { video: this.video } }));
      });
      this.video.addEventListener('error', (e) => {
        this.dispatchEvent(new CustomEvent('cctv-error', { detail: e }));
      });
    }
  }
}

if (!customElements.get('cctv-player')) {
  customElements.define('cctv-player', CctvPlayer);
}

/**
 * Global helper to mount a clean CCTV video player inside any container
 * @param {HTMLElement} container
 * @param {string} streamName - go2rtc stream identifier (e.g. cam_81, playback_81)
 * @param {Object} options - { title, onPlaying, onTimeUpdate, onCreated }
 * @returns {CctvPlayer}
 */
window.mountCctvPlayer = function(container, streamName, options = {}) {
  if (!container) return null;

  const existingPlayer = container.querySelector('cctv-player');
  if (existingPlayer && options.isSeeking) {
    // Smooth seek/step: Keep the existing video frame on screen, reconnect stream without black flash or loading spinner
    try {
      if (typeof existingPlayer.ondisconnect === 'function') {
        existingPlayer.ondisconnect();
      }
      existingPlayer.src = `/media/api/ws?src=${encodeURIComponent(streamName)}&mode=webrtc,mse,mp4`;
      if (typeof existingPlayer.onconnect === 'function') {
        existingPlayer.onconnect();
      }
    } catch (e) {
      console.warn('Smooth reconnect error:', e);
    }
    return existingPlayer;
  }

  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'w-full h-full relative overflow-hidden flex items-center justify-center bg-black select-none';

  // Sleek CCTV Hub loading spinner (fades out when video starts playing)
  const loading = document.createElement('div');
  loading.className = 'cctv-loading-overlay absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/85 text-amber-400 select-none pointer-events-none transition-opacity duration-300';
  loading.innerHTML = `
    <i class="fa-solid fa-spinner fa-spin text-2xl mb-2 text-amber-400"></i>
    <span class="text-xs font-semibold text-white tracking-wide">Menghubungkan Stream...</span>
    <span class="text-[10px] text-slate-400 mt-0.5">${options.title || streamName}</span>
  `;
  wrapper.appendChild(loading);

  const player = document.createElement('cctv-player');
  player.className = 'w-full h-full block bg-black';
  player.style.width = '100%';
  player.style.height = '100%';
  player.style.display = 'block';

  // Connect to Same-Origin go2rtc WebSocket with WebRTC preferred, MSE/MP4 fallback
  player.src = `/media/api/ws?src=${encodeURIComponent(streamName)}&mode=webrtc,mse,mp4`;

  player.addEventListener('cctv-playing', () => {
    loading.style.opacity = '0';
    setTimeout(() => {
      if (loading.parentElement) loading.remove();
    }, 350);
    if (options.onPlaying && player.video) {
      options.onPlaying(player.video);
    }
  });

  player.addEventListener('cctv-timeupdate', (e) => {
    if (options.onTimeUpdate && player.video) {
      options.onTimeUpdate(player.video.currentTime, player.video);
    }
  });

  player.addEventListener('cctv-error', (err) => {
    loading.classList.remove('pointer-events-none');
    loading.style.opacity = '1';
    loading.innerHTML = `
      <i class="fa-solid fa-circle-exclamation text-2xl mb-2 text-rose-500"></i>
      <span class="text-xs font-semibold text-white">Stream Terputus</span>
      <button type="button" class="mt-2 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-white border border-slate-700 pointer-events-auto transition">Coba Hubungkan Ulang</button>
    `;
    const retryBtn = loading.querySelector('button');
    if (retryBtn) {
      retryBtn.onclick = (e) => {
        e.stopPropagation();
        window.mountCctvPlayer(container, streamName, options);
      };
    }
  });

  wrapper.appendChild(player);
  container.appendChild(wrapper);

  if (options.onCreated) {
    options.onCreated(player);
  }

  return player;
};

