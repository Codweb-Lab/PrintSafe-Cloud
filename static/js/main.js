// ========================================================================
// 🛡️ PRINTSAFE CLOUD — COMPLETE FRONTEND ENGINE (v7.0)
// ========================================================================
const thumbnailCache = {};
pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/js/pdf.worker.min.js";

// Prevent Ctrl+S direct saving
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && (e.key === "s" || e.key === "S")) e.preventDefault();
});

// Global State Variables
let activeFile = {
  name: null,
  type: null,
  base64: null,
  binary: null,
  cloudId: null,
  accountId: null,
  accountName: null,
  provider: null
};
let savedPassword = "";
let activeThumbnailRequests = [];
let protectedFilesList = {};
let decryptedCanvasCache = [];

let qrPollingInterval = null;
let qrVisualCountdownInterval = null;
let qrSecondsRemaining = 15;
let currentSessionId = null;
let activeQRToken = null;

let globalVaultTree = [];
let printQueueItems = [];
let currentFolderNavigation = [];
let currentViewMode = localStorage.getItem("vault_view_mode") || "tile"; // 'tile' or 'list'
let currentFilterType = "all"; // 'all', 'pdf', 'image', 'print_queue'
let connectedAccountsList = [];
let contextMenuTargetItem = null;

// Restricted Session & Universal Real-Time Sync State
let sessionLoginType = "master"; // 'master' or 'qr_restricted'
let activeRestrictions = {
  is_restricted: false,
  mask_folders: false,
  disable_profile: false,
  allow_print: true
};
let lastSeenSyncEventId = null;
let backgroundSyncInterval = null;

// ========================================================================
// 🛠️ UTILITY HELPERS
// ========================================================================
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "Cloud Sync";
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + " KB";
  return (kb / 1024).toFixed(1) + " MB";
}

function getDisplayFolderName(rawName) {
  if (activeRestrictions.mask_folders) return "xxxxx";
  return rawName;
}

function getProviderBadgeHTML(item) {
  const prov = item.provider || "local";
  const accName = item.account_name || (prov === "local" ? "Local Vault" : "Cloud Drive");
  if (item.is_expired) {
    return `<span class="source-badge expired" title="Token Expired - Click to Reconnect"><i class="ri-error-warning-fill"></i> Expired • Reconnect</span>`;
  }
  if (prov === "google") {
    return `<span class="source-badge google" title="Google Drive: ${accName}"><i class="ri-google-fill"></i> ${accName}</span>`;
  } else if (prov === "onedrive") {
    return `<span class="source-badge onedrive" title="OneDrive: ${accName}"><i class="ri-microsoft-fill"></i> ${accName}</span>`;
  }
  return `<span class="source-badge local" title="Local Storage"><i class="ri-hard-drive-2-fill"></i> Local</span>`;
}

// ========================================================================
// 🔒 LIVE RESTRICTIONS UI ENFORCER (FOR QR SESSIONS)
// ========================================================================
function applyLiveRestrictionsUI() {
  const isRestricted = sessionLoginType === "qr_restricted" || activeRestrictions.is_restricted;
  const disableProf = isRestricted && activeRestrictions.disable_profile;

  const badge = document.getElementById("restricted-mode-indicator");
  if (badge) badge.style.display = isRestricted ? "inline-flex" : "none";

  // Hide Upload FAB in Restricted Mode
  const uploadFab = document.getElementById("floating-upload-fab");
  if (uploadFab) uploadFab.style.display = isRestricted ? "none" : "flex";

  // Hide Master-only Sidebar sections in Restricted Mode
  const restrictedSidebarBtns = document.querySelectorAll(".master-only-nav");
  restrictedSidebarBtns.forEach((btn) => {
    btn.style.display = isRestricted ? "none" : "";
  });

  // Lock Profile Avatar Dropdown if disabled
  const avatar = document.querySelector(".profile-avatar-pill");
  if (avatar) {
    avatar.style.opacity = disableProf ? "0.45" : "1";
    avatar.style.cursor = disableProf ? "not-allowed" : "pointer";
    avatar.title = disableProf ? "Profile Menu Locked by Mobile Master" : "Account Menu";
  }
  if (disableProf) {
    const dropdown = document.getElementById("profile-menu-dropdown");
    if (dropdown) dropdown.style.display = "none";
  }
}

// ========================================================================
// 🖨️ "TO BE PRINTED" WISHLIST QUEUE ENGINE
// ========================================================================
async function loadPrintQueue() {
  try {
    const res = await fetch("/api/print-queue");
    if (!res.ok) return;
    const data = await res.json();
    printQueueItems = data.items || [];
    updatePrintQueueBadges();
  } catch (e) {}
}

function updatePrintQueueBadges() {
  const count = printQueueItems.length;
  const b1 = document.getElementById("sidebar-print-queue-count");
  const b2 = document.getElementById("pill-print-queue-count");
  if (b1) b1.innerText = count;
  if (b2) b2.innerText = count;
}

function isItemInPrintQueue(relativePath) {
  return printQueueItems.some((i) => i.item_path === relativePath);
}

async function togglePrintQueueItem(e, item, relativePath) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  const exists = isItemInPrintQueue(relativePath);
  try {
    if (exists) {
      await fetch("/api/print-queue", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_path: relativePath })
      });
      showToast(`Removed "${item.name}" from To Be Printed`, "info");
    } else {
      await fetch("/api/print-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_path: relativePath,
          name: item.name,
          file_type: item.file_type || "pdf",
          size: item.size || 0,
          cloud_id: item.cloud_id || "",
          account_id: item.account_id || "",
          account_name: item.account_name || "Local Vault",
          provider: item.provider || "local"
        })
      });
      showToast(`Added "${item.name}" to To Be Printed!`, "success");
    }
    await loadPrintQueue();
    renderCurrentFolderLevel();
  } catch (err) {
    showToast("Could not update Print Queue", "error");
  }
}

function openPrintQueueView() {
  const pill = document.getElementById("pill-print-queue");
  applyQuickTypeFilter("print_queue", pill);
}

// ========================================================================
// 🔲 VIEW MODE SWITCHER (TILE VIEW vs LIST VIEW)
// ========================================================================
function setExplorerViewMode(mode) {
  currentViewMode = mode;
  localStorage.setItem("vault_view_mode", mode);
  document.getElementById("view-btn-tile")?.classList.toggle("active", mode === "tile");
  document.getElementById("view-btn-list")?.classList.toggle("active", mode === "list");
  renderCurrentFolderLevel();
}

// ========================================================================
// 📄 LIVE STREAM SIDE PREVIEW & VECTOR PRINT
// ========================================================================
function toggleFullscreenPane() {
  const col = document.querySelector(".integrated-preview-column");
  if (col) col.classList.toggle("fullscreen-pane");
}

async function showIntegratedPreview(
  filename,
  type,
  cardElement,
  filePassword = "",
  cloudId = null,
  accountId = null,
  accountName = "Local Vault",
  provider = "local"
) {
  activeThumbnailRequests.forEach((controller) => controller.abort());
  activeThumbnailRequests = [];

  const colWrapper = document.querySelector(".integrated-preview-column");
  if (colWrapper) colWrapper.classList.add("active-pane");

  const titleDisplay = document.getElementById("preview-filename-display");
  const pagesArea = document.getElementById("preview-raster-pages-area");
  const printBtn = document.getElementById("print-action-btn");

  if (!pagesArea) return;

  document.querySelectorAll(".file-card, .file-list-row").forEach((c) => c.classList.remove("active"));
  if (cardElement) cardElement.classList.add("active");

  if (printBtn) {
    printBtn.style.display = activeRestrictions.allow_print !== false ? "inline-flex" : "none";
  }
  if (titleDisplay) {
    titleDisplay.innerHTML = `${filename.split("/").pop()} <small style="display:block;font-size:10px;color:var(--text-sub);font-weight:500;">Source: ${accountName}</small>`;
  }

  activeFile = { name: filename, type, base64: null, binary: null, cloudId, accountId, accountName, provider };
  decryptedCanvasCache = [];
  pagesArea.innerHTML = `<div class="stream-loader"><div class="vault-spinner"></div><span>Streaming encrypted document...</span></div>`;

  try {
    const response = await fetch("/fetch-file-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: savedPassword,
        filename: filename,
        cloud_id: cloudId,
        account_id: accountId,
        session_id: currentSessionId
      })
    });

    if (!response.ok) throw new Error("Could not stream file bytes.");
    const fileData = await response.json();

    activeFile.base64 = fileData.base64;
    activeFile.binary = Uint8Array.from(atob(fileData.base64), (c) => c.charCodeAt(0));

    if (type === "pdf") {
      const loadingTask = pdfjsLib.getDocument({
        data: activeFile.binary.buffer.slice(0),
        password: filePassword
      });
      loadingTask.promise
        .then(async (pdf) => {
          pagesArea.innerHTML = "";
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const canvas = document.createElement("canvas");
            canvas.className = "raster-page-preview";
            const viewport = page.getViewport({ scale: 1.2 });
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            pagesArea.appendChild(canvas);

            const printCanvas = document.createElement("canvas");
            const printViewport = page.getViewport({ scale: 2.5 });
            printCanvas.height = printViewport.height;
            printCanvas.width = printViewport.width;
            await page.render({ canvasContext: printCanvas.getContext("2d"), viewport: printViewport }).promise;
            decryptedCanvasCache.push(printCanvas);
          }
        })
        .catch((err) => {
          if (err.name === "PasswordException") {
            protectedFilesList[filename] = true;
            pagesArea.innerHTML = `
              <div class="file-lock-form" style="padding:24px;text-align:center;">
                <i class="ri-lock-password-line" style="font-size:32px;color:var(--accent);"></i>
                <p style="font-size:13px;margin:10px 0;">Password Protected PDF</p>
                <input type="password" id="file-inner-pass" placeholder="Enter PDF Password" style="width:100%;padding:10px;margin-bottom:10px;border-radius:var(--radius-btn);border:1px solid var(--border);background:var(--bg-app);color:var(--text-title);">
                <button class="primary-submit-btn" onclick="submitFilePassword('${filename}', '${cloudId || ""}', '${accountId || ""}')">Decrypt</button>
              </div>`;
            pagesArea.querySelector(".file-lock-form").cardRef = cardElement;
          }
        });
    } else {
      pagesArea.innerHTML = "";
      const img = document.createElement("img");
      img.className = "raster-page-preview";
      img.src = `data:image/jpeg;base64,${fileData.base64}`;
      pagesArea.appendChild(img);
    }
  } catch (error) {
    pagesArea.innerHTML = `<div style='color:#ef4444; padding:30px; text-align:center; font-size:13px;'><i class="ri-error-warning-line" style="font-size:28px;display:block;margin-bottom:6px;"></i>${error.message}</div>`;
  }
}

function closePreviewPane() {
  const colWrapper = document.querySelector(".integrated-preview-column");
  if (colWrapper) {
    colWrapper.classList.remove("active-pane");
    colWrapper.classList.remove("fullscreen-pane");
  }
  document.querySelectorAll(".file-card, .file-list-row").forEach((c) => c.classList.remove("active"));
  activeFile = { name: null, type: null, base64: null, binary: null };
  decryptedCanvasCache = [];
}

function submitFilePassword(filename, cloudId, accountId) {
  const container = document.getElementById("preview-raster-pages-area");
  const cardElement = container.querySelector(".file-lock-form").cardRef;
  const enteredPass = document.getElementById("file-inner-pass").value;
  if (!enteredPass) return;
  showIntegratedPreview(filename, "pdf", cardElement, enteredPass, cloudId || null, accountId || null);
}

function triggerCleanVectorPrint() {
  if (!activeFile.base64) return;
  const existingFrame = document.getElementById("hidden-print-iframe");
  if (existingFrame) document.body.removeChild(existingFrame);

  const iframe = document.createElement("iframe");
  iframe.id = "hidden-print-iframe";
  iframe.style.cssText = "position:fixed;width:0;height:0;border:none;visibility:hidden;";
  document.body.appendChild(iframe);

  const isPdf = activeFile.type === "pdf";
  function cleanupPrintStream() {
    if (document.body.contains(iframe)) document.body.removeChild(iframe);
  }
  iframe.contentWindow.onafterprint = cleanupPrintStream;

  if (isPdf && protectedFilesList[activeFile.name] && decryptedCanvasCache.length > 0) {
    const pdoc = iframe.contentWindow.document;
    pdoc.open();
    pdoc.write(`<!DOCTYPE html><html><head><style>body{margin:0;text-align:center;}canvas{width:100%!important;height:auto!important;display:block;page-break-after:always;}@page{margin:0;size:auto;}</style></head><body></body></html>`);
    pdoc.close();
    decryptedCanvasCache.forEach((canvasElement) => {
      const newCanvas = pdoc.createElement("canvas");
      newCanvas.width = canvasElement.width;
      newCanvas.height = canvasElement.height;
      newCanvas.getContext("2d").drawImage(canvasElement, 0, 0);
      pdoc.body.appendChild(newCanvas);
    });
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    cleanupPrintStream();
  } else {
    const blob = new Blob([activeFile.binary.buffer.slice(0)], { type: isPdf ? "application/pdf" : "image/jpeg" });
    const blobURL = URL.createObjectURL(blob);
    iframe.onload = () => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    };
    iframe.src = blobURL;
  }
}

// ========================================================================
// 🔐 AUTHENTICATION & DASHBOARD BOOTSTRAP
// ========================================================================
async function unlockVault() {
  const passwordInput = document.getElementById("secret-key");
  if (!passwordInput) return;
  const password = passwordInput.value.trim();
  if (!password) {
    showToast("Please enter your secret key.", "error");
    return;
  }

  try {
    const loginResponse = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });

    if (!loginResponse.ok) {
      showToast("Incorrect secret key.", "error");
      return;
    }

    sessionLoginType = "master";
    activeRestrictions = { is_restricted: false, mask_folders: false, disable_profile: false, allow_print: true };
    await bootAuthenticatedDashboard();
    showToast("Vault Unlocked!", "success");
  } catch (error) {
    showToast("Error: " + error.message, "error");
  }
}

async function bootAuthenticatedDashboard() {
  const vaultResponse = await fetch("/fetch-vault-list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: currentSessionId })
  });
  if (!vaultResponse.ok) return;
  const data = await vaultResponse.json();

  document.getElementById("auth-container").style.display = "none";
  document.getElementById("file-manager-dashboard").style.display = "flex";

  globalVaultTree = data.tree || [];
  await loadPrintQueue();
  applyLiveRestrictionsUI();
  setExplorerViewMode(currentViewMode);
  await loadConnectedCloudAccounts();
  await refreshConnectedSessionsCount();
  initializeMobileScannerFeatures();
  startBackgroundSyncAndRestrictionMonitor();
}

// ========================================================================
// 📂 EXPLORER ENGINE (TILE, LIST, PRINT QUEUE, EXPIRED DRIVE & MASKING)
// ========================================================================
let lazyFilteredItems = [];

function renderCurrentFolderLevel() {
  const grid = document.getElementById("main-explorer-grid");
  const pathDisplay = document.getElementById("current-folder-path-display");
  const backBtn = document.getElementById("back-folder-btn");

  if (!grid) return;

  if (activeThumbnailRequests.length > 0) {
    activeThumbnailRequests.forEach((c) => {
      try { c.abort(); } catch (e) {}
    });
    activeThumbnailRequests = [];
  }
  grid.innerHTML = "";

  const searchQuery = (document.getElementById("drive-search-input")?.value || "").toLowerCase().trim();
  const typeFilter = currentFilterType;
  const sortBy = document.getElementById("drive-sort-by")?.value || "name-asc";

  let currentItems = [];
  let pathStrings = ["Root Vault"];

  if (typeFilter === "print_queue") {
    currentItems = printQueueItems;
    pathStrings = ["🖨️ To Be Printed Queue"];
    if (backBtn) backBtn.style.display = "none";
  } else {
    currentItems = globalVaultTree;
    currentFolderNavigation.forEach((folderName) => {
      pathStrings.push(getDisplayFolderName(folderName));
      const targetFolder = currentItems.find((item) => item.type === "folder" && item.name === folderName);
      if (targetFolder) currentItems = targetFolder.children || [];
    });
    if (backBtn) backBtn.style.display = currentFolderNavigation.length > 0 ? "inline-flex" : "none";
  }

  if (pathDisplay) {
    pathDisplay.innerHTML = pathStrings
      .map((p, idx) => `<span onclick="jumpToLocalBreadcrumb(${idx})" style="cursor:pointer;">${p}</span>`)
      .join(` <i class="ri-arrow-right-s-line" style="color:var(--text-sub);"></i> `);
  }

  lazyFilteredItems = currentItems.filter((item) => {
    const matchesSearch = item.name.toLowerCase().includes(searchQuery);
    let matchesType = true;
    if (typeFilter === "print_queue") {
      matchesType = true;
    } else if (item.type === "file") {
      if (typeFilter === "pdf" && item.file_type !== "pdf") matchesType = false;
      if (typeFilter === "image" && item.file_type !== "image") matchesType = false;
    } else if (item.type === "folder") {
      if (typeFilter !== "all" && !searchQuery) matchesType = false;
    }
    return matchesSearch && matchesType;
  });

  lazyFilteredItems.sort((a, b) => {
    if (a.type === "folder" && b.type !== "folder") return -1;
    if (a.type !== "folder" && b.type === "folder") return 1;
    if (sortBy === "name-asc") return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    if (sortBy === "name-desc") return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: "base" });
    if (sortBy === "size-asc") return (a.size || 0) - (b.size || 0);
    if (sortBy === "size-desc") return (b.size || 0) - (a.size || 0);
    return 0;
  });

  if (lazyFilteredItems.length === 0) {
    grid.className = "file-grid empty-state";
    const emptyMsg =
      typeFilter === "print_queue"
        ? "No files added to 'To Be Printed' queue yet. Click the printer icon on any file card to add it here."
        : "No items found in this directory";
    grid.innerHTML = `<div style="text-align: center; color: var(--text-sub); padding: 40px;"><i class="${typeFilter === "print_queue" ? "ri-printer-cloud-line" : "ri-folder-open-line"}" style="font-size: 48px; display: block; margin-bottom: 8px; opacity: 0.5;"></i><div style="font-size: 14px; font-weight: 600;">${emptyMsg}</div></div>`;
    return;
  }

  const folders = lazyFilteredItems.filter((i) => i.type === "folder");
  const files = lazyFilteredItems.filter((i) => i.type !== "folder");

  if (currentViewMode === "list") {
    grid.className = "file-list-container";
    const headerRow = document.createElement("div");
    headerRow.className = "file-list-header";
    headerRow.innerHTML = `
      <div style="flex:2;">Name</div>
      <div style="flex:1;">Drive / Source</div>
      <div style="width:90px;">Type</div>
      <div style="width:90px;text-align:right;">Action / Size</div>
    `;
    grid.appendChild(headerRow);

    [...folders, ...files].forEach((item) => {
      const row = document.createElement("div");
      row.className = `file-list-row ${item.is_expired ? "expired-card" : ""}`;
      const isFolder = item.type === "folder";
      const displayName = isFolder ? getDisplayFolderName(item.name) : item.name;
      const iconClass = isFolder ? "ri-folder-3-fill" : item.file_type === "pdf" ? "ri-file-pdf-2-fill" : "ri-image-2-fill";
      const iconColor = item.is_expired ? "#94a3b8" : isFolder ? "#f59e0b" : item.file_type === "pdf" ? "#ef4444" : "#3b82f6";
      const thumbId = `list-thumb-${Math.random().toString(36).substring(2, 8)}`;
      const relativeFilePath =
        item.item_path || (currentFolderNavigation.length > 0 ? currentFolderNavigation.join("/") + "/" + item.name : item.name);
      const inQueue = !isFolder && isItemInPrintQueue(relativeFilePath);

      row.innerHTML = `
        <div style="flex:2;display:flex;align-items:center;gap:12px;overflow:hidden;">
          <div class="list-thumb-box" id="${thumbId}">
            ${isFolder ? `<i class="${iconClass}" style="color:${iconColor};font-size:20px;"></i>` : `<div class="vault-spinner small"></div>`}
          </div>
          <span class="file-name" style="font-weight:600;">${displayName}</span>
        </div>
        <div style="flex:1;">${getProviderBadgeHTML(item)}</div>
        <div style="width:90px;font-size:12px;color:var(--text-sub);text-transform:uppercase;">${isFolder ? "Folder" : item.file_type}</div>
        <div style="width:90px;text-align:right;display:flex;align-items:center;justify-content:flex-end;gap:8px;">
          ${!isFolder ? `
            <button class="queue-star-btn ${inQueue ? "active" : ""}" title="${inQueue ? "Remove from Print Queue" : "Add to To Be Printed"}">
              <i class="${inQueue ? "ri-printer-fill" : "ri-printer-line"}"></i>
            </button>
          ` : `<span style="font-size:11px;color:var(--text-sub);">${(item.children || []).length} items</span>`}
        </div>
      `;

      const qBtn = row.querySelector(".queue-star-btn");
      if (qBtn) {
        qBtn.onclick = (ev) => togglePrintQueueItem(ev, item, relativeFilePath);
      }

      row.onclick = () => handleItemClick(item, relativeFilePath, row);
      row.oncontextmenu = (e) => openCustomContextMenu(e, item, relativeFilePath, row);

      if (!isFolder && !item.is_expired) {
        setTimeout(() => fetchAndRenderSingleThumbnail(relativeFilePath, item.file_type, thumbId, item.cloud_id, item.account_id), 10);
      }
      grid.appendChild(row);
    });
  } else {
    grid.className = "file-grid";
    [...folders, ...files].forEach((item) => {
      const card = document.createElement("div");
      card.className = `file-card ${item.is_expired ? "expired-card" : ""}`;
      const isFolder = item.type === "folder";
      const displayName = isFolder ? getDisplayFolderName(item.name) : item.name;
      const iconClass = isFolder ? "ri-folder-3-fill" : item.file_type === "pdf" ? "ri-file-pdf-2-fill" : "ri-image-2-fill";
      const iconColor = item.is_expired ? "#94a3b8" : isFolder ? "#f59e0b" : item.file_type === "pdf" ? "#ef4444" : "#3b82f6";
      const thumbId = `thumb-${Math.random().toString(36).substring(2, 9)}`;
      const relativeFilePath =
        item.item_path || (currentFolderNavigation.length > 0 ? currentFolderNavigation.join("/") + "/" + item.name : item.name);
      const inQueue = !isFolder && isItemInPrintQueue(relativeFilePath);

      card.innerHTML = `
        <div class="file-thumbnail-zone" id="${thumbId}" style="position:relative;${isFolder ? "background:rgba(245,158,11,0.08);" : ""}">
          ${isFolder
            ? `<i class="${iconClass}" style="font-size:46px;color:${iconColor};"></i>`
            : `<div class="vault-spinner"></div>`
          }
          ${!isFolder ? `
            <button class="queue-star-btn floating ${inQueue ? "active" : ""}" title="${inQueue ? "In To Be Printed Queue" : "Add to To Be Printed"}">
              <i class="${inQueue ? "ri-printer-fill" : "ri-printer-line"}"></i>
            </button>
          ` : ""}
        </div>
        <div class="file-info" style="flex-direction:column;align-items:flex-start;gap:5px;">
          <div style="display:flex;align-items:center;gap:6px;width:100%;">
            <i class="${iconClass}" style="color:${iconColor};font-size:15px;flex-shrink:0;"></i>
            <span class="file-name" title="${displayName}" style="flex:1;">${displayName}</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
            ${getProviderBadgeHTML(item)}
            <span style="font-size:10px;color:var(--text-sub);">${item.is_expired ? "Reconnect" : isFolder ? `${(item.children || []).length}` : formatFileSize(item.size)}</span>
          </div>
        </div>
      `;

      const qBtn = card.querySelector(".queue-star-btn");
      if (qBtn) {
        qBtn.onclick = (ev) => togglePrintQueueItem(ev, item, relativeFilePath);
      }

      card.onclick = () => handleItemClick(item, relativeFilePath, card);
      card.oncontextmenu = (e) => openCustomContextMenu(e, item, relativeFilePath, card);

      if (!isFolder && !item.is_expired) {
        setTimeout(() => fetchAndRenderSingleThumbnail(relativeFilePath, item.file_type, thumbId, item.cloud_id, item.account_id), 15);
      }
      grid.appendChild(card);
    });
  }
}

async function handleItemClick(item, relativeFilePath, element) {
  if (item.is_expired) {
    showToast(`Cloud session expired for ${item.account_name}. Opening Reconnect...`, "info");
    startDirectOAuthReconnect(item.provider || "google", item.account_name || "");
    return;
  }

  if (item.type === "folder") {
    const searchBar = document.getElementById("drive-search-input");
    if (searchBar) searchBar.value = "";

    if (item.cloud_id && (!item.children || item.children.length === 0)) {
      showToast(`Syncing folder contents...`, "info");
      try {
        const res = await fetch("/api/cloud/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: item.name,
            cloud_id: item.cloud_id,
            type: "folder",
            account_id: item.account_id,
            provider: item.provider,
            account_name: item.account_name
          })
        });
        const data = await res.json();
        if (data.success && data.imported_item?.children) {
          item.children = data.imported_item.children;
        }
      } catch (e) {}
    }
    currentFolderNavigation.push(item.name);
    renderCurrentFolderLevel();
  } else {
    showIntegratedPreview(
      relativeFilePath,
      item.file_type,
      element,
      "",
      item.cloud_id,
      item.account_id,
      item.account_name || "Local Vault",
      item.provider || "local"
    );
  }
}

function jumpToLocalBreadcrumb(idx) {
  if (currentFilterType === "print_queue") {
    applyQuickTypeFilter("all", document.querySelector(".filter-pill"));
    return;
  }
  if (idx === 0) currentFolderNavigation = [];
  else currentFolderNavigation = currentFolderNavigation.slice(0, idx);
  renderCurrentFolderLevel();
}

function navigateBackFolder() {
  if (currentFolderNavigation.length > 0) {
    currentFolderNavigation.pop();
    renderCurrentFolderLevel();
  }
}

// ========================================================================
// 🖼️ THUMBNAIL LOADER WITH SPINNER & QUEUE BUTTON PRESERVATION
// ========================================================================
async function fetchAndRenderSingleThumbnail(relativeFilePath, fileType, thumbId, cloudId = null, accountId = null) {
  const placeholder = document.getElementById(thumbId);
  if (!placeholder) return;

  const existingBtn = placeholder.querySelector(".queue-star-btn");

  function setThumbnailContent(innerMarkup) {
    const target = document.getElementById(thumbId);
    if (!target) return;
    target.innerHTML = innerMarkup;
    if (existingBtn) target.appendChild(existingBtn);
  }

  const fallbackIcon =
    fileType === "pdf"
      ? `<i class="ri-file-pdf-2-fill" style="font-size:32px;color:#ef4444;"></i>`
      : `<i class="ri-image-2-fill" style="font-size:32px;color:#3b82f6;"></i>`;

  if (thumbnailCache[relativeFilePath]) {
    if (thumbnailCache[relativeFilePath].status === "protected") {
      setThumbnailContent(`<div class="protected-badge"><i class="ri-lock-2-fill"></i> Locked</div>`);
    } else if (thumbnailCache[relativeFilePath].status === "success") {
      setThumbnailContent(`<img src="${thumbnailCache[relativeFilePath].dataUrl}" alt="thumb">`);
    } else {
      setThumbnailContent(fallbackIcon);
    }
    return;
  }

  const controller = new AbortController();
  activeThumbnailRequests.push(controller);

  try {
    const response = await fetch("/fetch-file-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: savedPassword,
        filename: relativeFilePath,
        cloud_id: cloudId,
        account_id: accountId,
        session_id: currentSessionId
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      setThumbnailContent(fallbackIcon);
      return;
    }
    const fileData = await response.json();
    if (!document.getElementById(thumbId)) return;

    if (fileType === "pdf") {
      const binary = Uint8Array.from(atob(fileData.base64), (c) => c.charCodeAt(0));
      const loadingTask = pdfjsLib.getDocument({ data: binary.buffer });

      loadingTask.promise
        .then(async (pdf) => {
          const page = await pdf.getPage(1);
          const canvas = document.createElement("canvas");
          const viewport = page.getViewport({ scale: 0.35 });
          canvas.height = viewport.height;
          canvas.width = viewport.width;

          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          const finalDataUrl = canvas.toDataURL();
          thumbnailCache[relativeFilePath] = { status: "success", dataUrl: finalDataUrl };
          setThumbnailContent(`<img src="${finalDataUrl}" alt="pdf">`);
        })
        .catch((err) => {
          if (err.name === "PasswordException") {
            protectedFilesList[relativeFilePath] = true;
            thumbnailCache[relativeFilePath] = { status: "protected" };
            setThumbnailContent(`<div class="protected-badge"><i class="ri-lock-2-fill"></i> Locked</div>`);
          } else {
            setThumbnailContent(fallbackIcon);
          }
        });
    } else {
      const srcDataUrl = `data:image/jpeg;base64,${fileData.base64}`;
      thumbnailCache[relativeFilePath] = { status: "success", dataUrl: srcDataUrl };
      setThumbnailContent(`<img src="${srcDataUrl}" alt="img">`);
    }
  } catch (e) {
    if (e.name !== "AbortError") setThumbnailContent(fallbackIcon);
  }
}

// ========================================================================
// 🖱️ CUSTOM RIGHT-CLICK CONTEXT MENU ENGINE
// ========================================================================
function openCustomContextMenu(e, item, relativePath, domElement) {
  e.preventDefault();
  e.stopPropagation();
  contextMenuTargetItem = { item, relativePath, domElement };

  const menu = document.getElementById("vault-context-menu");
  if (!menu) return;

  const isFolder = item.type === "folder";
  const displayName = isFolder ? getDisplayFolderName(item.name) : item.name;
  const accName = item.account_name || "Local Vault";
  const inQueue = !isFolder && isItemInPrintQueue(relativePath);

  menu.innerHTML = `
    <div class="ctx-header">
      <i class="${isFolder ? "ri-folder-3-fill" : "ri-file-text-fill"}" style="color:var(--accent);"></i>
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${displayName}</span>
    </div>
    ${item.is_expired ? `
      <div class="ctx-item" onclick="startDirectOAuthReconnect('${item.provider}', '${item.account_name}'); hideCustomContextMenu();" style="color:#ef4444;">
        <i class="ri-plug-line"></i>
        <span>Reconnect Expired Drive</span>
      </div>
    ` : `
      <div class="ctx-item" onclick="ctxOpenItem()">
        <i class="${isFolder ? "ri-folder-open-line" : "ri-eye-line"}"></i>
        <span>${isFolder ? "Open Folder" : "Preview Document"}</span>
      </div>
    `}
    ${!isFolder ? `
      <div class="ctx-item" onclick="ctxToggleQueue()">
        <i class="${inQueue ? "ri-printer-fill" : "ri-printer-line"}" style="color:var(--accent);"></i>
        <span>${inQueue ? "Remove from To Be Printed" : "Add to To Be Printed"}</span>
      </div>
      <div class="ctx-item" onclick="ctxPrintItem()">
        <i class="ri-printer-cloud-line"></i>
        <span>Quick Vector Print</span>
      </div>
    ` : ""}
    <div class="ctx-item" onclick="ctxShowDetails()">
      <i class="ri-information-line"></i>
      <span>Drive Source: ${accName}</span>
    </div>
    ${sessionLoginType !== "qr_restricted" ? `
      <div class="ctx-divider"></div>
      <div class="ctx-item" onclick="document.getElementById('vault-file-uploader').click(); hideCustomContextMenu();">
        <i class="ri-upload-cloud-2-line"></i>
        <span>Upload File Here</span>
      </div>
    ` : ""}
  `;

  menu.style.display = "block";
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 240)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 250)}px`;
}

function hideCustomContextMenu() {
  const menu = document.getElementById("vault-context-menu");
  if (menu) menu.style.display = "none";
}

function ctxOpenItem() {
  hideCustomContextMenu();
  if (!contextMenuTargetItem) return;
  handleItemClick(contextMenuTargetItem.item, contextMenuTargetItem.relativePath, contextMenuTargetItem.domElement);
}

function ctxToggleQueue() {
  hideCustomContextMenu();
  if (!contextMenuTargetItem) return;
  togglePrintQueueItem(null, contextMenuTargetItem.item, contextMenuTargetItem.relativePath);
}

async function ctxPrintItem() {
  hideCustomContextMenu();
  if (!contextMenuTargetItem) return;
  const { item, relativePath, domElement } = contextMenuTargetItem;
  await showIntegratedPreview(
    relativePath,
    item.file_type,
    domElement,
    "",
    item.cloud_id,
    item.account_id,
    item.account_name,
    item.provider
  );
  setTimeout(() => triggerCleanVectorPrint(), 600);
}

function ctxShowDetails() {
  hideCustomContextMenu();
  if (!contextMenuTargetItem) return;
  const { item, relativePath } = contextMenuTargetItem;
  const provName = (item.provider || "local").toUpperCase();
  const acc = item.account_name || "Local Vault";
  showToast(`Source: ${acc} (${provName}) • Path: /${relativePath}`, "info");
}

document.addEventListener("click", hideCustomContextMenu);

// ========================================================================
// 📤 FLOATING UPLOAD HANDLER (AUTOMATIC CURRENT LOCATION)
// ========================================================================
async function handleCurrentFolderUpload(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;

  const currentPath = currentFolderNavigation.join("/");
  const displayFolder =
    currentFolderNavigation.length > 0 ? currentFolderNavigation[currentFolderNavigation.length - 1] : "Root Vault";

  showToast(`Uploading ${files.length} file(s) to ${displayFolder}...`, "info");

  for (let i = 0; i < files.length; i++) {
    const formData = new FormData();
    formData.append("file", files[i]);
    formData.append("folder_path", currentPath);

    try {
      const response = await fetch("/api/upload-file", { method: "POST", body: formData });
      const result = await response.json();

      if (result.success && result.file_item) {
        let targetArray = globalVaultTree;
        for (const folderName of currentFolderNavigation) {
          const found = targetArray.find((item) => item.type === "folder" && item.name === folderName);
          if (found) {
            if (!found.children) found.children = [];
            targetArray = found.children;
          }
        }
        const existingIdx = targetArray.findIndex((item) => item.name === result.file_item.name);
        if (existingIdx !== -1) targetArray[existingIdx] = result.file_item;
        else targetArray.push(result.file_item);

        showToast(`${result.file_item.name} uploaded to ${displayFolder}!`, "success");
      } else {
        showToast(`Failed: ${result.error}`, "error");
      }
    } catch (err) {
      showToast("Network error during upload.", "error");
    }
  }
  event.target.value = "";
  renderCurrentFolderLevel();
}

// ========================================================================
// 🖥️ CONNECTED SESSIONS MANAGER & UNIVERSAL INSTANT UPLOAD SYNC
// ========================================================================
let activeSessionsCount = 0;

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
    </div>
  `
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

async function killSpecificDesktopSession(sessionId) {
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

async function disconnectAllConnectedDesktops() {
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

function startBackgroundSyncAndRestrictionMonitor() {
  if (backgroundSyncInterval) clearInterval(backgroundSyncInterval);

  backgroundSyncInterval = setInterval(async () => {
    try {
      if (sessionLoginType === "qr_restricted" && currentSessionId) {
        const res = await fetch("/verify-private-scan/" + currentSessionId + "?t=" + Date.now());
        if (!res.ok) {
          sessionStorage.removeItem("active_vault_token");
          window.location.reload();
          return;
        }
        const data = await res.json();
        if (!data.success || data.status === "terminated") {
          sessionStorage.removeItem("active_vault_token");
          fetch("/api/logout", { method: "POST" }).then(() => window.location.reload());
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
        // Universal Sync Polling for Master Sessions (Desktop or Mobile)
        const res = await fetch("/api/poll-events?t=" + Date.now());
        if (res.ok) {
          const data = await res.json();
          const badge = document.getElementById("header-connected-count");
          if (badge) badge.innerText = data.connected_count || 0;

          const mobileDiscFab = document.getElementById("mobile-floating-disconnect-btn");
          if (mobileDiscFab) {
            const isMobile = window.innerWidth <= 768 || /Mobi|Android|iPhone/i.test(navigator.userAgent);
            mobileDiscFab.style.display = isMobile && data.connected_count > 0 ? "flex" : "none";
          }

          if (data.latest_event && data.latest_event.event_id) {
            handleIncomingSyncEvent(data.latest_event);
          }
        }
      }
    } catch (e) {}
  }, 2200);
}

async function handleIncomingSyncEvent(ev) {
  if (lastSeenSyncEventId === null) {
    lastSeenSyncEventId = ev.event_id;
    return;
  }
  if (ev.event_id > lastSeenSyncEventId) {
    lastSeenSyncEventId = ev.event_id;
    showToast(`📲 Instant Sync: "${ev.filename}" uploaded to ${ev.folder_path}!`, "success");
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
  }
}

// ========================================================================
// 📱 MOBILE QR SCANNER
// ========================================================================
let dashboardHtml5QrCode = null;

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
// 🔐 DESKTOP QR LOGIN POLLING
// ========================================================================
async function generateNewQR() {
  const qrDisplay = document.getElementById("qr-code-display");
  if (!qrDisplay) return;
  qrDisplay.innerHTML = `<div class="vault-spinner"></div>`;

  try {
    const response = await fetch("/generate-qr-session");
    const data = await response.json();
    if (data.session_id && data.qr_image) {
      currentSessionId = data.session_id;
      activeQRToken = data.session_id;
      qrDisplay.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center;">
          <img src="${data.qr_image}" alt="Scan QR" style="width:185px; height:185px; border-radius:10px;">
          <div id="qr-countdown-ticker" style="font-size:12px; font-weight:600; color:#475569; margin-top:8px;">Expires in 15s</div>
        </div>
      `;
      resetQRVisualCountdown(15);
    }
  } catch (e) {
    qrDisplay.innerHTML = `<div style="color:#ef4444;font-size:12px;">QR Error</div>`;
  }
}

function startQRPolling() {
  if (qrPollingInterval) clearInterval(qrPollingInterval);
  qrPollingInterval = setInterval(checkQRAuthenticationStatus, 2000);
}

function stopQRPolling() {
  if (qrPollingInterval) clearInterval(qrPollingInterval);
  qrPollingInterval = null;
}

async function checkQRAuthenticationStatus() {
  if (!activeQRToken) return;
  try {
    const response = await fetch("/verify-private-scan/" + activeQRToken + "?t=" + Date.now());
    if (!response.ok) return;
    const data = await response.json();

    if (data.success) {
      stopQRPolling();
      if (qrVisualCountdownInterval) clearInterval(qrVisualCountdownInterval);
      currentSessionId = activeQRToken;
      sessionLoginType = "qr_restricted";
      if (data.restrictions) activeRestrictions = data.restrictions;
      sessionStorage.setItem("active_vault_token", currentSessionId);
      await bootAuthenticatedDashboard();
      showToast("Logged in via Mobile QR (Restricted Mode)", "success");
    }
  } catch (e) {}
}

function resetQRVisualCountdown(seconds = 15) {
  qrSecondsRemaining = seconds;
  if (qrVisualCountdownInterval) clearInterval(qrVisualCountdownInterval);
  qrVisualCountdownInterval = setInterval(() => {
    qrSecondsRemaining--;
    const ticker = document.getElementById("qr-countdown-ticker");
    if (ticker) ticker.innerText = `Expires in ${qrSecondsRemaining}s`;
    if (qrSecondsRemaining <= 0) {
      clearInterval(qrVisualCountdownInterval);
      generateNewQR();
    }
  }, 1000);
}

function rotateCard(shouldFlip) {
  const front = document.querySelector(".auth-card-front");
  const back = document.querySelector(".auth-card-back");
  if (!front || !back) return;
  if (shouldFlip) {
    front.style.display = "none";
    back.style.display = "block";
    generateNewQR().then(() => startQRPolling());
  } else {
    back.style.display = "none";
    front.style.display = "block";
    stopQRPolling();
    if (qrVisualCountdownInterval) clearInterval(qrVisualCountdownInterval);
  }
}

// ========================================================================
// ☁️ SIDEBAR NESTED CLOUD TREES & MULTI-ACCOUNT CLOUD MANAGER
// ========================================================================
let cloudNavigationStack = [];
let activeBrowseAccount = null;

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
  if (arrowEl) {
    arrowEl.className = isExpanded ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line";
  }
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

function renderSidebarProviderTree(provider, accounts) {
  const container = document.getElementById(`sidebar-accounts-${provider}`);
  if (!container) return;

  if (accounts.length === 0) {
    container.innerHTML = `
      <div class="nested-acc-item" onclick="openCloudAccountFormModal('add', '${provider}')">
        <span><i class="ri-add-circle-line"></i> Connect Account</span>
      </div>
    `;
    return;
  }

  container.innerHTML =
    accounts
      .map((acc) => {
        const statusClass = acc.is_expired ? "expired" : acc.is_enabled ? "online" : "disabled";
        const label = acc.custom_name || acc.email;
        const safeLabel = label.replace(/'/g, "\\'");
        const clickAction = acc.is_expired
          ? `startDirectOAuthReconnect('${provider}', '${safeLabel}')`
          : `openAccountPickerModal('${acc.account_id}', '${safeLabel}', '${provider}'); toggleMobileSidebar(false);`;

        return `
      <div class="nested-acc-item" onclick="${clickAction}" title="${acc.email} (${acc.is_expired ? "Expired - Click to Reconnect" : "Click to Browse"})">
        <div style="display:flex;align-items:center;gap:8px;overflow:hidden;">
          <span class="nested-acc-dot ${statusClass}"></span>
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</span>
        </div>
        <i class="${acc.is_expired ? "ri-plug-line" : "ri-folder-open-line"}" style="font-size:13px;flex-shrink:0;"></i>
      </div>
    `;
      })
      .join("") +
    `
    <div class="nested-acc-item" onclick="openCloudAccountFormModal('add', '${provider}')" style="color:var(--accent);margin-top:2px;">
      <span><i class="ri-add-line"></i> Add Another</span>
    </div>
  `;
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
    { id: "google", name: "Google Drive", icon: "ri-google-fill", color: "#ea4335", supported: true },
    { id: "onedrive", name: "Microsoft OneDrive", icon: "ri-microsoft-fill", color: "#0078d4", supported: true },
    { id: "dropbox", name: "Dropbox Cloud", icon: "ri-dropbox-fill", color: "#0061fe", supported: false }
  ];

  container.innerHTML = providers
    .map((p) => {
      const pAccounts = connectedAccountsList.filter((a) => a.provider === p.id);
      const activeCount = pAccounts.filter((a) => a.is_enabled && !a.is_expired).length;

      const accountsHtml =
        pAccounts.length === 0
          ? `<div style="font-size:12px;color:var(--text-sub);padding:8px 4px;">No accounts linked yet. Click "+ Add Account" to connect via OAuth.</div>`
          : pAccounts
              .map((acc) => {
                const label = acc.custom_name || acc.email;
                const safeLabel = label.replace(/'/g, "\\'");
                return `
        <div class="cloud-acc-row">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
            <label class="switch-toggle" title="Enable / Disable Account in Vault">
              <input type="checkbox" ${acc.is_enabled ? "checked" : ""} onchange="toggleCloudAccountState('${acc.account_id}', this.checked)">
              <span class="slider"></span>
            </label>
            <div style="overflow:hidden;">
              <div style="font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px;">
                <span>${label}</span>
                ${acc.is_expired ? `<span style="font-size:10px;background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 6px;border-radius:6px;">Expired</span>` : ""}
                <button onclick="openCloudAccountFormModal('rename', '${acc.provider}', '${acc.account_id}', '${safeLabel}')" style="background:none;border:none;color:var(--text-sub);cursor:pointer;padding:2px;" title="Edit Custom Name">
                  <i class="ri-edit-2-line"></i>
                </button>
              </div>
              <div style="font-size:11px;color:var(--text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${acc.email}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            ${acc.is_expired ? `
              <button onclick="startDirectOAuthReconnect('${acc.provider}', '${safeLabel}')" class="btn-acc-action danger">
                <i class="ri-plug-line"></i> Reconnect
              </button>
            ` : `
              <button onclick="openAccountPickerModal('${acc.account_id}', '${safeLabel}', '${acc.provider}')" class="btn-acc-action primary" ${!acc.is_enabled ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ""}>
                <i class="ri-folder-open-line"></i> Browse
              </button>
            `}
            <button onclick="openDeleteAccountConfirmModal('${acc.account_id}', '${safeLabel}')" class="btn-acc-action danger" title="Remove Account">
              <i class="ri-delete-bin-line"></i>
            </button>
          </div>
        </div>
      `;
              })
              .join("");

      return `
      <div class="provider-section-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:36px;height:36px;border-radius:var(--radius-btn);background:var(--surface-card);display:flex;align-items:center;justify-content:center;font-size:20px;color:${p.color};box-shadow:var(--card-shadow);">
              <i class="${p.icon}"></i>
            </div>
            <div>
              <div style="font-weight:800;font-size:14.5px;">${p.name}</div>
              <div style="font-size:11px;color:var(--text-sub);">${pAccounts.length} Connected (${activeCount} Active)</div>
            </div>
          </div>
          ${p.supported
            ? `<button onclick="openCloudAccountFormModal('add', '${p.id}')" class="btn-add-account"><i class="ri-add-line"></i> Add Account</button>`
            : `<span style="font-size:11px;color:var(--text-sub);font-weight:600;">Coming Soon</span>`
          }
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${accountsHtml}
        </div>
      </div>
    `;
    })
    .join("");
}

// Custom Form Modal for Adding / Renaming Cloud Accounts
let accountFormState = { mode: "add", provider: "google", accountId: "" };

function openCloudAccountFormModal(mode, provider, accountId = "", currentName = "") {
  accountFormState = { mode, provider, accountId };
  const modal = document.getElementById("cloud-account-form-modal");
  const titleEl = document.getElementById("cloud-account-form-title");
  const inputEl = document.getElementById("cloud-account-custom-name-input");
  const submitBtn = document.getElementById("cloud-account-form-submit-btn");

  if (!modal || !inputEl) return;

  if (mode === "add") {
    titleEl.innerHTML = `<i class="ri-cloud-line" style="color:var(--accent);"></i> Connect ${provider.toUpperCase()} Account`;
    inputEl.value = "";
    submitBtn.innerHTML = `<i class="ri-external-link-line"></i> Continue to OAuth`;
  } else {
    titleEl.innerHTML = `<i class="ri-edit-2-line" style="color:var(--accent);"></i> Rename Cloud Account`;
    inputEl.value = currentName;
    submitBtn.innerHTML = `<i class="ri-check-line"></i> Save Name`;
  }
  modal.style.display = "flex";
  setTimeout(() => inputEl.focus(), 50);
}

function closeCloudAccountFormModal() {
  const modal = document.getElementById("cloud-account-form-modal");
  if (modal) modal.style.display = "none";
}

async function submitCloudAccountForm() {
  const inputEl = document.getElementById("cloud-account-custom-name-input");
  const customName = (inputEl?.value || "").trim();
  closeCloudAccountFormModal();

  if (accountFormState.mode === "add") {
    await startDirectOAuthReconnect(accountFormState.provider, customName);
  } else {
    try {
      await fetch("/api/cloud/account/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountFormState.accountId,
          action: "rename",
          custom_name: customName
        })
      });
      showToast("Account label updated!", "success");
      await loadConnectedCloudAccounts();
      await bootAuthenticatedDashboard();
    } catch (e) {}
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
    if (data.auth_url) {
      window.open(data.auth_url, "oauth-win", "width=600,height=680");
    }
  } catch (e) {
    showToast("Could not initiate OAuth", "error");
  }
}

let pendingDeleteAccountId = null;

function openDeleteAccountConfirmModal(accountId, label) {
  pendingDeleteAccountId = accountId;
  const modal = document.getElementById("confirm-action-modal");
  const textEl = document.getElementById("confirm-action-message");
  if (textEl) textEl.innerText = `Remove cloud account "${label}" and its mounted folders from your vault?`;
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
    showToast(isEnabled ? "Account enabled in Vault" : "Account hidden from Vault", "info");
    await loadConnectedCloudAccounts();
    await bootAuthenticatedDashboard();
  } catch (e) {}
}

function quickOpenProvider(provider) {
  if (sessionLoginType === "qr_restricted") {
    showToast("Cloud configuration is locked in Restricted Mode", "error");
    return;
  }
  const enabledAccs = connectedAccountsList.filter((a) => a.provider === provider && a.is_enabled && !a.is_expired);
  if (enabledAccs.length === 1) {
    openAccountPickerModal(enabledAccs[0].account_id, enabledAccs[0].custom_name || enabledAccs[0].email, provider);
  } else {
    openCloudDriveManager(true);
  }
}

function openAccountPickerModal(accountId, accountName, provider) {
  openCloudDriveManager(false);
  activeBrowseAccount = { accountId, accountName, provider };
  cloudNavigationStack = [];
  document.getElementById("cloud-picker-title").innerHTML = `<i class="ri-folder-cloud-line" style="color:var(--accent);"></i> ${accountName}`;
  document.getElementById("cloud-picker-modal").style.display = "flex";
  fetchCloudPickerItems("root");
}

function closeCloudPickerModal() {
  document.getElementById("cloud-picker-modal").style.display = "none";
  activeBrowseAccount = null;
  cloudNavigationStack = [];
}

async function fetchCloudPickerItems(folderId = "root") {
  if (!activeBrowseAccount) return;
  const listContainer = document.getElementById("cloud-picker-list");
  if (!listContainer) return;

  listContainer.innerHTML = `<div style="text-align:center; padding:40px;"><div class="vault-spinner" style="margin:0 auto 10px auto;"></div><span style="font-size:13px;color:var(--text-sub);">Streaming from ${activeBrowseAccount.accountName}...</span></div>`;
  updateCloudBreadcrumb();

  try {
    const response = await fetch(`/api/cloud/fetch/${activeBrowseAccount.accountId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId })
    });
    const data = await response.json();
    if (data.authenticated && data.tree) {
      renderCloudPickerRows(data.tree);
    } else {
      listContainer.innerHTML = `
        <div style="text-align:center;padding:35px;">
          <p style="color:#ef4444;font-weight:600;margin-bottom:12px;">Session expired for ${activeBrowseAccount.accountName}</p>
          <button onclick="startDirectOAuthReconnect('${activeBrowseAccount.provider}', '${activeBrowseAccount.accountName}')" class="btn-add-account">
            <i class="ri-plug-line"></i> Reconnect Now
          </button>
        </div>`;
    }
  } catch (err) {
    listContainer.innerHTML = `<div style="color:#ef4444; text-align:center; padding:20px;">Connection timeout.</div>`;
  }
}

function renderCloudPickerRows(treeItems) {
  const listContainer = document.getElementById("cloud-picker-list");
  if (!listContainer) return;
  listContainer.innerHTML = "";

  if (treeItems.length === 0) {
    listContainer.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-sub);">Empty Directory.</div>`;
    return;
  }

  treeItems.forEach((item) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);border-radius:var(--radius-btn);margin-bottom:4px;";

    const isFolder = item.type === "folder";
    const iconClass = isFolder ? "ri-folder-3-fill" : item.file_type === "pdf" ? "ri-file-pdf-2-fill" : "ri-image-2-fill";
    const iconColor = isFolder ? "#f59e0b" : item.file_type === "pdf" ? "#ef4444" : "#3b82f6";

    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;cursor:${isFolder ? "pointer" : "default"};flex:1;">
        <i class="${iconClass}" style="font-size:20px;color:${iconColor};"></i>
        <span style="font-size:13.5px;font-weight:600;">${item.name}</span>
      </div>
      <button class="import-action-trigger" style="background:rgba(34,197,94,0.12);color:#16a34a;border:1px solid rgba(34,197,94,0.3);padding:6px 12px;border-radius:var(--radius-btn);font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
        <i class="ri-download-cloud-2-line"></i> Mount
      </button>
    `;

    if (isFolder) {
      row.children[0].onclick = () => {
        cloudNavigationStack.push({ name: item.name, id: item.cloud_id });
        fetchCloudPickerItems(item.cloud_id);
      };
    }

    row.querySelector(".import-action-trigger").onclick = () => {
      triggerCloudAssetImport(item.name, item.cloud_id, item.type);
    };
    listContainer.appendChild(row);
  });
}

function updateCloudBreadcrumb() {
  const crumb = document.getElementById("cloud-breadcrumb");
  if (!crumb) return;
  let html = `<span onclick="jumpToCloudLevel(-1)" style="cursor:pointer;"><i class="ri-cloud-line"></i> Root</span>`;
  cloudNavigationStack.forEach((node, idx) => {
    html += ` <i class="ri-arrow-right-s-line"></i> <span onclick="jumpToCloudLevel(${idx})" style="cursor:pointer;">${node.name}</span>`;
  });
  crumb.innerHTML = html;
}

function jumpToCloudLevel(index) {
  if (index === -1) {
    cloudNavigationStack = [];
    fetchCloudPickerItems("root");
  } else {
    cloudNavigationStack = cloudNavigationStack.slice(0, index + 1);
    fetchCloudPickerItems(cloudNavigationStack[index].id);
  }
}

async function triggerCloudAssetImport(name, cloudId, type) {
  if (!activeBrowseAccount) return;
  showToast(`Mounting ${name} from ${activeBrowseAccount.accountName}...`, "info");

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

    if (result.success && result.imported_item) {
      showToast(`${name} mounted!`, "success");
      closeCloudPickerModal();
      await bootAuthenticatedDashboard();
    } else {
      showToast(`Mount failed: ${result.error}`, "error");
    }
  } catch (err) {
    showToast("Network fault during mount.", "error");
  }
}

// ========================================================================
// ⚙️ INITIALIZATION & GLOBAL LISTENERS
// ========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  initializeMobileScannerFeatures();

  // Workspace background right-click listener
  const pane = document.querySelector(".category-view-pane");
  if (pane) {
    pane.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".file-card") || e.target.closest(".file-list-row")) return;
      e.preventDefault();
      const menu = document.getElementById("vault-context-menu");
      if (!menu) return;
      menu.innerHTML = `
        <div class="ctx-header"><i class="ri-hard-drive-2-line"></i> <span>Vault Workspace</span></div>
        ${sessionLoginType !== "qr_restricted" ? `
          <div class="ctx-item" onclick="document.getElementById('vault-file-uploader').click(); hideCustomContextMenu();">
            <i class="ri-upload-cloud-2-line"></i> <span>Upload Files Here</span>
          </div>
          <div class="ctx-item" onclick="openCloudDriveManager(true); hideCustomContextMenu();">
            <i class="ri-cloud-line"></i> <span>Manage Cloud Accounts</span>
          </div>
        ` : ""}
        <div class="ctx-item" onclick="setExplorerViewMode(currentViewMode === 'tile' ? 'list' : 'tile'); hideCustomContextMenu();">
          <i class="ri-layout-grid-line"></i> <span>Switch Tile / List View</span>
        </div>
        <div class="ctx-item" onclick="renderCurrentFolderLevel(); hideCustomContextMenu();">
          <i class="ri-refresh-line"></i> <span>Refresh Explorer</span>
        </div>
      `;
      menu.style.display = "block";
      menu.style.left = `${Math.min(e.clientX, window.innerWidth - 230)}px`;
      menu.style.top = `${Math.min(e.clientY, window.innerHeight - 200)}px`;
    });
  }

  try {
    const check = await fetch("/api/check-session");
    const status = await check.json();
    if (typeof status.latest_event_id === "number") {
      lastSeenSyncEventId = status.latest_event_id;
    }
    if (status.authenticated) {
      if (status.session_id) currentSessionId = status.session_id;
      sessionLoginType = status.login_type || "master";
      if (status.restrictions) activeRestrictions = status.restrictions;
      await bootAuthenticatedDashboard();
    }
  } catch (e) {}
});

function toggleProfileDropdown() {
  if (sessionLoginType === "qr_restricted" && activeRestrictions.disable_profile) {
    showToast("Profile menu is locked in Restricted QR Session", "error");
    return;
  }
  const dropdown = document.getElementById("profile-menu-dropdown");
  if (!dropdown) return;
  dropdown.style.display = dropdown.style.display === "block" ? "none" : "block";
}

document.addEventListener("click", (event) => {
  const dropdown = document.getElementById("profile-menu-dropdown");
  const avatar = document.querySelector(".profile-avatar-pill");
  if (dropdown && dropdown.style.display === "block" && avatar) {
    if (!avatar.contains(event.target) && !dropdown.contains(event.target)) {
      dropdown.style.display = "none";
    }
  }
});

function showToast(message, type = "error") {
  const container = document.getElementById("custom-toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.style.cssText = "width:100%;padding:0 16px;";
  const borderCol = type === "success" ? "#22c55e" : type === "info" ? "#3b82f6" : "#ef4444";
  const icon =
    type === "success" ? "ri-checkbox-circle-fill" : type === "info" ? "ri-information-fill" : "ri-error-warning-fill";
  toast.innerHTML = `<div style="background:#0f172a;color:white;border-left:4px solid ${borderCol};padding:12px 16px;border-radius:var(--radius-btn);box-shadow:0 10px 25px rgba(0,0,0,0.3);display:flex;align-items:center;gap:10px;font-size:12.5px;font-weight:600;"><i class="${icon}" style="color:${borderCol};font-size:18px;"></i><span>${message}</span></div>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

async function submitPasswordChange() {
  const currentPassword = document.getElementById("currentPassword")?.value;
  const newPassword = document.getElementById("newPassword")?.value;
  const confirmPassword = document.getElementById("confirmPassword")?.value;
  if (!currentPassword || !newPassword || newPassword !== confirmPassword) {
    showToast("Check password fields!", "error");
    return;
  }
  const res = await fetch("/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
  });
  const data = await res.json();
  if (data.success) {
    showToast("Master key updated!", "success");
    togglePasswordModal(false);
  } else {
    showToast(data.message || "Update failed", "error");
  }
}

window.addEventListener("message", (event) => {
  if (event.data && event.data.status === "success") {
    showToast("Cloud account connected!", "success");
    loadConnectedCloudAccounts();
    bootAuthenticatedDashboard();
  }
});