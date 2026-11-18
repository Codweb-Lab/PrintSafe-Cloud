// ========================================================================
// PRINTSAFE CLOUD — ADMIN CORE CONTROLLER (Design Dropdown + Context Menu)
// ========================================================================
let pendingConfirmAction = null;
let pendingInputAction = null;
let currentVaultSubpath = "";
let cachedVaultEntries = [];
let currentVaultFilter = "all";
let currentVaultView = "grid";

const DESIGN_STYLE_LABELS = {
  bento: "Glass Bento",
  fluent: "Microsoft Fluent",
  carbon: "IBM Carbon",
  neon: "Cyber Neon"
};

// ========================================================================
// UI DESIGN SYSTEM DROPDOWN + LIGHT/DARK/SYSTEM THEME SWITCHER
// ========================================================================
function toggleDesignStyleMenu(e) {
  if (e) e.stopPropagation();
  document.getElementById("design-menu-popover")?.classList.toggle("open");
}

function setAdminDesignStyle(styleKey) {
  localStorage.setItem("printsafe_admin_design_style", styleKey);
  document.documentElement.setAttribute("data-style", styleKey);

  const labelEl = document.getElementById("current-design-label");
  if (labelEl) labelEl.innerText = DESIGN_STYLE_LABELS[styleKey] || "IBM Carbon";

  document.querySelectorAll(".design-option-item").forEach((btn) => {
    const isMatch = btn.dataset.styleVal === styleKey;
    btn.classList.toggle("active", isMatch);
    const check = btn.querySelector(".check-mark");
    if (check) check.style.display = isMatch ? "inline-block" : "none";
  });
  document.getElementById("design-menu-popover")?.classList.remove("open");
}

function applyResolvedTheme(mode) {
  let effective = mode;
  if (mode === "system") {
    effective = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", effective);
  document.querySelectorAll(".theme-btn[data-theme-val]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeVal === mode);
  });
}

function setAdminTheme(mode) {
  localStorage.setItem("printsafe_admin_theme", mode);
  applyResolvedTheme(mode);
}

(function initAdminAppearance() {
  const savedTheme = localStorage.getItem("printsafe_admin_theme") || "dark";
  const savedStyle = localStorage.getItem("printsafe_admin_design_style") || "carbon";
  applyResolvedTheme(savedTheme);
  setAdminDesignStyle(savedStyle);
})();

document.addEventListener("click", () => {
  document.getElementById("design-menu-popover")?.classList.remove("open");
  closeVaultContextMenu();
});

// ========================================================================
// TOAST & MODALS
// ========================================================================
function showAdminToast(message, isError = false) {
  const box = document.getElementById("admin-toast-box");
  if (!box) return;
  const toast = document.createElement("div");
  toast.className = "admin-toast";
  toast.style.borderLeftColor = isError ? "var(--danger)" : "var(--success)";
  toast.innerHTML = `<i class="${isError ? "ri-error-warning-fill" : "ri-checkbox-circle-fill"}" style="color:${isError ? "var(--danger)" : "var(--success)"};font-size:16px;"></i><span>${message}</span>`;
  box.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function openModalById(id) {
  document.getElementById(id)?.classList.add("open");
}

function closeModalById(id) {
  document.getElementById(id)?.classList.remove("open");
}

function openAdminConfirmModal({ title, desc, confirmText = "Confirm", isDanger = true, iconClass = "ri-error-warning-fill", onConfirm }) {
  const modal = document.getElementById("admin-confirm-modal");
  if (!modal) return;
  document.getElementById("adm-confirm-title").innerText = title;
  document.getElementById("adm-confirm-desc").innerText = desc;
  const iconEl = document.getElementById("adm-confirm-icon");
  iconEl.className = iconClass;
  iconEl.style.color = isDanger ? "var(--danger)" : "var(--info)";

  const okBtn = document.getElementById("adm-confirm-ok-btn");
  okBtn.innerText = confirmText;
  okBtn.className = isDanger ? "btn btn-danger" : "btn btn-sky";

  pendingConfirmAction = onConfirm;
  okBtn.onclick = async () => {
    closeAdminConfirmModal();
    if (typeof pendingConfirmAction === "function") await pendingConfirmAction();
  };
  modal.classList.add("open");
}

function closeAdminConfirmModal() {
  closeModalById("admin-confirm-modal");
  pendingConfirmAction = null;
}

function openAdminInputModal({ title, desc, placeholder = "", inputType = "text", confirmText = "Submit", iconClass = "ri-edit-box-fill", onSubmit }) {
  const modal = document.getElementById("admin-input-modal");
  if (!modal) return;
  document.getElementById("adm-input-title").innerText = title;
  document.getElementById("adm-input-desc").innerText = desc;
  document.getElementById("adm-input-icon").className = iconClass;
  document.getElementById("adm-input-ok-btn").innerText = confirmText;

  const field = document.getElementById("adm-input-field");
  field.type = inputType;
  field.placeholder = placeholder;
  field.value = "";

  pendingInputAction = onSubmit;
  modal.classList.add("open");
  requestAnimationFrame(() => field.focus());
}

function closeAdminInputModal() {
  closeModalById("admin-input-modal");
  pendingInputAction = null;
}

async function submitAdminInputModal() {
  const field = document.getElementById("adm-input-field");
  const val = (field?.value || "").trim();
  if (!val) {
    showAdminToast("Please enter a valid value.", true);
    field?.focus();
    return;
  }
  const cb = pendingInputAction;
  closeAdminInputModal();
  if (typeof cb === "function") await cb(val);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".vault-modal-overlay.open").forEach((m) => m.classList.remove("open"));
    closeVaultContextMenu();
  }
});

// ========================================================================
// SIDEBAR NAVIGATION & AUTHENTICATION
// ========================================================================
function switchAdminCategory(panelName, btnEl) {
  document.querySelectorAll(".admin-panel").forEach((panel) => panel.classList.remove("active"));
  document.querySelectorAll(".admin-tab-btn").forEach((btn) => btn.classList.remove("active"));
  document.getElementById(`panel-${panelName}`)?.classList.add("active");
  if (btnEl) btnEl.classList.add("active");

  if (panelName === "vault") loadVaultExplorer(currentVaultSubpath);
  else if (panelName === "broadcast") loadBroadcastHistory();
  else if (panelName === "templates" && typeof loadEmailTemplatesGrid === "function") loadEmailTemplatesGrid();
  else if ((panelName === "integrations" || panelName === "features") && typeof loadAdminFeaturesAndIntegrations === "function") {
    loadAdminFeaturesAndIntegrations();
  }
}
window.switchAdminCategory = switchAdminCategory;

async function submitAdminLogin() {
  const input = document.getElementById("admin-secret-input");
  const errBox = document.getElementById("admin-login-err");
  const password = (input?.value || "").trim();
  if (!password) return;

  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      window.location.reload();
    } else if (errBox) {
      errBox.innerText = data.error || "Invalid Administrator Secret Key!";
      errBox.style.display = "block";
    }
  } catch (e) {
    if (errBox) {
      errBox.innerText = "Network error while signing in.";
      errBox.style.display = "block";
    }
  }
}

// ========================================================================
// TELEMETRY & REGISTERED USERS CARDS
// ========================================================================
async function loadOverviewAndUsers(notify = false) {
  const statsGrid = document.getElementById("admin-stats-grid");
  if (!statsGrid) return;

  try {
    const ovRes = await fetch("/api/admin/overview");
    if (!ovRes.ok) return;
    const ov = await ovRes.json();
    const t = ov.telemetry;

    statsGrid.innerHTML = `
      <div class="stat-card">
        <div style="font-size:11px;color:var(--text-secondary);font-weight:600;">SERVER CPU / RAM</div>
        <div class="stat-val">${t.cpu_percent}% <span style="font-size:14px;color:var(--text-secondary);">/ ${t.ram_percent}%</span></div>
        <div style="font-size:12px;color:var(--text-helper);">${t.ram_used_mb} / ${t.ram_total_mb} MB</div>
        <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, t.ram_percent)}%;"></div></div>
      </div>
      <div class="stat-card" style="border-top-color:var(--success);">
        <div style="font-size:11px;color:var(--text-secondary);font-weight:600;">HOSTED SERVER VAULT</div>
        <div class="stat-val">${t.hosted_vault_mb} MB</div>
        <div style="font-size:12px;color:var(--text-helper);">Disk Free: ${t.disk_free_gb} GB</div>
        <div class="progress-track"><div class="progress-fill" style="width:35%;background:var(--success);"></div></div>
      </div>
      <div class="stat-card">
        <div style="font-size:11px;color:var(--text-secondary);font-weight:600;">REGISTERED USERS</div>
        <div class="stat-val">${t.total_users}</div>
        <div style="font-size:12px;color:var(--text-helper);">Active QR Sessions: ${t.active_qr_sessions}</div>
      </div>
      <div class="stat-card" style="border-top-color:var(--warning);">
        <div style="font-size:11px;color:var(--text-secondary);font-weight:600;">CLOUD &amp; SFTP MOUNTS</div>
        <div class="stat-val">${t.total_clouds + t.total_remote_storages}</div>
        <div style="font-size:12px;color:var(--text-helper);">DB Size: ${t.db_size_kb} KB</div>
      </div>
    `;

    const usersContainer = document.getElementById("admin-users-container");
    if (usersContainer) {
      usersContainer.innerHTML = ov.users.length
        ? ov.users.map((u) => `
            <div class="entity-card">
              <div>
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;">
                  <strong style="font-size:14px;">${u.full_name}</strong>
                  <span class="carbon-tag tag-blue">${u.auth_provider.toUpperCase()}</span>
                </div>
                <div style="font-size:12px;color:var(--text-secondary);word-break:break-all;margin-bottom:8px;">${u.email}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  ${u.totp_enabled ? '<span class="carbon-tag tag-green">2FA ENABLED</span>' : '<span class="carbon-tag tag-amber">2FA OFF</span>'}
                  <span class="carbon-tag tag-blue">Quota: ${u.storage_quota_mb || 500} MB</span>
                </div>
              </div>
              <div style="display:flex;justify-content:flex-end;border-top:1px solid var(--border-subtle);padding-top:10px;">
                <button onclick="confirmDeleteUserByAdmin('${u.user_id}', '${u.email}')" class="btn btn-danger" style="padding:6px 11px;font-size:12px;">
                  <i class="ri-delete-bin-line"></i> Remove User
                </button>
              </div>
            </div>`).join("")
        : `<div style="font-size:13px;color:var(--text-secondary);">No users registered yet.</div>`;
    }
    if (notify) showAdminToast("System telemetry refreshed.");
  } catch (e) {}
}

// ========================================================================
// HOSTED SERVER VAULT EXPLORER + IN-EXPLORER SEARCH + CUSTOM CONTEXT MENU
// ========================================================================
function setVaultFilter(filterType, btnEl) {
  currentVaultFilter = filterType;
  document.querySelectorAll(".filter-pill").forEach((p) => p.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");
  renderVaultExplorerItems();
}

function setVaultViewMode(mode) {
  currentVaultView = mode;
  document.getElementById("btn-view-grid")?.classList.toggle("active", mode === "grid");
  document.getElementById("btn-view-list")?.classList.toggle("active", mode === "list");
  renderVaultExplorerItems();
}

function closeVaultContextMenu() {
  document.getElementById("vault-context-menu")?.classList.remove("open");
}

function handleExplorerContextMenu(e, itemName = "", isDir = false) {
  e.preventDefault();
  e.stopPropagation();
  const menu = document.getElementById("vault-context-menu");
  if (!menu) return;

  const nextSub = itemName ? (currentVaultSubpath ? `${currentVaultSubpath}/${itemName}` : itemName) : "";

  if (itemName) {
    menu.innerHTML = `
      ${isDir ? `<button type="button" class="ctx-menu-item" onclick="loadVaultExplorer('${nextSub}')"><i class="ri-folder-open-line" style="color:var(--warning);"></i> Open Folder</button>` : ""}
      <button type="button" class="ctx-menu-item" onclick="copyVaultRelativePath('${nextSub}')"><i class="ri-file-copy-line" style="color:var(--info);"></i> Copy Vault Path</button>
      <div class="ctx-menu-divider"></div>
      <button type="button" class="ctx-menu-item danger" onclick="confirmDeleteVaultItem('${itemName}')"><i class="ri-delete-bin-line"></i> Delete ${isDir ? "Folder" : "File"}</button>
    `;
  } else {
    menu.innerHTML = `
      <button type="button" class="ctx-menu-item" onclick="openCreateFolderModal()"><i class="ri-folder-add-line" style="color:var(--warning);"></i> New Folder</button>
      <button type="button" class="ctx-menu-item" onclick="document.getElementById('vault-upload-input').click()"><i class="ri-upload-cloud-2-line" style="color:var(--success);"></i> Upload Files Here</button>
      <div class="ctx-menu-divider"></div>
      <button type="button" class="ctx-menu-item" onclick="loadVaultExplorer(currentVaultSubpath)"><i class="ri-refresh-line" style="color:var(--info);"></i> Refresh Explorer</button>
    `;
  }

  const x = Math.min(e.clientX, window.innerWidth - 215);
  const y = Math.min(e.clientY, window.innerHeight - 165);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.add("open");
}

function copyVaultRelativePath(relPath) {
  navigator.clipboard?.writeText("/" + relPath);
  showAdminToast(`Copied path: /${relPath}`);
}

async function loadVaultExplorer(subpath = "") {
  currentVaultSubpath = subpath || "";
  const entriesBox = document.getElementById("admin-hosted-entries");
  const crumbBar = document.getElementById("vault-breadcrumb-bar");
  const pathInput = document.getElementById("admin-vault-path-input");
  if (!entriesBox) return;

  try {
    const res = await fetch(`/api/admin/vault-dir?subpath=${encodeURIComponent(currentVaultSubpath)}`);
    const d = await res.json();
    if (!res.ok || !d.success) return;

    if (pathInput) pathInput.value = d.root_path;
    cachedVaultEntries = d.entries || [];

    if (crumbBar) {
      const parts = d.subpath ? d.subpath.split("/").filter(Boolean) : [];
      let crumbsHtml = `<button type="button" class="crumb-link" onclick="loadVaultExplorer('')">Root Vault</button>`;
      let accum = "";
      parts.forEach((part) => {
        accum = accum ? `${accum}/${part}` : part;
        crumbsHtml += ` <span>/</span> <button type="button" class="crumb-link" onclick="loadVaultExplorer('${accum}')">${part}</button>`;
      });
      crumbBar.innerHTML = crumbsHtml;
    }

    renderVaultExplorerItems();
  } catch (e) {}
}

function renderVaultExplorerItems(searchQuery = "") {
  const entriesBox = document.getElementById("admin-hosted-entries");
  if (!entriesBox) return;

  const q = (searchQuery || document.getElementById("explorer-search-input")?.value || "").trim().toLowerCase();
  let items = cachedVaultEntries.filter((e) => {
    if (q && !e.name.toLowerCase().includes(q)) return false;
    if (currentVaultFilter === "folders") return e.is_dir;
    if (currentVaultFilter === "pdf") return !e.is_dir && e.name.toLowerCase().endsWith(".pdf");
    if (currentVaultFilter === "images") return !e.is_dir && /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(e.name);
    return true;
  });

  const parentRow = currentVaultSubpath
    ? `<div class="explorer-row" style="margin-bottom:8px;">
         <div class="explorer-name is-dir" onclick="loadVaultExplorer('${currentVaultSubpath.split("/").slice(0, -1).join("/")}')">
           <i class="ri-arrow-go-back-line"></i> .. (Back to Parent Folder)
         </div>
       </div>`
    : "";

  if (!items.length) {
    entriesBox.innerHTML = parentRow + `<div style="padding:36px;text-align:center;color:var(--text-helper);font-size:13px;">No matching items found. Right-click or use <strong>"Upload Here"</strong> / <strong>"New Folder"</strong>.</div>`;
    return;
  }

  if (currentVaultView === "grid") {
    const cards = items.map((e) => {
      const nextSub = currentVaultSubpath ? `${currentVaultSubpath}/${e.name}` : e.name;
      const openFn = e.is_dir ? `onclick="loadVaultExplorer('${nextSub}')"` : "";
      const ctxFn = `oncontextmenu="handleExplorerContextMenu(event, '${e.name}', ${e.is_dir})"`;
      const icon = e.is_dir
        ? `<i class="ri-folder-3-fill" style="color:var(--warning);"></i>`
        : e.name.toLowerCase().endsWith(".pdf")
        ? `<i class="ri-file-pdf-2-fill" style="color:var(--danger);"></i>`
        : `<i class="ri-file-text-fill" style="color:var(--info);"></i>`;

      return `
        <div class="vault-grid-item" ${ctxFn}>
          <div class="vault-thumb-box ${e.is_dir ? "" : "is-file"}" ${openFn}>${icon}</div>
          <div class="vault-item-title" ${openFn} title="${e.name}">${e.name}</div>
          <div class="vault-item-meta">
            <span class="carbon-tag ${e.is_dir ? "tag-amber" : "tag-blue"}">${e.is_dir ? "Folder" : e.size_kb + " KB"}</span>
            <button type="button" onclick="confirmDeleteVaultItem('${e.name}')" class="btn btn-danger" style="padding:3px 7px;font-size:11px;" title="Delete"><i class="ri-delete-bin-line"></i></button>
          </div>
        </div>`;
    }).join("");
    entriesBox.innerHTML = parentRow + `<div class="explorer-cards-grid">${cards}</div>`;
  } else {
    const rows = items.map((e) => {
      const nextSub = currentVaultSubpath ? `${currentVaultSubpath}/${e.name}` : e.name;
      const openFn = e.is_dir ? `onclick="loadVaultExplorer('${nextSub}')"` : "";
      const ctxFn = `oncontextmenu="handleExplorerContextMenu(event, '${e.name}', ${e.is_dir})"`;
      return `
        <div class="explorer-row" ${ctxFn}>
          <div class="explorer-name ${e.is_dir ? "is-dir" : ""}" ${openFn}>
            <i class="${e.is_dir ? "ri-folder-3-fill" : "ri-file-text-line"}" style="color:${e.is_dir ? "var(--warning)" : "var(--info)"};font-size:16px;"></i>
            <span>${e.name}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:12px;color:var(--text-helper);font-family:'IBM Plex Mono',monospace;">${e.is_dir ? "DIR" : e.size_kb + " KB"}</span>
            <button type="button" onclick="confirmDeleteVaultItem('${e.name}')" class="btn btn-danger" style="padding:4px 8px;font-size:11.5px;"><i class="ri-delete-bin-line"></i></button>
          </div>
        </div>`;
    }).join("");
    entriesBox.innerHTML = parentRow + rows;
  }
}

async function handleVaultFileUpload(fileList) {
  if (!fileList || !fileList.length) return;
  const formData = new FormData();
  formData.append("subpath", currentVaultSubpath);
  for (const file of fileList) formData.append("files", file);

  showAdminToast(`Uploading ${fileList.length} file(s)...`);
  try {
    const res = await fetch("/api/admin/vault-dir/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (res.ok && data.success) {
      showAdminToast(data.message);
      await loadVaultExplorer(currentVaultSubpath);
    } else {
      showAdminToast(data.error || "Upload failed", true);
    }
  } catch (e) {
    showAdminToast("Network error during upload", true);
  } finally {
    document.getElementById("vault-upload-input").value = "";
  }
}

function confirmDeleteVaultItem(itemName) {
  openAdminConfirmModal({
    title: "Delete Vault Item?",
    desc: `Permanently delete "${itemName}" from the Hosted Server Vault?`,
    confirmText: "Delete",
    isDanger: true,
    onConfirm: async () => {
      const res = await fetch("/api/admin/vault-dir/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: itemName, subpath: currentVaultSubpath })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showAdminToast(data.message);
        await loadVaultExplorer(currentVaultSubpath);
      } else {
        showAdminToast(data.error || "Delete failed", true);
      }
    }
  });
}

async function saveAdminVaultPath() {
  const path = (document.getElementById("admin-vault-path-input")?.value || "").trim();
  if (!path) return showAdminToast("Please enter a valid directory path.", true);
  const res = await fetch("/api/admin/vault-dir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path })
  });
  const data = await res.json();
  if (data.success) {
    showAdminToast("Root directory updated!");
    await loadVaultExplorer("");
  } else {
    showAdminToast(data.error || "Failed to update directory", true);
  }
}

function openCreateFolderModal() {
  openAdminInputModal({
    title: "Create New Folder",
    desc: `Create a folder inside /${currentVaultSubpath || "Root"}:`,
    placeholder: "e.g. Client_Prints_2026",
    confirmText: "Create Folder",
    onSubmit: async (folderName) => {
      const res = await fetch("/api/admin/vault-dir/create-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_name: folderName, subpath: currentVaultSubpath })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showAdminToast(`Folder "${folderName}" created!`);
        await loadVaultExplorer(currentVaultSubpath);
      } else {
        showAdminToast(data.error || "Invalid folder name", true);
      }
    }
  });
}


window._adminConfirmCb = null;

function openAdminConfirmModal({ title, desc, confirmText = "Confirm", isDanger = true, iconClass = "ri-error-warning-fill", onConfirm }) {
  const modal = document.getElementById("admin-confirm-modal");
  if (!modal) {
    if (typeof onConfirm === "function") onConfirm();
    return;
  }
  document.getElementById("adm-confirm-title").innerText = title;
  document.getElementById("adm-confirm-desc").innerText = desc;

  const iconEl = document.getElementById("adm-confirm-icon");
  if (iconEl) {
    iconEl.className = iconClass;
    iconEl.style.color = isDanger ? "var(--danger)" : "var(--info)";
  }

  const okBtn = document.getElementById("adm-confirm-ok-btn");
  if (okBtn) {
    okBtn.innerText = confirmText;
    okBtn.className = isDanger ? "btn btn-danger" : "btn btn-sky";
  }

  window._adminConfirmCb = onConfirm;
  modal.classList.add("open");
}

function closeAdminConfirmModal() {
  document.getElementById("admin-confirm-modal")?.classList.remove("open");
  window._adminConfirmCb = null;
}

async function runAdminConfirmCallback() {
  const cb = window._adminConfirmCb;
  closeAdminConfirmModal();
  if (typeof cb === "function") {
    await cb();
  }
}

function confirmAdminLogout() {
  openAdminConfirmModal({
    title: "Logout Admin Console?",
    desc: "Are you sure you want to end your Administrator session?",
    confirmText: "Yes, Logout",
    isDanger: true,
    iconClass: "ri-logout-box-r-line",
    onConfirm: async () => {
      try {
        await fetch("/api/admin/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin"
        });
      } catch (e) {}
      window.location.href = "/admin/logout";
    }
  });
}

window.openAdminConfirmModal = openAdminConfirmModal;
window.closeAdminConfirmModal = closeAdminConfirmModal;
window.runAdminConfirmCallback = runAdminConfirmCallback;
window.confirmAdminLogout = confirmAdminLogout;

// ========================================================================
// BROADCAST CENTER
// ========================================================================
let broadcastPollTimer = null;

function toggleBroadcastSchedulePicker(mode) {
  const wrap = document.getElementById("bc-datetime-wrap");
  if (!wrap) return;
  wrap.style.display = mode === "schedule" ? "block" : "none";
  if (mode === "schedule" && !document.getElementById("bc-sched-date").value) {
    setQuickBroadcastSchedule(15);
  }
}

function setQuickBroadcastSchedule(offset) {
  const d = new Date();
  if (offset === "tomorrow_9am") {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  } else {
    d.setMinutes(d.getMinutes() + Number(offset || 15));
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");

  const dateEl = document.getElementById("bc-sched-date");
  const timeEl = document.getElementById("bc-sched-time");
  if (dateEl) dateEl.value = `${yyyy}-${mm}-${dd}`;
  if (timeEl) timeEl.value = `${hh}:${min}`;
}

async function loadBroadcastHistory() {
  const box = document.getElementById("admin-broadcasts-list");
  if (!box) return;
  try {
    const res = await fetch("/api/admin/broadcasts");
    const data = await res.json();
    if (!res.ok || !data.success) return;

    let hasInFlight = false;

    box.innerHTML = data.broadcasts.length
      ? data.broadcasts.map((b) => {
          const dt = new Date(b.scheduled_for * 1000).toLocaleString();
          let badge = "";
          if (b.status === "sent") {
            badge = `<span class="carbon-tag tag-green"><i class="ri-check-double-line"></i> SENT (${b.recipient_count} Users)</span>`;
          } else if (b.status === "sending") {
            hasInFlight = true;
            badge = `<span class="carbon-tag tag-blue"><i class="ri-loader-4-line"></i> SENDING NOW...</span>`;
          } else {
            badge = `<span class="carbon-tag tag-amber"><i class="ri-time-line"></i> SCHEDULED: ${dt}</span>`;
          }

          return `
            <div class="smtp-profile-card">
              <div style="flex:1;min-width:220px;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
                  <strong>${b.title}</strong>
                  ${badge}
                  ${b.send_push ? '<span class="carbon-tag tag-blue">PUSH</span>' : ''}
                  ${b.send_email ? '<span class="carbon-tag tag-blue">EMAIL</span>' : ''}
                </div>
                <div style="font-size:12.5px;color:var(--text-secondary);">${b.message}</div>
              </div>
              <button type="button" onclick="deleteBroadcastItem('${b.broadcast_id}')" class="btn btn-danger" style="padding:6px 10px;font-size:12px;">
                <i class="ri-delete-bin-line"></i>
              </button>
            </div>`;
        }).join("")
      : `<div style="text-align:center;padding:24px;border:1px dashed var(--border-subtle);color:var(--text-secondary);font-size:13px;">No broadcasts dispatched yet.</div>`;

    // Automatically refresh badge from "SENDING NOW..." to "SENT" once emails finish dispatching
    if (broadcastPollTimer) clearTimeout(broadcastPollTimer);
    if (hasInFlight) {
      broadcastPollTimer = setTimeout(() => loadBroadcastHistory(), 2500);
    }
  } catch (e) {}
}

async function submitAdminBroadcast() {
  const title = (document.getElementById("bc-title")?.value || "").trim();
  const message = (document.getElementById("bc-message")?.value || "").trim();
  const send_push = document.getElementById("bc-send-push")?.checked;
  const send_email = document.getElementById("bc-send-email")?.checked;
  const template_id = send_email ? (document.getElementById("bc-template-select")?.value || "") : "";
  const schedule_mode = document.getElementById("bc-schedule-mode")?.value || "now";

  let scheduled_at = "";
  if (schedule_mode === "schedule") {
    const dVal = document.getElementById("bc-sched-date")?.value || "";
    const tVal = document.getElementById("bc-sched-time")?.value || "";
    if (!dVal || !tVal) {
      return showAdminToast("Please select both Date and Time for scheduled broadcast.", true);
    }
    scheduled_at = `${dVal}T${tVal}`;
  }

  const btn = document.getElementById("bc-submit-btn");
  if (!title || !message) return showAdminToast("Title and message are required.", true);
  if (btn) btn.disabled = true;

  try {
    const res = await fetch("/api/admin/broadcasts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, message, template_id, send_push, send_email, schedule_mode, scheduled_at })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showAdminToast(data.message);
      closeModalById("modal-new-broadcast");
      document.getElementById("bc-title").value = "";
      document.getElementById("bc-message").value = "";
      await loadBroadcastHistory();
    } else {
      showAdminToast(data.error || "Failed to dispatch broadcast", true);
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteBroadcastItem(broadcastId) {
  await fetch("/api/admin/broadcasts/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ broadcast_id: broadcastId })
  });
  showAdminToast("Broadcast deleted.");
  await loadBroadcastHistory();
}

document.addEventListener("DOMContentLoaded", () => {
  loadVaultExplorer("");
  loadOverviewAndUsers(false);
  if (typeof loadAdminFeaturesAndIntegrations === "function") {
    loadAdminFeaturesAndIntegrations();
  }
});

function openBroadcastComposerModal() {
  if (typeof loadEmailTemplatesGrid === "function" && (!window.cachedEmailTemplates || !window.cachedEmailTemplates.length)) {
    loadEmailTemplatesGrid();
  }
  const emailChecked = document.getElementById("bc-send-email")?.checked ?? true;
  toggleBroadcastTemplateBox(emailChecked);
  openModalById("modal-new-broadcast");
}

function toggleBroadcastTemplateBox(isEnabled) {
  const box = document.getElementById("bc-email-template-box");
  if (box) box.style.display = isEnabled ? "block" : "none";
}

function previewSelectedBroadcastTemplate() {
  const tplId = document.getElementById("bc-template-select")?.value || "";
  const titleVal = (document.getElementById("bc-title")?.value || "").trim() || "Important Platform Update";
  const msgVal = (document.getElementById("bc-message")?.value || "").trim() || "Hello User, here is your official announcement from PrintSafe Cloud.";
  const list = typeof cachedEmailTemplates !== "undefined" ? cachedEmailTemplates : [];
  const tpl = list.find((x) => x.template_id === tplId) || list[0];

  if (!tpl) {
    showAdminToast("Template not loaded yet. Open Email Templates tab once.", true);
    return;
  }

  document.getElementById("bc-preview-tpl-name").innerText = `Preview: ${tpl.name}`;
  const subj = tpl.subject.replaceAll("{{subject}}", titleVal).replaceAll("{{user_name}}", "Kapil Jangid");
  document.getElementById("bc-preview-subject-line").innerText = `Subject: ${subj}`;

  const renderedHtml = tpl.html_body
    .replaceAll("{{subject}}", titleVal)
    .replaceAll("{{message}}", msgVal)
    .replaceAll("{{otp_code}}", msgVal)
    .replaceAll("{{user_name}}", "Kapil Jangid")
    .replaceAll("{{user_email}}", "user@codweb.in")
    .replaceAll("{{logo_url}}", tpl.logo_url || "/static/images/logo3.png");

  document.getElementById("bc-preview-iframe").srcdoc = `<div style="padding:16px;">${renderedHtml}</div>`;
  openModalById("modal-bc-template-preview");
}

async function submitAdminBroadcast() {
  const title = (document.getElementById("bc-title")?.value || "").trim();
  const message = (document.getElementById("bc-message")?.value || "").trim();
  const send_push = document.getElementById("bc-send-push")?.checked;
  const send_email = document.getElementById("bc-send-email")?.checked;
  const template_id = send_email ? (document.getElementById("bc-template-select")?.value || "") : "";
  const schedule_mode = document.getElementById("bc-schedule-mode")?.value || "now";
  const scheduled_at = document.getElementById("bc-scheduled-at")?.value || "";
  const btn = document.getElementById("bc-submit-btn");

  if (!title || !message) return showAdminToast("Title and message are required.", true);
  if (btn) btn.disabled = true;

  try {
    const res = await fetch("/api/admin/broadcasts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, message, template_id, send_push, send_email, schedule_mode, scheduled_at })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showAdminToast(data.message);
      closeModalById("modal-new-broadcast");
      document.getElementById("bc-title").value = "";
      document.getElementById("bc-message").value = "";
      await loadBroadcastHistory();
    } else {
      showAdminToast(data.error || "Failed to dispatch broadcast", true);
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}