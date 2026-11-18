// ========================================================================
// 🌐 PRINTSAFE CLOUD — SHARED STATE, THEME & UI HELPERS (state.js)
// ========================================================================
const thumbnailCache = {};
if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/js/pdf.worker.min.js";
}

// Prevent direct Ctrl+S saving of streamed documents
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && (e.key === "s" || e.key === "S")) e.preventDefault();
});

// Global Application State
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
let currentViewMode = localStorage.getItem("vault_view_mode") || "tile";
let currentFilterType = "all";
let connectedAccountsList = [];
let contextMenuTargetItem = null;

let sessionLoginType = "master";
let activeRestrictions = {
  is_restricted: false,
  mask_folders: false,
  disable_profile: false,
  allow_print: true
};
let lastSeenSyncEventId = null;
let backgroundSyncInterval = null;

// ========================================================================
// 🛠️ FORMATTING & BADGE HELPERS
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
// 🔔 TOAST NOTIFICATIONS & CONFIRMATION MODALS
// ========================================================================
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

function openAboutModal() {
  const m = document.getElementById("about-app-modal");
  if (m) m.style.display = "flex";
  const dropdown = document.getElementById("profile-menu-dropdown");
  if (dropdown) dropdown.style.display = "none";
}

function closeAboutModal() {
  const m = document.getElementById("about-app-modal");
  if (m) m.style.display = "none";
}

function openSessionConfirmModal(title, message, btnLabel, onConfirm) {
  const modal = document.getElementById("session-confirm-modal");
  if (!modal) return;
  document.getElementById("session-confirm-title").innerText = title;
  document.getElementById("session-confirm-msg").innerText = message;
  const btn = document.getElementById("session-confirm-btn");
  btn.innerText = btnLabel;
  btn.onclick = async () => {
    closeSessionConfirmModal();
    await onConfirm();
  };
  modal.style.display = "flex";
}

function closeSessionConfirmModal() {
  const modal = document.getElementById("session-confirm-modal");
  if (modal) modal.style.display = "none";
}

// ========================================================================
// 🎨 SIDEBAR DRAWER, DROPDOWNS & THEME PRESET SWITCHER
// ========================================================================
function toggleMobileSidebar(open) {
  document.getElementById("explorer-sidebar")?.classList.toggle("open-drawer", open);
  document.getElementById("sidebar-backdrop")?.classList.toggle("open-drawer", open);
}

function toggleModernDropdown(dropdownId, event) {
  if (event) event.stopPropagation();
  const target = document.getElementById(dropdownId);
  if (!target) return;
  const isOpen = target.classList.contains("open");
  closeAllModernDropdowns();
  if (!isOpen) target.classList.add("open");
}

function closeAllModernDropdowns() {
  document.querySelectorAll(".modern-dropdown.open").forEach((d) => d.classList.remove("open"));
}

document.addEventListener("click", closeAllModernDropdowns);

const styleNamesMap = {
  glass: "Glass Bento",
  fluent: "Microsoft Fluent",
  carbon: "IBM Carbon",
  cyber: "Cyber Neon"
};

function selectModernUIStyle(styleName, labelText, itemEl) {
  setUIStylePreset(styleName, labelText);
  const wrapper = document.getElementById("dropdown-ui-style");
  if (wrapper) {
    wrapper.querySelectorAll(".modern-dropdown-item").forEach((i) => i.classList.remove("active"));
  }
  if (itemEl) itemEl.classList.add("active");
  closeAllModernDropdowns();
}

function setUIStylePreset(styleName, customLabel = null) {
  document.documentElement.setAttribute("data-style", styleName);
  localStorage.setItem("vault_style_preset", styleName);
  const hiddenInput = document.getElementById("ui-style-selector");
  if (hiddenInput) hiddenInput.value = styleName;
  const labelEl = document.getElementById("ui-style-label");
  if (labelEl) labelEl.innerText = customLabel || styleNamesMap[styleName] || "Glass Bento";

  const wrapper = document.getElementById("dropdown-ui-style");
  if (wrapper) {
    wrapper.querySelectorAll(".modern-dropdown-item").forEach((item) => {
      item.classList.toggle("active", item.getAttribute("data-value") === styleName);
    });
  }
}

function applyEffectiveTheme(mode) {
  const doc = document.documentElement;
  if (mode === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    doc.setAttribute("data-theme", prefersDark ? "dark" : "light");
  } else {
    doc.setAttribute("data-theme", mode);
  }
  document.querySelectorAll("#theme-btn-light, #theme-btn-dark, #theme-btn-system").forEach((btn) => btn.classList.remove("active"));
  document.getElementById(`theme-btn-${mode}`)?.classList.add("active");
}

function setThemeMode(mode) {
  localStorage.setItem("vault_theme_pref", mode);
  applyEffectiveTheme(mode);
}

(function initDesignAndTheme() {
  const savedStyle = localStorage.getItem("vault_style_preset") || "glass";
  setUIStylePreset(savedStyle);

  const savedTheme = localStorage.getItem("vault_theme_pref") || "system";
  applyEffectiveTheme(savedTheme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((localStorage.getItem("vault_theme_pref") || "system") === "system") applyEffectiveTheme("system");
  });
})();

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

function togglePasswordModal(show) {
  if (sessionLoginType === "qr_restricted") {
    showToast("Settings are locked in Restricted Mode", "error");
    return;
  }
  const modal = document.getElementById("passwordModal");
  if (modal) modal.style.display = show ? "flex" : "none";
  const dropdown = document.getElementById("profile-menu-dropdown");
  if (dropdown) dropdown.style.display = "none";
}

async function submitPasswordChange() {
  const currentPassword = document.getElementById("currentPassword")?.value;
  const newPassword = document.getElementById("newPassword")?.value;
  const confirmPassword = document.getElementById("confirmPassword")?.value;
  if (!currentPassword || !newPassword || newPassword !== confirmPassword) {
    showToast("Check password fields!", "error");
    return;
  }
  try {
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
  } catch (e) {
    showToast("Network error updating password", "error");
  }
}