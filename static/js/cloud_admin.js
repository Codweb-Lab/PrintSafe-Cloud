// ========================================================================
// ☁️ PRINTSAFE CLOUD — CLOUD MANAGER, SYNC, NOTIFICATIONS & 2FA (cloud_admin.js)
// ========================================================================
let activeSessionsCount = 0;
let dashboardHtml5QrCode = null;
let cloudNavigationStack = [];
let activeBrowseAccount = null;
let accountFormState = { mode: "add", provider: "google", accountId: "" };
let pendingDeleteAccountId = null;
let editingRemoteStorageId = null;

function setSidebarCloudLoadingState(isLoading) {
  ["google", "onedrive"].forEach((provider) => {
    const countEl = document.getElementById(`sidebar-${provider}-count`);
    const drawerEl = document.getElementById(`sidebar-accounts-${provider}`);
    const groupEl = countEl?.closest(".sidebar-provider-group") || countEl?.closest(".rail-btn");

    if (countEl && isLoading) {
      countEl.innerHTML = `<span class="vault-spinner small" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle;"></span>`;
    }

    if (groupEl) {
      groupEl.style.pointerEvents = isLoading ? "none" : "auto";
      groupEl.style.opacity = isLoading ? "0.55" : "1";
    }
    if (drawerEl) {
      drawerEl.style.pointerEvents = isLoading ? "none" : "auto";
      drawerEl.style.opacity = isLoading ? "0.55" : "1";
    }
  });
}

// ========================================================================
// 🚀 DASHBOARD BOOTSTRAP & USER HEADER HYDRATION (INSTANT <200ms BOOT)
// ========================================================================
async function bootAuthenticatedDashboard() {
  try {
    const sessRes = await fetch("/api/check-session?t=" + Date.now());
    if (!sessRes.ok) {
      window.location.replace("/");
      return;
    }
    const sess = await sessRes.json();
    if (!sess.authenticated) {
      window.location.replace("/");
      return;
    }

    if (typeof sess.latest_event_id === "number") lastSeenSyncEventId = sess.latest_event_id;
    if (sess.restrictions) activeRestrictions = sess.restrictions;
    applyFeatureFlagsToUserUI(sess.features || {});

    const displayName = (sess.user_name || sess.user_email || "User").trim();
    const displayEmail = (sess.user_email || "user@printsafe.cloud").trim();
    if (document.getElementById("dropdown-user-name")) document.getElementById("dropdown-user-name").innerText = displayName;
    if (document.getElementById("dropdown-user-email")) document.getElementById("dropdown-user-email").innerText = displayEmail;
    if (document.getElementById("header-user-avatar")) document.getElementById("header-user-avatar").innerText = displayName.charAt(0).toUpperCase();

    // 1. Instant Dashboard Unlock + Lock Sidebar Drives
    const authBox = document.getElementById("auth-container");
    const dashBox = document.getElementById("file-manager-dashboard");
    if (authBox) authBox.style.display = "none";
    if (dashBox) dashBox.style.display = "flex";
    setSidebarCloudLoadingState(true);

    applyLiveRestrictionsUI();
    initializeMobileScannerFeatures();
    startBackgroundSyncAndRestrictionMonitor();

    // 2. Full-Area Vault Loading Spinner Inside #main-explorer-grid
    const gridEl = document.getElementById("main-explorer-grid");
    if (gridEl) {
      gridEl.style.display = "flex";
      gridEl.style.flex = "1";
      gridEl.style.alignItems = "center";
      gridEl.style.justifyContent = "center";
      gridEl.innerHTML = `
        <div class="stream-loader" style="max-width:380px;text-align:center;justify-content:center;">
          <div class="vault-spinner" style="width:34px;height:34px;"></div>
          <div style="font-size:14.5px;font-weight:700;color:var(--text-title);">Loading Your Secure Cloud &amp; Hosting Vault...</div>
          <div style="font-size:12px;color:var(--text-sub);text-align:center;">Fetching mounted folders from Google Drive, OneDrive, and remote SFTP/FTP storages.</div>
        </div>`;
    }

    // 3. Parallel Background Sync & Render Vault
    Promise.allSettled([
      loadPrintQueue(),
      loadConnectedCloudAccounts().finally(() => setSidebarCloudLoadingState(false)),
      refreshConnectedSessionsCount(),
      fetch("/fetch-vault-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: currentSessionId })
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          globalVaultTree = (data && data.tree) ? data.tree : [];
          setExplorerViewMode(currentViewMode);
        })
    ]);
  } catch (err) {
    setSidebarCloudLoadingState(false);
    console.error("[DASHBOARD BOOT ERROR]:", err);
  }
}

// ========================================================================
// 🎛️ DYNAMIC FEATURE FLAG & QR RESTRICTION UI ENFORCERS
// ========================================================================
function applyFeatureFlagsToUserUI(features) {
  if (!features) return;
  const sftpBtn = document.querySelector("[onclick*='openRemoteStorageModal']");
  if (sftpBtn) sftpBtn.style.display = features.hosting_sftp_ftp === false ? "none" : "";

  const printNav = document.querySelector("[onclick*='openPrintQueueView']");
  const printPill = document.getElementById("pill-print-queue");
  if (printNav) printNav.style.display = features.print_wishlist_queue === false ? "none" : "";
  if (printPill) printPill.style.display = features.print_wishlist_queue === false ? "none" : "";
}

function applyLiveRestrictionsUI() {
  const isRestricted = sessionLoginType === "qr_restricted" || activeRestrictions.is_restricted;
  const disableProf = isRestricted && activeRestrictions.disable_profile;

  const badge = document.getElementById("restricted-mode-indicator");
  if (badge) badge.style.display = isRestricted ? "inline-flex" : "none";

  const uploadFab = document.getElementById("floating-upload-fab");
  if (uploadFab) uploadFab.style.display = isRestricted ? "none" : "flex";

  document.querySelectorAll(".master-only-nav").forEach((btn) => {
    btn.style.display = isRestricted ? "none" : "";
  });

  const avatar = document.querySelector(".profile-avatar-pill");
  if (avatar) {
    avatar.style.opacity = disableProf ? "0.45" : "1";
    avatar.style.cursor = disableProf ? "not-allowed" : "pointer";
  }
  if (disableProf) {
    const dropdown = document.getElementById("profile-menu-dropdown");
    if (dropdown) dropdown.style.display = "none";
  }
}

// ========================================================================
// 🖥️ CONNECTED DESKTOP SESSIONS & LIVE SYNC MONITOR
// ========================================================================
async function refreshConnectedSessionsCount() {
  try {
    const res = await fetch("/api/connected-sessions");
    if (!res.ok) return [];
    const data = await res.json();
    activeSessionsCount = data.count || 0;

    const headerBadge = document.getElementById("header-connected-count");
    const mobileDiscFab = document.getElementById("mobile-floating-disconnect-btn");
    if (headerBadge) headerBadge.innerText = activeSessionsCount;
    if (mobileDiscFab) {
      const isMobile = window.innerWidth <= 768 || /Mobi|Android|iPhone/i.test(navigator.userAgent);
      mobileDiscFab.style.display = isMobile && activeSessionsCount > 0 ? "flex" : "none";
    }
    return data.sessions || [];
  } catch (e) {
    return [];
  }
}

async function openConnectedDevicesModal(show) {
  const modal = document.getElementById("connected-devices-modal");
  if (!modal) return;
  modal.style.display = show ? "flex" : "none";
  const dropdown = document.getElementById("profile-menu-dropdown");
  if (dropdown) dropdown.style.display = "none";
  if (!show) return;

  const listEl = document.getElementById("connected-devices-list");
  listEl.innerHTML = `<div style="text-align:center;padding:20px;"><div class="vault-spinner" style="margin:0 auto;"></div></div>`;
  const sessions = await refreshConnectedSessionsCount();

  if (sessions.length === 0) {
    listEl.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-sub);font-size:13px;"><i class="ri-computer-line" style="font-size:36px;display:block;margin-bottom:8px;opacity:0.5;"></i>No active QR desktop sessions connected right now.</div>`;
    return;
  }

  listEl.innerHTML = sessions
    .map(
      (s) => `
    <div class="provider-section-card" style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:36px;height:36px;border-radius:var(--radius-btn);background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;">
            <i class="ri-computer-line"></i>
          </div>
          <div>
            <div style="font-weight:700;font-size:13.5px;">${s.device_info} <span style="font-size:10px;background:rgba(34,197,94,0.15);color:#16a34a;padding:2px 7px;border-radius:8px;">Live QR Session</span></div>
            <div style="font-size:11px;color:var(--text-sub);">ID: ${s.session_id.substring(0, 12)}...</div>
          </div>
        </div>
        <button onclick="killSpecificDesktopSession('${s.session_id}')" class="btn-acc-action danger">
          <i class="ri-shut-down-line"></i> Logout Device
        </button>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:10px;display:flex;flex-direction:column;gap:8px;font-size:12.5px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span><i class="ri-eye-off-line" style="color:var(--accent);"></i> Mask Folder Names as <b>"xxxxx"</b></span>
          <label class="switch-toggle">
            <input type="checkbox" ${s.mask_folders ? "checked" : ""} onchange="toggleRemoteSessionRule('${s.session_id}', 'mask_folders', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span><i class="ri-user-forbid-line" style="color:var(--accent);"></i> Disable Profile & Cloud Menu</span>
          <label class="switch-toggle">
            <input type="checkbox" ${s.disable_profile ? "checked" : ""} onchange="toggleRemoteSessionRule('${s.session_id}', 'disable_profile', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span><i class="ri-printer-line" style="color:var(--accent);"></i> Allow Vector Printing</span>
          <label class="switch-toggle">
            <input type="checkbox" ${s.allow_print ? "checked" : ""} onchange="toggleRemoteSessionRule('${s.session_id}', 'allow_print', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
      </div>
    </div>`
    )
    .join("");
}

async function toggleRemoteSessionRule(sessionId, field, value) {
  try {
    await fetch("/api/session-restrictions/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, field, value })
    });
    showToast("Live restriction applied on desktop!", "info");
  } catch (e) {}
}

function killSpecificDesktopSession(sessionId) {
  openSessionConfirmModal(
    "Disconnect Desktop?",
    "Are you sure you want to remotely logout this paired desktop session?",
    "Logout Device",
    async () => {
      try {
        await fetch("/terminate-desktop-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId })
        });
        showToast("Remote desktop device logged out!", "success");
        await openConnectedDevicesModal(true);
      } catch (e) {}
    }
  );
}

function disconnectAllConnectedDesktops() {
  openSessionConfirmModal(
    "Logout All Desktops?",
    "This will immediately terminate all connected QR desktop sessions.",
    "Disconnect All",
    async () => {
      try {
        await fetch("/terminate-desktop-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: "all" })
        });
        showToast("All connected desktop devices have been logged out!", "success");
        await refreshConnectedSessionsCount();
        openConnectedDevicesModal(false);
      } catch (e) {}
    }
  );
}

function startBackgroundSyncAndRestrictionMonitor() {
  if (backgroundSyncInterval) clearInterval(backgroundSyncInterval);
  backgroundSyncInterval = setInterval(async () => {
    try {
      if (sessionLoginType === "qr_restricted" && currentSessionId) {
        const res = await fetch("/verify-private-scan/" + currentSessionId + "?t=" + Date.now());
        if (!res.ok) {
          sessionStorage.removeItem("active_vault_token");
          window.location.replace("/");
          return;
        }
        const data = await res.json();
        if (!data.success || data.status === "terminated") {
          sessionStorage.removeItem("active_vault_token");
          fetch("/api/logout", { method: "POST" }).then(() => window.location.replace("/"));
          return;
        }
        if (data.restrictions) {
          const prevMask = activeRestrictions.mask_folders;
          const prevProf = activeRestrictions.disable_profile;
          activeRestrictions = data.restrictions;
          applyLiveRestrictionsUI();
          if (prevMask !== activeRestrictions.mask_folders || prevProf !== activeRestrictions.disable_profile) {
            renderCurrentFolderLevel();
          }
        }
        if (data.latest_event && data.latest_event.event_id) {
          handleIncomingSyncEvent(data.latest_event);
        }
      } else {
        const res = await fetch("/api/poll-events?t=" + Date.now());
        if (res.status === 403) {
          window.location.replace("/");
          return;
        }
        if (res.ok) {
          const data = await res.json();
          const badge = document.getElementById("header-connected-count");
          if (badge) badge.innerText = data.connected_count || 0;

          const notifBadge = document.getElementById("header-notif-badge");
          if (notifBadge) {
            const unread = data.unread_notifications || 0;
            notifBadge.innerText = unread;
            notifBadge.style.display = unread > 0 ? "inline-block" : "none";
          }

          if (data.features) applyFeatureFlagsToUserUI(data.features);

          if (data.latest_event && data.latest_event.event_id) {
            handleIncomingSyncEvent(data.latest_event);
          }
        }
      }
    } catch (e) {}
  }, 2500);
}

async function handleIncomingSyncEvent(ev) {
  if (lastSeenSyncEventId === null) {
    lastSeenSyncEventId = ev.event_id;
    return;
  }
  if (ev.event_id > lastSeenSyncEventId) {
    lastSeenSyncEventId = ev.event_id;
    await loadPrintQueue();
    const vaultResponse = await fetch("/fetch-vault-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: currentSessionId })
    });
    if (vaultResponse.ok) {
      const vData = await vaultResponse.json();
      globalVaultTree = vData.tree || [];
      renderCurrentFolderLevel();
    }
    showToast(`📲 Instant Sync: "${ev.filename}" (${ev.folder_path})`, "success");
  }
}

// ========================================================================
// 🔔 NOTIFICATION CENTER & USER PROFILE SETTINGS
// ========================================================================
async function openNotificationCenterModal() {
  const modal = document.getElementById("notification-center-modal");
  const list = document.getElementById("notifications-list-container");
  if (!modal || !list) return;
  modal.style.display = "flex";
  try {
    const res = await fetch("/api/notifications");
    if (res.ok) {
      const data = await res.json();
      list.innerHTML = data.notifications.length
        ? data.notifications
            .map(
              (n) => `
          <div class="provider-section-card" style="padding:12px;">
            <div style="font-weight:700;font-size:13px;color:var(--accent);">${n.title}</div>
            <div style="font-size:12px;color:var(--text-sub);margin-top:4px;">${n.message}</div>
          </div>`
            )
            .join("")
        : `<div style="text-align:center;color:var(--text-sub);padding:20px;font-size:13px;">No notifications yet.</div>`;

      await fetch("/api/notifications", { method: "POST" });
      const badge = document.getElementById("header-notif-badge");
      if (badge) badge.style.display = "none";
    }
  } catch (e) {}
}

async function openUserProfileModal() {
  const modal = document.getElementById("user-profile-modal");
  const dropdown = document.getElementById("profile-menu-dropdown");
  if (dropdown) dropdown.style.display = "none";
  if (!modal) return;
  modal.style.display = "flex";
  try {
    const res = await fetch("/api/user/profile");
    if (res.ok) {
      const data = await res.json();
      const p = data.profile || {};
      document.getElementById("prof-email-readonly").value = p.email || "";
      document.getElementById("prof-full-name").value = p.full_name || "";
      document.getElementById("prof-phone").value = p.phone || "";
      document.getElementById("prof-bio").value = p.bio || "";
    }
  } catch (e) {}
}

async function saveUserProfileDetails() {
  const payload = {
    full_name: (document.getElementById("prof-full-name")?.value || "").trim(),
    phone: (document.getElementById("prof-phone")?.value || "").trim(),
    bio: (document.getElementById("prof-bio")?.value || "").trim()
  };
  try {
    const res = await fetch("/api/user/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, "success");
      document.getElementById("user-profile-modal").style.display = "none";
      const newName = payload.full_name || "User";
      const nameEl = document.getElementById("dropdown-user-name");
      const avatarEl = document.getElementById("header-user-avatar");
      if (nameEl) nameEl.innerText = newName;
      if (avatarEl) avatarEl.innerText = newName.charAt(0).toUpperCase();
    }
  } catch (e) {
    showToast("Failed to update profile", "error");
  }
}

// ========================================================================
// 📱 MOBILE CAMERA QR SCANNER
// ========================================================================
function initializeMobileScannerFeatures() {
  const floatingQrBtn = document.getElementById("mobile-floating-qr-btn");
  const isMobileLayout = window.innerWidth <= 768 || /Mobi|Android|iPhone/i.test(navigator.userAgent);
  if (floatingQrBtn) floatingQrBtn.style.display = isMobileLayout ? "flex" : "none";
  refreshConnectedSessionsCount();
}

window.addEventListener("resize", initializeMobileScannerFeatures);

function openMobileScannerFromDashboard() {
  const modal = document.getElementById("mobile-dashboard-scanner-modal");
  if (!modal) return;
  modal.style.display = "flex";
  const statusEl = document.getElementById("mobile-dashboard-scanned-status");
  if (statusEl) statusEl.innerText = "Point camera at Desktop QR Code...";

  dashboardHtml5QrCode = new Html5Qrcode("mobile-dashboard-reader");
  dashboardHtml5QrCode
    .start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 230, height: 230 } },
      async (decodedText) => {
        if (statusEl) statusEl.innerText = "Authorizing Desktop in Restricted Mode...";
        await dashboardHtml5QrCode.stop();
        try {
          const res = await fetch("/verify-private-scan/" + decodedText, { method: "POST" });
          if (res.ok) {
            showToast("Desktop logged in (Restricted Read/Print Mode)!", "success");
            await refreshConnectedSessionsCount();
            modal.style.display = "none";
            openConnectedDevicesModal(true);
          } else {
            showToast("Expired or invalid QR code", "error");
            modal.style.display = "none";
          }
        } catch (e) {
          showToast("Network error", "error");
          modal.style.display = "none";
        }
      }
    )
    .catch(() => {
      if (statusEl) statusEl.innerText = "Camera permission denied!";
    });
}

function closeMobileScannerFromDashboard() {
  const modal = document.getElementById("mobile-dashboard-scanner-modal");
  if (dashboardHtml5QrCode && dashboardHtml5QrCode.isScanning) {
    dashboardHtml5QrCode.stop().then(() => {
      if (modal) modal.style.display = "none";
    });
  } else if (modal) {
    modal.style.display = "none";
  }
}

// ========================================================================
// ☁️ MULTI-ACCOUNT CLOUD DRIVE MANAGER (GOOGLE DRIVE & ONEDRIVE)
// ========================================================================
async function loadConnectedCloudAccounts() {
  try {
    const res = await fetch("/api/cloud/accounts");
    if (!res.ok) return;
    const data = await res.json();
    connectedAccountsList = data.accounts || [];
    updateCloudSummaryBadges();
    renderMultiCloudManagerUI();
  } catch (e) {}
}

function toggleSidebarProviderDrawer(provider) {
  const listEl = document.getElementById(`sidebar-accounts-${provider}`);
  const arrowEl = document.getElementById(`sidebar-arrow-${provider}`);
  if (!listEl) return;
  const isExpanded = listEl.classList.toggle("expanded");
  if (arrowEl) arrowEl.className = isExpanded ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line";
}

function updateCloudSummaryBadges() {
  const gAccounts = connectedAccountsList.filter((a) => a.provider === "google");
  const oAccounts = connectedAccountsList.filter((a) => a.provider === "onedrive");
  const gCountEl = document.getElementById("sidebar-google-count");
  const oCountEl = document.getElementById("sidebar-onedrive-count");
  if (gCountEl) gCountEl.innerText = gAccounts.length;
  if (oCountEl) oCountEl.innerText = oAccounts.length;
  renderSidebarProviderTree("google", gAccounts);
  renderSidebarProviderTree("onedrive", oAccounts);
}

// ========================================================================
// 🗂️ SIDEBAR CLOUD-WISE ACCOUNTS & ACCOUNT FILTERING
// ========================================================================
function renderSidebarProviderTree(provider, accounts) {
  const container = document.getElementById(`sidebar-accounts-${provider}`);
  if (!container) return;

  if (accounts.length === 0) {
    container.innerHTML = `<div class="nested-acc-item" onclick="openCloudAccountFormModal('add', '${provider}')"><span><i class="ri-add-circle-line"></i> Connect Account</span></div>`;
    return;
  }

  container.innerHTML =
    accounts
      .map((acc) => {
        const statusClass = acc.is_expired ? "expired" : acc.is_enabled ? "online" : "disabled";
        const label = acc.custom_name || acc.email;
        const safeLabel = label.replace(/'/g, "\\'");
        const isActiveFilter = window.activeAccountFilterId === acc.account_id;

        return `
      <div class="nested-acc-item ${isActiveFilter ? "active" : ""}" style="${isActiveFilter ? "background:var(--accent-soft);color:var(--accent);font-weight:700;" : ""}">
        <div onclick="filterVaultByAccount('${provider}', '${acc.account_id}', this); toggleMobileSidebar(false);" style="display:flex;align-items:center;gap:8px;overflow:hidden;flex:1;cursor:pointer;" title="Show mounted files from ${label}">
          <span class="nested-acc-dot ${statusClass}"></span>
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</span>
        </div>
        <button onclick="${acc.is_expired ? `startDirectOAuthReconnect('${provider}', '${safeLabel}')` : `openAccountPickerModal('${acc.account_id}', '${safeLabel}', '${provider}')`}" style="background:none;border:none;color:var(--accent);cursor:pointer;padding:2px 4px;" title="${acc.is_expired ? "Reconnect Drive" : "Browse & Mount Folders"}">
          <i class="${acc.is_expired ? "ri-plug-line" : "ri-folder-add-line"}" style="font-size:14px;"></i>
        </button>
      </div>`;
      })
      .join("") +
    `<div class="nested-acc-item" onclick="openCloudAccountFormModal('add', '${provider}')" style="color:var(--accent);margin-top:2px;cursor:pointer;"><span><i class="ri-add-line"></i> Add Another</span></div>`;
}

function openCloudDriveManager(show) {
  if (sessionLoginType === "qr_restricted") {
    showToast("Cloud Manager is locked in Restricted QR Mode", "error");
    return;
  }
  const modal = document.getElementById("cloud-sync-modal");
  if (modal) modal.style.display = show ? "flex" : "none";
  const dropdown = document.getElementById("profile-menu-dropdown");
  if (dropdown) dropdown.style.display = "none";
  if (show) loadConnectedCloudAccounts();
}

function renderMultiCloudManagerUI() {
  const container = document.getElementById("cloud-providers-list");
  if (!container) return;
  const providers = [
    { id: "google", name: "Google Drive", icon: "ri-google-fill", color: "#ea4335" },
    { id: "onedrive", name: "Microsoft OneDrive", icon: "ri-microsoft-fill", color: "#0078d4" }
  ];

  container.innerHTML = providers
    .map((p) => {
      const pAccounts = connectedAccountsList.filter((a) => a.provider === p.id);
      const accountsHtml =
        pAccounts.length === 0
          ? `<div style="font-size:12px;color:var(--text-sub);padding:8px 4px;">No accounts linked yet.</div>`
          : pAccounts
              .map((acc) => {
                const label = acc.custom_name || acc.email;
                const safeLabel = label.replace(/'/g, "\\'");
                return `
        <div class="cloud-acc-row">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
            <label class="switch-toggle"><input type="checkbox" ${acc.is_enabled ? "checked" : ""} onchange="toggleCloudAccountState('${acc.account_id}', this.checked)"><span class="slider"></span></label>
            <div style="overflow:hidden;">
              <div style="font-weight:700;font-size:13px;">${label}</div>
              <div style="font-size:11px;color:var(--text-sub);">${acc.email}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button onclick="openAccountPickerModal('${acc.account_id}', '${safeLabel}', '${acc.provider}')" class="btn-acc-action primary"><i class="ri-folder-open-line"></i> Browse</button>
            <button onclick="openDeleteAccountConfirmModal('${acc.account_id}', '${safeLabel}')" class="btn-acc-action danger"><i class="ri-delete-bin-line"></i></button>
          </div>
        </div>`;
              })
              .join("");

      return `
      <div class="provider-section-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="font-weight:800;font-size:14.5px;color:${p.color};"><i class="${p.icon}"></i> ${p.name}</div>
          <button onclick="openCloudAccountFormModal('add', '${p.id}')" class="btn-add-account"><i class="ri-add-line"></i> Add Account</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">${accountsHtml}</div>
      </div>`;
    })
    .join("");
}

// ========================================================================
// ☁️ CLOUD ACCOUNT OAUTH & LOADING STATUS
// ========================================================================
function openCloudAccountFormModal(mode, provider) {
  const name = prompt(`Enter a custom display name for this ${provider.toUpperCase()} account (Optional):`, "");
  if (name === null) return;

  showToast(`Connecting to ${provider.toUpperCase()}... Please authorize in the popup window.`, "info");

  fetch(`/api/cloud/oauth-url/${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ custom_name: name })
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.auth_url) {
        const width = 500, height = 650;
        const left = window.screenX + (window.innerWidth - width) / 2;
        const top = window.screenY + (window.innerHeight - height) / 2;
        const authWindow = window.open(data.auth_url, "CloudOAuth", `width=${width},height=${height},left=${left},top=${top}`);

        const pollTimer = setInterval(async () => {
          if (!authWindow || authWindow.closed) {
            clearInterval(pollTimer);
            showToast("Verifying and syncing cloud accounts...", "info");
            await loadConnectedCloudAccounts();
            await bootAuthenticatedDashboard();
            showToast("Cloud account connected & synced successfully!", "success");
          }
        }, 1000);
      } else {
        showToast(data.error || "Could not generate auth URL", "error");
      }
    })
    .catch(() => showToast("Network error initiating cloud connection", "error"));
}

function closeCloudAccountFormModal() {
  const modal = document.getElementById("cloud-account-form-modal");
  if (modal) modal.style.display = "none";
}

async function submitCloudAccountForm() {
  const customName = (document.getElementById("cloud-account-custom-name-input")?.value || "").trim();
  closeCloudAccountFormModal();
  if (accountFormState.mode === "add") {
    await startDirectOAuthReconnect(accountFormState.provider, customName);
  }
}

async function startDirectOAuthReconnect(provider, customName = "") {
  try {
    const res = await fetch(`/api/cloud/oauth-url/${provider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_name: customName })
    });
    const data = await res.json();
    if (data.auth_url) window.open(data.auth_url, "oauth-win", "width=600,height=680");
  } catch (e) {
    showToast("Could not initiate OAuth", "error");
  }
}

function openDeleteAccountConfirmModal(accountId, label) {
  pendingDeleteAccountId = accountId;
  const modal = document.getElementById("confirm-action-modal");
  const textEl = document.getElementById("confirm-action-message");
  if (textEl) textEl.innerText = `Remove cloud account "${label}" from your vault?`;
  if (modal) modal.style.display = "flex";
}

function closeDeleteAccountConfirmModal() {
  pendingDeleteAccountId = null;
  const modal = document.getElementById("confirm-action-modal");
  if (modal) modal.style.display = "none";
}

async function confirmDeleteCloudAccountExecution() {
  if (!pendingDeleteAccountId) return;
  const accId = pendingDeleteAccountId;
  closeDeleteAccountConfirmModal();
  try {
    await fetch("/api/cloud/account/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: accId, action: "delete" })
    });
    showToast("Cloud account removed", "info");
    await loadConnectedCloudAccounts();
    await bootAuthenticatedDashboard();
  } catch (e) {}
}

async function toggleCloudAccountState(accountId, isEnabled) {
  try {
    await fetch("/api/cloud/account/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: accountId, action: "toggle", is_enabled: isEnabled })
    });
    await loadConnectedCloudAccounts();
    await bootAuthenticatedDashboard();
  } catch (e) {}
}

// ========================================================================
// 📂 INTERACTIVE CLOUD DRIVE EXPLORER PICKER & LOADING STATUS
// ========================================================================
function openAccountPickerModal(accountId, accountName, provider) {
  openCloudDriveManager(false);
  activeBrowseAccount = { accountId, accountName, provider };
  cloudNavigationStack = [{ id: "root", name: accountName }];
  
  const titleEl = document.getElementById("cloud-picker-title");
  if (titleEl) {
    titleEl.innerHTML = `<i class="${provider === "google" ? "ri-google-fill" : "ri-microsoft-fill"}" style="color:var(--accent);"></i> ${accountName} Explorer`;
  }
  document.getElementById("cloud-picker-modal").style.display = "flex";
  fetchCloudPickerItems("root");
}

function closeCloudPickerModal() {
  document.getElementById("cloud-picker-modal").style.display = "none";
  activeBrowseAccount = null;
  cloudNavigationStack = [];
}

function renderCloudPickerBreadcrumbs() {
  const bcEl = document.getElementById("cloud-picker-breadcrumbs");
  const backBtn = document.getElementById("cloud-picker-back-btn");
  if (!bcEl) return;

  bcEl.innerHTML = cloudNavigationStack
    .map(
      (step, idx) =>
        `<span onclick="jumpToCloudPickerBreadcrumb(${idx})" style="cursor:pointer; color:${idx === cloudNavigationStack.length - 1 ? "var(--accent)" : "var(--text-sub)"};">${step.name}</span>`
    )
    .join(` <i class="ri-arrow-right-s-line" style="color:var(--text-sub);"></i> `);

  if (backBtn) {
    backBtn.style.display = cloudNavigationStack.length > 1 ? "inline-flex" : "none";
  }
}

function jumpToCloudPickerBreadcrumb(idx) {
  if (idx < 0 || idx >= cloudNavigationStack.length) return;
  cloudNavigationStack = cloudNavigationStack.slice(0, idx + 1);
  const target = cloudNavigationStack[cloudNavigationStack.length - 1];
  fetchCloudPickerItems(target.id);
}

function navigateCloudPickerBack() {
  if (cloudNavigationStack.length > 1) {
    cloudNavigationStack.pop();
    const prev = cloudNavigationStack[cloudNavigationStack.length - 1];
    fetchCloudPickerItems(prev.id);
  }
}

function enterCloudPickerFolder(folderId, folderName) {
  cloudNavigationStack.push({ id: folderId, name: folderName });
  fetchCloudPickerItems(folderId);
}

async function fetchCloudPickerItems(folderId = "root") {
  if (!activeBrowseAccount) return;
  renderCloudPickerBreadcrumbs();

  const listContainer = document.getElementById("cloud-picker-list");
  if (!listContainer) return;
  
  listContainer.innerHTML = `
    <div style="text-align:center; padding:50px 20px;">
      <div class="vault-spinner" style="margin:0 auto 12px auto;"></div>
      <div style="font-size:13px; font-weight:600; color:var(--text-sub);">Loading cloud directory items...</div>
    </div>`;

  try {
    const response = await fetch(`/api/cloud/fetch/${activeBrowseAccount.accountId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId })
    });
    const data = await response.json();
    if (data.authenticated && data.tree) {
      listContainer.innerHTML = data.tree.length
        ? data.tree
            .map((item) => {
              const safeName = item.name.replace(/'/g, "\\'");
              const isFolder = item.type === "folder";
              const isMounted = Boolean(item.is_mounted);
              const iconClass = isFolder
                ? "ri-folder-3-fill"
                : item.file_type === "pdf"
                ? "ri-file-pdf-2-fill"
                : "ri-image-2-fill";
              const iconColor = isFolder ? "#f59e0b" : "var(--accent)";

              return `
              <div style="display:flex; align-items:center; justify-content:space-between; padding:11px 16px; border-bottom:1px solid var(--border); gap:10px; transition:0.15s;">
                <div ${isFolder ? `onclick="enterCloudPickerFolder('${item.cloud_id}', '${safeName}')"` : ""} style="display:flex; align-items:center; gap:12px; overflow:hidden; flex:1; ${isFolder ? "cursor:pointer;" : ""}" title="${isFolder ? "Click to open folder" : item.name}">
                  <i class="${iconClass}" style="color:${iconColor}; font-size:20px; flex-shrink:0;"></i>
                  <div style="overflow:hidden;">
                    <div style="font-size:13.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:6px;">
                      <span>${item.name}</span>
                      ${isFolder ? `<i class="ri-arrow-right-s-line" style="color:var(--text-sub); font-size:14px;"></i>` : ""}
                    </div>
                    <div style="font-size:10.5px; color:var(--text-sub);">${isFolder ? "Click folder name to browse inside" : formatFileSize(item.size)}</div>
                  </div>
                  ${isMounted ? `<span class="version-pill" style="background:var(--accent-soft); color:var(--accent); border-color:var(--accent);">Mounted</span>` : ""}
                </div>
                <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                  ${
                    isMounted
                      ? `<button onclick="triggerCloudAssetUnmount('${safeName}', '${item.cloud_id}')" class="btn-acc-action danger"><i class="ri-link-unlink-m"></i> Unmount</button>`
                      : `<button onclick="triggerCloudAssetImport('${safeName}', '${item.cloud_id}', '${item.type}')" class="btn-acc-action primary"><i class="ri-add-circle-line"></i> Mount</button>`
                  }
                </div>
              </div>`;
            })
            .join("")
        : `<div style="text-align:center; color:var(--text-sub); padding:40px; font-size:13px;"><i class="ri-folder-open-line" style="font-size:32px; display:block; margin-bottom:6px; opacity:0.5;"></i>This cloud folder is empty.</div>`;
    }
  } catch (e) {
    listContainer.innerHTML = `<div style="text-align:center; color:#ef4444; padding:30px; font-size:13px;">Failed to load cloud items.</div>`;
  }
}

async function triggerCloudAssetImport(name, cloudId, type) {
  if (!activeBrowseAccount) return;
  const currentFolder = cloudNavigationStack[cloudNavigationStack.length - 1]?.id || "root";
  
  showToast(`Mounting "${name}"... Please wait.`, "info");
  
  try {
    const response = await fetch("/api/cloud/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        cloud_id: cloudId,
        type: type || "file",
        account_id: activeBrowseAccount.accountId,
        provider: activeBrowseAccount.provider,
        account_name: activeBrowseAccount.accountName
      })
    });
    const result = await response.json();
    if (result.success) {
      showToast(`"${name}" successfully mounted!`, "success");
      await fetchCloudPickerItems(currentFolder);
      await bootAuthenticatedDashboard();
    } else {
      showToast(result.error || "Failed to mount folder", "error");
    }
  } catch (e) {
    showToast("Network error while mounting", "error");
  }
}

async function triggerCloudAssetUnmount(name, cloudId) {
  const currentFolder = cloudNavigationStack[cloudNavigationStack.length - 1]?.id || "root";
  openSessionConfirmModal(
    "Unmount Cloud Folder?",
    `Are you sure you want to unmount "${name}" from your PrintSafe Vault? (Files remain safe on your Cloud Drive).`,
    "Yes, Unmount",
    async () => {
      showToast(`Unmounting "${name}"...`, "info");
      try {
        const response = await fetch("/api/cloud/unmount", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, cloud_id: cloudId })
        });
        const result = await response.json();
        if (result.success) {
          showToast(result.message || `"${name}" unmounted!`, "info");
          await fetchCloudPickerItems(currentFolder);
          await bootAuthenticatedDashboard();
        }
      } catch (e) {
        showToast("Network error while unmounting", "error");
      }
    }
  );
}

// ========================================================================
// 🛡️ 2FA AUTHENTICATOR APP & QUICK PIN SETTINGS JS
// ========================================================================
const _origTogglePasswordModal = togglePasswordModal;
togglePasswordModal = async function (show) {
  _origTogglePasswordModal(show);
  if (!show) return;
  try {
    const res = await fetch("/api/user/security/2fa/status");
    if (!res.ok) return;
    const data = await res.json();
    const badge = document.getElementById("totp-status-badge");
    const btnStart = document.getElementById("btn-start-2fa");
    const btnDisable = document.getElementById("btn-disable-2fa");
    if (badge) badge.innerText = data.totp_enabled ? "ENABLED" : "DISABLED";
    if (btnStart) btnStart.style.display = data.totp_enabled ? "none" : "inline-flex";
    if (btnDisable) btnDisable.style.display = data.totp_enabled ? "inline-flex" : "none";
  } catch (e) {}
};

async function start2FASetup() {
  try {
    const res = await fetch("/api/user/security/2fa/setup", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      document.getElementById("totp-qr-img").src = data.qr_image;
      document.getElementById("totp-secret-code").innerText = data.secret;
      document.getElementById("totp-setup-area").style.display = "block";
    }
  } catch (e) {}
}

async function confirmEnable2FA() {
  const code = (document.getElementById("totp-verify-input")?.value || "").trim();
  try {
    const res = await fetch("/api/user/security/2fa/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, "success");
      document.getElementById("totp-setup-area").style.display = "none";
      togglePasswordModal(true);
    } else {
      showToast(data.error || "Invalid 2FA code", "error");
    }
  } catch (e) {}
}

async function disable2FA() {
  try {
    await fetch("/api/user/security/2fa/disable", { method: "POST" });
    showToast("2FA disabled", "info");
    togglePasswordModal(true);
  } catch (e) {}
}

async function saveUserQuickPin() {
  const pin = (document.getElementById("user-new-pin-input")?.value || "").trim();
  try {
    const res = await fetch("/api/user/security/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();
    showToast(data.message || data.error, data.success ? "success" : "error");
  } catch (e) {}
}

// ========================================================================
// 🌐 HOSTING STORAGE (SSH/SFTP & FTP) — ADD, EDIT & REMOVE
// ========================================================================
async function openRemoteStorageModal() {
  editingRemoteStorageId = null;
  const modal = document.getElementById("remote-storage-modal");
  if (!modal) return;
  modal.style.display = "flex";
  await loadConnectedRemoteStorages();
}

async function loadConnectedRemoteStorages() {
  const box = document.getElementById("connected-remote-storages-list");
  if (!box) return;
  try {
    const res = await fetch("/api/remote-storage");
    if (!res.ok) return;
    const data = await res.json();
    const list = data.storages || [];
    box.innerHTML = list.length
      ? list
          .map(
            (s) => `
        <div class="cloud-acc-row">
          <div>
            <div style="font-weight:700;font-size:13px;">${s.label} <span class="version-pill">${s.protocol.toUpperCase()}</span></div>
            <div style="font-size:11px;color:var(--text-sub);">${s.username}@${s.host}:${s.port} (${s.base_path})</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button onclick='editHostingStorage(${JSON.stringify(s)})' class="btn-acc-action primary" title="Edit Storage"><i class="ri-edit-2-line"></i></button>
            <button onclick="removeHostingStorage('${s.storage_id}')" class="btn-acc-action danger" title="Remove"><i class="ri-delete-bin-line"></i></button>
          </div>
        </div>`
          )
          .join("")
      : `<div style="font-size:12px;color:var(--text-sub);">No hosting SFTP/FTP storage connected yet.</div>`;
  } catch (e) {}
}

function editHostingStorage(s) {
  editingRemoteStorageId = s.storage_id;
  document.getElementById("rem-protocol").value = s.protocol;
  document.getElementById("rem-label").value = s.label;
  document.getElementById("rem-host").value = s.host;
  document.getElementById("rem-port").value = s.port;
  document.getElementById("rem-user").value = s.username;
  document.getElementById("rem-pass").value = "";
  document.getElementById("rem-pass").placeholder = "Leave blank to keep existing password";
  document.getElementById("rem-path").value = s.base_path;
  showToast(`Editing "${s.label}" — update fields and click Test & Mount`, "info");
}

async function connectHostingStorage() {
  const payload = {
    storage_id: editingRemoteStorageId,
    protocol: document.getElementById("rem-protocol").value,
    label: document.getElementById("rem-label").value.trim(),
    host: document.getElementById("rem-host").value.trim(),
    port: document.getElementById("rem-port").value,
    username: document.getElementById("rem-user").value.trim(),
    password: document.getElementById("rem-pass").value,
    base_path: document.getElementById("rem-path").value.trim() || "/"
  };
  const method = editingRemoteStorageId ? "PUT" : "POST";
  showToast(editingRemoteStorageId ? "Updating storage..." : "Testing SSH/FTP connection...", "info");
  try {
    const res = await fetch("/api/remote-storage", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      editingRemoteStorageId = null;
      currentFolderNavigation = [];
      document.getElementById("rem-pass").placeholder = "Password";
      document.getElementById("remote-storage-modal").style.display = "none";
      showToast(data.message, "success");
      await loadConnectedRemoteStorages();
      await bootAuthenticatedDashboard();
    } else {
      showToast(data.error || "Connection failed", "error");
    }
  } catch (e) {
    showToast("Network error", "error");
  }
}

async function removeHostingStorage(storageId) {
  openSessionConfirmModal(
    "Remove Hosting Storage?",
    "Are you sure you want to permanently remove this SFTP/FTP storage and its folders?",
    "Remove Permanently",
    async () => {
      try {
        const res = await fetch("/api/remote-storage", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storage_id: storageId })
        });
        if (res.ok) {
          currentFolderNavigation = [];
          globalVaultTree = globalVaultTree.filter((item) => item.storage_id !== storageId);
          closePreviewPane();
          renderCurrentFolderLevel();
          await loadConnectedRemoteStorages();
          await bootAuthenticatedDashboard();
          showToast("Hosting storage completely removed!", "success");
        }
      } catch (e) {
        showToast("Error removing hosting storage", "error");
      }
    }
  );
}

// ========================================================================
// ⚙️ AUTO-BOOT ON PAGE LOAD
// ========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  initializeMobileScannerFeatures();
  try {
    const check = await fetch("/api/check-session");
    const status = await check.json();
    if (typeof status.latest_event_id === "number") lastSeenSyncEventId = status.latest_event_id;
    if (status.authenticated) {
      if (status.session_id) currentSessionId = status.session_id;
      sessionLoginType = status.login_type || "user_account";
      if (status.restrictions) activeRestrictions = status.restrictions;
      await bootAuthenticatedDashboard();
    } else {
      window.location.replace("/");
    }
  } catch (e) {}
});

window.addEventListener("message", (event) => {
  if (event.data && event.data.status === "success") {
    showToast("Cloud account connected!", "success");
    loadConnectedCloudAccounts();
    bootAuthenticatedDashboard();
  }
});