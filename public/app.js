/**
 * CCTV Central Hub v2 - Frontend Application Logic
 * Supports: Live View, Playback Tanggal Lama, Auto-Channel Discovery, and NVR Tree View
 */

// Application State
const state = {
  token: localStorage.getItem('cctv_token') || null,
  user: null,
  activeTab: 'liveView',
  gridSize: 4, // default 2x2
  selectedGroupId: '',
  searchQuery: '',
  sidebarFilter: '',
  groups: [],
  devices: [],
  cameras: [],
  jobs: [],
  playbackClips: [],
  playbackClipsKey: null,
  activePlaybackCamId: null,
  focusedCamId: null,
  prevGridSize: 4,
  ws: null
};

// --- DOM READY INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  checkAuth();
  startOSDClock();
  initWebSocket();
});

// --- WEBSOCKET REALTIME NOTIFICATIONS & SYNC ---
function initWebSocket() {
  const loc = window.location;
  const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${loc.host}`;

  try {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WebSocket] Terhubung ke CCTV Server.');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Auto-refresh downloads
        if (data.type === 'DOWNLOAD_PROGRESS' || data.type === 'DOWNLOAD_FINISHED' || data.type === 'DOWNLOAD_ERROR') {
          if (typeof fetchDownloads === 'function' && state.activeTab === 'downloads') {
            fetchDownloads();
          }
        }

        // Channel names updated on physical NVR
        if (data.type === 'CHANNELS_UPDATED') {
          showToast(`Nama channel NVR "${data.deviceName}" otomatis disinkronkan (${data.updatedCount} update)!`, 'info');
          fetchDevices();
          fetchCameras();
        }

        // NVR IP changed & auto-discovered
        if (data.type === 'DEVICE_IP_UPDATED') {
          showToast(`NVR "${data.deviceName}" berpindah IP ke ${data.newIp}. Sistem otomatis terhubung kembali!`, 'warning');
          fetchDevices();
          fetchCameras();
        }
      } catch (e) {}
    };

    ws.onclose = () => {
      setTimeout(initWebSocket, 5000);
    };
  } catch (err) {
    console.warn('[WebSocket] Gagal konek:', err.message);
  }
}

// --- CLOCK OSD OVERLAY TICKER (24 JAM & DETIK) ---
function startOSDClock() {
  const pad = (n) => String(n).padStart(2, '0');
  setInterval(() => {
    const now = new Date();
    const timeStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    document.querySelectorAll('.osd-time').forEach(el => {
      el.textContent = timeStr;
    });
  }, 1000);
}

// --- EVENT LISTENERS SETUP ---
function initEventListeners() {
  // Login Form
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);

  // Toggle Sidebar
  document.getElementById('toggleSidebarBtn').addEventListener('click', () => {
    const sidebar = document.getElementById('nvrSidebar');
    sidebar.classList.toggle('hidden');
  });

  // Sidebar Filter Input
  document.getElementById('sidebarFilterInput').addEventListener('input', (e) => {
    state.sidebarFilter = e.target.value.toLowerCase().trim();
    renderSidebarTree();
  });

  // Tab Navigation
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      switchTab(tabName);
    });
  });

  // Global Instant Search
  const searchInput = document.getElementById('globalSearchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');

  let debounceTimer;
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    if (state.searchQuery) {
      clearSearchBtn.classList.remove('hidden');
    } else {
      clearSearchBtn.classList.add('hidden');
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (state.activeTab !== 'liveView' && state.searchQuery) {
        switchTab('liveView');
      }
      fetchCameras();
    }, 250);
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    clearSearchBtn.classList.add('hidden');
    fetchCameras();
  });

  // Grid Controls (1x1, 2x2, 3x3, 4x4)
  document.querySelectorAll('.grid-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('active', 'bg-slate-800', 'text-white'));
      btn.classList.add('active', 'bg-slate-800', 'text-white');
      state.gridSize = parseInt(btn.dataset.grid, 10);
      liveCurrentPage = 0;
      if (state.gridSize !== 1) {
        state.focusedCamId = null;
      } else if (!state.focusedCamId && state.cameras.length > 0) {
        state.focusedCamId = state.cameras[0].id;
      }
      updateGridDisplay();
      renderCameraGrid();
      if (state.gridSize === 1 && state.focusedCamId) {
        playLiveStream(state.focusedCamId);
      }
    });
  });

  // Global Escape Key to exit 1x1 focused mode, and 'F' key for Playback Fullscreen
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.gridSize === 1 && state.focusedCamId) {
      toggleCameraFocus(state.focusedCamId);
    }
    if (e.key === 'f' || e.key === 'F') {
      const tag = document.activeElement?.tagName;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
      const pbTab = document.getElementById('tab-playback');
      if (pbTab && !pbTab.classList.contains('hidden')) {
        e.preventDefault();
        togglePlaybackFullscreen();
      }
    }
  });

  // --- PLAYBACK CONTROLS ---
  document.getElementById('pbDeviceSelect').addEventListener('change', (e) => {
    updatePlaybackChannelOptions(e.target.value);
  });

  document.querySelectorAll('.playback-date-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.playback-date-preset').forEach(b => {
        b.classList.remove('active', 'border-brand-500', 'bg-brand-500/20', 'text-brand-300');
        b.classList.add('border-cctv-border', 'bg-slate-900', 'text-slate-400');
      });
      btn.classList.add('active', 'border-brand-500', 'bg-brand-500/20', 'text-brand-300');

      const offsetDays = parseInt(btn.dataset.offset, 10) || 0;
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - offsetDays);
      const pad = (n) => String(n).padStart(2, '0');
      document.getElementById('pbDateInput').value = `${targetDate.getFullYear()}-${pad(targetDate.getMonth() + 1)}-${pad(targetDate.getDate())}`;

      // If device and channel selected, auto-trigger search
      const devId = document.getElementById('pbDeviceSelect').value;
      const chNo = document.getElementById('pbChannelSelect').value;
      if (devId && chNo) {
        handlePlaybackSearch();
      }
    });
  });

  document.getElementById('playbackSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handlePlaybackSearch();
  });

  // Init Playback Control Toolbar (Speed, Zoom, Play/Pause, Stop, Single Frame)
  initPlaybackToolbar();
  initTimelineControls();
  initCalendarPopoverControls();

  // --- DOWNLOAD CONTROLS ---
  document.getElementById('dlDeviceSelect').addEventListener('change', (e) => {
    updateDownloadChannelOptions(e.target.value);
  });

  // Download Start & End Time synchronization
  const dlStartInput = document.getElementById('dlStartTime');
  const dlEndInput = document.getElementById('dlEndTime');
  const onDlTimeChange = () => {
    if (dlStartInput?.value && dlEndInput?.value) {
      const s = new Date(dlStartInput.value).getTime();
      const e = new Date(dlEndInput.value).getTime();
      if (e > s) {
        const diffMins = Math.max(1, Math.round((e - s) / 60000));
        const durInput = document.getElementById('dlDurationInput');
        if (durInput) durInput.value = diffMins;
        const durLabel = document.getElementById('dlCalculatedDurationLabel');
        if (durLabel) durLabel.textContent = `Durasi: ${formatDurationText(diffMins)}`;
        document.querySelectorAll('.duration-btn').forEach(b => {
          const match = b.dataset.mins === String(diffMins);
          b.classList.toggle('active', match);
          b.classList.toggle('border-brand-500', match);
          b.classList.toggle('bg-brand-500/20', match);
          b.classList.toggle('text-brand-400', match);
          b.classList.toggle('border-cctv-border', !match);
          b.classList.toggle('bg-slate-900', !match);
          b.classList.toggle('text-slate-400', !match);
        });
      }
    }
  };
  dlStartInput?.addEventListener('change', onDlTimeChange);
  dlEndInput?.addEventListener('change', onDlTimeChange);

  document.querySelectorAll('.duration-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.duration-btn').forEach(b => {
        b.classList.remove('active', 'border-brand-500', 'bg-brand-500/20', 'text-brand-400');
        b.classList.add('border-cctv-border', 'bg-slate-900', 'text-slate-400');
      });
      btn.classList.add('active', 'border-brand-500', 'bg-brand-500/20', 'text-brand-400');
      const mins = parseInt(btn.dataset.mins, 10);
      document.getElementById('dlDurationInput').value = mins;
      updateDlEndTimeFromDuration(mins);
    });
  });

  document.getElementById('downloadForm').addEventListener('submit', handleDownloadSubmit);
  document.getElementById('checkRecordingsBtn').addEventListener('click', handleCheckRecordings);
  document.getElementById('refreshJobsBtn').addEventListener('click', fetchDownloads);

  // Add Device Form & Test Connection
  document.getElementById('testConnBtn').addEventListener('click', handleTestConnection);
  document.getElementById('btnAutoFindSerial')?.addEventListener('click', handleAutoFindSerial);
  document.getElementById('btnScanSadp')?.addEventListener('click', handleScanSadp);
  document.getElementById('addDeviceForm').addEventListener('submit', handleAddDeviceSubmit);

  // Edit Camera Form
  document.getElementById('editCameraForm').addEventListener('submit', handleEditCameraSubmit);

  // Add Group Form
  document.getElementById('addGroupForm').addEventListener('submit', handleAddGroupSubmit);

  // Add User Form
  document.getElementById('addUserForm').addEventListener('submit', handleAddUserSubmit);
}

// --- TAB SWITCHING ---
function switchTab(tabName) {
  state.activeTab = tabName;

  document.querySelectorAll('.nav-tab').forEach(tab => {
    if (tab.dataset.tab === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  document.querySelectorAll('.tab-content').forEach(content => {
    if (content.id === `tab-${tabName}`) {
      content.classList.remove('hidden');
    } else {
      content.classList.add('hidden');
    }
  });

  if (tabName === 'liveView') {
    fetchCameras();
  } else if (tabName === 'playback') {
    initPlaybackDefaults();
  } else if (tabName === 'downloads') {
    fetchDownloads();
    initDownloadDefaults();
  } else if (tabName === 'devices') {
    fetchDevices();
  } else if (tabName === 'users') {
    fetchUsers();
  }
  updateSidebarActiveCamera();
}

// --- AUTHENTICATION ---
async function checkAuth() {
  if (!state.token) {
    showLoginModal();
    return;
  }

  try {
    const res = await apiRequest('/api/auth/me');
    if (res.success && res.user) {
      state.user = res.user;
      hideLoginModal();
      initApp();
    } else {
      showLoginModal();
    }
  } catch (err) {
    showLoginModal();
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  const alertEl = document.getElementById('loginAlert');
  const btn = document.getElementById('loginBtn');

  alertEl.classList.add('hidden');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Memproses...</span>';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (data.success) {
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('cctv_token', data.token);
      hideLoginModal();
      initApp();
      showToast('Selamat datang, ' + data.user.name, 'success');
    } else {
      alertEl.textContent = data.error || 'Login gagal.';
      alertEl.classList.remove('hidden');
    }
  } catch (err) {
    alertEl.textContent = 'Gagal menghubungi server.';
    alertEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>Masuk ke Sistem</span> <i class="fa-solid fa-arrow-right text-sm"></i>';
  }
}

function handleLogout() {
  if (confirm('Apakah Anda yakin ingin keluar dari sistem CCTV?')) {
    localStorage.removeItem('cctv_token');
    state.token = null;
    state.user = null;
    if (state.ws) state.ws.close();
    showLoginModal();
  }
}

function showLoginModal() {
  document.getElementById('loginModal').classList.remove('hidden');
  document.getElementById('appContainer').classList.add('hidden');
}

function hideLoginModal() {
  document.getElementById('loginModal').classList.add('hidden');
  document.getElementById('appContainer').classList.remove('hidden');
}

// --- INITIALIZE APPLICATION DATA ---
async function initApp() {
  document.getElementById('currentUserName').textContent = state.user.name || state.user.username;
  document.getElementById('currentUserRole').textContent = state.user.role.toUpperCase();

  if (state.user.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  } else {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
  }

  initWebSocket();
  await fetchGroups();
  await fetchDevices();
  await fetchCameras();
  initPlaybackDefaults();
  initDownloadDefaults();
  startSnapshotAutoRefresh();
}

// --- API HELPER ---
async function apiRequest(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const res = await fetch(endpoint, {
    ...options,
    headers
  });

  if (res.status === 401) {
    localStorage.removeItem('cctv_token');
    state.token = null;
    showLoginModal();
    throw new Error('Sesi berakhir, silakan login kembali.');
  }

  return await res.json();
}

// --- WEBSOCKET FOR REALTIME EVENTS ---
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'DOWNLOAD_PROGRESS') {
        updateJobProgressUI(data.jobId, data.progress, data.bytesDownloaded, data.totalBytes);
      } else if (data.type === 'DOWNLOAD_STATUS_CHANGED') {
        fetchDownloads();
      }
    } catch (e) {}
  };

  state.ws.onclose = () => {
    setTimeout(initWebSocket, 5000);
  };
}

// --- GROUPS MANAGEMENT ---
async function fetchGroups() {
  try {
    const res = await apiRequest('/api/groups');
    if (res.success) {
      state.groups = res.groups;
      renderGroupFilterPills();
      populateGroupSelects();
    }
  } catch (err) {
    console.error('Fetch groups error:', err);
  }
}

function renderGroupFilterPills() {
  const container = document.getElementById('groupFilterPills');
  let html = `
    <button class="group-pill ${state.selectedGroupId === '' ? 'active' : ''} px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition" onclick="filterByGroup('')">
      <i class="fa-solid fa-layer-group mr-1"></i> Semua Grup
    </button>
  `;

  state.groups.forEach(g => {
    const isActive = state.selectedGroupId === String(g.id);
    html += `
      <button class="group-pill ${isActive ? 'active' : ''} px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition" onclick="filterByGroup('${g.id}')">
        ${g.name} (${g.camera_count || 0})
      </button>
    `;
  });

  // Action buttons: Add Group and Manage Groups
  if (state.user && state.user.role === 'admin') {
    html += `
      <button type="button" onclick="openAddGroupModal()" class="px-2.5 py-1 rounded-lg text-xs font-semibold text-brand-400 hover:text-white bg-slate-900 border border-cctv-border hover:bg-brand-500/20 whitespace-nowrap transition flex items-center space-x-1 shadow-sm" title="Tambah Grup / Folder Baru">
        <i class="fa-solid fa-folder-plus text-[11px]"></i>
        <span>+ Grup</span>
      </button>
      <button type="button" onclick="openAddGroupModal()" class="px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-400 hover:text-white bg-slate-900 border border-cctv-border hover:bg-slate-800 whitespace-nowrap transition flex items-center space-x-1 shadow-sm" title="Kelola Grup (Ubah Nama / Hapus)">
        <i class="fa-solid fa-gear text-[11px]"></i>
        <span>Kelola</span>
      </button>
    `;
  }

  container.innerHTML = html;
}

function filterByGroup(groupId) {
  state.selectedGroupId = groupId;
  renderGroupFilterPills();
  fetchCameras();
}

function populateGroupSelects() {
  const devGroup = document.getElementById('devGroup');
  const editCamGroup = document.getElementById('editCamGroup');
  const sidebarGroupFilter = document.getElementById('sidebarGroupFilter');
  const assignGroupSelect = document.getElementById('assignGroupSelect');

  let opts = '<option value="">-- Tanpa Grup --</option>';
  state.groups.forEach(g => {
    opts += `<option value="${g.id}">${g.name}</option>`;
  });

  if (devGroup) devGroup.innerHTML = opts;
  if (editCamGroup) editCamGroup.innerHTML = opts;
  if (assignGroupSelect) assignGroupSelect.innerHTML = '<option value="">-- Tanpa Grup (Umum) --</option>' + state.groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('');

  if (sidebarGroupFilter) {
    const curVal = sidebarGroupFilter.value;
    let filterOpts = '<option value="">Semua Grup</option>';
    state.groups.forEach(g => {
      filterOpts += `<option value="${g.id}">📁 ${g.name} (${g.camera_count || 0})</option>`;
    });
    sidebarGroupFilter.innerHTML = filterOpts;
    if (curVal && state.groups.some(g => String(g.id) === curVal)) {
      sidebarGroupFilter.value = curVal;
    }
  }
}

function onSidebarGroupFilterChange(groupId) {
  state.sidebarGroupFilter = groupId;
  renderSidebarTree();
}

// Open modal to assign NVR to a Group
function openAssignNvrGroupModal(devId, devName, currentGroupId) {
  const modal = document.getElementById('assignNvrGroupModal');
  const devIdInput = document.getElementById('assignDevId');
  const devNameInput = document.getElementById('assignDevName');
  const groupSelect = document.getElementById('assignGroupSelect');

  if (devIdInput) devIdInput.value = devId;
  if (devNameInput) devNameInput.value = devName;
  if (groupSelect) groupSelect.value = currentGroupId ? String(currentGroupId) : '';
  if (modal) modal.classList.remove('hidden');
}

function closeAssignNvrGroupModal() {
  const modal = document.getElementById('assignNvrGroupModal');
  if (modal) modal.classList.add('hidden');
}

async function handleAssignNvrGroup(e) {
  e.preventDefault();
  const devId = document.getElementById('assignDevId').value;
  const groupId = document.getElementById('assignGroupSelect').value;

  try {
    const res = await apiRequest(`/api/devices/${devId}`, {
      method: 'PUT',
      body: JSON.stringify({ group_id: groupId ? parseInt(groupId, 10) : null })
    });

    if (res.success) {
      showToast('NVR berhasil dipindahkan ke grup!', 'info');
      closeAssignNvrGroupModal();
      await fetchGroups();
      await fetchDevices();
      await fetchCameras();
    } else {
      showToast(res.error || 'Gagal memindahkan NVR', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- DEVICES (NVR) MANAGEMENT ---
async function fetchDevices() {
  try {
    const res = await apiRequest('/api/devices');
    if (res.success) {
      state.devices = res.devices;
      renderDevicesList();
      populateDownloadDeviceSelect();
      populatePlaybackDeviceSelect();
      updateHeaderSummary();
      renderSidebarTree();
    }
  } catch (err) {
    console.error('Fetch devices error:', err);
  }
}

function updateHeaderSummary() {
  const totalNvr = state.devices.length;
  const totalCam = state.devices.reduce((acc, d) => acc + (d.camera_count || 0), 0);
  document.getElementById('statSummary').innerHTML = `
    <span class="text-white font-medium">${totalNvr} NVR</span>
    <span class="text-slate-600">•</span>
    <span class="text-white font-medium">${totalCam} Kamera Terdeteksi</span>
  `;
  const sidebarLabel = document.getElementById('sidebarTotalCamLabel');
  if (sidebarLabel) sidebarLabel.textContent = `${totalCam} Kamera Terdaftar`;
}

// --- SIDEBAR TREE VIEW: GROUPED BY FOLDER & NVR ---
function renderSidebarTree() {
  const container = document.getElementById('sidebarNvrTree');
  if (!container) return;

  if (state.devices.length === 0) {
    container.innerHTML = `
      <div class="p-4 text-center text-xs text-slate-500">
        Belum ada NVR terdaftar.
      </div>
    `;
    return;
  }

  // Filter devices by selected group in sidebar
  let filteredDevices = state.devices;
  if (state.sidebarGroupFilter) {
    filteredDevices = state.devices.filter(d => String(d.group_id) === String(state.sidebarGroupFilter));
  }

  // Group devices by group_id
  const groupMap = new Map();
  // Initialize with known groups
  state.groups.forEach(g => {
    groupMap.set(String(g.id), { id: g.id, name: g.name, devices: [] });
  });
  // Add "Tanpa Grup" bucket
  groupMap.set('null', { id: null, name: 'Tanpa Grup (Umum)', devices: [] });

  filteredDevices.forEach(dev => {
    const gKey = dev.group_id ? String(dev.group_id) : 'null';
    if (!groupMap.has(gKey)) {
      groupMap.set(gKey, { id: dev.group_id, name: dev.group_name || 'Grup', devices: [] });
    }
    groupMap.get(gKey).devices.push(dev);
  });

  let html = '';

  groupMap.forEach((grp, gKey) => {
    if (grp.devices.length === 0 && state.sidebarGroupFilter) return;

    // Don't show empty groups unless searching
    if (grp.devices.length === 0 && !state.sidebarFilter) return;

    let devCardsHtml = '';

    grp.devices.forEach(dev => {
      const isOnline = dev.status === 'online';
      const devCameras = state.cameras.filter(c => c.device_id === dev.id);

      // Filter by search text
      const filteredCams = state.sidebarFilter
        ? devCameras.filter(c => c.custom_name.toLowerCase().includes(state.sidebarFilter) || String(c.channel_no).includes(state.sidebarFilter))
        : devCameras;

      if (state.sidebarFilter && filteredCams.length === 0 && !dev.name.toLowerCase().includes(state.sidebarFilter)) {
        return;
      }

      devCardsHtml += `
        <div class="border border-cctv-border/70 rounded-lg overflow-hidden bg-slate-900/60 mb-1.5 shadow-sm">
          <!-- NVR Header Item -->
          <div class="w-full px-2 py-1.5 flex items-center justify-between hover:bg-slate-800/60 transition text-xs font-semibold text-white cursor-pointer"
            onclick="toggleSidebarNode('sb-node-${dev.id}')">
            <div class="flex items-center space-x-1.5 truncate mr-1">
              <span class="inline-block w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400 shadow-[0_0_4px_#10b981]' : 'bg-slate-500'} flex-shrink-0"></span>
              <span class="truncate text-[11px]" title="${dev.name}">${dev.name}</span>
            </div>
            <div class="flex items-center space-x-1 text-[10px] text-slate-400 flex-shrink-0">
              <span class="px-1 py-0.2 rounded bg-slate-800 font-mono text-[9px]">${dev.camera_count} Ch</span>
              ${state.user && state.user.role === 'admin' ? `
              <button type="button" onclick="event.stopPropagation(); openAssignNvrGroupModal(${dev.id}, '${escapeQuotes(dev.name)}', ${dev.group_id || 'null'})"
                class="p-0.5 px-1 rounded hover:bg-amber-500/20 text-slate-400 hover:text-amber-400 text-[9px]" title="Pindahkan NVR ke Grup">
                <i class="fa-solid fa-folder-tree"></i>
              </button>` : ''}
              <i id="sb-icon-${dev.id}" class="fa-solid fa-chevron-down text-[8px] transition duration-200"></i>
            </div>
          </div>

          <!-- Channels List -->
          <div id="sb-node-${dev.id}" class="divide-y divide-cctv-border/30 bg-slate-950/80 text-xs">
            ${filteredCams.map(cam => {
              const chPad = String(cam.channel_no).padStart(2, '0');
              return `
                <div id="sb-cam-${cam.id}" data-cam-id="${cam.id}" data-device-id="${cam.device_id}" data-channel-no="${cam.channel_no}"
                  class="sb-cam-row px-2 py-1.5 flex items-center justify-between hover:bg-slate-900 transition group border-l-2 border-transparent">
                  <div class="flex items-center space-x-1.5 truncate mr-1 cursor-pointer flex-1 min-w-0" onclick="selectCameraFromSidebar(${cam.device_id}, ${cam.channel_no}, ${cam.id})">
                    <span class="sb-ch-badge px-1 py-0.2 rounded bg-slate-800 text-[9px] font-mono text-brand-400 flex-shrink-0">CH ${chPad}</span>
                    <span class="sb-cam-name truncate text-[11px] text-slate-200 group-hover:text-brand-300 font-medium" title="${cam.custom_name}">
                      ${cam.custom_name}
                    </span>
                  </div>
                  <div class="flex items-center space-x-1.5 flex-shrink-0">
                    <div class="sb-cam-status-badge"></div>
                    <div class="flex items-center space-x-0.5 opacity-0 group-hover:opacity-100 transition">
                      <button onclick="openCameraPlaybackDirect(${cam.device_id}, ${cam.channel_no}, ${cam.id}, '${escapeQuotes(cam.custom_name)}')"
                        class="p-0.5 rounded hover:bg-amber-950/60 text-amber-400 text-[10px]" title="Buka Playback Kamera Ini">
                        <i class="fa-solid fa-clock-rotate-left"></i>
                      </button>
                      <button onclick="quickDownloadCamera(${cam.device_id}, ${cam.channel_no})"
                        class="p-0.5 rounded hover:bg-emerald-950/60 text-emerald-400 text-[10px]" title="Unduh Video">
                        <i class="fa-solid fa-download"></i>
                      </button>
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    });

    if (devCardsHtml) {
      const gNodeId = `sb-grp-${gKey}`;
      html += `
        <div class="border border-cctv-border/80 rounded-xl overflow-hidden bg-slate-950/40 mb-2">
          <div class="px-2.5 py-1.5 bg-slate-900/80 border-b border-cctv-border/50 flex items-center justify-between cursor-pointer select-none"
            onclick="toggleSidebarNode('${gNodeId}')">
            <div class="flex items-center space-x-1.5 text-xs font-bold text-amber-300 truncate">
              <i class="fa-solid fa-folder-open text-amber-400 text-[11px]"></i>
              <span class="truncate">${grp.name}</span>
            </div>
            <span class="text-[10px] text-slate-400 font-mono">${grp.devices.length} NVR</span>
          </div>
          <div id="${gNodeId}" class="p-1.5">
            ${devCardsHtml}
          </div>
        </div>
      `;
    }
  });

  container.innerHTML = html || '<div class="p-3 text-center text-xs text-slate-500">Tidak ada NVR atau kamera yang cocok.</div>';
  updateSidebarActiveCamera();
}

function updateSidebarActiveCamera() {
  const rows = document.querySelectorAll('.sb-cam-row');
  if (!rows || rows.length === 0) return;

  const activeSlot = pbSlots ? pbSlots[activePbSlot] : null;
  const activePbCamId = activeSlot ? Number(activeSlot.camId) : null;
  const activePbDevId = activeSlot ? Number(activeSlot.deviceId) : null;
  const activePbChNo = activeSlot ? Number(activeSlot.channelNo) : null;
  const activeLiveCamId = state.focusedCamId || state.activeLiveCamId;

  rows.forEach(row => {
    const cId = Number(row.dataset.camId);
    const dId = Number(row.dataset.deviceId);
    const chNo = Number(row.dataset.channelNo);

    const isPbActiveSlot = (activePbCamId && cId === activePbCamId) || (activePbDevId && activePbDevId === dId && activePbChNo === chNo);
    const isPbPlaying = pbSlots ? pbSlots.some(s => s.isPlaying && (Number(s.camId) === cId || (Number(s.deviceId) === dId && Number(s.channelNo) === chNo))) : false;
    const isLiveActive = (state.activeTab === 'liveView' && activeLiveCamId && cId === Number(activeLiveCamId));

    const isOpen = (state.activeTab === 'playback' ? (isPbActiveSlot || isPbPlaying) : isLiveActive) || isPbActiveSlot || isPbPlaying;

    const badgeContainer = row.querySelector('.sb-cam-status-badge');
    const chBadge = row.querySelector('.sb-ch-badge');
    const nameEl = row.querySelector('.sb-cam-name');

    if (isOpen) {
      row.classList.add('bg-amber-500/15', 'border-amber-400', 'shadow-[inset_0_0_10px_rgba(245,158,11,0.15)]');
      row.classList.remove('border-transparent', 'hover:bg-slate-900');
      if (chBadge) {
        chBadge.className = 'sb-ch-badge px-1 py-0.2 rounded bg-amber-500/30 text-amber-300 font-mono text-[9px] font-bold border border-amber-400/50 flex-shrink-0';
      }
      if (nameEl) {
        nameEl.className = 'sb-cam-name truncate text-[11px] text-amber-200 font-bold';
      }
      if (badgeContainer) {
        badgeContainer.innerHTML = `
          <span class="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-300 border border-amber-400/50 text-[9px] font-bold select-none shadow-sm">
            <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
            <span>DIBUKA</span>
          </span>
        `;
      }
    } else {
      row.classList.remove('bg-amber-500/15', 'border-amber-400', 'shadow-[inset_0_0_10px_rgba(245,158,11,0.15)]');
      row.classList.add('border-transparent', 'hover:bg-slate-900');
      if (chBadge) {
        chBadge.className = 'sb-ch-badge px-1 py-0.2 rounded bg-slate-800 text-[9px] font-mono text-brand-400 flex-shrink-0';
      }
      if (nameEl) {
        nameEl.className = 'sb-cam-name truncate text-[11px] text-slate-200 group-hover:text-brand-300 font-medium';
      }
      if (badgeContainer) {
        badgeContainer.innerHTML = '';
      }
    }
  });
}

function toggleSidebarNode(nodeId) {
  const node = document.getElementById(nodeId);
  if (node) node.classList.toggle('hidden');
}

function selectCameraFromSidebar(deviceId, channelNo, camId) {
  if (state.activeTab === 'playback') {
    document.getElementById('pbDeviceSelect').value = deviceId;
    updatePlaybackChannelOptions(deviceId).then(() => {
      document.getElementById('pbChannelSelect').value = channelNo;
      handlePlaybackSearch();
      updateSidebarActiveCamera();
    });
  } else if (state.activeTab === 'downloads') {
    quickDownloadCamera(deviceId, channelNo);
  } else {
    // Switch to Live View and scroll to camera
    switchTab('liveView');
    setTimeout(() => {
      const card = document.getElementById(`cam-player-${camId}`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('ring-2', 'ring-brand-500');
        setTimeout(() => card.classList.remove('ring-2', 'ring-brand-500'), 2000);
      }
      updateSidebarActiveCamera();
    }, 200);
  }
}

function openCameraPlaybackDirect(deviceId, channelNo, camId, camName) {
  switchTab('playback');
  document.getElementById('pbDeviceSelect').value = deviceId;
  updatePlaybackChannelOptions(deviceId).then(() => {
    document.getElementById('pbChannelSelect').value = channelNo;
    handlePlaybackSearch();
    updateSidebarActiveCamera();
  });
}

// --- DEVICES VIEW TABLE ---
function renderDevicesList() {
  const container = document.getElementById('devicesListContainer');
  if (!container) return;

  if (state.devices.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center bg-cctv-panel rounded-2xl border border-cctv-border text-slate-400">
        <i class="fa-solid fa-server text-3xl mb-2 text-slate-600"></i>
        <p class="text-sm">Belum ada NVR yang ditambahkan.</p>
        <button onclick="openAddDeviceModal()" class="mt-3 px-4 py-1.5 rounded-xl bg-brand-500 text-white text-xs font-semibold">
          + Tambah NVR Pertama
        </button>
      </div>
    `;
    return;
  }

  let html = '';
  state.devices.forEach(dev => {
    const isOnline = dev.status === 'online';
    html += `
      <div class="bg-cctv-panel border border-cctv-border rounded-2xl p-5 shadow-lg space-y-4">
        <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 pb-3 border-b border-cctv-border">
          <div class="flex items-center space-x-3">
            <div class="w-12 h-12 rounded-xl bg-slate-900 border border-cctv-border flex items-center justify-center text-xl text-brand-500">
              <i class="fa-solid fa-server"></i>
            </div>
            <div>
              <div class="flex items-center space-x-2">
                <h3 class="font-bold text-white text-base">${dev.name}</h3>
                <span class="px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${isOnline ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-400'}">
                  <span class="inline-block w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-slate-500'} mr-1"></span>
                  ${isOnline ? 'ONLINE' : 'OFFLINE'}
                </span>
                ${dev.group_name ? `<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30">${dev.group_name}</span>` : ''}
              </div>
              <p class="text-xs text-slate-400 font-mono mt-0.5">
                IP: <span class="text-slate-200">${dev.ip}</span> | HTTP: ${dev.http_port} | RTSP: ${dev.rtsp_port} | User: ${dev.username}
              </p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button onclick="syncNvrChannels(${dev.id})" class="px-3 py-1.5 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 text-xs border border-emerald-800/40 transition flex items-center space-x-1.5" title="Sinkronkan nama asli kamera dari NVR">
              <i class="fa-solid fa-wand-magic-sparkles text-emerald-400"></i>
              <span>Auto-Sync Nama Asli</span>
            </button>
            <button onclick="testExistingDevice(${dev.id})" class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs border border-cctv-border transition flex items-center space-x-1">
              <i class="fa-solid fa-bolt text-yellow-400"></i>
              <span>Test Ping</span>
            </button>
            <button onclick="toggleDeviceChannels(${dev.id})" class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-brand-400 text-xs border border-cctv-border transition flex items-center space-x-1">
              <i class="fa-solid fa-camera"></i>
              <span>Lihat ${dev.camera_count} Channel</span>
              <i class="fa-solid fa-chevron-down text-[10px] ml-1"></i>
            </button>
            <button onclick="deleteDevice(${dev.id}, '${escapeQuotes(dev.name)}')" class="px-2.5 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 text-xs border border-rose-900/40 transition" title="Hapus NVR">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>

        <div id="dev-channels-${dev.id}" class="hidden pt-2 border-t border-cctv-border/50">
          <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center justify-between">
            <span>Daftar Channel Kamera (${dev.camera_count} Kamera)</span>
            <span class="text-[11px] text-slate-500">Menampilkan nama asli bawaan NVR</span>
          </div>
          <div id="dev-channels-list-${dev.id}" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <div class="text-xs text-slate-500 py-2">Memuat daftar channel...</div>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

async function syncNvrChannels(deviceId) {
  showToast('Memindai NVR dan menyinkronkan nama asli kamera...', 'info');
  try {
    const res = await apiRequest(`/api/devices/${deviceId}/sync-channels`, { method: 'POST' });
    if (res.success) {
      showToast(res.message, 'success');
      await fetchDevices();
      await fetchCameras();
      renderSidebarTree();
    } else {
      showToast(res.error || 'Gagal sinkronisasi.', 'error');
    }
  } catch (err) {
    showToast('Sync error: ' + err.message, 'error');
  }
}

async function toggleDeviceChannels(deviceId) {
  const container = document.getElementById(`dev-channels-${deviceId}`);
  const listContainer = document.getElementById(`dev-channels-list-${deviceId}`);
  if (!container) return;

  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  try {
    const res = await apiRequest(`/api/devices/${deviceId}`);
    if (res.success && res.cameras) {
      let html = '';
      res.cameras.forEach(cam => {
        html += `
          <div class="bg-slate-900/90 border border-cctv-border rounded-xl p-2.5 flex items-center justify-between hover:border-brand-500/50 transition">
            <div class="overflow-hidden mr-2">
              <div class="flex items-center space-x-1.5">
                <span class="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-brand-400">CH ${String(cam.channel_no).padStart(2, '0')}</span>
                <span class="text-xs font-medium text-white truncate" title="${cam.custom_name}">${cam.custom_name}</span>
              </div>
              <p class="text-[10px] text-slate-500 truncate mt-0.5" title="${cam.tags || '-'}">Tag: ${cam.tags || '-'}</p>
            </div>
            <div class="flex items-center space-x-1">
              <button onclick="openEditCameraModal(${cam.id}, '${escapeQuotes(cam.custom_name)}', '${escapeQuotes(cam.tags || '')}', '${cam.group_id || ''}')"
                class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-300 transition" title="Ubah Nama">
                <i class="fa-solid fa-pen text-[10px]"></i>
              </button>
              <button onclick="copyToClipboard('${escapeQuotes(cam.main_stream_url)}')"
                class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-300 transition" title="Salin RTSP Link">
                <i class="fa-solid fa-link text-[10px]"></i>
              </button>
            </div>
          </div>
        `;
      });
      listContainer.innerHTML = html;
    }
  } catch (err) {
    listContainer.innerHTML = `<div class="text-xs text-rose-400">Gagal memuat: ${err.message}</div>`;
  }
}

// --- CAMERAS & INSTANT SEARCH ---
async function fetchCameras() {
  const container = document.getElementById('cameraGrid');
  const emptyState = document.getElementById('emptyCameraState');
  const countLabel = document.getElementById('cameraCountLabel');

  try {
    let url = '/api/cameras?';
    if (state.searchQuery) url += `q=${encodeURIComponent(state.searchQuery)}&`;
    if (state.selectedGroupId) url += `group_id=${encodeURIComponent(state.selectedGroupId)}&`;

    const res = await apiRequest(url);
    if (res.success) {
      state.cameras = res.cameras;
      if (countLabel) countLabel.textContent = `${res.count} Kamera Ditemukan`;

      if (res.cameras.length === 0) {
        container.innerHTML = '';
        emptyState.classList.remove('hidden');
      } else {
        emptyState.classList.add('hidden');
        renderCameraGrid();
      }
      renderSidebarTree();
    }
  } catch (err) {
    console.error('Fetch cameras error:', err);
  }
}

function toggleCameraFocus(camId) {
  if (state.gridSize === 1 && state.focusedCamId === camId) {
    // Restore previous multi-grid
    state.gridSize = state.prevGridSize || 4;
    state.focusedCamId = null;
  } else {
    state.prevGridSize = state.gridSize > 1 ? state.gridSize : 4;
    state.gridSize = 1;
    state.focusedCamId = camId;
  }

  // Update active grid button in UI
  document.querySelectorAll('.grid-btn').forEach(btn => {
    const isAct = parseInt(btn.dataset.grid, 10) === state.gridSize;
    btn.classList.toggle('active', isAct);
    btn.classList.toggle('bg-slate-800', isAct);
    btn.classList.toggle('text-white', isAct);
    btn.classList.toggle('text-slate-400', !isAct);
  });

  renderCameraGrid();

  // If focused into 1x1, auto-play live stream
  if (state.gridSize === 1 && state.focusedCamId) {
    playLiveStream(state.focusedCamId);
  }
}

let liveCurrentPage = 0;
let liveIsPlayingAll = false;

function updateLivePagingUI() {
  const pageSize = state.gridSize || 4;
  const totalPages = Math.max(1, Math.ceil(state.cameras.length / pageSize));
  if (liveCurrentPage >= totalPages) liveCurrentPage = totalPages - 1;
  if (liveCurrentPage < 0) liveCurrentPage = 0;

  const indicator = document.getElementById('livePageIndicator');
  if (indicator) indicator.textContent = `${liveCurrentPage + 1} / ${totalPages}`;

  const prevBtn = document.getElementById('livePrevPageBtn');
  if (prevBtn) prevBtn.disabled = liveCurrentPage === 0;

  const nextBtn = document.getElementById('liveNextPageBtn');
  if (nextBtn) nextBtn.disabled = liveCurrentPage >= totalPages - 1;
}

function prevLivePage() {
  if (liveCurrentPage > 0) {
    liveCurrentPage--;
    renderCameraGrid();
  }
}

function nextLivePage() {
  const pageSize = state.gridSize || 4;
  const totalPages = Math.max(1, Math.ceil(state.cameras.length / pageSize));
  if (liveCurrentPage < totalPages - 1) {
    liveCurrentPage++;
    renderCameraGrid();
  }
}

function togglePlayAllLiveStreams() {
  const btn = document.getElementById('livePlayAllBtn');
  const label = document.getElementById('livePlayAllLabel');

  if (!liveIsPlayingAll) {
    const pageSize = state.gridSize || 4;
    let visibleCams = state.cameras;
    if (state.gridSize === 1 && state.focusedCamId) {
      visibleCams = state.cameras.filter(c => c.id === state.focusedCamId);
    } else {
      visibleCams = state.cameras.slice(liveCurrentPage * pageSize, (liveCurrentPage + 1) * pageSize);
    }

    if (visibleCams.length === 0) {
      showToast('Tidak ada kamera untuk diputar.', 'warning');
      return;
    }

    visibleCams.forEach(cam => {
      playLiveStream(cam.id);
    });

    liveIsPlayingAll = true;
    if (label) label.textContent = 'Hentikan Semua';
    if (btn) {
      btn.className = 'px-2.5 py-1 rounded-lg bg-rose-600/20 hover:bg-rose-600 text-rose-300 hover:text-white border border-rose-500/30 text-xs font-semibold flex items-center space-x-1.5 transition shadow-sm';
      const icon = btn.querySelector('i');
      if (icon) icon.className = 'fa-solid fa-stop text-[10px]';
    }
    showToast(`Memutar live video ${visibleCams.length} kamera...`, 'info');
  } else {
    liveIsPlayingAll = false;
    if (label) label.textContent = 'Putar Semua';
    if (btn) {
      btn.className = 'px-2.5 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 text-xs font-semibold flex items-center space-x-1.5 transition shadow-sm';
      const icon = btn.querySelector('i');
      if (icon) icon.className = 'fa-solid fa-play text-[10px]';
    }
    renderCameraGrid();
    showToast('Live stream dihentikan', 'info');
  }
}

function updateGridDisplay() {
  const container = document.getElementById('cameraGrid');
  if (!container) return;

  const size = state.gridSize || 4;
  container.className = `flex-1 min-h-0 w-full h-full overflow-hidden live-grid-${size}`;
}

function renderCameraGrid() {
  const container = document.getElementById('cameraGrid');
  if (!container) return;
  updateGridDisplay();

  let camsToRender = state.cameras;
  if (state.gridSize === 1 && state.focusedCamId) {
    camsToRender = state.cameras.filter(c => c.id === state.focusedCamId);
    if (camsToRender.length === 0) camsToRender = state.cameras.slice(0, 1);
  } else {
    const pageSize = state.gridSize || 4;
    camsToRender = state.cameras.slice(liveCurrentPage * pageSize, (liveCurrentPage + 1) * pageSize);
  }

  updateLivePagingUI();

  let html = '';
  camsToRender.forEach(cam => {
    const isOnline = cam.device_status === 'online';
    const channelPadded = String(cam.channel_no).padStart(2, '0');
    const isFocused = state.gridSize === 1 && state.focusedCamId === cam.id;

    html += `
      <div class="cctv-card flex flex-col group ${isFocused ? 'h-full' : ''}" ondblclick="toggleCameraFocus(${cam.id})">
        <!-- Header Info -->
        <div class="cctv-card-header p-2 bg-cctv-panel flex items-center justify-between border-b border-cctv-border flex-shrink-0">
          <div class="flex items-center space-x-1.5 overflow-hidden mr-2">
            <span class="px-1.5 py-0.5 rounded text-[11px] font-mono font-bold bg-brand-500/20 text-brand-400 border border-brand-500/30">
              CH ${channelPadded}
            </span>
            <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 tracking-tight" title="Resolusi: 1080p Full HD (Main Stream)">
              1080p HD
            </span>
            <div class="truncate">
              <h4 class="text-xs font-bold text-white truncate" title="${cam.custom_name}">${cam.custom_name}</h4>
              <p class="text-[10px] text-slate-400 truncate">
                ${cam.device_name} (${cam.device_ip}) ${cam.group_name ? `• ${cam.group_name}` : ''}
              </p>
            </div>
          </div>

          <div class="flex items-center space-x-1.5 flex-shrink-0">
            ${isFocused ? `
            <button onclick="toggleCameraFocus(${cam.id})" class="px-2 py-0.5 rounded-lg bg-brand-500/20 hover:bg-brand-500 text-brand-300 hover:text-white border border-brand-500/30 text-[10px] font-bold flex items-center space-x-1 transition mr-1" title="Kembali ke Multi-Grid (Esc / Dobel Klik)">
              <i class="fa-solid fa-compress"></i>
              <span>Kembali</span>
            </button>
            ` : ''}
            <span class="inline-block w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-emerald-400 shadow-[0_0_6px_#10b981]' : 'bg-slate-600'}" title="${isOnline ? 'NVR Online' : 'NVR Offline'}"></span>
            ${state.user && state.user.role === 'admin' ? `
            <button onclick="event.stopPropagation(); openEditCameraModal(${cam.id}, '${escapeQuotes(cam.custom_name)}', '${escapeQuotes(cam.tags || '')}', '${cam.group_id || ''}')"
              class="w-6 h-6 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center text-xs transition" title="Ubah Nama Kamera">
              <i class="fa-solid fa-pen text-[10px]"></i>
            </button>` : ''}
          </div>
        </div>

        <!-- Video Screen with Live Snapshot & Clean WebRTC Player -->
        <div class="cctv-screen relative cursor-pointer group/screen flex-1 min-h-0" onclick="playLiveStream(${cam.id})" title="Klik untuk putar live stream | Dobel klik untuk 1x1">
          <div class="cctv-osd">
            <div class="flex items-center">
              <span class="rec-dot"></span>
              <span class="font-bold tracking-wider">LIVE</span>
            </div>
            <div class="osd-time">${new Date().toLocaleTimeString()}</div>
          </div>

          <!-- Video / Snapshot Player Container -->
          <div id="cam-player-${cam.id}" class="w-full h-full relative flex items-center justify-center bg-black overflow-hidden">
            <img id="cam-img-${cam.id}"
                 data-cam-id="${cam.id}"
                 src="/api/cameras/${cam.id}/snapshot" 
                 alt="${cam.custom_name}" 
                 class="cam-live-img w-full h-full object-cover select-none">
            
            <button type="button" onclick="event.stopPropagation(); playLiveStream(${cam.id})"
              class="absolute bottom-2.5 right-2.5 z-10 px-2.5 py-1 rounded-lg bg-slate-900/90 hover:bg-emerald-600 text-white text-[11px] font-semibold border border-cctv-border flex items-center space-x-1.5 transition shadow-lg">
              <i class="fa-solid fa-play text-emerald-400"></i>
              <span>Live HD</span>
            </button>
          </div>
        </div>

        <!-- Bottom Tag / Details -->
        <div class="cctv-card-footer p-1.5 px-2 bg-slate-900/60 flex items-center justify-between text-[10px] text-slate-400 flex-shrink-0">
          <span class="truncate"><i class="fa-solid fa-tag text-[9px] mr-1 text-slate-500"></i> ${cam.tags || 'Tidak ada tag'}</span>
          <button onclick="event.stopPropagation(); copyToClipboard('${escapeQuotes(cam.main_stream_url)}')" class="text-slate-500 hover:text-brand-400 flex items-center space-x-1 flex-shrink-0" title="Salin RTSP URL">
            <i class="fa-solid fa-link text-[9px]"></i>
            <span class="text-[9px]">RTSP</span>
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// --- PLAY LIVE STREAM VIA WEBRTC / GO2RTC ---
async function playLiveStream(camId) {
  const playerDiv = document.getElementById(`cam-player-${camId}`);
  if (!playerDiv) return;

  playerDiv.innerHTML = `
    <div class="flex flex-col items-center justify-center p-4 text-xs text-brand-400 bg-slate-950/95 w-full h-full">
      <i class="fa-solid fa-spinner fa-spin text-2xl mb-2 text-brand-500"></i>
      <span class="font-medium">Menghubungkan RTSP Stream...</span>
      <span class="text-[10px] text-slate-500 mt-1">Mengaktifkan WebRTC gateway</span>
    </div>
  `;

  try {
    const res = await apiRequest(`/api/cameras/${camId}/stream`, { method: 'POST' });
    if (res.success && res.streamName) {
      if (typeof window.mountCctvPlayer === 'function') {
        window.mountCctvPlayer(playerDiv, res.streamName, {
          title: `CH ${camId}`
        });
      } else {
        const playerUrl = res.playerUrl || `/media/stream.html?src=${encodeURIComponent(res.streamName)}&mode=webrtc,mse,mp4`;
        playerDiv.innerHTML = `
          <iframe src="${playerUrl}" class="w-full h-full border-0" allow="autoplay; fullscreen"></iframe>
        `;
      }
    } else {
      playerDiv.innerHTML = `
        <div class="flex flex-col items-center justify-center p-3 text-center text-xs text-rose-400 bg-slate-950 w-full h-full">
          <i class="fa-solid fa-circle-exclamation text-xl mb-1"></i>
          <div>Gagal memutar stream: ${res.error || 'NVR Offline'}</div>
          <button onclick="renderCameraGrid()" class="mt-2 px-2.5 py-1 rounded bg-slate-800 text-slate-300 text-[10px]">Kembali</button>
        </div>
      `;
    }
  } catch (err) {
    playerDiv.innerHTML = `
      <div class="flex flex-col items-center justify-center p-3 text-center text-xs text-rose-400 bg-slate-950 w-full h-full">
        <i class="fa-solid fa-triangle-exclamation text-xl mb-1"></i>
        <div>Koneksi gagal: ${err.message}</div>
        <button onclick="renderCameraGrid()" class="mt-2 px-2.5 py-1 rounded bg-slate-800 text-slate-300 text-[10px]">Kembali</button>
      </div>
    `;
  }
}

// --- AUTO REFRESH LIVE CAMERA SNAPSHOTS (STAGGERED TO PROTECT NVR SOCKETS) ---
let snapshotInterval = null;
let currentSnapIdx = 0;

function startSnapshotAutoRefresh() {
  if (snapshotInterval) clearInterval(snapshotInterval);
  snapshotInterval = setInterval(() => {
    if (state.activeTab !== 'liveView') return;
    const images = Array.from(document.querySelectorAll('.cam-live-img'));
    if (images.length === 0) return;
    
    // Refresh 2 cameras per cycle in round-robin fashion so NVR CPU and sockets stay healthy
    for (let i = 0; i < 2; i++) {
      const img = images[currentSnapIdx % images.length];
      currentSnapIdx++;
      if (img && img.dataset.camId) {
        const next = new Image();
        next.onload = () => { img.src = next.src; };
        next.src = `/api/cameras/${img.dataset.camId}/snapshot?t=${Date.now()}`;
      }
    }
  }, 1500);
}

// --- PLAYBACK MODULE (REKAMAN TANGGAL LAMA) ---
// --- PLAYBACK MODULE (REKAMAN TANGGAL LAMA) ---
function initPlaybackDefaults() {
  const dateInput = document.getElementById('pbDateInput');
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }
  const timeInput = document.getElementById('pbTimeInput');
  if (timeInput) {
    if (!timeInput.value || timeInput.value === '08:00:00') {
      timeInput.value = '00:00:00';
    }

    // Auto-masking: type digits without colon ':' (e.g. 110732 -> 11:07:32)
    timeInput.addEventListener('input', (e) => {
      let val = e.target.value.replace(/\D/g, '').slice(0, 6);
      if (val.length <= 2) {
        e.target.value = val;
      } else if (val.length <= 4) {
        e.target.value = val.slice(0, 2) + ':' + val.slice(2);
      } else {
        e.target.value = val.slice(0, 2) + ':' + val.slice(2, 4) + ':' + val.slice(4, 6);
      }
    });

    timeInput.addEventListener('blur', (e) => {
      let val = e.target.value.replace(/\D/g, '');
      if (val.length === 0) {
        e.target.value = '00:00:00';
        return;
      }
      val = val.padEnd(6, '0').slice(0, 6);
      const h = Math.min(23, parseInt(val.slice(0, 2), 10));
      const m = Math.min(59, parseInt(val.slice(2, 4), 10));
      const s = Math.min(59, parseInt(val.slice(4, 6), 10));
      const pad = (n) => String(n).padStart(2, '0');
      const formatted = `${pad(h)}:${pad(m)}:${pad(s)}`;
      e.target.value = formatted;
      const sec = (h * 3600) + (m * 60) + s;
      tlState.currentSecondInDay = sec;
      updateTimelinePlayhead(sec);
    });
  }

  populatePlaybackDeviceSelect();
}

function populatePlaybackDeviceSelect() {
  const select = document.getElementById('pbDeviceSelect');
  if (!select) return;

  const prevVal = select.value;
  let opts = '<option value="">-- Pilih NVR --</option>';
  state.devices.forEach(d => {
    opts += `<option value="${d.id}">${d.name} (${d.ip}) - ${d.camera_count} Channel</option>`;
  });
  select.innerHTML = opts;

  // Preserve user selection if device still exists
  if (prevVal && state.devices.some(d => String(d.id) === String(prevVal))) {
    select.value = prevVal;
  } else if (state.devices.length === 1) {
    select.value = state.devices[0].id;
    updatePlaybackChannelOptions(state.devices[0].id);
  }
}

async function updatePlaybackChannelOptions(deviceId) {
  const select = document.getElementById('pbChannelSelect');
  if (!deviceId) {
    select.disabled = true;
    select.innerHTML = '<option value="">-- Pilih NVR terlebih dahulu --</option>';
    return;
  }

  const prevVal = select.value;
  select.disabled = false;
  select.innerHTML = '<option value="">Memuat channel...</option>';

  try {
    const res = await apiRequest(`/api/devices/${deviceId}`);
    if (res.success && res.cameras) {
      let opts = '<option value="">-- Pilih Channel Kamera --</option>';
      res.cameras.forEach(cam => {
        opts += `<option value="${cam.channel_no}" data-cam-id="${cam.id}">CH ${String(cam.channel_no).padStart(2, '0')} - ${cam.custom_name}</option>`;
      });
      select.innerHTML = opts;

      // Preserve previously selected channel number if present
      if (prevVal && res.cameras.some(c => String(c.channel_no) === String(prevVal))) {
        select.value = prevVal;
      } else if (res.cameras.length > 0) {
        select.value = res.cameras[0].channel_no;
      }

      // Update calendar indicator dots for this camera
      loadMonthRecordingsForCalendar();
    }
  } catch (err) {
    select.innerHTML = '<option value="">Gagal memuat channel</option>';
  }
}

function setPlaybackTimeToNow() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const input = document.getElementById('pbTimeInput');
  if (input) input.value = timeStr;
  const sec = (now.getHours() * 3600) + (now.getMinutes() * 60) + now.getSeconds();
  updateTimelinePlayhead(sec);
  showToast(`Jam rekaman disetel ke sekarang: ${timeStr}`, 'info');
}

// =========================================================================
// HIKVISION 24-HOUR INTERACTIVE TIMELINE (CENTER-FIXED NEEDLE & DRAGGABLE TRACK)
// =========================================================================
const TL_ZOOM_LEVELS = [
  { id: '24h', label: '24 Jam', duration: 86400, majorStep: 3600, minorStep: 1800 },
  { id: '12h', label: '12 Jam', duration: 43200, majorStep: 3600, minorStep: 900 },
  { id: '4h',  label: '4 Jam',  duration: 14400, majorStep: 1800, minorStep: 300 },
  { id: '1h',  label: '1 Jam',  duration: 3600,  majorStep: 600,  minorStep: 60 },
  { id: '10m', label: '10 Menit', duration: 600,  majorStep: 60,   minorStep: 10 },
  { id: '1m',  label: '1 Menit (Detik)', duration: 60, majorStep: 10, minorStep: 1 }
];

const tlState = {
  zoomIndex: 0, // 0 = 24 Jam s/d 5 = 1 Menit (Detik)
  currentDateStr: null,
  clips: [],
  currentSecondInDay: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartSec: 0,
  hasMoved: false,
  activeClipStartMs: 0,
  activeClipEndMs: 0
};

function formatHHMMSS(sec) {
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function getTimelinePPS() {
  const wrapper = document.getElementById('timelineScrollerWrapper');
  const w = wrapper ? (wrapper.clientWidth || 1000) : 1000;
  const zoom = TL_ZOOM_LEVELS[tlState.zoomIndex];
  return w / zoom.duration;
}

function initTimelineControls() {
  renderTimelineRuler();
  updateTimelinePlayhead(tlState.currentSecondInDay);

  // Zoom buttons (+ and -)
  const btnZoomIn = document.getElementById('tlBtnZoomIn');
  const btnZoomOut = document.getElementById('tlBtnZoomOut');

  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
      if (tlState.zoomIndex < TL_ZOOM_LEVELS.length - 1) {
        tlState.zoomIndex++;
        updateZoomUI();
      }
    });
  }

  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
      if (tlState.zoomIndex > 0) {
        tlState.zoomIndex--;
        updateZoomUI();
      }
    });
  }

  // Draggable Timeline Track (Needle fixed in center, ruler moves)
  const trackWrapper = document.getElementById('timelineScrollerWrapper');
  if (trackWrapper) {
    trackWrapper.addEventListener('mousedown', (e) => {
      // Don't drag if clicking buttons
      if (e.target.closest('button')) return;

      tlState.isDragging = true;
      tlState.dragStartX = e.clientX;
      tlState.dragStartSec = tlState.currentSecondInDay;
      tlState.hasMoved = false;

      const onMouseMove = (ev) => {
        if (!tlState.isDragging) return;
        const dx = ev.clientX - tlState.dragStartX;
        if (Math.abs(dx) > 3) {
          tlState.hasMoved = true;
        }

        const pps = getTimelinePPS();
        const deltaSec = - (dx / pps); // Drag left -> time moves forward, drag right -> time moves back
        const targetSec = Math.max(0, Math.min(86400, Math.round(tlState.dragStartSec + deltaSec)));

        tlState.currentSecondInDay = targetSec;
        updateTimelinePlayhead(targetSec, false);

        const timeInput = document.getElementById('pbTimeInput');
        if (timeInput) timeInput.value = formatHHMMSS(targetSec);
      };

      const onMouseUp = (ev) => {
        if (!tlState.isDragging) return;
        tlState.isDragging = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);

        if (tlState.hasMoved) {
          // Dragging finished: seek immediately in memory if clips are cached
          seekPlaybackToTime(tlState.currentSecondInDay);
        } else {
          // Clicked at specific position on track: center that time under needle
          const rect = trackWrapper.getBoundingClientRect();
          const pps = getTimelinePPS();
          const distFromCenter = ev.clientX - (rect.left + rect.width / 2);
          const clickedSec = Math.max(0, Math.min(86400, Math.round(tlState.dragStartSec + (distFromCenter / pps))));

          tlState.currentSecondInDay = clickedSec;
          updateTimelinePlayhead(clickedSec, true);

          const timeInput = document.getElementById('pbTimeInput');
          if (timeInput) timeInput.value = formatHHMMSS(clickedSec);

          seekPlaybackToTime(clickedSec);
        }
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  // Single Frame Stepping Buttons (Back & Forward)
  const btnFrameBack = document.getElementById('pbBtnFrameBack');
  if (btnFrameBack) {
    btnFrameBack.addEventListener('click', () => stepSingleFrame(-1));
  }
  const btnFrameFwd = document.getElementById('pbBtnFrameForward');
  if (btnFrameFwd) {
    btnFrameFwd.addEventListener('click', () => stepSingleFrame(1));
  }
  const btnSingle = document.getElementById('pbBtnSingleFrame');
  if (btnSingle) {
    btnSingle.addEventListener('click', () => stepSingleFrame(1));
  }

  // Global Ctrl + Mouse Wheel shortcut for Single Frame (Prevent page zoom entirely when on Playback tab)
  const handleCtrlWheelSingleFrame = (e) => {
    if (e.ctrlKey) {
      const pbTab = document.getElementById('playbackTab');
      const isPb = pbTab && !pbTab.classList.contains('hidden');
      if (isPb) {
        e.preventDefault();
        e.stopPropagation();
        stepPlaybackSeconds(e.deltaY < 0 ? 1 : -1, false);
      }
    }
  };
  window.addEventListener('wheel', handleCtrlWheelSingleFrame, { passive: false });
  document.addEventListener('wheel', handleCtrlWheelSingleFrame, { passive: false });

  // Window resize: re-render timeline width and offset
  window.addEventListener('resize', () => {
    renderTimelineRuler();
    if (tlState.clips.length > 0 && tlState.currentDateStr) {
      renderTimelineRecordings(tlState.clips, tlState.currentDateStr);
    }
    updateTimelinePlayhead(tlState.currentSecondInDay);
  });
}

function updateZoomUI() {
  const zoom = TL_ZOOM_LEVELS[tlState.zoomIndex];
  const label = document.getElementById('pbZoomScaleLabel');
  if (label) {
    label.textContent = `Skala: ${zoom.label}`;
  }

  renderTimelineRuler();
  if (tlState.clips.length > 0 && tlState.currentDateStr) {
    renderTimelineRecordings(tlState.clips, tlState.currentDateStr);
  }
  updateTimelinePlayhead(tlState.currentSecondInDay);
}

function renderTimelineRuler() {
  const ruler = document.getElementById('timelineRuler');
  const track = document.getElementById('timelineTrack');
  if (!ruler || !track) return;

  ruler.innerHTML = '';
  const zoom = TL_ZOOM_LEVELS[tlState.zoomIndex];
  const pps = getTimelinePPS();
  const totalTrackWidth = 86400 * pps;

  track.style.width = `${totalTrackWidth}px`;

  // Render ticks across the visible range + margin to keep DOM fast
  const centerSec = tlState.currentSecondInDay;
  const startSec = Math.max(0, Math.floor((centerSec - 1.5 * zoom.duration) / zoom.majorStep) * zoom.majorStep);
  const endSec = Math.min(86400, Math.ceil((centerSec + 1.5 * zoom.duration) / zoom.majorStep) * zoom.majorStep);

  const pad = (n) => String(n).padStart(2, '0');

  for (let s = startSec; s <= endSec; s += zoom.majorStep) {
    const leftPx = s * pps;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    let timeLabel = `${pad(h)}:00`;
    if (zoom.majorStep < 3600 && zoom.majorStep >= 60) {
      timeLabel = `${pad(h)}:${pad(m)}`;
    } else if (zoom.majorStep < 60) {
      timeLabel = `${pad(h)}:${pad(m)}:${pad(sec)}`;
    }

    const tick = document.createElement('div');
    tick.className = 'tl-hour-tick';
    tick.style.left = `${leftPx}px`;
    tick.innerHTML = `<span>${timeLabel}</span>`;
    ruler.appendChild(tick);

    // Minor sub-tick
    if (s + zoom.minorStep <= endSec && zoom.minorStep < zoom.majorStep) {
      const subTick = document.createElement('div');
      subTick.className = 'tl-sub-tick';
      subTick.style.left = `${(s + zoom.minorStep) * pps}px`;
      ruler.appendChild(subTick);
    }
  }
}

function renderTimelineRecordings(recordings, dateStr) {
  const container = document.getElementById('timelineRecordingBlocks');
  if (!container) return;

  container.innerHTML = '';
  tlState.clips = recordings || [];
  tlState.currentDateStr = dateStr;

  if (!recordings || recordings.length === 0) return;

  const dayStartMs = new Date(`${dateStr}T00:00:00`).getTime();
  const pps = getTimelinePPS();

  recordings.forEach(clip => {
    const sMs = new Date(clip.startTime).getTime();
    const eMs = new Date(clip.endTime).getTime();

    const startSec = Math.max(0, Math.min(86400, Math.round((sMs - dayStartMs) / 1000)));
    const endSec = Math.max(0, Math.min(86400, Math.round((eMs - dayStartMs) / 1000)));

    if (endSec > startSec) {
      const leftPx = startSec * pps;
      const widthPx = Math.max(2, (endSec - startSec) * pps);

      const block = document.createElement('div');
      block.className = 'tl-recording-segment';
      block.style.left = `${leftPx}px`;
      block.style.width = `${widthPx}px`;

      const pad = (n) => String(n).padStart(2, '0');
      const sDate = new Date(sMs);
      const eDate = new Date(eMs);
      const tip = `${pad(sDate.getHours())}:${pad(sDate.getMinutes())}:${pad(sDate.getSeconds())} - ${pad(eDate.getHours())}:${pad(eDate.getMinutes())}:${pad(eDate.getSeconds())}`;
      block.title = `Rekaman: ${tip}`;

      container.appendChild(block);
    }
  });
}

function updateTimelinePlayhead(secInDay, reRenderTicks = true) {
  tlState.currentSecondInDay = secInDay;

  const wrapper = document.getElementById('timelineScrollerWrapper');
  const track = document.getElementById('timelineTrack');
  const centerDisplay = document.getElementById('timelineCenterTimeDisplay');
  const labelTop = document.getElementById('pbTimelineCurrentTime');

  const wrapperWidth = wrapper ? (wrapper.clientWidth || 1000) : 1000;
  const pps = getTimelinePPS();

  // Shift track underneath the center needle (Needle is locked at wrapperWidth / 2)
  if (track) {
    const trackOffset = (wrapperWidth / 2) - (secInDay * pps);
    track.style.transform = `translateX(${trackOffset}px)`;
  }

  const timeStr = formatHHMMSS(secInDay);
  const dateStr = tlState.currentDateStr || document.getElementById('pbDateInput')?.value || new Date().toISOString().slice(0, 10);

  if (centerDisplay) {
    centerDisplay.textContent = `${dateStr} ${timeStr}`;
  }
  if (labelTop) {
    labelTop.textContent = timeStr;
  }

  if (reRenderTicks) {
    renderTimelineRuler();
  }
}

function updateTimelinePlayheadByMs(currentMs) {
  if (!tlState.currentDateStr) return;
  const dayStartMs = new Date(`${tlState.currentDateStr}T00:00:00`).getTime();
  const secInDay = Math.max(0, Math.min(86400, Math.round((currentMs - dayStartMs) / 1000)));
  updateTimelinePlayhead(secInDay, false);
}

// =========================================================================
// HIKVISION CALENDAR POPOVER & RECORDING DAY INDICATOR
// =========================================================================
let calCurrentYear = new Date().getFullYear();
let calCurrentMonth = new Date().getMonth() + 1;
let calRecordedDays = new Set();

function initCalendarPopoverControls() {
  const toggleBtn = document.getElementById('toggleCalendarBtn');
  const popover = document.getElementById('pbCalendarPopover');
  const closeBtn = document.getElementById('calCloseBtn');
  const prevBtn = document.getElementById('calPrevMonthBtn');
  const nextBtn = document.getElementById('calNextMonthBtn');

  if (toggleBtn && popover) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popover.classList.toggle('hidden');
      if (!popover.classList.contains('hidden')) {
        loadMonthRecordingsForCalendar();
      }
    });

    closeBtn?.addEventListener('click', () => popover.classList.add('hidden'));

    document.addEventListener('click', (e) => {
      if (!popover.contains(e.target) && e.target !== toggleBtn && !toggleBtn.contains(e.target)) {
        popover.classList.add('hidden');
      }
    });

    prevBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      calCurrentMonth--;
      if (calCurrentMonth < 1) {
        calCurrentMonth = 12;
        calCurrentYear--;
      }
      loadMonthRecordingsForCalendar();
    });

    nextBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      calCurrentMonth++;
      if (calCurrentMonth > 12) {
        calCurrentMonth = 1;
        calCurrentYear++;
      }
      loadMonthRecordingsForCalendar();
    });
  }

  // Also sync calendar when user changes pbDateInput
  document.getElementById('pbDateInput')?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val) {
      const parts = val.split('-');
      if (parts.length === 3) {
        calCurrentYear = parseInt(parts[0], 10);
        calCurrentMonth = parseInt(parts[1], 10);
        loadMonthRecordingsForCalendar();
      }
    }
  });
}

async function loadMonthRecordingsForCalendar() {
  const chSelect = document.getElementById('pbChannelSelect');
  const camId = chSelect?.selectedOptions?.[0]?.dataset?.camId;

  const dateInput = document.getElementById('pbDateInput');
  if (dateInput?.value) {
    const parts = dateInput.value.split('-');
    if (parts.length === 3) {
      calCurrentYear = parseInt(parts[0], 10);
      calCurrentMonth = parseInt(parts[1], 10);
    }
  }

  const monthNames = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
  ];
  const label = document.getElementById('calMonthYearLabel');
  if (label) {
    label.textContent = `${monthNames[calCurrentMonth - 1]} ${calCurrentYear}`;
  }

  calRecordedDays = new Set();

  if (camId) {
    try {
      const res = await apiRequest(`/api/cameras/${camId}/month-recordings?year=${calCurrentYear}&month=${calCurrentMonth}`);
      if (res.success && res.recordedDays) {
        calRecordedDays = new Set(res.recordedDays);
      }
    } catch (err) {
      console.warn('Gagal memuat distribusi rekaman bulanan:', err.message);
    }
  }

  renderCalendarGrid();
}

function renderCalendarGrid() {
  const grid = document.getElementById('calDaysGrid');
  if (!grid) return;

  grid.innerHTML = '';
  const pad = (n) => String(n).padStart(2, '0');

  // First day of month (0 = Sun, 1 = Mon, ..., 6 = Sat)
  const firstDay = new Date(calCurrentYear, calCurrentMonth - 1, 1).getDay();
  // Total days in month
  const totalDays = new Date(calCurrentYear, calCurrentMonth, 0).getDate();

  // Selected date
  const selectedDateStr = document.getElementById('pbDateInput')?.value || '';

  // Empty leading cells
  for (let i = 0; i < firstDay; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'h-8';
    grid.appendChild(emptyCell);
  }

  // Day buttons
  for (let d = 1; d <= totalDays; d++) {
    const dayStr = `${calCurrentYear}-${pad(calCurrentMonth)}-${pad(d)}`;
    const hasRecording = calRecordedDays.has(d);
    const isSelected = selectedDateStr === dayStr;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cal-day-btn ${isSelected ? 'active' : 'text-slate-200'} ${hasRecording ? 'font-bold' : 'text-slate-400'}`;
    btn.innerHTML = `
      <span>${d}</span>
      ${hasRecording ? '<span class="cal-record-dot" title="Tersedia Rekaman NVR"></span>' : ''}
    `;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dateInput = document.getElementById('pbDateInput');
      if (dateInput) {
        dateInput.value = dayStr;
      }
      document.getElementById('pbCalendarPopover')?.classList.add('hidden');
      renderCalendarGrid();
      handlePlaybackSearch();
    });

    grid.appendChild(btn);
  }
}

// =========================================================================
// PLAYBACK MULTI-GRID MATRIX & HIGH-PRECISION STREAM ENGINE (1x1, 2x2, 3x3, 4x4)
// =========================================================================
let pbGridSize = 4; // default 2x2 (4 slots)
let pbPrevGridSize = 4;
let activePbSlot = 0; // Active selected slot index (0..15)

// Up to 16 slots state management
const pbSlots = Array.from({ length: 16 }, (_, i) => ({
  index: i,
  deviceId: null,
  channelNo: null,
  camId: null,
  camName: null,
  streamName: null,
  startTime: null,
  endTime: null,
  playbackURI: null,
  isPlaying: false,
  isPaused: false,
  videoElement: null,
  playerComponent: null
}));

let pbHasStartedPlaying = false;

function setPlaybackGridSize(size) {
  pbGridSize = parseInt(size, 10) || 4;
  pbHasStartedPlaying = true;
  if (pbGridSize > 1) {
    pbPrevGridSize = pbGridSize;
  }

  // Update button active state
  document.querySelectorAll('.pb-grid-btn').forEach(btn => {
    const isAct = parseInt(btn.dataset.grid, 10) === pbGridSize;
    btn.classList.toggle('active', isAct);
    btn.classList.toggle('bg-slate-800', isAct);
    btn.classList.toggle('text-amber-400', isAct);
    btn.classList.toggle('font-bold', isAct);
    btn.classList.toggle('border', isAct);
    btn.classList.toggle('border-amber-500/30', isAct);
    btn.classList.toggle('text-slate-400', !isAct);
  });

  if (activePbSlot >= pbGridSize) {
    activePbSlot = 0;
  }

  renderPlaybackGrid();
}

function selectPlaybackSlot(slotIdx) {
  if (slotIdx < 0 || slotIdx >= 16) return;
  activePbSlot = slotIdx;

  // Update visual selection borders
  document.querySelectorAll('.pb-slot').forEach((el) => {
    const idx = parseInt(el.dataset.slotIdx, 10);
    if (idx === activePbSlot) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  updateActiveSlotUI();
}

function updateActiveSlotUI() {
  const slot = pbSlots[activePbSlot];
  const title = document.getElementById('pbActiveCamTitle');
  const badge = document.getElementById('pbTimeRangeBadge');
  const downloadBtn = document.getElementById('pbDirectDownloadBtn');

  const pad = (n) => String(n).padStart(2, '0');
  const format24 = (isoStr) => {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  if (slot && slot.isPlaying) {
    if (title) title.textContent = `[Slot ${activePbSlot + 1}] ${slot.camName}`;
    if (badge) badge.textContent = `${format24(slot.startTime)} s/d ${format24(slot.endTime)}`;
    if (downloadBtn) {
      downloadBtn.classList.remove('hidden');
      downloadBtn.onclick = () => {
        quickDownloadClip(slot.deviceId, slot.channelNo, slot.startTime, slot.endTime);
      };
    }
    const video = getActivePlaybackVideo();
    if (video) {
      updatePlayPauseBtnUI(video.paused);
    }
  } else {
    if (title) title.textContent = `[Slot ${activePbSlot + 1}] Belum Ada Rekaman (Pilih & Putar)`;
    if (badge) badge.textContent = '-';
    if (downloadBtn) downloadBtn.classList.add('hidden');
    updatePlayPauseBtnUI(true);
  }

  updateSidebarActiveCamera();
}

function togglePlaybackSlotMaximize(slotIdx) {
  selectPlaybackSlot(slotIdx);
  if (pbGridSize === 1) {
    // Restore previous multi-grid
    setPlaybackGridSize(pbPrevGridSize || 4);
  } else {
    // Maximize clicked slot
    pbPrevGridSize = pbGridSize;
    setPlaybackGridSize(1);
  }
}

function stopPlaybackSlot(slotIdx) {
  const slot = pbSlots[slotIdx];
  if (slot) {
    slot.isPlaying = false;
    slot.streamName = null;
    slot.camId = null;
    slot.videoElement = null;
    slot.playerComponent = null;
  }
  renderPlaybackGrid();
  updateActiveSlotUI();
}

function renderPlaybackGrid() {
  const container = document.getElementById('playbackPlayerContainer');
  if (!container) return;

  const hasAnyPlaying = pbSlots.some(s => s.isPlaying);

  // If user hasn't clicked "Putar Rekaman" or grid selector yet, show the clean idle welcome screen
  if (!pbHasStartedPlaying && !hasAnyPlaying) {
    container.innerHTML = `
      <div class="flex-1 min-h-0 flex flex-col items-center justify-center p-8 text-center text-slate-500 select-none bg-black/60 w-full h-full">
        <div class="w-16 h-16 rounded-2xl bg-slate-900 border border-cctv-border flex items-center justify-center text-3xl mb-3 text-amber-400 shadow-xl shadow-amber-500/10">
          <i class="fa-solid fa-film"></i>
        </div>
        <h3 class="text-base text-slate-200 font-bold mb-1">Layar Pemutar Video Rekaman (Playback)</h3>
        <p class="text-xs text-slate-400 max-w-md mx-auto mb-3">Pilih perangkat NVR, Channel Kamera, Tanggal, dan Jam Mulai pada form di atas, lalu klik <span class="text-amber-400 font-bold">"Putar Rekaman"</span>.</p>
        <div class="flex items-center space-x-2 text-[11px] text-slate-400 bg-slate-900/90 px-3 py-1.5 rounded-xl border border-cctv-border">
          <i class="fa-solid fa-layer-group text-amber-400"></i>
          <span>Mendukung CCTV Multi-Grid 1x1, 2x2, 3x3, 4x4 (hingga 16 split layar)</span>
        </div>
      </div>
    `;
    updateActiveSlotUI();
    return;
  }

  let matrix = document.getElementById('playbackMatrix');
  if (!matrix) {
    container.innerHTML = '';
    matrix = document.createElement('div');
    matrix.id = 'playbackMatrix';
    container.appendChild(matrix);
  }

  matrix.className = `pb-matrix pb-grid-${pbGridSize}`;
  matrix.innerHTML = '';

  for (let i = 0; i < pbGridSize; i++) {
    const slot = pbSlots[i];
    const isActive = i === activePbSlot;

    const slotEl = document.createElement('div');
    slotEl.id = `pb-slot-${i}`;
    slotEl.dataset.slotIdx = String(i);
    slotEl.className = `pb-slot ${isActive ? 'active' : ''}`;
    
    slotEl.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      selectPlaybackSlot(i);
    });

    slotEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      togglePlaybackSlotMaximize(i);
    });

    if (slot.isPlaying && slot.streamName) {
      slotEl.innerHTML = `
        <div class="pb-slot-header flex items-center justify-between px-2 py-1 bg-slate-900/90 border-b border-cctv-border text-[11px] select-none z-10">
          <div class="flex items-center space-x-1.5 truncate mr-1">
            <span class="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 font-mono font-bold text-[10px]">#${i + 1}</span>
            <span class="truncate font-semibold text-white text-[11px]">${escapeQuotes(slot.camName || 'Kamera')}</span>
          </div>
          <div class="flex items-center space-x-1">
            <button type="button" onclick="event.stopPropagation(); togglePlaybackSlotMaximize(${i})" class="p-0.5 px-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white text-[10px]" title="Maksimalkan (Dobel Klik)">
              <i class="fa-solid ${pbGridSize === 1 ? 'fa-compress' : 'fa-expand'}"></i>
            </button>
            <button type="button" onclick="event.stopPropagation(); stopPlaybackSlot(${i})" class="p-0.5 px-1 rounded hover:bg-rose-950/60 text-slate-400 hover:text-rose-400 text-[10px]" title="Hentikan Slot Ini">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>
        <div id="pb-slot-player-${i}" class="flex-1 min-h-0 relative w-full h-full bg-black overflow-hidden flex items-center justify-center"></div>
      `;

      matrix.appendChild(slotEl);

      const playerBody = slotEl.querySelector(`#pb-slot-player-${i}`);
      if (playerBody) {
        if (typeof window.mountCctvPlayer === 'function') {
          window.mountCctvPlayer(playerBody, slot.streamName, {
            title: slot.camName,
            onPlaying: (video) => {
              slot.videoElement = video;
              slot.isPlaying = true;
              if (i === activePbSlot) {
                updatePlayPauseBtnUI(false);
              }
            },
            onTimeUpdate: (currentTime, video) => {
              slot.videoElement = video;
              if (i === activePbSlot && !tlState.isDragging && tlState.activeClipStartMs) {
                const currentMs = tlState.activeClipStartMs + (currentTime * 1000);
                updateTimelinePlayheadByMs(currentMs);
              }
            }
          });
        }
      }
    } else {
      slotEl.innerHTML = `
        <div class="pb-slot-header flex items-center justify-between px-2 py-1 bg-slate-900/60 border-b border-cctv-border/40 text-[10px] select-none text-slate-400">
          <span class="font-mono font-bold text-slate-400">Slot #${i + 1}</span>
          <span class="text-[9px] ${isActive ? 'text-amber-400 font-bold' : 'text-slate-500'}">${isActive ? '● AKTIF' : 'Kosong'}</span>
        </div>
        <div class="flex-1 min-h-0 flex flex-col items-center justify-center p-3 text-center text-slate-500 select-none">
          <i class="fa-solid fa-video text-xl mb-1.5 ${isActive ? 'text-amber-400' : 'text-slate-600'}"></i>
          <span class="text-[11px] font-semibold ${isActive ? 'text-amber-300' : 'text-slate-400'}">Slot ${i + 1}</span>
          <span class="text-[10px] text-slate-500 mt-0.5">Klik slot ini lalu tekan "Putar Rekaman"</span>
        </div>
      `;
      matrix.appendChild(slotEl);
    }
  }

  updateActiveSlotUI();
  updatePlaybackZoomUI();
}

// Literal time string parser (avoids 7-hour timezone offset subtraction)
function parseCameraTimeString(str) {
  if (!str) return 0;
  const clean = str.replace(/[TZ]/g, ' ').trim();
  const m = clean.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10)).getTime();
  }
  return new Date(str).getTime();
}

// Fast in-memory timeline seeking without repeating full NVR disk search
async function seekPlaybackToTime(targetSecInDay) {
  const deviceId = document.getElementById('pbDeviceSelect')?.value;
  const channelNo = document.getElementById('pbChannelSelect')?.value;
  const dateStr = document.getElementById('pbDateInput')?.value;

  if (!deviceId || !channelNo || !dateStr) {
    return handlePlaybackSearch();
  }

  const cacheKey = `${deviceId}_${channelNo}_${dateStr}`;
  if (state.playbackClipsKey === cacheKey && state.playbackClips && state.playbackClips.length > 0) {
    const selectedOpt = document.querySelector(`#pbChannelSelect option[value="${channelNo}"]`);
    const camId = selectedOpt ? selectedOpt.dataset.camId : null;
    const camName = selectedOpt ? selectedOpt.textContent : `Channel ${channelNo}`;

    const timeStr = formatHHMMSS(targetSecInDay);
    const targetDateStr = `${dateStr}T${timeStr}`;
    const targetTimeMs = parseCameraTimeString(targetDateStr);

    let bestClip = null;
    for (const clip of state.playbackClips) {
      const sMs = parseCameraTimeString(clip.startTime);
      const eMs = parseCameraTimeString(clip.endTime);
      if (targetTimeMs >= sMs && targetTimeMs <= eMs) {
        bestClip = clip;
        break;
      }
    }

    let requestedStart;
    if (bestClip) {
      requestedStart = targetDateStr;
    } else {
      let minDiff = Infinity;
      for (const clip of state.playbackClips) {
        const sMs = parseCameraTimeString(clip.startTime);
        const eMs = parseCameraTimeString(clip.endTime);
        const diff = Math.min(Math.abs(targetTimeMs - sMs), Math.abs(targetTimeMs - eMs));
        if (diff < minDiff) {
          minDiff = diff;
          bestClip = clip;
        }
      }
      requestedStart = bestClip ? bestClip.startTime : targetDateStr;
      if (bestClip) {
        showToast(`Jam terdekat di NVR: ${bestClip.startTime.replace(/.*T/, '').replace(/Z/, '')}`, 'info');
      }
    }

    if (bestClip) {
      tlState.activeClipStartMs = parseCameraTimeString(requestedStart);
      tlState.activeClipEndMs = parseCameraTimeString(bestClip.endTime);
      updateTimelinePlayhead(targetSecInDay, false);

      await startPlaybackInSlot(activePbSlot, {
        deviceId,
        channelNo,
        camId,
        camName,
        startTime: requestedStart,
        endTime: bestClip.endTime,
        playbackURI: bestClip.playbackURI
      }, true);
      return;
    }
  }

  await handlePlaybackSearch();
}

// =========================================================================
// PLAYBACK SEARCH & HIGH-PRECISION STREAM CONTROL
// =========================================================================
async function handlePlaybackSearch() {
  const deviceId = document.getElementById('pbDeviceSelect').value;
  const channelNo = document.getElementById('pbChannelSelect').value;
  const dateStr = document.getElementById('pbDateInput').value;

  // Strict 24-hour time with seconds (HH:MM:SS)
  let rawTime = document.getElementById('pbTimeInput')?.value?.trim() || '00:00:00';
  const parts = rawTime.split(':');
  let h = '00', m = '00', s = '00';
  if (parts.length >= 1) h = parts[0].padStart(2, '0');
  if (parts.length >= 2) m = parts[1].padStart(2, '0');
  if (parts.length >= 3) s = parts[2].padStart(2, '0');
  const timeStr = `${h}:${m}:${s}`;
  const targetDateStr = `${dateStr}T${timeStr}`;

  const btn = document.getElementById('pbSearchBtn');
  const statusBadge = document.getElementById('pbStatusText');

  if (!deviceId || !channelNo || !dateStr) {
    alert('Harap pilih NVR, Channel Kamera, dan Tanggal Rekaman!');
    return;
  }

  const selectedOpt = document.querySelector(`#pbChannelSelect option[value="${channelNo}"]`);
  const camId = selectedOpt ? selectedOpt.dataset.camId : null;
  const camName = selectedOpt ? selectedOpt.textContent : `Channel ${channelNo}`;

  const targetTimeMs = parseCameraTimeString(targetDateStr);
  const targetSecInDay = (parseInt(h, 10) * 3600) + (parseInt(m, 10) * 60) + parseInt(s, 10);

  // Literal local search window for the entire day
  const searchStart = `${dateStr}T00:00:00`;
  const searchEnd = `${dateStr}T23:59:59`;

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Mencari di NVR...</span>';
  if (statusBadge) statusBadge.textContent = 'Mencari rekaman...';

  try {
    const res = await apiRequest('/api/downloads/search', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: parseInt(deviceId, 10),
        channelNo: parseInt(channelNo, 10),
        startTime: searchStart,
        endTime: searchEnd
      })
    });

    if (res.success && res.recordings) {
      state.playbackClips = res.recordings;
      state.playbackClipsKey = `${deviceId}_${channelNo}_${dateStr}`;
      renderTimelineRecordings(res.recordings, dateStr);
      updateTimelinePlayhead(targetSecInDay);

      if (res.recordings.length === 0) {
        if (statusBadge) statusBadge.textContent = 'Tidak ada rekaman';
        showToast(`Tidak ditemukan file rekaman pada tanggal ${dateStr} di NVR untuk kamera ini.`, 'warning');
        return;
      }

      // Find clip covering target time, or closest clip
      let bestClip = null;
      for (const clip of res.recordings) {
        const sMs = parseCameraTimeString(clip.startTime);
        const eMs = parseCameraTimeString(clip.endTime);
        if (targetTimeMs >= sMs && targetTimeMs <= eMs) {
          bestClip = clip;
          break;
        }
      }

      let requestedStart;
      if (bestClip) {
        // High-precision start at exact target second
        requestedStart = targetDateStr;
      } else {
        let minDiff = Infinity;
        for (const clip of res.recordings) {
          const sMs = parseCameraTimeString(clip.startTime);
          const eMs = parseCameraTimeString(clip.endTime);
          const diff = Math.min(Math.abs(targetTimeMs - sMs), Math.abs(targetTimeMs - eMs));
          if (diff < minDiff) {
            minDiff = diff;
            bestClip = clip;
          }
        }
        requestedStart = bestClip.startTime;
        showToast(`Jam terdekat di NVR: ${bestClip.startTime.replace(/.*T/, '').replace(/Z/, '')}`, 'info');
      }

      tlState.activeClipStartMs = parseCameraTimeString(requestedStart);
      tlState.activeClipEndMs = parseCameraTimeString(bestClip.endTime);

      await startPlaybackInSlot(activePbSlot, {
        deviceId,
        channelNo,
        camId,
        camName,
        startTime: requestedStart,
        endTime: bestClip.endTime,
        playbackURI: bestClip.playbackURI
      });

      if (statusBadge) statusBadge.textContent = 'Sedang diputar';
    } else {
      if (statusBadge) statusBadge.textContent = 'Gagal';
      showToast(res.error || 'NVR tidak merespon data rekaman.', 'error');
    }
  } catch (err) {
    if (statusBadge) statusBadge.textContent = 'Error';
    showToast('Koneksi NVR gagal: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-play"></i> <span>Putar Rekaman</span>';
  }
}

async function startPlaybackInSlot(slotIdx, params, isSeeking = false) {
  const slot = pbSlots[slotIdx];
  if (!slot) return;

  try {
    const res = await apiRequest(`/api/cameras/${params.camId}/playback-stream`, {
      method: 'POST',
      body: JSON.stringify({
        startTime: params.startTime,
        endTime: params.endTime,
        playbackURI: params.playbackURI
      })
    });

    if (res.success && res.streamName) {
      pbSlots[slotIdx] = {
        ...pbSlots[slotIdx],
        ...params,
        streamName: res.streamName,
        isPlaying: true,
        isPaused: pbIsPaused
      };

      const playerBody = document.querySelector(`#pb-slot-player-${slotIdx}`);
      if (isSeeking && playerBody && playerBody.querySelector('cctv-player')) {
        // Smooth seek/step: Reconnect stream directly without tearing down grid DOM
        if (typeof window.mountCctvPlayer === 'function') {
          window.mountCctvPlayer(playerBody, res.streamName, {
            title: params.camName,
            isSeeking: true
          });
        }
      } else {
        renderPlaybackGrid();
        showToast(`Rekaman dimuat di Slot #${slotIdx + 1} (${params.camName})`, 'success');
      }
    } else {
      showToast(res.error || 'NVR menolak stream playback.', 'error');
    }
  } catch (err) {
    showToast('Gagal memutar playback: ' + err.message, 'error');
  }
}

// ==========================================
// PLAYBACK CONTROLS: SPEED, ZOOM, PAUSE & SINGLE FRAME
// ==========================================
let pbZoomModeActive = false;
let pbZoomScale = 1.0;
let pbPanX = 0;
let pbPanY = 0;
let pbIsDragging = false;
let pbDragStartX = 0;
let pbDragStartY = 0;
let pbCurrentSpeed = 1.0;
let pbIsPaused = false;
let pbSlowCadenceTimer = null;
let pbSpeedScanTimer = null;

function getActivePlaybackVideo() {
  const activeSlot = pbSlots[activePbSlot];
  if (activeSlot && activeSlot.videoElement) {
    return activeSlot.videoElement;
  }
  const activeSlotEl = document.querySelector(`.pb-slot.active`);
  if (activeSlotEl) {
    const vid = activeSlotEl.querySelector('video');
    if (vid) return vid;
  }
  const directVid = document.querySelector('#playbackPlayerContainer video');
  if (directVid) return directVid;
  return null;
}

function updatePlayPauseBtnUI(isPaused) {
  const icon = document.getElementById('pbIconPlayPause');
  const label = document.getElementById('pbLabelPlayPause');
  const btn = document.getElementById('pbBtnPlayPause');
  if (isPaused) {
    if (icon) icon.className = 'fa-solid fa-play text-xs';
    if (label) label.textContent = 'Putar';
    if (btn) btn.className = 'h-7 px-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center space-x-1.5 transition shadow';
  } else {
    if (icon) icon.className = 'fa-solid fa-pause text-xs';
    if (label) label.textContent = 'Jeda';
    if (btn) btn.className = 'h-7 px-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center space-x-1.5 transition shadow';
  }
}

function togglePlaybackPlayPause() {
  const videoEl = getActivePlaybackVideo();
  if (videoEl) {
    if (videoEl.paused) {
      videoEl.play().catch(() => {});
      pbIsPaused = false;
      updatePlayPauseBtnUI(false);
      showPlaybackHUD('Putar', 'fa-solid fa-play');
    } else {
      videoEl.pause();
      pbIsPaused = true;
      updatePlayPauseBtnUI(true);
      showPlaybackHUD('Jeda', 'fa-solid fa-pause');
    }
  } else {
    showToast('Pilih slot rekaman yang sedang aktif.', 'warning');
  }
}

// On-Screen HUD Notification for video actions
let pbHUDTimer = null;
function showPlaybackHUD(text, iconClass = 'fa-solid fa-play') {
  const hud = document.getElementById('pbPlayerHUD');
  const icon = document.getElementById('pbHUDIcon');
  const label = document.getElementById('pbHUDText');
  if (!hud || !label) return;

  label.textContent = text;
  if (icon) icon.className = `${iconClass} text-amber-400 text-xs`;

  hud.classList.remove('hidden');
  hud.style.opacity = '1';

  clearTimeout(pbHUDTimer);
  pbHUDTimer = setTimeout(() => {
    hud.style.opacity = '0';
    setTimeout(() => {
      if (hud.style.opacity === '0') hud.classList.add('hidden');
    }, 200);
  }, 1200);
}

// Precision Stepping & Seeking (100% Functional via NVR seek)
let pbStepDebounceTimer = null;

// Single frame step (Maju / Mundur 1 frame / detik)
function stepSingleFrame(direction) {
  // Pause playback first so frame can be inspected
  const videoEl = getActivePlaybackVideo();
  if (videoEl && !videoEl.paused) {
    videoEl.pause();
    pbIsPaused = true;
    updatePlayPauseBtnUI(true);
  }

  // Clear any active scan/cadence speed timers
  if (pbSpeedScanTimer) {
    clearInterval(pbSpeedScanTimer);
    pbSpeedScanTimer = null;
  }
  if (pbSlowCadenceTimer) {
    clearTimeout(pbSlowCadenceTimer);
    clearInterval(pbSlowCadenceTimer);
    pbSlowCadenceTimer = null;
  }

  const currentSec = tlState.currentSecondInDay || 0;
  const newSec = Math.max(0, Math.min(86399, currentSec + direction));
  tlState.currentSecondInDay = newSec;

  // Immediately move the yellow needle and clock display on the timeline
  updateTimelinePlayhead(newSec, false);

  const sign = direction > 0 ? '+' : '';
  const icon = direction > 0 ? 'fa-solid fa-forward-step' : 'fa-solid fa-backward-step';
  showPlaybackHUD(`${sign}${direction} Frame (${formatHHMMSS(newSec)})`, icon);

  clearTimeout(pbStepDebounceTimer);
  pbStepDebounceTimer = setTimeout(() => {
    seekPlaybackToTime(newSec);
  }, 120);
}

function stepPlaybackSeconds(seconds, immediate = false) {
  stepSingleFrame(seconds);
}

function stepPlayback(seconds) {
  stepSingleFrame(seconds);
}

// Active Playback Speed: 1/4, 1/2, 1, 2+, 3+, 4+
function setPlaybackSpeed(speed) {
  pbCurrentSpeed = speed;

  // Clear any existing speed scan or slow cadence timers
  if (pbSpeedScanTimer) {
    clearInterval(pbSpeedScanTimer);
    pbSpeedScanTimer = null;
  }
  if (pbSlowCadenceTimer) {
    clearTimeout(pbSlowCadenceTimer);
    clearInterval(pbSlowCadenceTimer);
    pbSlowCadenceTimer = null;
  }

  // Update UI active buttons
  document.querySelectorAll('.pb-speed-btn').forEach(btn => {
    const btnSpeed = parseFloat(btn.dataset.speed);
    if (Math.abs(btnSpeed - speed) < 0.01) {
      btn.className = 'pb-speed-btn active px-2 py-0.5 rounded text-[11px] font-mono font-bold text-white bg-brand-500 transition shadow';
    } else {
      btn.className = 'pb-speed-btn px-1.5 py-0.5 rounded text-[11px] font-mono text-slate-400 hover:text-white transition';
    }
  });

  const videoEl = getActivePlaybackVideo();

  if (speed === 1.0) {
    // Normal 1x playback
    if (videoEl) {
      try { videoEl.playbackRate = 1.0; } catch (e) {}
      if (videoEl.paused && !pbIsPaused) videoEl.play().catch(() => {});
    }
    showPlaybackHUD('1x Normal', 'fa-solid fa-play');
    showToast('Kecepatan putar normal (1x)', 'info');

  } else if (speed === 0.25 || speed === 0.5) {
    // Slow Motion (1/4 or 1/2)
    const label = speed === 0.25 ? '1/4 Putar Lambat' : '1/2 Putar Lambat';
    showPlaybackHUD(label, 'fa-solid fa-gauge');
    showToast(`Mode ${label} aktif`, 'info');

    // Attempt native playbackRate if supported by browser/stream mode
    if (videoEl) {
      try { videoEl.playbackRate = speed; } catch (e) {}
    }

    // Zero-latency smooth cadence engine for WebRTC/MSE stream
    // 0.5x: 500ms play, 500ms pause
    // 0.25x: 250ms play, 750ms pause
    const playMs = speed === 0.25 ? 250 : 500;
    const pauseMs = speed === 0.25 ? 750 : 500;
    const cycleMs = playMs + pauseMs;

    const runCadence = () => {
      const vid = getActivePlaybackVideo();
      if (!vid || pbIsPaused || pbCurrentSpeed >= 1.0) return;
      vid.play().catch(() => {});
      pbSlowCadenceTimer = setTimeout(() => {
        const vid2 = getActivePlaybackVideo();
        if (vid2 && !pbIsPaused && pbCurrentSpeed < 1.0) {
          vid2.pause();
        }
      }, playMs);
    };

    runCadence();
    pbSpeedScanTimer = setInterval(runCadence, cycleMs);

  } else if (speed >= 2.0) {
    // Fast Scan (2+, 3+, 4+)
    const scanFactor = speed;
    const label = `${scanFactor}+ Pindai Cepat`;
    showPlaybackHUD(label, 'fa-solid fa-forward-fast');
    showToast(`Mode ${label} aktif`, 'info');

    if (videoEl && videoEl.paused) {
      videoEl.play().catch(() => {});
      pbIsPaused = false;
      updatePlayPauseBtnUI(false);
    }

    // Advance smoothly every 1500ms:
    // 2+: +3s every 1.5s
    // 3+: +4.5s (round 5s) every 1.5s
    // 4+: +6s every 1.5s
    const intervalMs = 1500;
    const deltaSec = Math.max(2, Math.round((intervalMs / 1000) * scanFactor));

    pbSpeedScanTimer = setInterval(() => {
      if (pbIsPaused) return;
      const current = tlState.currentSecondInDay || 0;
      const nextSec = Math.min(86399, current + deltaSec);
      tlState.currentSecondInDay = nextSec;
      updateTimelinePlayhead(nextSec, false);
      seekPlaybackToTime(nextSec);
    }, intervalMs);
  }
}

function stopPlayback() {
  if (pbSpeedScanTimer) {
    clearInterval(pbSpeedScanTimer);
    pbSpeedScanTimer = null;
  }
  if (pbSlowCadenceTimer) {
    clearTimeout(pbSlowCadenceTimer);
    clearInterval(pbSlowCadenceTimer);
    pbSlowCadenceTimer = null;
  }
  stopPlaybackSlot(activePbSlot);
  showToast(`Pemutaran rekaman pada Slot #${activePbSlot + 1} dihentikan`, 'info');
}

function clampPlaybackPan() {
  const container = document.getElementById('playbackPlayerContainer');
  if (!container || pbZoomScale <= 1.0) {
    pbPanX = 0;
    pbPanY = 0;
    return;
  }
  const maxPanX = (container.clientWidth * (pbZoomScale - 1)) / 2;
  const maxPanY = (container.clientHeight * (pbZoomScale - 1)) / 2;
  pbPanX = Math.max(-maxPanX, Math.min(maxPanX, pbPanX));
  pbPanY = Math.max(-maxPanY, Math.min(maxPanY, pbPanY));
}

function updatePlaybackZoomUI() {
  clampPlaybackPan();

  const matrix = document.getElementById('playbackMatrix');
  const container = document.getElementById('playbackPlayerContainer');
  const zoomBtn = document.getElementById('pbBtnZoomToggle');
  const zoomIcon = document.getElementById('pbIconZoom');

  if (matrix) {
    matrix.style.transform = `translate(${pbPanX}px, ${pbPanY}px) scale(${pbZoomScale})`;
    matrix.style.transformOrigin = 'center center';
  }

  if (container) {
    if (pbZoomModeActive && pbZoomScale > 1.0) {
      container.classList.add('is-zoomed');
    } else {
      container.classList.remove('is-zoomed', 'is-dragging');
    }
  }

  // Update single icon zoom toggle button appearance
  if (zoomBtn) {
    if (pbZoomModeActive) {
      zoomBtn.classList.add('active');
      zoomBtn.title = `Mode Zoom Aktif (${Math.round(pbZoomScale * 100)}%) - Putar roda mouse untuk atur zoom, klik untuk matikan`;
      if (zoomIcon) {
        zoomIcon.className = pbZoomScale > 1.0 ? 'fa-solid fa-magnifying-glass-plus text-xs' : 'fa-solid fa-magnifying-glass text-xs';
      }
    } else {
      zoomBtn.classList.remove('active');
      zoomBtn.title = 'Mode Zoom Video (Klik untuk aktifkan zoom, lalu scroll roda mouse untuk skala)';
      if (zoomIcon) zoomIcon.className = 'fa-solid fa-magnifying-glass text-xs';
    }
  }
}

function togglePlaybackZoom() {
  if (pbZoomModeActive) {
    // Mode zoom sedang aktif -> Matikan & reset ke normal 100%
    resetPlaybackZoom();
  } else {
    // Mode zoom nonaktif -> Aktifkan ke 200%
    pbZoomModeActive = true;
    pbZoomScale = 2.0;
    pbPanX = 0;
    pbPanY = 0;
    updatePlaybackZoomUI();
    showPlaybackHUD('Mode Zoom Aktif (200%)', 'fa-solid fa-magnifying-glass-plus');
    showToast('Mode Zoom Aktif (200%). Putar roda mouse untuk perbesar/perkecil, klik tahan untuk geser.', 'info');
  }
}

function panPlayback(deltaX, deltaY) {
  if (!pbZoomModeActive) return;
  pbPanX += deltaX;
  pbPanY += deltaY;
  updatePlaybackZoomUI();
}

function resetPlaybackPan() {
  pbPanX = 0;
  pbPanY = 0;
  updatePlaybackZoomUI();
}

function zoomInPlayback() {
  if (!pbZoomModeActive) return; // Kunci: jangan zoom jika mode zoom belum diaktifkan!
  if (pbZoomScale < 5.0) {
    pbZoomScale = Math.min(5.0, +(pbZoomScale + 0.25).toFixed(2));
    updatePlaybackZoomUI();
    showPlaybackHUD(`Zoom ${Math.round(pbZoomScale * 100)}%`, 'fa-solid fa-magnifying-glass-plus');
  }
}

function zoomOutPlayback() {
  if (!pbZoomModeActive) return; // Kunci: jangan zoom jika mode zoom belum diaktifkan!
  if (pbZoomScale > 1.0) {
    pbZoomScale = Math.max(1.0, +(pbZoomScale - 0.25).toFixed(2));
    if (pbZoomScale === 1.0) {
      pbPanX = 0;
      pbPanY = 0;
    }
    updatePlaybackZoomUI();
    showPlaybackHUD(`Zoom ${Math.round(pbZoomScale * 100)}%`, pbZoomScale > 1.0 ? 'fa-solid fa-magnifying-glass-minus' : 'fa-solid fa-magnifying-glass');
  }
}

function resetPlaybackZoom() {
  pbZoomModeActive = false;
  pbZoomScale = 1.0;
  pbPanX = 0;
  pbPanY = 0;
  updatePlaybackZoomUI();
  showPlaybackHUD('Mode Zoom Nonaktif (100%)', 'fa-solid fa-compress');
}

window.stepPlaybackSeconds = stepPlaybackSeconds;
window.stepSingleFrame = stepSingleFrame;
window.stepPlayback = stepPlayback;
window.setPlaybackSpeed = setPlaybackSpeed;
window.togglePlaybackZoom = togglePlaybackZoom;
window.panPlayback = panPlayback;
window.resetPlaybackPan = resetPlaybackPan;
window.zoomInPlayback = zoomInPlayback;
window.zoomOutPlayback = zoomOutPlayback;
window.resetPlaybackZoom = resetPlaybackZoom;
window.showPlaybackHUD = showPlaybackHUD;

function togglePlaybackFullscreen() {
  const card = document.getElementById('playbackScreenCard') || document.getElementById('playbackPlayerContainer');
  if (!card) return;

  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (!isFs) {
    if (card.requestFullscreen) {
      card.requestFullscreen().catch(() => {});
    } else if (card.webkitRequestFullscreen) {
      card.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function handlePlaybackFullscreenChange() {
  const card = document.getElementById('playbackScreenCard');
  const icon = document.getElementById('pbIconFullscreen');
  const topExitBtn = document.getElementById('pbTopBtnExitFullscreen');
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);

  if (card) {
    if (isFs && (document.fullscreenElement === card || document.webkitFullscreenElement === card)) {
      card.classList.add('is-fullscreen');
      if (topExitBtn) {
        topExitBtn.classList.remove('hidden');
        topExitBtn.classList.add('flex');
      }
    } else {
      card.classList.remove('is-fullscreen');
      if (topExitBtn) {
        topExitBtn.classList.add('hidden');
        topExitBtn.classList.remove('flex');
      }
    }
  }

  if (icon) {
    if (isFs) {
      icon.className = 'fa-solid fa-compress text-xs';
    } else {
      icon.className = 'fa-solid fa-expand text-xs';
    }
  }

  // Recalculate timeline PPS, ticks, and playhead offset on screen resize/fullscreen
  setTimeout(() => {
    renderTimelineRuler();
    if (tlState.clips && tlState.clips.length > 0 && tlState.currentDateStr) {
      renderTimelineRecordings(tlState.clips, tlState.currentDateStr);
    }
    updateTimelinePlayhead(tlState.currentSecondInDay, true);
  }, 100);
}

function initPlaybackToolbar() {
  const btnStop = document.getElementById('pbBtnStop');
  if (btnStop) btnStop.addEventListener('click', stopPlayback);

  const btnPlayPause = document.getElementById('pbBtnPlayPause');
  if (btnPlayPause) btnPlayPause.addEventListener('click', togglePlaybackPlayPause);

  const btnStepBack = document.getElementById('pbBtnStepBack');
  if (btnStepBack) btnStepBack.addEventListener('click', () => stepPlayback(-10));

  const btnStepForward = document.getElementById('pbBtnStepForward');
  if (btnStepForward) btnStepForward.addEventListener('click', () => stepPlayback(10));

  const btnStep30s = document.getElementById('pbBtnStep30s');
  if (btnStep30s) btnStep30s.addEventListener('click', () => stepPlayback(30));

  const btnFrameBack = document.getElementById('pbBtnFrameBack');
  if (btnFrameBack) btnFrameBack.addEventListener('click', () => stepSingleFrame(-1));

  const btnFrameForward = document.getElementById('pbBtnFrameForward');
  if (btnFrameForward) btnFrameForward.addEventListener('click', () => stepSingleFrame(1));

  document.querySelectorAll('.pb-speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const speed = parseFloat(btn.dataset.speed);
      setPlaybackSpeed(speed);
    });
  });

  const btnZoomToggle = document.getElementById('pbBtnZoomToggle');
  if (btnZoomToggle) btnZoomToggle.addEventListener('click', togglePlaybackZoom);

  const btnFullscreen = document.getElementById('pbBtnFullscreen');
  if (btnFullscreen) btnFullscreen.addEventListener('click', togglePlaybackFullscreen);

  // Toggle timeline bar on/off button
  const btnToggleTimeline = document.getElementById('pbBtnToggleTimeline');
  if (btnToggleTimeline) {
    btnToggleTimeline.addEventListener('click', () => {
      const tl = document.getElementById('playbackTimelineContainer');
      if (tl) {
        tl.classList.toggle('hidden');
        const isHidden = tl.classList.contains('hidden');
        btnToggleTimeline.classList.toggle('opacity-60', isHidden);
        if (!isHidden) {
          setTimeout(() => {
            renderTimelineRuler();
            if (tlState.clips && tlState.clips.length > 0 && tlState.currentDateStr) {
              renderTimelineRecordings(tlState.clips, tlState.currentDateStr);
            }
            updateTimelinePlayhead(tlState.currentSecondInDay, true);
          }, 50);
        }
      }
    });
  }

  // Handle Fullscreen transitions
  document.addEventListener('fullscreenchange', handlePlaybackFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handlePlaybackFullscreenChange);

  // Pure Mouse Drag-to-Pan video when zoomed
  const playerContainer = document.getElementById('playbackPlayerContainer');
  if (playerContainer) {
    playerContainer.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !pbZoomModeActive || pbZoomScale <= 1.0) return;
      if (e.target.closest('button')) return;

      pbIsDragging = true;
      pbDragStartX = e.clientX - pbPanX;
      pbDragStartY = e.clientY - pbPanY;
      playerContainer.classList.add('is-dragging');
      e.preventDefault();
    });

    // Mouse wheel: Scroll = Zoom In/Out (HANYA saat mode zoom aktif) | Ctrl + Scroll = Precision Frame Step
    playerContainer.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        stepPlaybackSeconds(e.deltaY < 0 ? 1 : -1, false);
        return;
      }

      // KUNCI: Jangan zoom jika mode zoom sedang nonaktif!
      if (!pbZoomModeActive) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) {
        zoomInPlayback();
      } else {
        zoomOutPlayback();
      }
    }, { passive: false });

    // Double Click: Toggle Zoom (Aktif 200% <-> Nonaktif 100%)
    playerContainer.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      togglePlaybackZoom();
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (!pbIsDragging) return;
    pbPanX = e.clientX - pbDragStartX;
    pbPanY = e.clientY - pbDragStartY;
    updatePlaybackZoomUI();
  });

  window.addEventListener('mouseup', () => {
    if (pbIsDragging) {
      pbIsDragging = false;
      const pc = document.getElementById('playbackPlayerContainer');
      if (pc) pc.classList.remove('is-dragging');
    }
  });

  // Initialize the playback grid matrix on initial load
  renderPlaybackGrid();
}

// Synchronize Download 24-Hour UI fields with hidden ISO inputs
function syncDlInputsToHidden() {
  const sDate = document.getElementById('dlStartDate')?.value;
  let sTime = document.getElementById('dlStartTime24')?.value?.trim() || '00:00:00';
  const eDate = document.getElementById('dlEndDate')?.value;
  let eTime = document.getElementById('dlEndTime24')?.value?.trim() || '00:15:00';

  const normalizeTime = (t) => {
    if (!t) return '00:00:00';
    const p = t.split(':');
    const h = (p[0] || '00').padStart(2, '0');
    const m = (p[1] || '00').padStart(2, '0');
    const s = (p[2] || '00').padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  sTime = normalizeTime(sTime);
  eTime = normalizeTime(eTime);

  const startInput = document.getElementById('dlStartTime');
  const endInput = document.getElementById('dlEndTime');

  if (startInput && sDate) startInput.value = `${sDate}T${sTime}`;
  if (endInput && eDate) endInput.value = `${eDate}T${eTime}`;

  if (sDate && eDate) {
    const sMs = new Date(`${sDate}T${sTime}`).getTime();
    const eMs = new Date(`${eDate}T${eTime}`).getTime();
    if (!isNaN(sMs) && !isNaN(eMs) && eMs >= sMs) {
      const diffMins = Math.max(1, Math.round((eMs - sMs) / 60000));
      const durInput = document.getElementById('dlDurationInput');
      if (durInput) durInput.value = diffMins;
      const label = document.getElementById('dlCalculatedDurationLabel');
      if (label) label.textContent = `Durasi: ${formatDurationText(diffMins)}`;
    }
  }
}

function syncHiddenToDlInputs(startStr, endStr) {
  if (startStr) {
    const clean = startStr.replace(/[Z]/g, '').trim();
    const m = clean.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
    if (m) {
      const sDateEl = document.getElementById('dlStartDate');
      const sTimeEl = document.getElementById('dlStartTime24');
      if (sDateEl) sDateEl.value = m[1];
      if (sTimeEl) sTimeEl.value = m[2].length === 5 ? `${m[2]}:00` : m[2];
    }
    const startInput = document.getElementById('dlStartTime');
    if (startInput) startInput.value = startStr;
  }

  if (endStr) {
    const clean = endStr.replace(/[Z]/g, '').trim();
    const m = clean.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
    if (m) {
      const eDateEl = document.getElementById('dlEndDate');
      const eTimeEl = document.getElementById('dlEndTime24');
      if (eDateEl) eDateEl.value = m[1];
      if (eTimeEl) eTimeEl.value = m[2].length === 5 ? `${m[2]}:00` : m[2];
    }
    const endInput = document.getElementById('dlEndTime');
    if (endInput) endInput.value = endStr;
  }
}

function quickDownloadClip(deviceId, channelNo, startTime, endTime) {
  switchTab('downloads');
  const devSelect = document.getElementById('dlDeviceSelect');
  devSelect.value = deviceId;
  updateDownloadChannelOptions(deviceId).then(() => {
    document.getElementById('dlChannelSelect').value = channelNo;
    syncHiddenToDlInputs(startTime, endTime);
    syncDlInputsToHidden();

    const sDate = new Date(startTime);
    const eDate = new Date(endTime);
    const durMin = Math.max(1, Math.round((eDate.getTime() - sDate.getTime()) / 60000));
    document.getElementById('dlDurationInput').value = durMin;
    const durLabel = document.getElementById('dlCalculatedDurationLabel');
    if (durLabel) durLabel.textContent = `Durasi: ${formatDurationText(durMin)}`;
    showToast(`Parameter klip rekaman (${formatDurationText(durMin)}) telah dipasang di form download!`, 'info');
  });
}

// --- DOWNLOAD VIDEO REKAMAN MODULE (STRICT 24-HOUR FORMAT) ---
function initDownloadDefaults() {
  const now = new Date();
  const s = new Date(now.getTime() - 15 * 60000);
  const pad = (n) => String(n).padStart(2, '0');

  const sDateStr = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
  const sTimeStr = `${pad(s.getHours())}:${pad(s.getMinutes())}:${pad(s.getSeconds())}`;
  const eDateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const eTimeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const sDateEl = document.getElementById('dlStartDate');
  if (sDateEl && !sDateEl.value) {
    sDateEl.value = sDateStr;
    const sTimeEl = document.getElementById('dlStartTime24');
    if (sTimeEl) sTimeEl.value = sTimeStr;

    const eDateEl = document.getElementById('dlEndDate');
    if (eDateEl) eDateEl.value = eDateStr;
    const eTimeEl = document.getElementById('dlEndTime24');
    if (eTimeEl) eTimeEl.value = eTimeStr;

    syncDlInputsToHidden();
  }

  // Bind change listeners to 24h inputs
  ['dlStartDate', 'dlStartTime24', 'dlEndDate', 'dlEndTime24'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.dataset.bound) {
      el.dataset.bound = 'true';
      el.addEventListener('change', syncDlInputsToHidden);
      el.addEventListener('blur', syncDlInputsToHidden);
      el.addEventListener('input', syncDlInputsToHidden);
    }
  });
}

function setDlStartToNow() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const tStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const sDateEl = document.getElementById('dlStartDate');
  const sTimeEl = document.getElementById('dlStartTime24');
  if (sDateEl) sDateEl.value = dStr;
  if (sTimeEl) sTimeEl.value = tStr;

  syncDlInputsToHidden();
  const durMins = parseInt(document.getElementById('dlDurationInput')?.value, 10) || 15;
  updateDlEndTimeFromDuration(durMins);
  showToast('Waktu mulai disetel ke sekarang (24 Jam)', 'info');
}

function updateDlEndTimeFromDuration(mins) {
  syncDlInputsToHidden();
  const startInput = document.getElementById('dlStartTime');
  if (!startInput || !startInput.value) return;

  const s = new Date(startInput.value);
  if (isNaN(s.getTime())) return;
  const e = new Date(s.getTime() + mins * 60000);
  const pad = (n) => String(n).padStart(2, '0');

  const eDateStr = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`;
  const eTimeStr = `${pad(e.getHours())}:${pad(e.getMinutes())}:${pad(e.getSeconds())}`;

  const eDateEl = document.getElementById('dlEndDate');
  const eTimeEl = document.getElementById('dlEndTime24');
  if (eDateEl) eDateEl.value = eDateStr;
  if (eTimeEl) eTimeEl.value = eTimeStr;

  syncDlInputsToHidden();

  const label = document.getElementById('dlCalculatedDurationLabel');
  if (label) {
    label.textContent = `Durasi: ${formatDurationText(mins)}`;
  }
}

function formatDurationText(mins) {
  if (mins < 60) return `${mins} Menit`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} Jam ${m} Menit` : `${h} Jam`;
}

function populateDownloadDeviceSelect() {
  const select = document.getElementById('dlDeviceSelect');
  if (!select) return;

  let opts = '<option value="">-- Pilih NVR / IP --</option>';
  state.devices.forEach(d => {
    opts += `<option value="${d.id}">${d.name} (${d.ip}) - ${d.camera_count} Channel</option>`;
  });
  select.innerHTML = opts;

  if (state.devices.length === 1 && !select.value) {
    select.value = state.devices[0].id;
    updateDownloadChannelOptions(state.devices[0].id);
  }
}

async function updateDownloadChannelOptions(deviceId) {
  const select = document.getElementById('dlChannelSelect');
  if (!deviceId) {
    select.disabled = true;
    select.innerHTML = '<option value="">-- Pilih NVR terlebih dahulu --</option>';
    return;
  }

  select.disabled = false;
  select.innerHTML = '<option value="">Memuat channel...</option>';

  try {
    const res = await apiRequest(`/api/devices/${deviceId}`);
    if (res.success && res.cameras) {
      let opts = '<option value="">-- Pilih Channel Kamera --</option>';
      res.cameras.forEach(cam => {
        opts += `<option value="${cam.channel_no}">CH ${String(cam.channel_no).padStart(2, '0')} - ${cam.custom_name}</option>`;
      });
      select.innerHTML = opts;
    }
  } catch (err) {
    select.innerHTML = '<option value="">Gagal memuat channel</option>';
  }
}

function quickDownloadCamera(deviceId, channelNo) {
  switchTab('downloads');
  const devSelect = document.getElementById('dlDeviceSelect');
  devSelect.value = deviceId;
  updateDownloadChannelOptions(deviceId).then(() => {
    document.getElementById('dlChannelSelect').value = channelNo;
  });
}

async function handleDownloadSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  syncDlInputsToHidden();
  const deviceId = document.getElementById('dlDeviceSelect').value;
  const channelNo = document.getElementById('dlChannelSelect').value;
  const startTime = document.getElementById('dlStartTime').value;
  const endTime = document.getElementById('dlEndTime')?.value;
  const durationMins = document.getElementById('dlDurationInput').value;
  const streamType = document.querySelector('input[name="streamQuality"]:checked')?.value || 'main';
  const btn = document.getElementById('startDownloadBtn');

  if (!deviceId || !channelNo || !startTime || !endTime) {
    alert('Harap lengkapi Device, Channel, Waktu Mulai, dan Waktu Selesai!');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Mengirim Perintah Download...</span>';

  try {
    const res = await apiRequest('/api/downloads', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: parseInt(deviceId, 10),
        channelNo: parseInt(channelNo, 10),
        startTime: startTime,
        endTime: endTime,
        durationMins: parseInt(durationMins, 10) || 15,
        streamType
      })
    });

    if (res.success) {
      showToast('Tugas download rekaman berhasil dimulai!', 'success');
      fetchDownloads();
      const list = document.getElementById('downloadJobsList');
      if (list) list.scrollIntoView({ behavior: 'smooth' });
    } else {
      showToast(res.error || 'Gagal memulai download.', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-download"></i> <span>Mulai Unduh Video (.MP4)</span>';
  }
}

async function handleCheckRecordings() {
  syncDlInputsToHidden();
  const deviceId = document.getElementById('dlDeviceSelect').value;
  const channelNo = document.getElementById('dlChannelSelect').value;
  const startTime = document.getElementById('dlStartTime').value;
  const endTime = document.getElementById('dlEndTime')?.value;
  const btn = document.getElementById('checkRecordingsBtn');
  const resultBox = document.getElementById('checkRecordingsResult');

  if (!deviceId || !channelNo || !startTime || !endTime) {
    alert('Harap pilih Device, Channel, Waktu Mulai, dan Waktu Selesai!');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Mengecek NVR ISAPI...</span>';
  if (resultBox) resultBox.classList.add('hidden');

  try {
    const res = await apiRequest('/api/downloads/search', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: parseInt(deviceId, 10),
        channelNo: parseInt(channelNo, 10),
        startTime: startTime,
        endTime: endTime
      })
    });

    if (res.success && resultBox) {
      resultBox.classList.remove('hidden');
      if (res.count > 0 && res.recordings && res.recordings.length > 0) {
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (iso) => {
          const d = new Date(iso);
          return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        };

        let clipsHtml = res.recordings.slice(0, 5).map((clip, idx) => {
          const s = fmt(clip.startTime);
          const e = fmt(clip.endTime);
          const dur = Math.max(1, Math.round((new Date(clip.endTime) - new Date(clip.startTime)) / 60000));
          return `
            <div class="flex items-center justify-between py-1 border-b border-emerald-500/20 text-[11px] text-slate-200">
              <span><i class="fa-solid fa-film text-emerald-400 mr-1.5"></i>Klip ${idx + 1}: <b>${s}</b> s/d <b>${e}</b> (${dur} mnt)</span>
              <button type="button" onclick="executeQuickDownloadSpecificClip('${clip.startTime}', '${clip.endTime}')" class="px-2 py-0.5 rounded bg-emerald-700/60 hover:bg-emerald-600 text-white font-semibold text-[10px]">Unduh Klip</button>
            </div>
          `;
        }).join('');

        resultBox.innerHTML = `
          <div class="flex items-start space-x-2 text-emerald-300">
            <i class="fa-solid fa-circle-check text-emerald-400 mt-0.5 text-sm"></i>
            <div class="flex-1">
              <div class="font-bold text-xs text-white">Ditemukan ${res.count} Klip Rekaman di Harddisk NVR!</div>
              <p class="text-[11px] text-emerald-300/80 mt-0.5">Rekaman tersedia di storage NVR Hikvision. Anda dapat langsung mengunduh klip pilihan atau klik tombol di bawah untuk seluruh rentang waktu.</p>
              <div class="mt-2 space-y-1">
                ${clipsHtml}
              </div>
              <button type="button" onclick="handleDownloadSubmit(event)" class="mt-3 w-full py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs flex items-center justify-center space-x-1.5 shadow-lg">
                <i class="fa-solid fa-download"></i>
                <span>Langsung Unduh Rentang Waktu Ini (.MP4)</span>
              </button>
            </div>
          </div>
        `;
        showToast(`Ditemukan ${res.count} klip rekaman di NVR!`, 'success');
      } else {
        resultBox.innerHTML = `
          <div class="flex items-start space-x-2 text-amber-300">
            <i class="fa-solid fa-circle-exclamation text-amber-400 mt-0.5 text-sm"></i>
            <div>
              <div class="font-bold text-xs text-white">Tidak Ada Rekaman di NVR</div>
              <p class="text-[11px] text-amber-300/80 mt-0.5">NVR merespon bahwa tidak ada file rekaman yang tersimpan pada rentang waktu yang dipilih.</p>
            </div>
          </div>
        `;
        showToast('Tidak ada rekaman pada jam tersebut di NVR.', 'warning');
      }
    } else {
      showToast('Cek NVR: ' + (res.error || 'Gagal cek rekaman'), 'warning');
    }
  } catch (err) {
    showToast('Koneksi NVR: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> <span>Cek Rekaman Tersedia di NVR (ISAPI)</span>';
  }
}

function executeQuickDownloadSpecificClip(startTime, endTime) {
  const sDate = new Date(startTime);
  const eDate = new Date(endTime);
  const pad = (n) => String(n).padStart(2, '0');
  document.getElementById('dlStartTime').value = `${sDate.getFullYear()}-${pad(sDate.getMonth() + 1)}-${pad(sDate.getDate())}T${pad(sDate.getHours())}:${pad(sDate.getMinutes())}`;
  document.getElementById('dlEndTime').value = `${eDate.getFullYear()}-${pad(eDate.getMonth() + 1)}-${pad(eDate.getDate())}T${pad(eDate.getHours())}:${pad(eDate.getMinutes())}`;
  const durMin = Math.max(1, Math.round((eDate.getTime() - sDate.getTime()) / 60000));
  document.getElementById('dlDurationInput').value = durMin;
  handleDownloadSubmit(new Event('submit'));
}

async function fetchDownloads() {
  try {
    const res = await apiRequest('/api/downloads');
    if (res.success) {
      state.jobs = res.jobs;
      renderDownloadJobs();
      updateActiveDlBadge();
    }
  } catch (err) {
    console.error('Fetch downloads error:', err);
  }
}

function updateActiveDlBadge() {
  const badge = document.getElementById('activeDlBadge');
  const hasActive = state.jobs.some(j => j.status === 'downloading' || j.status === 'pending');
  if (hasActive) {
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderDownloadJobs() {
  const container = document.getElementById('downloadJobsList');
  const emptyState = document.getElementById('emptyDownloadJobs');
  if (!container) return;

  if (state.jobs.length === 0) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  let html = '';

  state.jobs.forEach(job => {
    const isCompleted = job.status === 'completed';
    const isDownloading = job.status === 'downloading';
    const isFailed = job.status === 'failed';
    const sizeMb = (job.file_size / (1024 * 1024)).toFixed(1);

    let statusBadge = '';
    if (isCompleted) {
      statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"><i class="fa-solid fa-check mr-1"></i>Selesai</span>';
    } else if (isDownloading) {
      statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Mengunduh</span>';
    } else if (isFailed) {
      statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-500/20 text-rose-400 border border-rose-500/30"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Gagal</span>';
    } else {
      statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">Menunggu</span>';
    }

    const startDate = new Date(job.start_time).toLocaleString('id-ID');

    html += `
      <div id="job-card-${job.id}" class="bg-slate-900/90 border border-cctv-border rounded-xl p-4 shadow space-y-3">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="flex items-center space-x-2">
              <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-brand-400">CH ${String(job.channel_no).padStart(2, '0')}</span>
              <h4 class="text-sm font-bold text-white">${job.camera_name}</h4>
              ${statusBadge}
            </div>
            <p class="text-xs text-slate-400 mt-1">
              NVR: <span class="text-slate-200">${job.device_name}</span> | Mulai: <span class="text-slate-200">${startDate}</span> (${job.duration_mins} Menit)
            </p>
          </div>

          <div class="flex items-center space-x-2">
            ${isCompleted ? `
              <a href="/api/downloads/${job.id}/file" download
                class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center space-x-1.5 shadow-lg shadow-emerald-900/40 transition">
                <i class="fa-solid fa-download"></i>
                <span>Unduh ke PC (${sizeMb} MB)</span>
              </a>
            ` : ''}
            <button onclick="deleteDownloadJob('${job.id}')" class="text-slate-500 hover:text-rose-400 text-xs p-1" title="Hapus Riwayat">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>

        ${(isDownloading || isCompleted) ? `
          <div>
            <div class="flex justify-between text-[10px] text-slate-400 mb-1">
              <span id="job-prog-text-${job.id}">${isCompleted ? '100% Selesai' : `Proses Download: ${job.progress}%`}</span>
              <span id="job-size-text-${job.id}">${isCompleted ? `${sizeMb} MB` : `${((job.bytes_downloaded || 0) / (1024 * 1024)).toFixed(1)} MB`}</span>
            </div>
            <div class="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700/50">
              <div id="job-prog-bar-${job.id}" class="bg-gradient-to-r from-emerald-500 to-teal-400 h-2 rounded-full transition-all duration-300" style="width: ${job.progress}%"></div>
            </div>
          </div>
        ` : ''}

        ${job.error_message ? `
          <p class="text-xs text-rose-400 bg-rose-950/30 p-2 rounded-lg border border-rose-900/30">
            <i class="fa-solid fa-circle-exclamation mr-1"></i> ${job.error_message}
          </p>
        ` : ''}
      </div>
    `;
  });

  container.innerHTML = html;
}

function updateJobProgressUI(jobId, progress, bytes, total) {
  const bar = document.getElementById(`job-prog-bar-${jobId}`);
  const text = document.getElementById(`job-prog-text-${jobId}`);
  const sizeText = document.getElementById(`job-size-text-${jobId}`);

  if (bar) bar.style.width = `${progress}%`;
  if (text) text.textContent = `Proses Download: ${progress}%`;
  if (sizeText) sizeText.textContent = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function deleteDownloadJob(jobId) {
  if (confirm('Hapus riwayat unduhan ini?')) {
    try {
      await apiRequest(`/api/downloads/${jobId}`, { method: 'DELETE' });
      fetchDownloads();
    } catch (err) {
      showToast('Gagal menghapus riwayat.', 'error');
    }
  }
}

// --- ADD DEVICE MODAL & ACTIONS ---
function openAddDeviceModal() {
  document.getElementById('addDeviceModal').classList.remove('hidden');
  document.getElementById('testConnAlert').classList.add('hidden');
}

async function handleTestConnection() {
  const ip = document.getElementById('devIp').value.trim();
  const http_port = document.getElementById('devHttpPort').value;
  const username = document.getElementById('devUser').value.trim();
  const password = document.getElementById('devPass').value.trim();
  const alertEl = document.getElementById('testConnAlert');
  const btn = document.getElementById('testConnBtn');

  if (!ip || !username || !password) {
    alert('Harap isi IP, Username, dan Password NVR terlebih dahulu!');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Mengecek...</span>';
  alertEl.classList.add('hidden');

  try {
    const res = await apiRequest('/api/devices/test', {
      method: 'POST',
      body: JSON.stringify({ ip, http_port, username, password })
    });

    alertEl.classList.remove('hidden');
    if (res.success) {
      alertEl.className = 'p-3 rounded-xl text-xs bg-emerald-500/20 border border-emerald-500/40 text-emerald-300';
      alertEl.innerHTML = `
        <div class="font-bold mb-0.5">✅ Terhubung ke Hikvision!</div>
        <div>Model: ${res.deviceInfo.model} | S/N: ${res.deviceInfo.serialNumber} | FW: ${res.deviceInfo.firmwareVersion}</div>
      `;
      if (res.deviceInfo.serialNumber) document.getElementById('devSerial').value = res.deviceInfo.serialNumber;
      if (res.deviceInfo.model) document.getElementById('devModel').value = res.deviceInfo.model;
    } else {
      alertEl.className = 'p-3 rounded-xl text-xs bg-rose-500/20 border border-rose-500/40 text-rose-300';
      alertEl.innerHTML = `❌ ${res.error || 'Gagal terhubung ke NVR'}`;
    }
  } catch (err) {
    alertEl.className = 'p-3 rounded-xl text-xs bg-rose-500/20 border border-rose-500/40 text-rose-300';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
    alertEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-bolt text-yellow-400"></i> <span>Test Koneksi</span>';
  }
}

async function handleAutoFindSerial() {
  const serial = document.getElementById('devSerialSearch').value.trim();
  const user = document.getElementById('devUser').value.trim() || 'admin';
  const pass = document.getElementById('devPass').value.trim() || '';
  const btn = document.getElementById('btnAutoFindSerial');
  const resDiv = document.getElementById('serialSearchResult');

  if (!serial) {
    alert('Harap ketik nomor seri NVR terlebih dahulu (misal: GK5808953)!');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Mencari...</span>';
  resDiv.classList.remove('hidden');
  resDiv.className = 'text-[11px] p-2 rounded-lg bg-slate-900 border border-cctv-border text-amber-400';
  resDiv.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Memindai NVR di jaringan dengan nomor seri: <b>' + serial + '</b>...';

  try {
    const res = await apiRequest('/api/devices/discover-serial', {
      method: 'POST',
      body: JSON.stringify({ serial, username: user, password: pass })
    });

    if (res.success && res.result && res.result.found) {
      const found = res.result;
      document.getElementById('devIp').value = found.ip;
      document.getElementById('devSerial').value = found.serialNumber;
      document.getElementById('devModel').value = found.model || '';
      if (!document.getElementById('devName').value) {
        document.getElementById('devName').value = found.deviceName || found.model || ('NVR ' + serial);
      }
      if (found.http_port) {
        document.getElementById('devHttpPort').value = found.http_port;
      }

      resDiv.className = 'text-[11px] p-2.5 rounded-lg bg-emerald-950/80 border border-emerald-800 text-emerald-300';
      resDiv.innerHTML = `
        <div class="flex items-center space-x-1.5 font-bold text-white mb-0.5">
          <i class="fa-solid fa-circle-check text-emerald-400"></i>
          <span>NVR Berhasil Ditemukan!</span>
        </div>
        <div>IP Terdeteksi: <b class="text-white">${found.ip}</b> (Port ${found.http_port || 80})</div>
        <div class="text-[10px] text-emerald-400">Model: ${found.model} • Seri: ${found.serialNumber}</div>
      `;
    } else {
      resDiv.className = 'text-[11px] p-2.5 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-300';
      resDiv.innerHTML = `<i class="fa-solid fa-circle-exclamation mr-1"></i> NVR dengan nomor seri <b>${serial}</b> tidak ditemukan. Pastikan nomor seri benar, NVR menyala, dan kabel LAN terhubung.`;
    }
  } catch (err) {
    resDiv.className = 'text-[11px] p-2.5 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-300';
    resDiv.innerHTML = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> <span>Cari IP</span>';
  }
}

async function handleScanSadp() {
  const btn = document.getElementById('btnScanSadp');
  const resDiv = document.getElementById('serialSearchResult');
  if (!btn || !resDiv) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Scanning...</span>';
  resDiv.classList.remove('hidden');
  resDiv.className = 'text-[11px] p-2.5 rounded-lg bg-slate-900 border border-cctv-border text-amber-400';
  resDiv.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Memindai seluruh NVR Hikvision di jaringan lokal (SADP)...';

  try {
    const res = await apiRequest('/api/devices/sadp');
    if (res.success && res.devices && res.devices.length > 0) {
      let html = `<div class="font-bold text-white mb-1.5 flex items-center justify-between">
        <span>Ditemukan ${res.devices.length} Perangkat Hikvision di LAN:</span>
        <span class="text-[10px] text-slate-400">Klik untuk isi form</span>
      </div><div class="space-y-1.5 max-h-48 overflow-y-auto">`;

      res.devices.forEach((dev, idx) => {
        html += `
          <div onclick="selectDiscoveredDevice(${idx})" class="p-2 rounded bg-slate-800/80 hover:bg-brand-950/80 hover:border-brand-500 border border-slate-700 cursor-pointer transition flex items-center justify-between">
            <div>
              <div class="font-bold text-white text-xs">${dev.model || 'Hikvision Device'}</div>
              <div class="text-[10px] text-slate-400 font-mono">IP: <span class="text-amber-300 font-bold">${dev.ip}</span> | Port: ${dev.http_port} | Serial: <span class="text-emerald-400">${dev.serialNumber || '-'}</span></div>
            </div>
            <button type="button" class="px-2 py-1 rounded bg-brand-500 hover:bg-brand-600 text-white text-[10px] font-bold">Pilih</button>
          </div>
        `;
      });
      html += '</div>';
      resDiv.className = 'text-[11px] p-2.5 rounded-lg bg-slate-900 border border-emerald-500/40 text-emerald-400';
      resDiv.innerHTML = html;
      window._discoveredDevices = res.devices;
    } else {
      resDiv.className = 'text-[11px] p-2.5 rounded-lg bg-slate-900 border border-amber-500/40 text-amber-400';
      resDiv.innerHTML = '<i class="fa-solid fa-circle-info mr-1"></i> Tidak ada respon SADP broadcast langsung. Silakan gunakan tombol "Cari IP" dengan mengetik nomor seri NVR di sebelah kiri.';
    }
  } catch (err) {
    resDiv.className = 'text-[11px] p-2.5 rounded-lg bg-slate-900 border border-rose-500/40 text-rose-400';
    resDiv.innerHTML = '<i class="fa-solid fa-triangle-exclamation mr-1"></i> Gagal scan SADP: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-network-wired"></i> <span>Scan LAN</span>';
  }
}

function selectDiscoveredDevice(idx) {
  if (!window._discoveredDevices || !window._discoveredDevices[idx]) return;
  const dev = window._discoveredDevices[idx];
  document.getElementById('devIp').value = dev.ip || '';
  document.getElementById('devSerial').value = dev.serialNumber || '';
  document.getElementById('devModel').value = dev.model || '';
  if (dev.http_port) document.getElementById('devHttpPort').value = dev.http_port;
  if (!document.getElementById('devName').value) {
    document.getElementById('devName').value = (dev.model ? dev.model + ' ' : 'NVR ') + (dev.ip || '');
  }
  showToast(`Perangkat ${dev.ip} (${dev.model || ''}) dipilih! Silakan isi username & password lalu simpan.`, 'info');
}

async function handleAddDeviceSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('devName').value.trim();
  const group_id = document.getElementById('devGroup').value;
  const ip = document.getElementById('devIp').value.trim();
  const http_port = document.getElementById('devHttpPort').value;
  const rtsp_port = document.getElementById('devRtspPort').value;
  const username = document.getElementById('devUser').value.trim();
  const password = document.getElementById('devPass').value.trim();
  const serial_number = document.getElementById('devSerial')?.value || '';
  const model = document.getElementById('devModel')?.value || '';
  const btn = document.getElementById('saveDevBtn');

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Memindai Channel NVR...</span>';

  try {
    const res = await apiRequest('/api/devices', {
      method: 'POST',
      body: JSON.stringify({
        name,
        group_id: group_id ? parseInt(group_id, 10) : null,
        ip,
        http_port: parseInt(http_port, 10),
        rtsp_port: parseInt(rtsp_port, 10),
        username,
        password,
        serial_number,
        model
      })
    });

    if (res.success) {
      closeModal('addDeviceModal');
      document.getElementById('addDeviceForm').reset();
      showToast(res.message, 'success');
      await fetchDevices();
      await fetchCameras();
      switchTab('devices');
    } else {
      alert(res.error || 'Gagal menyimpan NVR');
    }
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> <span>Simpan & Auto-Scan Channel NVR</span>';
  }
}

async function testExistingDevice(deviceId) {
  try {
    const res = await apiRequest(`/api/devices/${deviceId}`);
    if (res.success && res.device) {
      const dev = res.device;
      const testRes = await apiRequest('/api/devices/test', {
        method: 'POST',
        body: JSON.stringify({
          ip: dev.ip,
          http_port: dev.http_port,
          username: dev.username,
          password: dev.password
        })
      });

      if (testRes.success) {
        showToast(`NVR ${dev.name} ONLINE! Model: ${testRes.deviceInfo.model}`, 'success');
      } else {
        showToast(`NVR ${dev.name} OFFLINE: ${testRes.error}`, 'error');
      }
      fetchDevices();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteDevice(deviceId, devName) {
  if (confirm(`HAPUS NVR "${devName}" beserta SEMUA channel kameranya? Tindakan ini tidak dapat dibatalkan.`)) {
    try {
      const res = await apiRequest(`/api/devices/${deviceId}`, { method: 'DELETE' });
      if (res.success) {
        showToast(`NVR ${devName} berhasil dihapus.`, 'success');
        await fetchDevices();
        await fetchCameras();
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
}

// --- EDIT CAMERA MODAL & ACTIONS ---
function openEditCameraModal(camId, customName, tags, groupId) {
  document.getElementById('editCamId').value = camId;
  document.getElementById('editCamName').value = customName;
  document.getElementById('editCamTags').value = tags;
  document.getElementById('editCamGroup').value = groupId || '';
  document.getElementById('editCameraModal').classList.remove('hidden');
}

async function handleEditCameraSubmit(e) {
  e.preventDefault();
  const camId = document.getElementById('editCamId').value;
  const custom_name = document.getElementById('editCamName').value.trim();
  const tags = document.getElementById('editCamTags').value.trim();
  const group_id = document.getElementById('editCamGroup').value;

  try {
    const res = await apiRequest(`/api/cameras/${camId}`, {
      method: 'PUT',
      body: JSON.stringify({
        custom_name,
        tags,
        group_id: group_id ? parseInt(group_id, 10) : null
      })
    });

    if (res.success) {
      closeModal('editCameraModal');
      showToast('Kamera berhasil diperbarui!', 'success');
      fetchCameras();
      fetchDevices();
    } else {
      alert(res.error || 'Gagal mengubah kamera');
    }
  } catch (err) {
    alert(err.message);
  }
}

// --- GROUP MODAL & ACTIONS ---
function openAddGroupModal() {
  document.getElementById('addGroupModal').classList.remove('hidden');
  renderGroupsModalList();
}

function renderGroupsModalList() {
  const container = document.getElementById('groupsListModal');
  if (!container) return;

  if (state.groups.length === 0) {
    container.innerHTML = '<div class="py-4 text-center text-xs text-slate-500">Belum ada grup yang dibuat.</div>';
    return;
  }

  let html = '';
  state.groups.forEach(g => {
    html += `
      <div class="py-2.5 flex items-center justify-between group/grp">
        <div>
          <span class="text-sm font-semibold text-white">${g.name}</span>
          <p class="text-[11px] text-slate-400">${g.device_count || 0} NVR • ${g.camera_count || 0} Kamera</p>
        </div>
        <div class="flex items-center space-x-1.5">
          <button type="button" onclick="editGroupPrompt(${g.id}, '${escapeQuotes(g.name)}')" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs flex items-center space-x-1 transition" title="Ubah Nama Grup">
            <i class="fa-solid fa-pen text-[10px]"></i>
            <span class="text-[10px]">Ubah</span>
          </button>
          <button type="button" onclick="deleteGroup(${g.id}, '${escapeQuotes(g.name)}')" class="px-2 py-1 rounded bg-slate-800 hover:bg-rose-900/60 text-slate-400 hover:text-rose-300 text-xs flex items-center space-x-1 transition" title="Hapus Grup">
            <i class="fa-solid fa-trash text-[10px]"></i>
            <span class="text-[10px]">Hapus</span>
          </button>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

async function editGroupPrompt(groupId, currentName) {
  const newName = prompt(`Ubah nama grup "${currentName}":`, currentName);
  if (!newName || !newName.trim() || newName.trim() === currentName) return;

  try {
    const res = await apiRequest(`/api/groups/${groupId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: newName.trim() })
    });

    if (res.success) {
      showToast(`Grup berhasil diubah menjadi "${newName.trim()}"!`, 'success');
      await fetchGroups();
      await fetchCameras();
      renderGroupsModalList();
    } else {
      alert(res.error || 'Gagal mengubah grup');
    }
  } catch (err) {
    alert(err.message);
  }
}

async function handleAddGroupSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('newGroupName').value.trim();
  try {
    const res = await apiRequest('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ name })
    });

    if (res.success) {
      document.getElementById('newGroupName').value = '';
      showToast('Grup baru berhasil ditambahkan!', 'success');
      await fetchGroups();
      await fetchCameras();
      renderGroupsModalList();
    } else {
      alert(res.error || 'Gagal menambahkan grup');
    }
  } catch (err) {
    alert(err.message);
  }
}

async function deleteGroup(groupId, groupName) {
  if (confirm(`Hapus grup "${groupName}"? Kamera di grup ini akan otomatis dialihkan ke "Semua Grup".`)) {
    try {
      const res = await apiRequest(`/api/groups/${groupId}`, { method: 'DELETE' });
      if (res.success) {
        showToast('Grup berhasil dihapus', 'success');
        if (state.selectedGroupId === String(groupId)) {
          state.selectedGroupId = '';
        }
        await fetchGroups();
        await fetchCameras();
        renderGroupsModalList();
      } else {
        alert(res.error || 'Gagal menghapus grup');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
}

// --- USERS MANAGEMENT (Admin Only) ---
async function fetchUsers() {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;

  try {
    const res = await apiRequest('/api/auth/users');
    if (res.success && res.users) {
      let html = '';
      res.users.forEach(u => {
        const isAdmin = u.role === 'admin';
        html += `
          <tr class="hover:bg-slate-900/40 transition">
            <td class="px-6 py-4">
              <div class="font-bold text-white">${u.name}</div>
              <div class="text-xs text-slate-400 font-mono">@${u.username}</div>
            </td>
            <td class="px-6 py-4">
              <span class="px-2 py-0.5 rounded text-xs font-semibold uppercase ${isAdmin ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-300'}">
                ${u.role}
              </span>
            </td>
            <td class="px-6 py-4 text-xs text-slate-300">
              ${u.allowed_groups === '*' ? 'Semua Grup (Akses Penuh)' : u.allowed_groups}
            </td>
            <td class="px-6 py-4 text-xs text-slate-400">
              ${new Date(u.created_at).toLocaleDateString('id-ID')}
            </td>
            <td class="px-6 py-4 text-right">
              ${u.id !== state.user.id ? `
                <button onclick="deleteUser(${u.id}, '${escapeQuotes(u.username)}')" class="text-slate-400 hover:text-rose-400 text-xs p-1" title="Hapus User">
                  <i class="fa-solid fa-trash"></i>
                </button>
              ` : '<span class="text-[11px] text-slate-500">Akun Anda</span>'}
            </td>
          </tr>
        `;
      });
      tbody.innerHTML = html;
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-rose-400">${err.message}</td></tr>`;
  }
}

function openAddUserModal() {
  document.getElementById('addUserModal').classList.remove('hidden');
}

async function handleAddUserSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('usrFullName').value.trim();
  const username = document.getElementById('usrUsername').value.trim();
  const password = document.getElementById('usrPassword').value.trim();
  const role = document.getElementById('usrRole').value;

  try {
    const res = await apiRequest('/api/auth/users', {
      method: 'POST',
      body: JSON.stringify({ name, username, password, role, allowed_groups: '*' })
    });

    if (res.success) {
      closeModal('addUserModal');
      document.getElementById('addUserForm').reset();
      showToast('Akun pengguna baru berhasil dibuat!', 'success');
      fetchUsers();
    } else {
      alert(res.error || 'Gagal membuat user');
    }
  } catch (err) {
    alert(err.message);
  }
}

async function deleteUser(userId, username) {
  if (confirm(`Hapus pengguna @${username}?`)) {
    try {
      await apiRequest(`/api/auth/users/${userId}`, { method: 'DELETE' });
      showToast('User berhasil dihapus', 'success');
      fetchUsers();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
}

// --- UTILITIES ---
function closeModal(modalId) {
  document.getElementById(modalId).classList.add('hidden');
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  let bg = 'bg-slate-900 border-cctv-border text-white';
  let icon = '<i class="fa-solid fa-circle-info text-blue-400"></i>';

  if (type === 'success') {
    bg = 'bg-emerald-950 border-emerald-800 text-emerald-100';
    icon = '<i class="fa-solid fa-circle-check text-emerald-400"></i>';
  } else if (type === 'error') {
    bg = 'bg-rose-950 border-rose-800 text-rose-100';
    icon = '<i class="fa-solid fa-circle-xmark text-rose-400"></i>';
  } else if (type === 'warning') {
    bg = 'bg-amber-950 border-amber-800 text-amber-100';
    icon = '<i class="fa-solid fa-triangle-exclamation text-amber-400"></i>';
  }

  toast.className = `fixed bottom-5 right-5 z-50 p-4 rounded-xl shadow-2xl text-sm border flex items-center space-x-3 transition-all duration-300 ${bg}`;
  toast.innerHTML = `${icon} <span>${message}</span>`;
  toast.classList.remove('hidden');

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Tautan RTSP berhasil disalin ke clipboard!', 'success');
  }).catch(() => {
    prompt('Salin link RTSP ini:', text);
  });
}

function escapeQuotes(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
