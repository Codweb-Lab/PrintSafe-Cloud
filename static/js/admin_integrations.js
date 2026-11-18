// ========================================================================
// 🔌 PRINTSAFE CLOUD — INTEGRATIONS & MULTI-SMTP MODAL CONTROLLER
// ========================================================================
let cachedSmtpProfiles = [];

async function loadAdminFeaturesAndIntegrations() {
  try {
    const fBox = document.getElementById("admin-feature-flags-list");
    if (fBox) {
      const fRes = await fetch("/api/admin/features");
      if (fRes.ok) {
        const fData = await fRes.json();
        fBox.innerHTML = fData.features.map((f) => `
          <div class="entity-card">
            <div>
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px;">
                <strong style="font-size:14px;">${f.feature_name}</strong>
                <label class="switch">
                  <input type="checkbox" ${f.is_enabled ? "checked" : ""} onchange="toggleFeatureFlag('${f.feature_key}', this.checked)">
                  <span class="slider"></span>
                </label>
              </div>
              <div style="font-size:12px;color:var(--cds-text-secondary);line-height:1.5;">${f.description}</div>
            </div>
            <div style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--cds-text-helper);border-top:1px solid var(--cds-border-subtle);padding-top:8px;">
              KEY: ${f.feature_key}
            </div>
          </div>`).join("");
      }
    }

    const iRes = await fetch("/api/admin/integrations");
    if (iRes.ok) {
      const cfg = await iRes.json();
      const gStatus = document.getElementById("google-cfg-status");
      const gUris = document.getElementById("adm-goog-uris");
      const oStatus = document.getElementById("onedrive-cfg-status");
      const oUris = document.getElementById("adm-oned-uris");
      const rStatus = document.getElementById("relay-cfg-status");

      if (gStatus) gStatus.innerText = cfg.google.has_client_id ? `Active: ${cfg.google.masked_id}` : "Not configured yet";
      if (gUris) gUris.innerText = `${cfg.google.login_callback_uri} | ${cfg.google.drive_callback_uri}`;
      if (oStatus) oStatus.innerText = cfg.onedrive.has_client_id ? `Active: ${cfg.onedrive.masked_id}` : "Not configured yet";
      if (oUris) oUris.innerText = cfg.onedrive.drive_callback_uri;

      if (cfg.relay) {
        const dIn = document.getElementById("adm-relay-domain");
        const uIn = document.getElementById("adm-relay-url");
        if (dIn && !dIn.value) dIn.value = cfg.relay.relay_domain || "";
        if (uIn && !uIn.value) uIn.value = cfg.relay.relay_url || "";
        if (rStatus) {
          rStatus.innerText = cfg.relay.has_secret && cfg.relay.relay_url
            ? `Active Domain: ${cfg.relay.relay_domain}`
            : "Not configured (Direct SMTP mode)";
        }
      }

      cachedSmtpProfiles = cfg.smtp_profiles || [];
      renderSmtpProfilesList();
      loadEmailTemplatesGrid();
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
      <div style="text-align:center;padding:24px;border:1px dashed var(--border);border-radius:14px;color:var(--text-sub);font-size:13px;">
        No SMTP profiles configured yet. Click <strong>"Add SMTP Gateway"</strong> to add cPanel, Gmail, Outlook, or Custom SMTP.
      </div>`;
    return;
  }

  container.innerHTML = cachedSmtpProfiles.map((p) => {
    const activeBadge = p.is_active
      ? `<span class="badge-admin"><i class="ri-checkbox-circle-fill"></i> ACTIVE GATEWAY</span>`
      : `<span class="badge-warn">STANDBY</span>`;

    return `
      <div class="smtp-profile-card ${p.is_active ? "is-active" : ""}">
        <div style="flex:1;min-width:220px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
            <span style="font-weight:800;font-size:14px;">${p.label}</span>
            <span class="badge-provider">${p.provider}</span>
            ${activeBadge}
          </div>
          <div style="font-size:12px;color:var(--text-sub);font-family:'JetBrains Mono',monospace;">
            ${p.smtp_host}:${p.smtp_port} • Auth: ${p.smtp_user} • From: ${p.smtp_from_name} &lt;${p.smtp_from_email}&gt;
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;">
          <button type="button" onclick="triggerTestSmtp('${p.id}')" class="btn btn-ghost" style="padding:7px 11px;font-size:11.5px;">
            <i class="ri-send-plane-line"></i> Test
          </button>
          <button type="button" onclick="openSmtpEditorModal('${p.id}')" class="btn btn-ghost" style="padding:7px 11px;font-size:11.5px;">
            <i class="ri-edit-line"></i> Edit
          </button>
          <button type="button" onclick="confirmDeleteSmtpProfile('${p.id}', '${p.label}')" class="btn btn-danger" style="padding:7px 10px;font-size:11.5px;">
            <i class="ri-delete-bin-line"></i>
          </button>
          <label class="switch" title="${p.is_active ? "Disable Gateway" : "Enable Gateway (disables others)"}">
            <input type="checkbox" ${p.is_active ? "checked" : ""} onchange="toggleSmtpProfileActive('${p.id}', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
      </div>`;
  }).join("");
}

function openSmtpEditorModal(profileId = "") {
  const modal = document.getElementById("modal-smtp-editor");
  const title = document.getElementById("smtp-editor-title");
  if (!modal) return;

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
      document.getElementById("adm-smtp-from-email").value = prof.smtp_from_email || "";
      document.getElementById("adm-smtp-make-active").checked = Boolean(prof.is_active);
    }
  } else {
    title.innerText = "Add SMTP Gateway Profile";
    const defaultBtn = modal.querySelector('.preset-pill[data-preset="cpanel"]');
    applySmtpPreset("cpanel", defaultBtn);
    document.getElementById("adm-smtp-label").value = "";
    document.getElementById("adm-smtp-user").value = "";
    document.getElementById("adm-smtp-pass").value = "";
    document.getElementById("adm-smtp-from-email").value = "";
    document.getElementById("adm-smtp-make-active").checked = true;
  }
  openModalById("modal-smtp-editor");
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
    hostEl.value = "";
    hostEl.placeholder = "e.g. mail.yourdomain.com";
    portEl.value = "465";
    userEl.placeholder = "e.g. no-reply@yourdomain.com";
    passEl.placeholder = "Enter cPanel Mailbox Password...";
    guideEl.innerHTML = "<b>cPanel / Custom Domain:</b> Routes via HTTPS Relay if configured for your domain, or directly over SSL Port 465.";
  } else if (preset === "gmail") {
    hostEl.value = "smtp.gmail.com";
    portEl.value = "587";
    userEl.placeholder = "e.g. youraccount@gmail.com";
    passEl.placeholder = "16-Digit Google App Password...";
    guideEl.innerHTML = "<b>Gmail SMTP:</b> Turn on 2-Step Verification in Google Account &rarr; <b>App Passwords</b> &rarr; Generate a 16-char password.";
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
    passEl.placeholder = "Brevo SMTP Relay Key...";
    guideEl.innerHTML = "<b>Brevo / Zoho Relay:</b> Verify your domain in Brevo Senders &amp; Domains for full SPF/DKIM alignment.";
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
    smtp_from_email: document.getElementById("adm-smtp-from-email").value.trim(),
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
      closeModalById("modal-smtp-editor");
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

function triggerTestSmtp(profileId = "") {
  openAdminInputModal({
    title: "Test SMTP Gateway Delivery",
    desc: "Enter the recipient email address where you want to receive a live 6-digit Test OTP:",
    placeholder: "e.g. yourname@gmail.com",
    inputType: "email",
    confirmText: "Send Test OTP",
    iconClass: "ri-mail-send-fill",
    onSubmit: async (toEmail) => {
      showAdminToast("Sending test OTP...");
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
      }
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
      idIn.placeholder = "Google OAuth Client ID (Drive + Sign-In Scopes)...";
      hint.innerHTML = "Enable <b>Google Drive API</b> and add both <code>/api/google/callback</code> and <code>/api/auth/google/user-callback</code>.";
    } else {
      idIn.placeholder = "e.g. 1234567890-abc.apps.googleusercontent.com";
      hint.innerHTML = "Authorized Redirect URIs:<br><code style='color:var(--accent);'>" + window.location.origin + "/api/google/callback</code>";
    }
  } else if (provider === "onedrive") {
    const hint = document.getElementById("oned-preset-hint");
    if (preset === "personal") {
      hint.innerHTML = "In Entra ID, select <b>Personal Microsoft accounts only</b> and add:<br><code style='color:var(--accent);'>" + window.location.origin + "/api/onedrive/callback</code>";
    } else {
      hint.innerHTML = "Select <b>Accounts in any organizational directory and personal Microsoft accounts</b> and add:<br><code style='color:var(--accent);'>" + window.location.origin + "/api/onedrive/callback</code>";
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
    if (res.ok) {
      closeModalById(section === "google" ? "modal-google-oauth" : "modal-onedrive-oauth");
    }
    await loadAdminFeaturesAndIntegrations();
  } catch (e) {
    showAdminToast("Network error while saving settings.", true);
  }
}

async function saveRelayVaultConfig() {
  const payload = {
    section: "relay",
    relay_domain: (document.getElementById("adm-relay-domain")?.value || "").trim(),
    relay_url: (document.getElementById("adm-relay-url")?.value || "").trim(),
    relay_secret: (document.getElementById("adm-relay-secret")?.value || "").trim()
  };

  try {
    const res = await fetch("/api/admin/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    showAdminToast(data.message || data.error || "Saved!", !res.ok);
    if (res.ok) closeModalById("modal-https-relay");
    await loadAdminFeaturesAndIntegrations();
  } catch (e) {
    showAdminToast("Network error saving relay config.", true);
  }
}

// ========================================================================
// 🎨 CUSTOM EMAIL TEMPLATES STUDIO + LOGO UPLOAD + LIVE PREVIEW
// ========================================================================
let cachedEmailTemplates = [];

async function loadEmailTemplatesGrid() {
  const grid = document.getElementById("admin-email-templates-grid");
  if (!grid) return;
  try {
    const res = await fetch("/api/admin/email-templates");
    const data = await res.json();
    if (!res.ok || !data.success) return;
    cachedEmailTemplates = data.templates || [];

    grid.innerHTML = cachedEmailTemplates.map((t) => `
      <div class="entity-card">
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
            <span class="carbon-tag tag-blue">${t.category.toUpperCase()}</span>
            ${t.is_active ? '<span class="carbon-tag tag-green">ACTIVE</span>' : '<span class="carbon-tag tag-amber">STANDBY</span>'}
          </div>
          <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${t.name}</div>
          <div style="font-size:12px;color:var(--cds-text-secondary);margin-bottom:10px;">Subject: ${t.subject}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid var(--cds-border-subtle);padding-top:10px;">
          <button type="button" onclick="openEmailTemplateModal('${t.template_id}')" class="btn btn-ghost" style="padding:5px 10px;font-size:11.5px;"><i class="ri-eye-line"></i> Edit &amp; Preview</button>
          ${!t.is_active ? `<button type="button" onclick="activateEmailTemplate('${t.template_id}', '${t.category}')" class="btn btn-emerald" style="padding:5px 10px;font-size:11.5px;">Activate</button>` : ""}
          <button type="button" onclick="deleteEmailTemplate('${t.template_id}')" class="btn btn-danger" style="padding:5px 9px;font-size:11.5px;"><i class="ri-delete-bin-line"></i></button>
        </div>
      </div>
    `).join("");

    const bcSelect = document.getElementById("bc-template-select");
    if (bcSelect) {
      bcSelect.innerHTML = cachedEmailTemplates
        .filter((t) => t.category !== "otp")
        .map((t) => `<option value="${t.template_id}">[${t.category.toUpperCase()}] ${t.name}</option>`)
        .join("");
    }
  } catch (e) {}
}

function openEmailTemplateModal(templateId = "") {
  const heading = document.getElementById("tpl-modal-heading");
  document.getElementById("tpl-edit-id").value = templateId || "";

  if (templateId) {
    const tpl = cachedEmailTemplates.find((x) => x.template_id === templateId);
    if (tpl) {
      heading.innerText = `Edit & Preview: ${tpl.name}`;
      document.getElementById("tpl-name").value = tpl.name;
      document.getElementById("tpl-category").value = tpl.category;
      document.getElementById("tpl-subject").value = tpl.subject;
      document.getElementById("tpl-logo-url").value = tpl.logo_url || "/static/images/logo3.png";
      document.getElementById("tpl-html-body").value = tpl.html_body;
      document.getElementById("tpl-is-active").checked = Boolean(tpl.is_active);
    }
  } else {
    heading.innerText = "Create Custom Email Template";
    document.getElementById("tpl-name").value = "";
    document.getElementById("tpl-category").value = "otp";
    document.getElementById("tpl-subject").value = "PrintSafe Cloud — Verification Code: {{otp_code}}";
    document.getElementById("tpl-logo-url").value = "/static/images/logo3.png";
    document.getElementById("tpl-html-body").value = cachedEmailTemplates[0]?.html_body || "";
    document.getElementById("tpl-is-active").checked = true;
  }
  openModalById("modal-email-template");
  renderEmailTemplateLivePreview();
}

function renderEmailTemplateLivePreview() {
  const iframe = document.getElementById("tpl-live-preview-iframe");
  if (!iframe) return;
  const rawHtml = document.getElementById("tpl-html-body").value || "";
  const logoUrl = document.getElementById("tpl-logo-url").value || "/static/images/logo3.png";
  const previewHtml = rawHtml
    .replaceAll("{{otp_code}}", "849201")
    .replaceAll("{{user_name}}", "Kapil Jangid")
    .replaceAll("{{user_email}}", "kapil@codweb.in")
    .replaceAll("{{subject}}", document.getElementById("tpl-subject").value || "Announcement")
    .replaceAll("{{message}}", "System update completed successfully. All cloud vaults are online.")
    .replaceAll("{{logo_url}}", logoUrl);
  iframe.srcdoc = `<div style="padding:16px;">${previewHtml}</div>`;
}

async function uploadTemplateLogoFile(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append("logo", file);
  const res = await fetch("/api/admin/email-templates/upload-logo", { method: "POST", body: fd });
  const data = await res.json();
  if (res.ok && data.success) {
    document.getElementById("tpl-logo-url").value = data.logo_url;
    renderEmailTemplateLivePreview();
    showAdminToast("Brand logo uploaded & preview updated!");
  } else {
    showAdminToast(data.error || "Logo upload failed", true);
  }
}

async function saveEmailTemplateForm() {
  const payload = {
    action: "save",
    template_id: document.getElementById("tpl-edit-id").value.trim(),
    name: document.getElementById("tpl-name").value.trim(),
    category: document.getElementById("tpl-category").value,
    subject: document.getElementById("tpl-subject").value.trim(),
    logo_url: document.getElementById("tpl-logo-url").value.trim(),
    html_body: document.getElementById("tpl-html-body").value.trim(),
    is_active: document.getElementById("tpl-is-active").checked
  };
  const res = await fetch("/api/admin/email-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (res.ok && data.success) {
    showAdminToast(data.message);
    closeModalById("modal-email-template");
    await loadEmailTemplatesGrid();
  } else {
    showAdminToast(data.error || "Failed to save template", true);
  }
}

async function activateEmailTemplate(templateId, category) {
  const res = await fetch("/api/admin/email-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "activate", template_id: templateId, category })
  });
  const data = await res.json();
  if (res.ok && data.success) {
    showAdminToast(data.message);
    await loadEmailTemplatesGrid();
  }
}

async function deleteEmailTemplate(templateId) {
  openAdminConfirmModal({
    title: "Delete Email Template?",
    desc: "Are you sure you want to remove this custom email template?",
    confirmText: "Delete",
    isDanger: true,
    onConfirm: async () => {
      await fetch("/api/admin/email-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", template_id: templateId })
      });
      showAdminToast("Template deleted.");
      await loadEmailTemplatesGrid();
    }
  });
}