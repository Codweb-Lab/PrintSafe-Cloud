// ========================================================================
// 🛡️ PRINTSAFE CLOUD — DEDICATED ADMIN PORTAL CONTROLLER (admin.js)
// ========================================================================
let cachedSmtpProfiles = [];
let pendingConfirmAction = null;
let pendingInputAction = null;

function showAdminToast(message, isError = false) {
  const box = document.getElementById("admin-toast-box");
  if (!box) return;
  const toast = document.createElement("div");
  toast.className = "admin-toast";
  toast.style.borderColor = isError ? "rgba(244,63,94,0.6)" : "rgba(56,189,248,0.45)";
  toast.innerHTML = `<i class="${isError ? "ri-error-warning-fill" : "ri-checkbox-circle-fill"}" style="color:${isError ? "#fb7185" : "#10b981"};font-size:17px;"></i><span>${message}</span>`;
  box.appendChild(toast);
  setTimeout(() => toast.remove(), 3800);
}

// ========================================================================
// 🪟 CUSTOM ENTERPRISE MODALS (REPLACES ALL NATIVE ALERT/CONFIRM/PROMPT)
// ========================================================================
function openAdminConfirmModal({ title, desc, confirmText = "Confirm", isDanger = true, iconClass = "ri-error-warning-fill", onConfirm }) {
  const modal = document.getElementById("admin-confirm-modal");
  if (!modal) return;

  document.getElementById("adm-confirm-title").innerText = title;
  document.getElementById("adm-confirm-desc").innerText = desc;
  const iconEl = document.getElementById("adm-confirm-icon");
  iconEl.className = iconClass;
  iconEl.style.color = isDanger ? "var(--rose)" : "var(--accent)";

  const okBtn = document.getElementById("adm-confirm-ok-btn");
  okBtn.innerText = confirmText;
  okBtn.className = isDanger ? "btn btn-danger" : "btn btn-sky";

  pendingConfirmAction = onConfirm;
  okBtn.onclick = async () => {
    closeAdminConfirmModal();
    if (typeof pendingConfirmAction === "function") {
      await pendingConfirmAction();
    }
  };
  modal.classList.add("open");
}

function closeAdminConfirmModal() {
  const modal = document.getElementById("admin-confirm-modal");
  if (modal) modal.classList.remove("open");
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
  setTimeout(() => field.focus(), 50);
}

function closeAdminInputModal() {
  const modal = document.getElementById("admin-input-modal");
  if (modal) modal.classList.remove("open");
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
  if (typeof cb === "function") {
    await cb(val);
  }
}

// Close open modals on Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAdminConfirmModal();
    closeAdminInputModal();
  }
});

// ========================================================================
// 🗂️ CATEGORY-WISE SIDEBAR NAVIGATION SWITCHER
// ========================================================================
function switchAdminCategory(panelName, btnEl) {
  document.querySelectorAll(".admin-panel").forEach((panel) => {
    panel.classList.remove("active");
  });
  document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  const targetPanel = document.getElementById(`panel-${panelName}`);
  if (targetPanel) targetPanel.classList.add("active");
  if (btnEl) btnEl.classList.add("active");
}
window.switchAdminCategory = switchAdminCategory;

// ========================================================================
// 🔐 ADMIN AUTHENTICATION & LOGOUT
// ========================================================================
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

function confirmAdminLogout() {
  openAdminConfirmModal({
    title: "Logout Admin Console?",
    desc: "Are you sure you want to end your Administrator control plane session?",
    confirmText: "Yes, Logout",
    isDanger: true,
    iconClass: "ri-logout-box-r-line",
    onConfirm: async () => {
      try {
        await fetch("/api/admin/logout", { method: "POST" });
      } catch (e) {}
      window.location.href = "/admin";
    }
  });
}

// ========================================================================
// 📊 SYSTEM OVERVIEW, HOSTED LOCAL VAULT & REGISTERED USERS LOADER
// ========================================================================
async function loadAdminDashboard(notify = false) {
  const statsGrid = document.getElementById("admin-stats-grid");
  if (!statsGrid) return;

  try {
    const [ovRes, dirRes] = await Promise.all([
      fetch("/api/admin/overview"),
      fetch("/api/admin/vault-dir")
    ]);

    if (ovRes.ok) {
      const ov = await ovRes.json();
      const t = ov.telemetry;

      statsGrid.innerHTML = `
        <div class="stat-card">
          <div style="font-size:10.5px;color:var(--text-sub);font-weight:800;letter-spacing:0.6px;">SERVER CPU / RAM</div>
          <div class="stat-val">${t.cpu_percent}% <span style="font-size:15px;color:var(--text-sub);">/ ${t.ram_percent}%</span></div>
          <div style="font-size:11.5px;color:var(--text-sub);">${t.ram_used_mb} / ${t.ram_total_mb} MB</div>
          <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, t.ram_percent)}%;"></div></div>
        </div>
        <div class="stat-card">
          <div style="font-size:10.5px;color:var(--text-sub);font-weight:800;letter-spacing:0.6px;">HOSTED LOCAL VAULT</div>
          <div class="stat-val" style="color:var(--emerald);">${t.hosted_vault_mb} MB</div>
          <div style="font-size:11.5px;color:var(--text-sub);">Disk Free: ${t.disk_free_gb} GB</div>
          <div class="progress-track"><div class="progress-fill" style="width:35%;background:var(--emerald);"></div></div>
        </div>
        <div class="stat-card">
          <div style="font-size:10.5px;color:var(--text-sub);font-weight:800;letter-spacing:0.6px;">REGISTERED USERS</div>
          <div class="stat-val">${t.total_users}</div>
          <div style="font-size:11.5px;color:var(--text-sub);">Active QR Sessions: ${t.active_qr_sessions}</div>
        </div>
        <div class="stat-card">
          <div style="font-size:10.5px;color:var(--text-sub);font-weight:800;letter-spacing:0.6px;">CLOUD &amp; SFTP MOUNTS</div>
          <div class="stat-val">${t.total_clouds + t.total_remote_storages}</div>
          <div style="font-size:11.5px;color:var(--text-sub);">SQLite DB Size: ${t.db_size_kb} KB</div>
        </div>
      `;

      const usersContainer = document.getElementById("admin-users-container");
      if (usersContainer) {
        usersContainer.innerHTML = ov.users.length
          ? ov.users
              .map(
                (u) => `
              <div class="row-item">
                <div>
                  <div style="font-weight:700;font-size:13.5px;">${u.full_name} <span class="badge-admin">${u.auth_provider.toUpperCase()}</span> ${u.totp_enabled ? '<span class="badge-admin">2FA ON</span>' : ""}</div>
                  <div style="font-size:11.5px;color:var(--text-sub);">${u.email} ${u.phone ? "• " + u.phone : ""}</div>
                </div>
                <button onclick="confirmDeleteUserByAdmin('${u.user_id}', '${u.email}')" class="btn btn-danger"><i class="ri-delete-bin-line"></i> Remove</button>
              </div>`
              )
              .join("")
          : `<div style="font-size:13px;color:var(--text-sub);">No users registered yet.</div>`;
      }
    }

    if (dirRes.ok) {
      const d = await dirRes.json();
      const pathInput = document.getElementById("admin-vault-path-input");
      if (pathInput) pathInput.value = d.path;
      const entriesBox = document.getElementById("admin-hosted-entries");
      if (entriesBox) {
        entriesBox.innerHTML = d.entries.length
          ? d.entries
              .map(
                (e) => `
              <div class="row-item">
                <span><i class="${e.is_dir ? "ri-folder-3-fill" : "ri-file-text-line"}" style="color:${e.is_dir ? "#f59e0b" : "#38bdf8"};margin-right:8px;"></i>${e.name}</span>
                <span style="font-size:12px;color:var(--text-sub);">${e.is_dir ? "Directory" : e.size_kb + " KB"}</span>
              </div>`
              )
              .join("")
          : `<div style="font-size:12.5px;color:var(--text-sub);">Directory is currently empty.</div>`;
      }
    }

    await loadAdminFeaturesAndIntegrations();
    if (notify) showAdminToast("System telemetry refreshed.");
  } catch (e) {
    console.error("[ADMIN DASHBOARD LOAD ERROR]:", e);
  }
}

// ========================================================================
// 🎛️ FEATURE FLAGS, OAUTH & MULTI-SMTP PROFILES LOADER
// ========================================================================
async function loadAdminFeaturesAndIntegrations() {
  try {
    const fBox = document.getElementById("admin-feature-flags-list");
    if (fBox) {
      const fRes = await fetch("/api/admin/features");
      if (fRes.ok) {
        const fData = await fRes.json();
        fBox.innerHTML = fData.features
          .map(
            (f) => `
          <div class="row-item">
            <div>
              <div style="font-weight:700;font-size:13.5px;">${f.feature_name}</div>
              <div style="font-size:11.5px;color:var(--text-sub);">${f.description}</div>
            </div>
            <label class="switch">
              <input type="checkbox" ${f.is_enabled ? "checked" : ""} onchange="toggleFeatureFlag('${f.feature_key}', this.checked)">
              <span class="slider"></span>
            </label>
          </div>`
          )
          .join("");
      }
    }

    const iRes = await fetch("/api/admin/integrations");
    if (iRes.ok) {
      const cfg = await iRes.json();
      const gStatus = document.getElementById("google-cfg-status");
      const gUris = document.getElementById("adm-goog-uris");
      const oStatus = document.getElementById("onedrive-cfg-status");
      const oUris = document.getElementById("adm-oned-uris");

      if (gStatus) gStatus.innerText = cfg.google.has_client_id ? `Active: ${cfg.google.masked_id}` : "Not configured yet";
      if (gUris) gUris.innerText = `${cfg.google.login_callback_uri} | ${cfg.google.drive_callback_uri}`;
      if (oStatus) oStatus.innerText = cfg.onedrive.has_client_id ? `Active: ${cfg.onedrive.masked_id}` : "Not configured yet";
      if (oUris) oUris.innerText = cfg.onedrive.drive_callback_uri;

      cachedSmtpProfiles = cfg.smtp_profiles || [];
      renderSmtpProfilesList();
    }
  } catch (e) {
    console.error("[INTEGRATIONS LOAD ERROR]:", e);
  }
}

function renderSmtpProfilesList() {
  const container = document.getElementById("smtp-profiles-list-container");
  if (!container) return;

  if (!cachedSmtpProfiles.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:26px;border:1px dashed var(--border);border-radius:14px;color:var(--text-sub);font-size:13px;">
        No SMTP profiles added yet. Click <strong>"Add New SMTP Gateway"</strong> above to add cPanel, Gmail, Outlook, or Custom SMTP.
      </div>`;
    return;
  }

  container.innerHTML = cachedSmtpProfiles
    .map((p) => {
      const activeBadge = p.is_active
        ? `<span class="badge-admin"><i class="ri-checkbox-circle-fill"></i> ACTIVE GATEWAY</span>`
        : `<span class="badge-warn">STANDBY / DISABLED</span>`;

      return `
      <div class="smtp-profile-card ${p.is_active ? "is-active" : ""}">
        <div style="flex:1;min-width:240px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
            <span style="font-weight:800;font-size:14px;">${p.label}</span>
            <span class="badge-provider">${p.provider}</span>
            ${activeBadge}
          </div>
          <div style="font-size:12px;color:var(--text-sub);font-family:'JetBrains Mono',monospace;">
            ${p.smtp_host}:${p.smtp_port} • Auth: ${p.smtp_user} • From: ${p.smtp_from_name} &lt;${p.smtp_from_email}&gt;
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button type="button" onclick="triggerTestSmtp('${p.id}')" class="btn btn-ghost" style="padding:7px 11px;font-size:11.5px;" title="Test this specific profile">
            <i class="ri-send-plane-line"></i> Test
          </button>
          <button type="button" onclick="openSmtpEditorForm('${p.id}')" class="btn btn-ghost" style="padding:7px 11px;font-size:11.5px;" title="Edit profile">
            <i class="ri-edit-line"></i> Edit
          </button>
          <button type="button" onclick="confirmDeleteSmtpProfile('${p.id}', '${p.label}')" class="btn btn-danger" style="padding:7px 10px;font-size:11.5px;" title="Delete profile">
            <i class="ri-delete-bin-line"></i>
          </button>
          <label class="switch" title="${p.is_active ? "Disable Gateway" : "Enable Gateway (disables others)"}">
            <input type="checkbox" ${p.is_active ? "checked" : ""} onchange="toggleSmtpProfileActive('${p.id}', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
      </div>`;
    })
    .join("");
}

// ========================================================================
// 📧 SMTP PROFILE DRAWER, PRESETS, SINGLE-ACTIVE TOGGLE & LIVE TEST
// ========================================================================
function openSmtpEditorForm(profileId = "") {
  const drawer = document.getElementById("smtp-editor-drawer");
  const title = document.getElementById("smtp-editor-title");
  if (!drawer) return;

  drawer.style.display = "block";
  document.getElementById("edit-smtp-id").value = profileId || "";

  if (profileId) {
    const prof = cachedSmtpProfiles.find((x) => x.id === profileId);
    if (prof) {
      title.innerText = `Edit SMTP Profile: ${prof.label}`;
      document.getElementById("edit-smtp-provider").value = prof.provider || "custom";
      document.getElementById("adm-smtp-label").value = prof.label || "";
      document.getElementById("adm-smtp-host").value = prof.smtp_host || "";
      document.getElementById("adm-smtp-port").value = prof.smtp_port || "465";
      document.getElementById("adm-smtp-user").value = prof.smtp_user || "";
      document.getElementById("adm-smtp-pass").value = "";
      document.getElementById("adm-smtp-from-name").value = prof.smtp_from_name || "PrintSafe Cloud";
      document.getElementById("adm-smtp-from-email").value = prof.smtp_from_email || "no-reply@codweb.in";
      document.getElementById("adm-smtp-make-active").checked = Boolean(prof.is_active);
    }
  } else {
    title.innerText = "Add New SMTP Gateway Profile";
    const defaultBtn = drawer.querySelector('.preset-pill[data-preset="cpanel"]');
    applySmtpPreset("cpanel", defaultBtn);
    document.getElementById("adm-smtp-label").value = "";
    document.getElementById("adm-smtp-user").value = "";
    document.getElementById("adm-smtp-pass").value = "";
    document.getElementById("adm-smtp-make-active").checked = true;
  }
  drawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeSmtpEditorForm() {
  const drawer = document.getElementById("smtp-editor-drawer");
  if (drawer) drawer.style.display = "none";
}

function applySmtpPreset(preset, btnEl) {
  if (btnEl) {
    btnEl.parentElement.querySelectorAll(".preset-pill").forEach((p) => p.classList.remove("active"));
    btnEl.classList.add("active");
  }
  document.getElementById("edit-smtp-provider").value = preset;

  const hostEl = document.getElementById("adm-smtp-host");
  const portEl = document.getElementById("adm-smtp-port");
  const userEl = document.getElementById("adm-smtp-user");
  const passEl = document.getElementById("adm-smtp-pass");
  const guideEl = document.getElementById("smtp-preset-guide");

  if (preset === "cpanel") {
    hostEl.value = "mail.codweb.in";
    portEl.value = "465";
    userEl.placeholder = "e.g. no-reply@codweb.in";
    passEl.placeholder = "Enter cPanel Mailbox Password...";
    guideEl.innerHTML = "<b>cPanel / Custom Domain:</b> Automatically routes via authenticated local relay on <code>codweb.in</code> with no-reply masking.";
  } else if (preset === "gmail") {
    hostEl.value = "smtp.gmail.com";
    portEl.value = "587";
    userEl.placeholder = "e.g. youraccount@gmail.com";
    passEl.placeholder = "16-Digit Google App Password...";
    guideEl.innerHTML = "<b>Gmail SMTP:</b> Enable 2-Step Verification in Google Account &rarr; <b>App Passwords</b> &rarr; Generate a 16-character App Password.";
  } else if (preset === "outlook") {
    hostEl.value = "smtp.office365.com";
    portEl.value = "587";
    userEl.placeholder = "e.g. sender@yourdomain.onmicrosoft.com";
    passEl.placeholder = "Microsoft 365 / Outlook App Password...";
    guideEl.innerHTML = "<b>Microsoft Outlook / Office 365:</b> Enable Authenticated SMTP in M365 Admin Center on Port <b>587 (STARTTLS)</b>.";
  } else if (preset === "brevo") {
    hostEl.value = "smtp-relay.brevo.com";
    portEl.value = "587";
    userEl.placeholder = "e.g. login@smtp-brevo.com";
    passEl.placeholder = "Brevo SMTP Key...";
    guideEl.innerHTML = "<b>Brevo / Zoho Relay:</b> Verify <code>codweb.in</code> in Brevo Senders &amp; Domains for full SPF/DKIM delivery.";
  } else {
    hostEl.value = "";
    hostEl.placeholder = "Enter Custom SMTP Hostname...";
    portEl.value = "587";
    userEl.placeholder = "Enter SMTP Username...";
    passEl.placeholder = "Enter SMTP Password...";
    guideEl.innerHTML = "<b>Custom SMTP:</b> Configure any third-party SMTP server with SSL (465) or STARTTLS (587).";
  }
}

async function saveSmtpProfileForm() {
  const payload = {
    section: "smtp_save",
    id: document.getElementById("edit-smtp-id").value.trim(),
    provider: document.getElementById("edit-smtp-provider").value.trim(),
    label: document.getElementById("adm-smtp-label").value.trim(),
    smtp_host: document.getElementById("adm-smtp-host").value.trim(),
    smtp_port: document.getElementById("adm-smtp-port").value.trim(),
    smtp_user: document.getElementById("adm-smtp-user").value.trim(),
    smtp_pass: document.getElementById("adm-smtp-pass").value.trim(),
    smtp_from_name: document.getElementById("adm-smtp-from-name").value.trim() || "PrintSafe Cloud",
    smtp_from_email: document.getElementById("adm-smtp-from-email").value.trim() || "no-reply@codweb.in",
    is_active: document.getElementById("adm-smtp-make-active").checked
  };

  try {
    const res = await fetch("/api/admin/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showAdminToast(data.message);
      closeSmtpEditorForm();
      await loadAdminFeaturesAndIntegrations();
    } else {
      showAdminToast(data.error || "Failed to save SMTP profile", true);
    }
  } catch (e) {
    showAdminToast("Network error saving SMTP profile", true);
  }
}

async function toggleSmtpProfileActive(profileId, enable) {
  try {
    const res = await fetch("/api/admin/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section: "smtp_toggle", id: profileId, enable })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showAdminToast(data.message);
      await loadAdminFeaturesAndIntegrations();
    } else {
      showAdminToast(data.error || "Failed to toggle gateway", true);
    }
  } catch (e) {
    showAdminToast("Network error toggling gateway", true);
  }
}

function confirmDeleteSmtpProfile(profileId, label) {
  openAdminConfirmModal({
    title: "Delete SMTP Gateway?",
    desc: `Are you sure you want to permanently remove "${label}"?`,
    confirmText: "Delete Profile",
    isDanger: true,
    iconClass: "ri-delete-bin-fill",
    onConfirm: async () => {
      try {
        const res = await fetch("/api/admin/integrations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section: "smtp_delete", id: profileId })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showAdminToast(data.message);
          await loadAdminFeaturesAndIntegrations();
        }
      } catch (e) {
        showAdminToast("Error deleting SMTP profile", true);
      }
    }
  });
}

async function executeTestSmtpRequest(toEmail, profileId = "") {
  const btn = document.getElementById("smtp-quick-test-btn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="ri-loader-4-line"></i> Sending...`;
  }

  try {
    const res = await fetch("/api/admin/smtp/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_email: toEmail, id: profileId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showAdminToast(data.message);
    } else {
      showAdminToast(data.error || "SMTP Test failed", true);
    }
  } catch (e) {
    showAdminToast("Network error during SMTP test", true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="ri-send-plane-fill"></i> Send Test OTP`;
    }
  }
}

function triggerTestSmtp(profileId = "") {
  const emailInput = document.getElementById("smtp-quick-test-email");
  const existingEmail = (emailInput?.value || "").trim();

  if (existingEmail && existingEmail.includes("@")) {
    executeTestSmtpRequest(existingEmail, profileId);
    return;
  }

  openAdminInputModal({
    title: "Test SMTP Gateway Delivery",
    desc: "Enter the recipient email address where you want to receive a live 6-digit Test OTP:",
    placeholder: "e.g. yourname@gmail.com",
    inputType: "email",
    confirmText: "Send Test OTP",
    iconClass: "ri-mail-send-fill",
    onSubmit: async (enteredEmail) => {
      if (emailInput) emailInput.value = enteredEmail;
      await executeTestSmtpRequest(enteredEmail, profileId);
    }
  });
}

function applyOAuthPreset(provider, preset, btnEl) {
  btnEl.parentElement.querySelectorAll(".preset-pill").forEach((p) => p.classList.remove("active"));
  btnEl.classList.add("active");

  if (provider === "google") {
    const idIn = document.getElementById("adm-goog-id");
    const hint = document.getElementById("goog-preset-hint");
    if (preset === "drive_login") {
      idIn.placeholder = "Google OAuth Client ID (Drive + Sign-In Scopes Enabled)...";
      hint.innerHTML = "Enable <b>Google Drive API</b> in Google Cloud Console and add both <code>/api/google/callback</code> and <code>/api/auth/google/user-callback</code>.";
    } else {
      idIn.placeholder = "e.g. 1234567890-abc.apps.googleusercontent.com";
      hint.innerHTML = "Add these Authorized Redirect URIs in Google Cloud Console:<br><code style='color:#38bdf8;'>" + window.location.origin + "/api/google/callback</code>";
    }
  } else if (provider === "onedrive") {
    const hint = document.getElementById("oned-preset-hint");
    if (preset === "personal") {
      hint.innerHTML = "In Entra ID &rarr; Authentication, select <b>Personal Microsoft accounts only</b> and add:<br><code style='color:#38bdf8;'>" + window.location.origin + "/api/onedrive/callback</code>";
    } else {
      hint.innerHTML = "Select <b>Accounts in any organizational directory and personal Microsoft accounts</b> in Entra ID and add:<br><code style='color:#38bdf8;'>" + window.location.origin + "/api/onedrive/callback</code>";
    }
  }
}

async function toggleFeatureFlag(feature_key, is_enabled) {
  try {
    await fetch("/api/admin/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature_key, is_enabled })
    });
    showAdminToast(`Feature '${feature_key}' ${is_enabled ? "enabled" : "disabled"}.`);
  } catch (e) {
    console.error("[FEATURE TOGGLE ERROR]:", e);
  }
}

async function saveAdminIntegration(section) {
  let payload = { section };
  if (section === "google") {
    payload.client_id = (document.getElementById("adm-goog-id")?.value || "").trim();
    payload.client_secret = (document.getElementById("adm-goog-secret")?.value || "").trim();
  } else if (section === "onedrive") {
    payload.client_id = (document.getElementById("adm-oned-id")?.value || "").trim();
    payload.client_secret = (document.getElementById("adm-oned-secret")?.value || "").trim();
  }

  try {
    const res = await fetch("/api/admin/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    showAdminToast(data.message || data.error || "Saved!", !res.ok);
    await loadAdminFeaturesAndIntegrations();
  } catch (e) {
    showAdminToast("Network error while saving settings.", true);
  }
}

// ========================================================================
// 📁 HOSTED LOCAL VAULT DIRECTORY & USER REMOVAL (WITH CUSTOM MODALS)
// ========================================================================
async function saveAdminVaultPath() {
  const path = (document.getElementById("admin-vault-path-input")?.value || "").trim();
  if (!path) {
    showAdminToast("Please enter a valid directory path.", true);
    return;
  }
  try {
    const res = await fetch("/api/admin/vault-dir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    });
    const data = await res.json();
    if (data.success) {
      showAdminToast("Hosted Vault directory updated!");
      await loadAdminDashboard();
    } else {
      showAdminToast(data.error || "Failed to update directory", true);
    }
  } catch (e) {
    showAdminToast("Network error updating directory.", true);
  }
}

function openCreateFolderModal() {
  openAdminInputModal({
    title: "Create New Vault Folder",
    desc: "Enter a folder name to create inside the Admin Hosted Local Vault:",
    placeholder: "e.g. Client_Prints_2026",
    inputType: "text",
    confirmText: "Create Folder",
    iconClass: "ri-folder-add-fill",
    onSubmit: async (folderName) => {
      try {
        const res = await fetch("/api/admin/vault-dir/create-folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder_name: folderName })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showAdminToast(`Folder "${folderName}" created!`);
          await loadAdminDashboard();
        } else {
          showAdminToast(data.error || "Invalid folder name", true);
        }
      } catch (e) {
        showAdminToast("Error creating folder.", true);
      }
    }
  });
}

function confirmDeleteUserByAdmin(userId, email) {
  openAdminConfirmModal({
    title: "Remove Registered User?",
    desc: `This will permanently delete the user account (${email}) and revoke their vault access.`,
    confirmText: "Remove User",
    isDanger: true,
    iconClass: "ri-user-unfollow-fill",
    onConfirm: async () => {
      try {
        await fetch("/api/admin/users/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userId, action: "delete" })
        });
        showAdminToast("User removed permanently.");
        await loadAdminDashboard();
      } catch (e) {
        showAdminToast("Error removing user.", true);
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", () => loadAdminDashboard(false));