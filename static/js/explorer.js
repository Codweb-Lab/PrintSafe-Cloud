// ========================================================================
// 📂 PRINTSAFE CLOUD — EXPLORER, PRINT QUEUE & UPLOAD ENGINE (explorer.js)
// ========================================================================
let lazyFilteredItems = [];

function formatFileSize(bytes) {
  const num = Number(bytes || 0);
  if (!num || num <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(num) / Math.log(1024)));
  const val = num / Math.pow(1024, idx);
  if (idx === 0) return `${Math.round(val)} B`;
  return `${val.toFixed(2)} ${units[idx]}`;
}
window.formatFileSize = formatFileSize;

function formatCombinedCapacity(bytes) {
  const num = Number(bytes || 0);
  if (!num || num <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(num) / Math.log(1024)));
  const val = num / Math.pow(1024, idx);
  if (idx === 0) return `${Math.round(val)} B`;

  // If TB value has sub-0.01 fractional GB (e.g., 5 TB + 5 GB = 5.00488 TB), show 3 decimals cleanly
  const twoDec = val.toFixed(2);
  if (idx === 4 && twoDec.endsWith(".00") && val > Math.floor(val)) {
    return `${val.toFixed(3)} ${units[idx]}`;
  }
  return `${twoDec} ${units[idx]}`;
}
window.formatCombinedCapacity = formatCombinedCapacity;

function applySmartNameMarquee(rootContainer = document) {
  requestAnimationFrame(() => {
    rootContainer.querySelectorAll(".ps-marquee-wrap").forEach((wrap) => {
      const track = wrap.querySelector(".ps-marquee-track");
      if (!track) return;
      wrap.classList.remove("is-overflowing");
      track.style.removeProperty("--marquee-shift");

      const overflowPx = track.scrollWidth - wrap.clientWidth;
      if (overflowPx > 4) {
        wrap.classList.add("is-overflowing");
        track.style.setProperty("--marquee-shift", `-${overflowPx + 14}px`);
      }
    });
  });
}

function isCloudlyBentoActive() {
  return document.documentElement.getAttribute("data-style") === "cloudly";
}

function getPeekDocumentsFromFolder(item) {
  const children = Array.isArray(item.children) ? item.children : [];
  const docFiles = children.filter((c) => c && c.type !== "folder");
  const first = docFiles[0] || children[0] || null;
  const second = docFiles[1] || children[1] || null;

  const getTag = (node, fallback) => {
    if (!node) return fallback;
    if (node.type === "folder") return "DIR";
    const ext = (node.name || "").split(".").pop().toUpperCase();
    return ext && ext.length <= 5 ? ext : fallback;
  };

  return {
    backTag: getTag(second, "DOC"),
    frontTag: getTag(first, "PDF"),
    frontTitle: first ? first.name : item.name
  };
}

function getFolderEdgeCloudBadgeHTML(item) {
  const prov = (item.provider || "local").toLowerCase();
  const accLabel =
    item.account_name ||
    (prov === "google" ? "Google Drive" : prov === "onedrive" ? "OneDrive" : "Vault");

  let iconClass = "ri-shield-check-fill";
  let iconColor = "var(--accent)";
  if (prov === "google") {
    iconClass = "ri-google-fill";
    iconColor = "#ea4335";
  } else if (prov === "onedrive") {
    iconClass = "ri-microsoft-fill";
    iconColor = "#0078d4";
  } else if (prov === "sftp" || prov === "ftp") {
    iconClass = "ri-server-fill";
    iconColor = "#38bdf8";
  }

  return `
    <span class="folder-edge-cloud-pill" title="${accLabel}">
      <i class="${iconClass}" style="color:${iconColor};"></i>
      <span class="ps-marquee-wrap">
        <span class="ps-marquee-track">${accLabel}</span>
      </span>
    </span>`;
}

function buildFolderThumbnailHtml(item, iconClass, iconColor) {
  const childCount = Array.isArray(item.children) ? item.children.length : 0;
  const badgeText = childCount === 1 ? "1 item" : `${childCount} items`;

  if (!isCloudlyBentoActive()) {
    return `
      <div class="std-theme-folder-box" aria-hidden="true">
        <i class="ri-folder-3-fill folder-icon-closed" style="color:${iconColor};"></i>
        <i class="ri-folder-open-fill folder-icon-open" style="color:${iconColor};"></i>
        <span class="std-theme-folder-count">${badgeText}</span>
      </div>`;
  }

  const peek = getPeekDocumentsFromFolder(item);
  const fUid = `fpeek-${Math.random().toString(36).substring(2, 9)}`;

  let peekDocsHtml = "";
  if (childCount > 0) {
    setTimeout(() => hydrateFolderPeekThumbnails(item, fUid), 30);
    const backSheetHtml =
      childCount > 1
        ? `<div class="peek-doc doc-back" id="${fUid}-back"><span class="peek-doc-tag">${peek.backTag}</span></div>`
        : "";
    peekDocsHtml = `
      ${backSheetHtml}
      <div class="peek-doc doc-front" id="${fUid}-front">
        <span class="peek-doc-tag">${peek.frontTag}</span>
        <div class="peek-doc-line"></div>
        <div class="peek-doc-line short"></div>
      </div>`;
  }

  return `
    <div class="cloudly-3d-folder" id="${fUid}" aria-hidden="true">
      <div class="folder-back-tab"></div>
      <div class="folder-back-body"></div>
      ${peekDocsHtml}
      <div class="folder-front-pocket">
        <span class="folder-pocket-badge">${badgeText}</span>
      </div>
    </div>`;
}

async function hydrateFolderPeekThumbnails(folderItem, fUid) {
  const rootEl = document.getElementById(fUid);
  if (!rootEl || !Array.isArray(folderItem.children)) return;

  const previewable = folderItem.children.filter((c) => c && c.type !== "folder").slice(0, 2);
  if (previewable.length === 0) return;

  const slots = [
    { file: previewable[0], slotId: `${fUid}-front` },
    { file: previewable[1], slotId: `${fUid}-back` }
  ];

  for (const { file, slotId } of slots) {
    if (!file) continue;
    const slotEl = document.getElementById(slotId);
    if (!slotEl) continue;

    const relPath = `${folderItem.name}/${file.name}`;
    const cacheKey = file.remote_path || file.cloud_id || relPath;

    if (thumbnailCache[cacheKey]?.status === "success") {
      slotEl.style.padding = "0";
      slotEl.innerHTML = `<img class="peek-thumb-img" src="${thumbnailCache[cacheKey].dataUrl}" alt="">`;
      continue;
    }

    try {
      const res = await fetch("/fetch-file-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: savedPassword,
          filename: relPath,
          cloud_id: file.cloud_id || null,
          account_id: file.account_id || folderItem.account_id || null,
          storage_id: file.storage_id || folderItem.storage_id || null,
          remote_path: file.remote_path || null,
          session_id: currentSessionId
        })
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.base64) continue;

      if (file.file_type === "pdf") {
        const binary = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
        const pdf = await pdfjsLib.getDocument({ data: binary.buffer }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.28 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const url = canvas.toDataURL();
        thumbnailCache[cacheKey] = { status: "success", dataUrl: url };
        if (document.getElementById(slotId)) {
          document.getElementById(slotId).style.padding = "0";
          document.getElementById(slotId).innerHTML = `<img class="peek-thumb-img" src="${url}" alt="">`;
        }
      } else {
        const url = `data:image/jpeg;base64,${data.base64}`;
        thumbnailCache[cacheKey] = { status: "success", dataUrl: url };
        if (document.getElementById(slotId)) {
          document.getElementById(slotId).style.padding = "0";
          document.getElementById(slotId).innerHTML = `<img class="peek-thumb-img" src="${url}" alt="">`;
        }
      }
    } catch (e) {}
  }
}

function getActiveUploadFolderContext() {
  if (!Array.isArray(currentFolderNavigation) || currentFolderNavigation.length === 0) {
    return null;
  }
  let walker = globalVaultTree || [];
  let ctx = null;
  let inheritedProvider = "";
  let inheritedAccountId = "";
  let inheritedAccountName = "";
  let inheritedStorageId = "";

  for (const seg of currentFolderNavigation) {
    const match = walker.find((n) => n.type === "folder" && n.name === seg);
    if (!match) break;

    if (match.provider) inheritedProvider = String(match.provider).toLowerCase();
    if (match.account_id) inheritedAccountId = match.account_id;
    if (match.account_name) inheritedAccountName = match.account_name;
    if (match.storage_id) inheritedStorageId = match.storage_id;

    ctx = {
      name: match.name,
      provider: (match.provider || inheritedProvider || "google").toLowerCase(),
      cloud_id: match.cloud_id || "",
      account_id: match.account_id || inheritedAccountId || "",
      account_name: match.account_name || inheritedAccountName || "",
      storage_id: match.storage_id || inheritedStorageId || "",
      remote_path: match.remote_path || "",
      is_expired: Boolean(match.is_expired)
    };
    walker = match.children || [];
  }
  return ctx;
}

// ========================================================================
// 📤 FLOATING UPLOAD ACTION MENU (FIXED-POSITION + EVENT DELEGATION)
// ========================================================================
function toggleFloatingUploadMenu(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  const fab = document.getElementById("floating-upload-fab");
  let menu = document.getElementById("floating-upload-menu");
  if (!fab || !menu) return;

  if (menu.parentElement !== document.body) {
    document.body.appendChild(menu);
  }

  const isOpen = menu.classList.contains("open");
  if (isOpen) {
    closeFloatingUploadMenu();
    return;
  }

  const rect = fab.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.right = `${Math.max(16, window.innerWidth - rect.right)}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 10}px`;
  menu.style.left = "auto";
  menu.style.top = "auto";
  menu.style.zIndex = "100040";
  menu.classList.add("open");
  menu.style.display = "flex";
}

function closeFloatingUploadMenu() {
  const menu = document.getElementById("floating-upload-menu");
  if (menu) {
    menu.classList.remove("open");
    menu.style.display = "none";
  }
}

function triggerNormalUploadFromFab() {
  closeFloatingUploadMenu();
  const uploader = document.getElementById("vault-file-uploader");
  if (uploader) uploader.click();
}

function triggerDocScannerFromFab() {
  closeFloatingUploadMenu();
  const folderCtx = typeof getActiveUploadFolderContext === "function" ? getActiveUploadFolderContext() : null;
  if (window.PrintSafeScanner && typeof window.PrintSafeScanner.open === "function") {
    window.PrintSafeScanner.open(folderCtx);
  } else {
    alert("Scanner script not loaded yet. Please press Ctrl+Shift+R to hard refresh.");
  }
}

document.addEventListener(
  "click",
  (e) => {
    const fab = e.target.closest("#floating-upload-fab");
    if (fab) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleFloatingUploadMenu(e);
      return;
    }

    const menu = document.getElementById("floating-upload-menu");
    if (menu && menu.classList.contains("open") && !menu.contains(e.target)) {
      closeFloatingUploadMenu();
    }
  },
  true
);

// ========================================================================
// 🔍 FILTER, SORT & VIEW MODE CONTROLLERS
// ========================================================================
function applyQuickTypeFilter(type, el) {
  currentFilterType = type;
  document.querySelectorAll(".filter-pill").forEach((p) => p.classList.remove("active"));
  if (el) el.classList.add("active");
  renderCurrentFolderLevel();
}

function selectModernSort(sortVal, labelText, iconClass, itemEl) {
  const input = document.getElementById("drive-sort-by");
  const label = document.getElementById("sort-trigger-label");
  const icon = document.getElementById("sort-trigger-icon");
  if (input) input.value = sortVal;
  if (label) label.innerText = labelText;
  if (icon) icon.className = iconClass;

  const wrapper = document.getElementById("dropdown-sort-by");
  if (wrapper) {
    wrapper.querySelectorAll(".modern-dropdown-item").forEach((i) => i.classList.remove("active"));
  }
  if (itemEl) itemEl.classList.add("active");
  closeAllModernDropdowns();
  renderCurrentFolderLevel();
}

function setExplorerViewMode(mode) {
  currentViewMode = mode;
  localStorage.setItem("vault_view_mode", mode);
  document.getElementById("view-btn-tile")?.classList.toggle("active", mode === "tile");
  document.getElementById("view-btn-list")?.classList.toggle("active", mode === "list");
  renderCurrentFolderLevel();
}

// ========================================================================
// 🖨️ "TO BE PRINTED" WISHLIST QUEUE
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
  window.activeWorkspaceTab = "explorer";
  const dashView = document.getElementById("cloudly-dashboard-view");
  const explorerView = document.getElementById("file-manager-dashboard");
  if (dashView) dashView.style.display = "none";
  if (explorerView) explorerView.style.display = "flex";

  document.querySelectorAll(".rail-btn").forEach((b) => b.classList.remove("active"));
  document.getElementById("nav-print-queue-btn")?.classList.add("active");

  const pill = document.getElementById("pill-print-queue");
  applyQuickTypeFilter("print_queue", pill);
}

// ========================================================================
// 📁 FOLDER LEVEL RENDERER (TILE & LIST MODES)
// ========================================================================
function renderCurrentFolderLevel() {
  const grid = document.getElementById("main-explorer-grid");
  const pathDisplay = document.getElementById("current-folder-path-display");
  const backBtn = document.getElementById("back-folder-btn");
  if (!grid) return;

  closeFloatingUploadMenu();

  if (typeof updateUploadButtonVisibility === "function") {
    updateUploadButtonVisibility();
  }

  if (activeThumbnailRequests.length > 0) {
    activeThumbnailRequests.forEach((c) => {
      try { c.abort(); } catch (e) {}
    });
    activeThumbnailRequests = [];
  }
  grid.innerHTML = "";
  grid.style.display = "";
  grid.style.alignItems = "";
  grid.style.justifyContent = "";
  grid.style.flex = "";

  const searchQuery = (document.getElementById("drive-search-input")?.value || "").toLowerCase().trim();
  const typeFilter = currentFilterType;
  const sortBy = document.getElementById("drive-sort-by")?.value || "name-asc";
  const cloudlyMode = isCloudlyBentoActive();

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

    let matchesAccount = true;
    if (currentFolderNavigation.length === 0 && window.activeProviderFilter !== "all") {
      if (window.activeAccountFilterId) {
        matchesAccount = (item.account_id === window.activeAccountFilterId) || (item.provider === window.activeProviderFilter);
      } else {
        matchesAccount = (item.provider || "").toLowerCase() === window.activeProviderFilter;
      }
    }

    return matchesSearch && matchesType && matchesAccount;
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
    grid.style.display = "flex";
    grid.style.flex = "1";
    grid.style.alignItems = "center";
    grid.style.justifyContent = "center";

    const isPrintQueue = typeFilter === "print_queue";
    const isInsideFolder = currentFolderNavigation.length > 0;
    const emptyTitle = isPrintQueue ? "Print Queue is Empty" : "No items found in this directory";
    const emptyMsg = isPrintQueue
      ? "No files added to 'To Be Printed' queue yet. Click the printer icon on any file card to add it here."
      : isInsideFolder
      ? "This folder is currently empty. Use the 'Upload Here' button at the bottom right to upload or scan documents directly here."
      : "Mount folders from your connected Cloud Drive or Hosting SFTP/FTP storage to view and manage files.";

    grid.innerHTML = `
      <div class="vault-empty-state" style="max-width:410px;text-align:center;color:var(--text-sub);padding:16px 20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;">
        <i class="${isPrintQueue ? "ri-printer-cloud-line" : "ri-folder-open-line"}" style="font-size:46px;display:block;margin-bottom:4px;opacity:0.55;"></i>
        <div class="empty-title" style="font-size:15px;font-weight:700;color:var(--text-title);">${emptyTitle}</div>
        <div class="empty-desc" style="font-size:12.5px;line-height:1.5;color:var(--text-sub);">${emptyMsg}</div>
      </div>`;
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
      const iconColor = item.is_expired
        ? "#94a3b8"
        : isFolder
        ? cloudlyMode
          ? "#FF8132"
          : "#f59e0b"
        : item.file_type === "pdf"
        ? "#ef4444"
        : "#3b82f6";
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
      if (qBtn) qBtn.onclick = (ev) => togglePrintQueueItem(ev, item, relativeFilePath);

      row.onclick = () => handleItemClick(item, relativeFilePath, row);
      row.oncontextmenu = (e) => openCustomContextMenu(e, item, relativeFilePath, row);

      if (!isFolder && !item.is_expired) {
        setTimeout(() => fetchAndRenderSingleThumbnail(relativeFilePath, item, thumbId), 10);
      }
      grid.appendChild(row);
    });
  } else {
    grid.className = "file-grid";
    [...folders, ...files].forEach((item) => {
      const card = document.createElement("div");
      const isFolder = item.type === "folder";
      card.className = `file-card ${isFolder ? "is-folder-card" : ""} ${item.is_expired ? "expired-card" : ""}`;
      const displayName = isFolder ? getDisplayFolderName(item.name) : item.name;
      const iconClass = isFolder ? "ri-folder-3-fill" : item.file_type === "pdf" ? "ri-file-pdf-2-fill" : "ri-image-2-fill";
      const iconColor = item.is_expired
        ? "#94a3b8"
        : isFolder
        ? cloudlyMode
          ? "#FF8132"
          : "#f59e0b"
        : item.file_type === "pdf"
        ? "#ef4444"
        : "#3b82f6";
      const thumbId = `thumb-${Math.random().toString(36).substring(2, 9)}`;
      const relativeFilePath =
        item.item_path || (currentFolderNavigation.length > 0 ? currentFolderNavigation.join("/") + "/" + item.name : item.name);
      const inQueue = !isFolder && isItemInPrintQueue(relativeFilePath);

      if (isFolder) {
        card.innerHTML = `
          <div class="file-thumbnail-zone" id="${thumbId}" style="position:relative;height:104px;margin-bottom:10px;">
            ${buildFolderThumbnailHtml(item, iconClass, iconColor)}
            ${getFolderEdgeCloudBadgeHTML(item)}
          </div>
          <div class="file-info" style="flex-direction:column;align-items:center;text-align:center;gap:3px;">
            <span class="ps-marquee-wrap" title="${displayName}" style="width:100%;">
              <span class="ps-marquee-track" style="font-weight:700;font-size:13.5px;color:var(--text-title);">${displayName}</span>
            </span>
            ${item.is_expired ? `<span style="font-size:10.5px;color:#ef4444;font-weight:700;">Session Expired · Reconnect</span>` : ""}
          </div>
        `;
      } else {
        card.innerHTML = `
          <div class="file-thumbnail-zone" id="${thumbId}" style="position:relative;">
            <div class="vault-spinner"></div>
            <button class="queue-star-btn floating ${inQueue ? "active" : ""}" title="${inQueue ? "In To Be Printed Queue" : "Add to To Be Printed"}">
              <i class="${inQueue ? "ri-printer-fill" : "ri-printer-line"}"></i>
            </button>
          </div>
          <div class="file-info" style="flex-direction:column;align-items:flex-start;gap:5px;">
            <div style="display:flex;align-items:center;gap:6px;width:100%;">
              <i class="${iconClass}" style="color:${iconColor};font-size:15px;flex-shrink:0;"></i>
              <span class="ps-marquee-wrap" title="${displayName}" style="flex:1;min-width:0;">
                <span class="ps-marquee-track" style="font-weight:700;">${displayName}</span>
              </span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
              ${getProviderBadgeHTML(item)}
              <span style="font-size:10.5px;color:var(--text-sub);font-weight:600;">${formatFileSize(item.size)}</span>
            </div>
          </div>
        `;
      }

      const qBtn = card.querySelector(".queue-star-btn");
      if (qBtn) qBtn.onclick = (ev) => togglePrintQueueItem(ev, item, relativeFilePath);

      card.onclick = () => handleItemClick(item, relativeFilePath, card);
      card.oncontextmenu = (e) => openCustomContextMenu(e, item, relativeFilePath, card);

      if (!isFolder && !item.is_expired) {
        setTimeout(() => fetchAndRenderSingleThumbnail(relativeFilePath, item, thumbId), 15);
      }
      grid.appendChild(card);
    });
    applySmartNameMarquee(grid);
  }
}

window.activeProviderFilter = "all";
window.activeAccountFilterId = null;

function getProviderBadgeHTML(item) {
  const prov = (item.provider || "local").toLowerCase();
  const accLabel = item.account_name || (prov === "google" ? "Google Drive" : prov === "onedrive" ? "OneDrive" : "Encrypted Vault");

  let iconClass = "ri-shield-check-fill";
  if (prov === "google") iconClass = "ri-google-fill";
  else if (prov === "onedrive") iconClass = "ri-microsoft-fill";
  else if (prov === "sftp" || prov === "ftp") iconClass = "ri-server-fill";

  return `
    <span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--accent-soft);color:var(--accent);border:1px solid rgba(56,189,248,0.28);max-width:165px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${accLabel}">
      <i class="${iconClass}" style="font-size:11px;flex-shrink:0;"></i>
      <span style="overflow:hidden;text-overflow:ellipsis;">${accLabel}</span>
    </span>
  `;
}

function filterVaultByAccount(provider, accountId = null, el = null) {
  window.activeWorkspaceTab = "explorer";
  const dashView = document.getElementById("cloudly-dashboard-view");
  const explorerView = document.getElementById("file-manager-dashboard");
  if (dashView) dashView.style.display = "none";
  if (explorerView) explorerView.style.display = "flex";

  window.activeProviderFilter = provider || "all";
  window.activeAccountFilterId = accountId || null;
  currentFilterType = "all";
  currentFolderNavigation = [];

  document.querySelectorAll(".rail-btn, .sidebar-nav-item").forEach((b) => b.classList.remove("active"));
  if (provider === "all") {
    document.getElementById("nav-all-vault-btn")?.classList.add("active");
  } else if (el) {
    el.closest(".rail-btn, .sidebar-nav-item")?.classList.add("active");
  }

  document.querySelectorAll(".quick-filter-pills-bar .filter-pill").forEach((p, idx) => {
    p.classList.toggle("active", idx === 0);
  });

  updateCloudSummaryBadges();
  renderCurrentFolderLevel();
}

// ========================================================================
// 🖱️ FOLDER NAVIGATION & FILE PREVIEW DISPATCHER
// ========================================================================
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
        const res = await fetch(`/api/cloud/fetch/${item.account_id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder_id: item.cloud_id })
        });
        const data = await res.json();
        if (data.authenticated && Array.isArray(data.tree)) {
          item.children = data.tree;
        }
      } catch (e) {}
    }
    currentFolderNavigation.push(item.name);
    renderCurrentFolderLevel();
  } else {
    if (typeof closeCloudPickerModal === "function") {
      closeCloudPickerModal();
    }
    showIntegratedPreview(
      relativeFilePath,
      item.file_type,
      element,
      "",
      item.cloud_id || null,
      item.account_id || null,
      item.account_name || "Local Vault",
      item.provider || "local",
      item.storage_id || null,
      item.remote_path || null
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
// 🖼️ THUMBNAIL RENDERER (SUPPORTS LOCAL, CLOUD & SFTP/FTP)
// ========================================================================
async function fetchAndRenderSingleThumbnail(relativeFilePath, item, thumbId) {
  const placeholder = document.getElementById(thumbId);
  if (!placeholder) return;

  const fileType = item.file_type;
  const cacheKey = item.remote_path || item.cloud_id || relativeFilePath;
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

  if (thumbnailCache[cacheKey]) {
    if (thumbnailCache[cacheKey].status === "protected") {
      setThumbnailContent(`<div class="protected-badge"><i class="ri-lock-2-fill"></i> Locked</div>`);
    } else if (thumbnailCache[cacheKey].status === "success") {
      setThumbnailContent(`<img src="${thumbnailCache[cacheKey].dataUrl}" alt="thumb">`);
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
        cloud_id: item.cloud_id || null,
        account_id: item.account_id || null,
        storage_id: item.storage_id || null,
        remote_path: item.remote_path || null,
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
          thumbnailCache[cacheKey] = { status: "success", dataUrl: finalDataUrl };
          setThumbnailContent(`<img src="${finalDataUrl}" alt="pdf">`);
        })
        .catch((err) => {
          if (err.name === "PasswordException") {
            protectedFilesList[relativeFilePath] = true;
            thumbnailCache[cacheKey] = { status: "protected" };
            setThumbnailContent(`<div class="protected-badge"><i class="ri-lock-2-fill"></i> Locked</div>`);
          } else {
            setThumbnailContent(fallbackIcon);
          }
        });
    } else {
      const srcDataUrl = `data:image/jpeg;base64,${fileData.base64}`;
      thumbnailCache[cacheKey] = { status: "success", dataUrl: srcDataUrl };
      setThumbnailContent(`<img src="${srcDataUrl}" alt="img">`);
    }
  } catch (e) {
    if (e.name !== "AbortError") setThumbnailContent(fallbackIcon);
  }
}

// ========================================================================
// 🖱️ RIGHT-CLICK CONTEXT MENU (WITH CONFIRMATION & PERMANENT DELETE)
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
  const isRestricted = sessionLoginType === "qr_restricted";
  const canUploadHere = !isRestricted && Boolean(getActiveUploadFolderContext());

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
      <span>Source: ${accName}</span>
    </div>
    ${!isRestricted ? `
      <div class="ctx-divider"></div>
      ${canUploadHere ? `
        <div class="ctx-item" onclick="document.getElementById('vault-file-uploader').click(); hideCustomContextMenu();">
          <i class="ri-upload-cloud-2-line"></i>
          <span>Upload File Here</span>
        </div>
        <div class="ctx-item" onclick="hideCustomContextMenu(); triggerDocScannerFromFab();">
          <i class="ri-scan-2-line"></i>
          <span>Scan Document Here</span>
        </div>
      ` : ""}
      ${isFolder ? `
        <div class="ctx-item" onclick="ctxConfirmUnmountFolder()" style="color:#ef4444;">
          <i class="ri-link-unlink-m"></i>
          <span>Remove / Unmount Folder</span>
        </div>
      ` : `
        <div class="ctx-item" onclick="ctxConfirmDeleteFilePermanently()" style="color:#ef4444;">
          <i class="ri-delete-bin-6-line"></i>
          <span>Delete File Permanently</span>
        </div>
      `}
    ` : ""}
  `;

  menu.style.display = "block";
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 245)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 280)}px`;
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
  if (typeof closeCloudPickerModal === "function") closeCloudPickerModal();
  await showIntegratedPreview(
    relativePath,
    item.file_type,
    domElement,
    "",
    item.cloud_id || null,
    item.account_id || null,
    item.account_name,
    item.provider,
    item.storage_id || null,
    item.remote_path || null
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

function ctxConfirmUnmountFolder() {
  hideCustomContextMenu();
  if (!contextMenuTargetItem) return;
  const { item } = contextMenuTargetItem;

  openSessionConfirmModal(
    "Unmount / Remove Folder?",
    `Are you sure you want to remove "${item.name}" from your PrintSafe Cloud workspace?`,
    "Yes, Remove Folder",
    async () => {
      try {
        const res = await fetch("/api/vault/remove-mounted", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: item.name,
            cloud_id: item.cloud_id || "",
            storage_id: item.storage_id || ""
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          globalVaultTree = globalVaultTree.filter((n) => n.name !== item.name);
          renderCurrentFolderLevel();
          showToast(data.message || `"${item.name}" removed from Vault!`, "success");
        } else {
          showToast(data.error || "Could not remove folder", "error");
        }
      } catch (e) {
        showToast("Network error while removing folder", "error");
      }
    }
  );
}

function ctxConfirmDeleteFilePermanently() {
  hideCustomContextMenu();
  if (!contextMenuTargetItem) return;
  const { item, relativePath } = contextMenuTargetItem;
  const provLabel =
    item.provider === "google"
      ? "Google Drive"
      : item.provider === "onedrive"
      ? "Microsoft OneDrive"
      : item.provider === "sftp" || item.provider === "ftp"
      ? `Hosting ${item.provider.toUpperCase()} Server`
      : "Encrypted Vault";

  openSessionConfirmModal(
    "⚠️ STRICT WARNING: Permanent File Deletion",
    `You are about to PERMANENTLY DELETE "${item.name}" directly from ${provLabel}. This file will be erased from the source storage and CANNOT be recovered!`,
    "Delete Permanently",
    async () => {
      try {
        showToast(`Deleting "${item.name}" from ${provLabel}...`, "info");
        const res = await fetch("/api/vault/delete-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: item.provider || "local",
            filename: relativePath,
            cloud_id: item.cloud_id || "",
            account_id: item.account_id || "",
            storage_id: item.storage_id || "",
            remote_path: item.remote_path || ""
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          if (activeFile && activeFile.name === relativePath) {
            closePreviewPane();
          }
          let targetArray = globalVaultTree;
          for (const folderName of currentFolderNavigation) {
            const found = targetArray.find((n) => n.type === "folder" && n.name === folderName);
            if (found && Array.isArray(found.children)) targetArray = found.children;
          }
          const idx = targetArray.findIndex((n) => n.name === item.name && n.type === "file");
          if (idx !== -1) targetArray.splice(idx, 1);

          await loadPrintQueue();
          renderCurrentFolderLevel();
          showToast(data.message || `"${item.name}" permanently deleted!`, "success");
        } else {
          showToast(data.error || "Failed to delete file", "error");
        }
      } catch (e) {
        showToast("Network error while deleting file", "error");
      }
    }
  );
}

document.addEventListener("click", hideCustomContextMenu);

// ========================================================================
// 📤 UPLOAD HANDLER (DIRECT TO ACTIVE MOUNTED CLOUD OR SFTP/FTP FOLDER)
// ========================================================================
async function handleCurrentFolderUpload(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;

  const folderCtx = getActiveUploadFolderContext();
  if (!folderCtx) {
    showToast("Open a mounted Cloud Drive or SFTP/FTP folder first to upload files.", "error");
    event.target.value = "";
    return;
  }

  const currentPath = currentFolderNavigation.join("/");
  const displayFolder = folderCtx.name;
  const grid = document.getElementById("main-explorer-grid");
  if (grid && grid.classList.contains("empty-state")) {
    grid.className = "file-grid";
    grid.style.display = "";
    grid.style.alignItems = "";
    grid.style.justifyContent = "";
    grid.style.minHeight = "";
    grid.innerHTML = "";
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const dummyId = `upload-dummy-${Date.now()}-${i}`;

    const dummyCard = document.createElement("div");
    dummyCard.id = dummyId;
    dummyCard.className = "file-card";
    dummyCard.style.borderStyle = "dashed";
    dummyCard.style.borderColor = "var(--accent)";
    dummyCard.innerHTML = `
      <div class="file-thumbnail-zone" style="flex-direction:column;gap:8px;padding:10px;">
        <i class="ri-upload-cloud-2-line" style="font-size:28px;color:var(--accent);"></i>
        <div style="width:100%;height:6px;background:var(--border);border-radius:99px;overflow:hidden;">
          <div id="${dummyId}-bar" style="width:0%;height:100%;background:var(--accent-gradient);transition:width 0.15s;"></div>
        </div>
        <span id="${dummyId}-pct" style="font-size:11px;font-weight:700;color:var(--accent);">0%</span>
      </div>
      <div class="file-info" style="flex-direction:column;align-items:flex-start;gap:4px;">
        <span class="file-name" title="${file.name}">${file.name}</span>
        <span style="font-size:10px;color:var(--text-sub);">Uploading to ${displayFolder}...</span>
      </div>
    `;
    if (grid) grid.prepend(dummyCard);

    await new Promise((resolve) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("folder_path", currentPath);

      if (folderCtx.storage_id) {
        formData.append("storage_id", folderCtx.storage_id);
        formData.append("remote_dir", folderCtx.remote_path);
      }
      if (folderCtx.cloud_id && folderCtx.account_id) {
        formData.append("cloud_folder_id", folderCtx.cloud_id);
        formData.append("account_id", folderCtx.account_id);
        formData.append("provider", folderCtx.provider);
      }

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload-file", true);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          const bar = document.getElementById(`${dummyId}-bar`);
          const lbl = document.getElementById(`${dummyId}-pct`);
          if (bar) bar.style.width = pct + "%";
          if (lbl) lbl.innerText = pct + "%";
        }
      };

      xhr.onload = () => {
        document.getElementById(dummyId)?.remove();
        let result = {};
        try { result = JSON.parse(xhr.responseText); } catch (e) {}

        if (xhr.status === 200 && result.success && result.file_item) {
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
          showToast(result.error || `Failed to upload ${file.name}`, "error");
        }
        resolve();
      };

      xhr.onerror = () => {
        document.getElementById(dummyId)?.remove();
        showToast("Network error during upload.", "error");
        resolve();
      };

      xhr.send(formData);
    });
  }

  event.target.value = "";
  renderCurrentFolderLevel();
}

// ========================================================================
// 📊 MODULAR DASHBOARD OVERVIEW CONTROLLER
// ========================================================================
function openDashboardOverview() {
  window.activeWorkspaceTab = "dashboard";
  const dashView = document.getElementById("cloudly-dashboard-view");
  const explorerView = document.getElementById("file-manager-dashboard");
  if (dashView) dashView.style.display = "grid";
  if (explorerView) explorerView.style.display = "none";

  document.querySelectorAll(".rail-btn").forEach((b) => b.classList.remove("active"));
  document.getElementById("nav-dashboard-btn")?.classList.add("active");

  if (typeof updateUploadButtonVisibility === "function") {
    updateUploadButtonVisibility();
  }
  if (typeof applyLiveRestrictionsUI === "function") {
    applyLiveRestrictionsUI();
  }
  renderCloudlyDashboardOverview();
}
window.openDashboardOverview = openDashboardOverview;

function switchToVaultExplorerFromDash(providerFilter = "all") {
  filterVaultByAccount(providerFilter, null, document.getElementById("nav-all-vault-btn"));
}
window.switchToVaultExplorerFromDash = switchToVaultExplorerFromDash;

function openPrintQueueFromDash() {
  openPrintQueueView();
}
window.openPrintQueueFromDash = openPrintQueueFromDash;

function openDashCreateFolderPrompt() {
  switchToVaultExplorerFromDash("all");
  showToast("Open any mounted drive folder and click Upload / New Folder.", "info");
}

function renderCloudlyDashboardOverview() {
  const userName = (document.getElementById("dropdown-user-name")?.innerText || "User").trim();
  const headingEl = document.getElementById("dash-welcome-heading");
  if (headingEl) {
    headingEl.innerText = `Welcome Back${userName && userName !== "User" ? `, ${userName}` : ""}!`;
  }

  const allFolders = [];
  const allFiles = [];
  let sftpUsedBytes = 0;
  let localUsedBytes = 0;

  function walkNodes(nodes, parentPath = "") {
    (nodes || []).forEach((node) => {
      if (!node) return;
      const curPath = parentPath ? `${parentPath}/${node.name}` : node.name;
      const prov = (node.provider || "local").toLowerCase();
      if (node.type === "folder") {
        allFolders.push({ ...node, _relPath: curPath });
        walkNodes(node.children || [], curPath);
      } else {
        const sz = Number(node.size || 0);
        allFiles.push({ ...node, _relPath: node.item_path || curPath });
        if (prov === "sftp" || prov === "ftp") sftpUsedBytes += sz;
        else if (prov === "local") localUsedBytes += sz;
      }
    });
  }
  walkNodes(globalVaultTree || []);

  // Aggregate combined storage per provider across ALL connected accounts
  const gAccs = (connectedAccountsList || []).filter((a) => a.provider === "google" && a.is_enabled !== false);
  const oAccs = (connectedAccountsList || []).filter((a) => a.provider === "onedrive" && a.is_enabled !== false);
  const sServs = (connectedRemoteStoragesList || []).filter((s) => s.is_enabled !== false);

  const gUsed = gAccs.reduce((sum, a) => sum + Number(a.used_bytes || 0), 0);
  const gTotal = gAccs.reduce((sum, a) => sum + Number(a.total_bytes || 0), 0);
  const oUsed = oAccs.reduce((sum, a) => sum + Number(a.used_bytes || 0), 0);
  const oTotal = oAccs.reduce((sum, a) => sum + Number(a.total_bytes || 0), 0);

  const gFilesCount = allFiles.filter((f) => (f.provider || "").toLowerCase() === "google").length;
  const oFilesCount = allFiles.filter((f) => (f.provider || "").toLowerCase() === "onedrive").length;
  const sFilesCount = allFiles.filter((f) => ["sftp", "ftp"].includes((f.provider || "").toLowerCase())).length;

  // 1. Render Cloud-Wise Combined Usage / Total Cards
  const statsGrid = document.getElementById("dash-provider-cards");
  if (statsGrid) {
    const gPct = gTotal > 0 ? Math.min(100, Math.round((gUsed / gTotal) * 100)) : 0;
    const oPct = oTotal > 0 ? Math.min(100, Math.round((oUsed / oTotal) * 100)) : 0;
    const pqCount = (printQueueItems || []).length;

    const cards = [
      {
        title: "Google Drive",
        icon: "ri-google-fill",
        color: "#7CA1FF",
        count: `${gFilesCount} Mounted Files`,
        sub: `${gAccs.length} ${gAccs.length === 1 ? "Account" : "Accounts"}`,
        usedStr: formatFileSize(gUsed),
        totalStr: gTotal > 0 ? formatFileSize(gTotal) : "∞",
        pct: gPct,
        onView: `switchToVaultExplorerFromDash('google')`
      },
      {
        title: "OneDrive",
        icon: "ri-microsoft-fill",
        color: "#FF7DA0",
        count: `${oFilesCount} Mounted Files`,
        sub: `${oAccs.length} ${oAccs.length === 1 ? "Account" : "Accounts"}`,
        usedStr: formatFileSize(oUsed),
        totalStr: oTotal > 0 ? formatFileSize(oTotal) : "∞",
        pct: oPct,
        onView: `switchToVaultExplorerFromDash('onedrive')`
      },
      {
        title: "Hosting (SFTP/FTP)",
        icon: "ri-server-fill",
        color: "#9878DD",
        count: `${sFilesCount} Files`,
        sub: `${sServs.length} ${sServs.length === 1 ? "Server" : "Servers"}`,
        usedStr: formatFileSize(sftpUsedBytes),
        totalStr: "Hosting",
        pct: sftpUsedBytes > 0 ? 35 : 0,
        onView: `switchToVaultExplorerFromDash('sftp')`
      },
      {
        title: "To Be Printed",
        icon: "ri-printer-cloud-fill",
        color: "#FF8132",
        count: `${pqCount} Queued`,
        sub: "Print Wishlist",
        usedStr: `${pqCount} ready`,
        totalStr: "Queue",
        pct: pqCount > 0 ? Math.min(100, pqCount * 15) : 0,
        onView: `openPrintQueueFromDash()`
      }
    ];

    statsGrid.innerHTML = cards
      .map(
        (c) => `
      <div class="ps-stat-card">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div class="ps-stat-icon" style="color:${c.color};"><i class="${c.icon}"></i></div>
          <span style="font-size:11px;font-weight:700;color:var(--text-sub);">${c.sub}</span>
        </div>
        <div>
          <div style="font-size:12px;color:var(--text-sub);font-weight:600;">${c.title}</div>
          <div style="font-size:17px;font-weight:800;color:var(--text-title);margin-top:2px;">${c.count}</div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:700;color:var(--text-sub);">
          <span>${c.usedStr}</span>
          <span>${c.totalStr}</span>
        </div>
        <div class="ps-stat-progress"><span style="width:${c.pct}%;background:${c.color};"></span></div>
        <div class="ps-stat-footer" onclick="${c.onView}">
          <span>View</span>
          <i class="ri-arrow-right-line"></i>
        </div>
      </div>`
      )
      .join("");
  }

  // 2. Render Mounted Folders (Theme-Aware + Bottom-Right Cloud Pill + Marquee Name Scroll)
  const foldersGrid = document.getElementById("dash-folders-grid");
  const cloudlyMode = isCloudlyBentoActive();
  if (foldersGrid) {
    const topFolders = (globalVaultTree || []).filter((n) => n.type === "folder").slice(0, 6);
    foldersGrid.innerHTML = topFolders.length
      ? topFolders
          .map((f) => {
            const folderIconCol = cloudlyMode ? "#FF8132" : "#f59e0b";
            const dName = getDisplayFolderName(f.name);
            return `
            <div class="ps-dash-folder-card" onclick="openDashFolderInExplorer('${f.name.replace(/'/g, "\\'")}')">
              <div class="ps-dash-folder-thumbnail" style="position:relative;height:104px;display:flex;align-items:center;justify-content:center;margin-bottom:4px;">
                ${buildFolderThumbnailHtml(f, "ri-folder-3-fill", folderIconCol)}
                ${getFolderEdgeCloudBadgeHTML(f)}
              </div>
              <span class="ps-marquee-wrap" title="${dName}" style="font-weight:700;font-size:13.5px;color:var(--text-title);width:100%;">
                <span class="ps-marquee-track">${dName}</span>
              </span>
            </div>`;
          })
          .join("")
      : `<div style="grid-column:1/-1;text-align:center;padding:24px;color:var(--text-sub);font-size:13px;">No mounted folders yet.</div>`;
    applySmartNameMarquee(foldersGrid);
  }

  // 3. Render "Recent" Compact Grid (Folders & Files with Date and Time + Marquee)
  const recentGrid = document.getElementById("dash-recent-grid");
  if (recentGrid) {
    const nowLabel = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    const recentItems = [
      ...allFolders.slice(0, 4).map((d) => ({ ...d, _isDir: true })),
      ...allFiles.slice(0, 8).map((f) => ({ ...f, _isDir: false }))
    ].slice(0, 8);

    recentGrid.innerHTML = recentItems.length
      ? recentItems
          .map((item) => {
            const isDir = item._isDir;
            const icon = isDir
              ? "ri-folder-3-fill"
              : item.file_type === "pdf"
              ? "ri-file-pdf-2-fill"
              : "ri-image-2-fill";
            const col = isDir
              ? cloudlyMode
                ? "#FF8132"
                : "#f59e0b"
              : item.file_type === "pdf"
              ? "#FF8132"
              : "#7CA1FF";
            const dateText = item.modified_time || item.created_at || nowLabel;
            const sizeText = isDir ? `${(item.children || []).length} items` : formatFileSize(item.size || 0);
            const titleLabel = isDir ? getDisplayFolderName(item.name) : item.name;
            const clickAttr = isDir
              ? `openDashFolderInExplorer('${item.name.replace(/'/g, "\\'")}')`
              : `openDashFilePreview('${item._relPath.replace(/'/g, "\\'")}', '${item.file_type}', '${item.cloud_id || ""}', '${item.account_id || ""}', '${(item.account_name || "Vault").replace(/'/g, "\\'")}', '${item.provider || "local"}', '${item.storage_id || ""}', '${item.remote_path || ""}')`;

            return `
            <div class="ps-recent-card" onclick="${clickAttr}">
              <div class="ps-recent-icon-box" style="color:${col};">
                <i class="${icon}"></i>
              </div>
              <div class="ps-recent-meta">
                <span class="ps-marquee-wrap ps-recent-title" title="${titleLabel}">
                  <span class="ps-marquee-track">${titleLabel}</span>
                </span>
                <div class="ps-recent-sub">
                  <span>${sizeText}</span>
                  <span>•</span>
                  <span>${dateText}</span>
                </div>
              </div>
            </div>`;
          })
          .join("")
      : `<div style="grid-column:1/-1;text-align:center;padding:24px;color:var(--text-sub);font-size:13px;">No recent folders or files yet.</div>`;
    applySmartNameMarquee(recentGrid);
  }

  // 4. Update Combined Storage Donut Chart
  const combinedUsed = gUsed + oUsed + sftpUsedBytes + localUsedBytes;
  const combinedTotal = gTotal + oTotal;
  const totalItemsPill = document.getElementById("dash-total-items-pill");
  const totalUsedEl = document.getElementById("dash-donut-total-used");
  const totalCapEl = document.getElementById("dash-donut-total-cap");
  if (totalItemsPill) totalItemsPill.innerText = `${allFiles.length + allFolders.length} Items`;
  if (totalUsedEl) totalUsedEl.innerText = formatFileSize(combinedUsed);
  if (totalCapEl) {
  totalCapEl.innerText = combinedTotal > 0 ? `of ${formatCombinedCapacity(combinedTotal)}` : `${allFiles.length} Files`;
}

  const C = 427;
  const denom = Math.max(1, combinedUsed);
  const segs = [
    { id: "donut-seg-google", val: gUsed },
    { id: "donut-seg-onedrive", val: oUsed },
    { id: "donut-seg-sftp", val: sftpUsedBytes },
    { id: "donut-seg-local", val: localUsedBytes }
  ];
  let offset = 0;
  segs.forEach((s) => {
    const el = document.getElementById(s.id);
    const len = (s.val / denom) * C;
    if (el) {
      el.setAttribute("stroke-dasharray", `${len.toFixed(1)} ${C}`);
      el.setAttribute("stroke-dashoffset", `${(-offset).toFixed(1)}`);
    }
    offset += len;
  });

  const bdList = document.getElementById("dash-breakdown-list");
  if (bdList) {
    const rows = [
      { label: "Google Drive", color: "#7CA1FF", used: formatFileSize(gUsed), cap: gTotal > 0 ? formatFileSize(gTotal) : "∞" },
      { label: "OneDrive", color: "#FF7DA0", used: formatFileSize(oUsed), cap: oTotal > 0 ? formatFileSize(oTotal) : "∞" },
      { label: "Hosting (SFTP/FTP)", color: "#9878DD", used: formatFileSize(sftpUsedBytes), cap: "Mounted" },
      { label: "Local Vault", color: "#FF8132", used: formatFileSize(localUsedBytes), cap: "Encrypted" }
    ];
    bdList.innerHTML = rows
      .map(
        (r) => `
      <div class="ps-bd-row">
        <div style="display:flex;align-items:center;font-weight:600;color:var(--text-title);">
          <span class="ps-bd-dot" style="background:${r.color};"></span>${r.label}
        </div>
        <div style="color:var(--text-sub);font-weight:600;"><b style="color:var(--text-title);">${r.used}</b> / ${r.cap}</div>
      </div>`
      )
      .join("");
  }

  const connSum = document.getElementById("dash-connected-drives-summary");
  if (connSum) {
    const totalLinked = (connectedAccountsList || []).length + (connectedRemoteStoragesList || []).length;
    connSum.innerText = `${totalLinked} Cloud & Hosting Storages Linked`;
  }
}

function openDashFolderInExplorer(folderName) {
  switchToVaultExplorerFromDash("all");
  currentFolderNavigation = [folderName];
  renderCurrentFolderLevel();
}

function openDashFilePreview(relPath, fileType, cloudId, accountId, accountName, provider, storageId, remotePath) {
  switchToVaultExplorerFromDash("all");
  if (typeof showIntegratedPreview === "function") {
    showIntegratedPreview(
      relPath,
      fileType,
      null,
      "",
      cloudId || null,
      accountId || null,
      accountName,
      provider,
      storageId || null,
      remotePath || null
    );
  }
}

// ========================================================================
// 🎨 INSTANT LIVE RE-RENDER ON STYLE / THEME CHANGE (DASHBOARD + EXPLORER)
// ========================================================================
(function bindInstantThemeReRenderer() {
  const rerenderActiveWorkspace = () => {
    requestAnimationFrame(() => {
      const dashView = document.getElementById("cloudly-dashboard-view");
      const isDashVisible =
        window.activeWorkspaceTab === "dashboard" ||
        (dashView && getComputedStyle(dashView).display !== "none");

      if (isDashVisible && typeof renderCloudlyDashboardOverview === "function") {
        renderCloudlyDashboardOverview();
      }
      if (typeof renderCurrentFolderLevel === "function") {
        renderCurrentFolderLevel();
      }
    });
  };

  if (typeof window.selectModernUIStyle === "function" && !window.selectModernUIStyle._psWrapped) {
    const origSelectStyle = window.selectModernUIStyle;
    window.selectModernUIStyle = function (...args) {
      const res = origSelectStyle.apply(this, args);
      rerenderActiveWorkspace();
      return res;
    };
    window.selectModernUIStyle._psWrapped = true;
  }

  const htmlObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && (m.attributeName === "data-style" || m.attributeName === "data-theme")) {
        rerenderActiveWorkspace();
        break;
      }
    }
  });
  htmlObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-style", "data-theme"]
  });
})();