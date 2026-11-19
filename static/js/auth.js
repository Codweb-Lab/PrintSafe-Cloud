// ========================================================================
// PRINTSAFE CLOUD — USER AUTH, 3-STEP REGISTRATION & 2FA (auth.js)
// ========================================================================
let activeLoginSubMethod = "email"; // 'email' | 'otp' | 'pin'
let verifiedSignInEmail = "";
let isLoginSubmitting = false;

// ========================================================================
// LOCK / UNLOCK OPPOSITE TABS, SUB-METHODS, OAUTH & QR BUTTONS
// ========================================================================
function setAuthOngoingState(mode, isOngoing) {
  const signinTab = document.getElementById("tab-user-signin");
  const signupTab = document.getElementById("tab-user-signup");
  const submethodsBar = document.getElementById("signin-submethods-bar");
  const signinGoogle = document.getElementById("signin-google-btn");
  const signupGoogle = document.getElementById("signup-google-btn");
  const qrBtn = document.getElementById("signin-qr-btn");

  const applyLock = (el, lock) => {
    if (!el) return;
    el.style.pointerEvents = lock ? "none" : "auto";
    el.style.opacity = lock ? "0.42" : "1";
    if ("disabled" in el) el.disabled = lock;
  };

  if (mode === "signin") {
    applyLock(signupTab, isOngoing);
    applyLock(submethodsBar, isOngoing);
    applyLock(signinGoogle, isOngoing);
    applyLock(qrBtn, isOngoing);
  } else if (mode === "signup") {
    applyLock(signinTab, isOngoing);
    applyLock(signupGoogle, isOngoing);
  } else {
    applyLock(signinTab, false);
    applyLock(signupTab, false);
    applyLock(submethodsBar, false);
    applyLock(signinGoogle, false);
    applyLock(signupGoogle, false);
    applyLock(qrBtn, false);
  }
}

function switchUserAuthMode(mode) {
  setAuthOngoingState("none", false);
  const signInPanel = document.getElementById("panel-user-signin");
  const signUpPanel = document.getElementById("panel-user-signup");
  const tabIn = document.getElementById("tab-user-signin");
  const tabUp = document.getElementById("tab-user-signup");
  const qrCta = document.getElementById("qr-login-cta-wrapper");

  if (signInPanel) signInPanel.style.display = mode === "signin" ? "block" : "none";
  if (signUpPanel) signUpPanel.style.display = mode === "signup" ? "block" : "none";
  if (tabIn) tabIn.classList.toggle("active", mode === "signin");
  if (tabUp) tabUp.classList.toggle("active", mode === "signup");
  if (qrCta) qrCta.style.display = mode === "signin" ? "" : "none";
}

function resetSignInFlows() {
  verifiedSignInEmail = "";
  isLoginSubmitting = false;
  setAuthOngoingState("none", false);

  const eStep1 = document.getElementById("email-login-step1");
  const eStep2 = document.getElementById("email-login-step2");
  const ePass = document.getElementById("email-login-password-input");
  if (eStep1) eStep1.style.display = "block";
  if (eStep2) eStep2.style.display = "none";
  if (ePass) ePass.value = "";

  const oStep1 = document.getElementById("otp-login-step1");
  const oStep2 = document.getElementById("otp-login-step2");
  const oCode = document.getElementById("otp-login-code-input");
  if (oStep1) oStep1.style.display = "block";
  if (oStep2) oStep2.style.display = "none";
  if (oCode) oCode.value = "";

  const pIdent = document.getElementById("pin-login-identifier-input");
  const pCode = document.getElementById("pin-login-code-input");
  const twoFaBox = document.getElementById("signin-2fa-box");
  const twoFaCode = document.getElementById("signin-totp-code");
  if (pIdent) pIdent.value = "";
  if (pCode) pCode.value = "";
  if (twoFaBox) twoFaBox.style.display = "none";
  if (twoFaCode) twoFaCode.value = "";

  ["email", "otp", "pin"].forEach((m) => {
    const flowEl = document.getElementById(`signin-flow-${m}`);
    if (flowEl) flowEl.style.display = m === activeLoginSubMethod ? "block" : "none";
  });
}

function resetRegisterFlows() {
  setAuthOngoingState("none", false);
  const s1 = document.getElementById("reg-step-1");
  const s2 = document.getElementById("reg-step-2");
  const s3 = document.getElementById("reg-step-3");
  const otpIn = document.getElementById("reg-otp-input");
  const passIn = document.getElementById("reg-pass-input");
  const pinIn = document.getElementById("reg-pin-input");
  const btn1 = document.getElementById("reg-step1-btn");

  if (s1) s1.style.display = "block";
  if (s2) s2.style.display = "none";
  if (s3) s3.style.display = "none";
  if (otpIn) otpIn.value = "";
  if (passIn) passIn.value = "";
  if (pinIn) pinIn.value = "";
  if (btn1) {
    btn1.disabled = false;
    btn1.innerHTML = `<i class="ri-mail-send-line"></i> Send Verification OTP`;
  }
}

function setLoginSubMethod(method) {
  activeLoginSubMethod = method;
  resetSignInFlows();

  ["email", "otp", "pin"].forEach((m) => {
    document.getElementById(`method-btn-${m}`)?.classList.toggle("active", m === method); const flowEl = document.getElementById(`signin-flow-${m}`);
    if (flowEl) flowEl.style.display = m === method ? "block" : "none";
  });
}

// ========================================================================
// SIGN IN FLOWS (EMAIL, OTP, PIN & 2FA INPUT SWAP)
// ========================================================================
async function verifyEmailForLogin() {
  const emailInput = document.getElementById("email-login-email-input");
  const btn = document.getElementById("email-step1-btn");
  const email = (emailInput?.value || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    showToast("Please enter a valid email address.", "error");
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="vault-spinner small" style="border-top-color:#fff;"></div> Checking...`;
  }

  try {
    const res = await fetch("/api/user/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || "Email not found.", "error");
      return;
    }

    verifiedSignInEmail = email;
    document.getElementById("email-login-step1").style.display = "none";
    document.getElementById("email-login-step2").style.display = "block";
    document.getElementById("email-verified-label").innerText = email;
    setAuthOngoingState("signin", true);
    requestAnimationFrame(() => document.getElementById("email-login-password-input")?.focus());
  } catch (e) {
    showToast("Network error verifying email.", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="ri-arrow-right-line"></i> Continue`;
    }
  }
}

async function sendUserSignInOtp() {
  const email = (document.getElementById("otp-login-email-input")?.value || "").trim().toLowerCase();
  const btn = document.getElementById("otp-step1-btn");
  if (!email || !email.includes("@")) {
    showToast("Enter your registered email address first.", "error");
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="vault-spinner small" style="border-top-color:#fff;"></div> Sending OTP...`;
  }
  setAuthOngoingState("signin", true);

  try {
    const res = await fetch("/api/user/send-login-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      setAuthOngoingState("none", false);
      showToast(data.error || "Could not send OTP.", "error");
      return;
    }

    verifiedSignInEmail = email;
    document.getElementById("otp-login-step1").style.display = "none";
    document.getElementById("otp-login-step2").style.display = "block";
    document.getElementById("otp-verified-label").innerText = email;
    requestAnimationFrame(() => document.getElementById("otp-login-code-input")?.focus());
    showToast(data.message || "OTP sent!", "success");
  } catch (e) {
    setAuthOngoingState("none", false);
    showToast("Network error sending OTP.", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="ri-mail-send-line"></i> Send OTP`;
    }
  }
}

async function submitUserLogin() {
  if (isLoginSubmitting) return;

  let email = verifiedSignInEmail;
  let credential = "";
  let activeBtn = null;
  let defaultBtnHtml = "";

  if (activeLoginSubMethod === "email") {
    credential = (document.getElementById("email-login-password-input")?.value || "").trim();
    activeBtn = document.getElementById("email-step2-btn") || document.querySelector("#email-login-step2 button.btn-primary, #email-login-step2 button[onclick*='submitUserLogin']");
  } else if (activeLoginSubMethod === "otp") {
    credential = (document.getElementById("otp-login-code-input")?.value || "").trim();
    activeBtn = document.getElementById("otp-step2-btn") || document.querySelector("#otp-login-step2 button.btn-primary, #otp-login-step2 button[onclick*='submitUserLogin']");
  } else if (activeLoginSubMethod === "pin") {
    email = (document.getElementById("pin-login-identifier-input")?.value || "").trim().toLowerCase();
    credential = (document.getElementById("pin-login-code-input")?.value || "").trim();
    activeBtn = document.getElementById("pin-step1-btn");
    if (!email) {
      showToast("Please enter your Email or User ID.", "error");
      document.getElementById("pin-login-identifier-input")?.focus();
      return;
    }
  }

  const totp_code = (document.getElementById("signin-totp-code")?.value || "").trim();
  if (totp_code) {
    activeBtn = document.querySelector("#signin-2fa-box button[onclick*='submitUserLogin']") || activeBtn;
  }

  if (!credential) {
    showToast(`Please enter your ${activeLoginSubMethod === "email" ? "Password" : activeLoginSubMethod.toUpperCase()}.`, "error");
    return;
  }

  isLoginSubmitting = true;
  if (activeBtn) {
    defaultBtnHtml = activeBtn.innerHTML;
    activeBtn.disabled = true;
    activeBtn.innerHTML = `<div class="vault-spinner small" style="border-top-color:#fff;"></div> Signing In...`;
  }

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: activeLoginSubMethod, email, credential, totp_code })
    });
    const data = await res.json();

    if (data.require_2fa) {
      const eFlow = document.getElementById("signin-flow-email");
      const oFlow = document.getElementById("signin-flow-otp");
      const pFlow = document.getElementById("signin-flow-pin");
      const box = document.getElementById("signin-2fa-box");

      if (eFlow) eFlow.style.display = "none";
      if (oFlow) oFlow.style.display = "none";
      if (pFlow) pFlow.style.display = "none";
      if (box) box.style.display = "block";
      setAuthOngoingState("signin", true);

      showToast(data.error || data.message, data.error ? "error" : "info");
      requestAnimationFrame(() => document.getElementById("signin-totp-code")?.focus());
      return;
    }

    if (!res.ok || !data.success) {
      showToast(data.error || "Sign in failed!", "error");
      return;
    }

    setAuthOngoingState("none", false);
    sessionLoginType = "user_account";
    showToast("Signed in to PrintSafe Cloud!", "success");
    await bootAuthenticatedDashboard(data.redirect || null);
  } catch (e) {
    showToast("Network error during login", "error");
  } finally {
    isLoginSubmitting = false;
    if (activeBtn) {
      activeBtn.disabled = false;
      activeBtn.innerHTML = defaultBtnHtml || "Sign In";
    }
  }
}

// ========================================================================
// 3-STEP PROGRESSIVE REGISTRATION HANDLERS
// ========================================================================
async function step1SendRegOtp() {
  const email = (document.getElementById("reg-email-input")?.value || "").trim();
  const btn = document.getElementById("reg-step1-btn");
  if (!email || !email.includes("@")) {
    showToast("Please enter a valid email address.", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="vault-spinner small" style="border-top-color:#fff;"></div> Sending OTP...`;
  }
  setAuthOngoingState("signup", true);

  try {
    const res = await fetch("/api/register/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      setAuthOngoingState("none", false);
      showToast(data.error || "Failed to send OTP", "error");
      return;
    }
    document.getElementById("reg-step-1").style.display = "none";
    document.getElementById("reg-step-2").style.display = "block";
    document.getElementById("reg-display-email").innerText = email;
    requestAnimationFrame(() => document.getElementById("reg-otp-input")?.focus());
    showToast("OTP sent! Please check your email.", "success");
  } catch (e) {
    setAuthOngoingState("none", false);
    showToast("Network error", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="ri-mail-send-line"></i> Send Verification OTP`;
    }
  }
}

async function step2VerifyRegOtp() {
  const email = (document.getElementById("reg-email-input")?.value || "").trim();
  const otp = (document.getElementById("reg-otp-input")?.value || "").trim();
  const btn = document.getElementById("reg-step2-btn");
  if (otp.length !== 6) {
    showToast("Enter the 6-digit OTP sent to your email.", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="vault-spinner small" style="border-top-color:#fff;"></div> Verifying...`;
  }

  try {
    const res = await fetch("/api/register/check-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || "Invalid OTP", "error");
      return;
    }
    document.getElementById("reg-step-2").style.display = "none";
    document.getElementById("reg-step-3").style.display = "block";
    requestAnimationFrame(() => document.getElementById("reg-pass-input")?.focus());
    showToast("OTP Verified! Create your password & PIN.", "success");
  } catch (e) {
    showToast("Verification error", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="ri-checkbox-circle-line"></i> Verify OTP`;
    }
  }
}

async function step3CompleteRegistration() {
  const email = (document.getElementById("reg-email-input")?.value || "").trim();
  const otp = (document.getElementById("reg-otp-input")?.value || "").trim();
  const full_name = (document.getElementById("reg-name-input")?.value || "").trim();
  const password = (document.getElementById("reg-pass-input")?.value || "").trim();
  const pin = (document.getElementById("reg-pin-input")?.value || "").trim();
  const btn = document.getElementById("reg-step3-btn");

  if (password.length < 4) {
    showToast("Password must be at least 4 characters.", "error");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="vault-spinner small" style="border-top-color:#fff;"></div> Creating Account...`;
  }

  try {
    const res = await fetch("/api/register/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp, full_name, password, pin })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || "Registration failed", "error");
      return;
    }
    setAuthOngoingState("none", false);
    sessionLoginType = "user_account";
    showToast("Account created & verified!", "success");
    await bootAuthenticatedDashboard(data.redirect || null);
  } catch (e) {
    showToast("Network error", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="ri-shield-check-line"></i> Create Account`;
    }
  }
}

// ========================================================================
// DESKTOP QR LOGIN & LOGOUT
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
        </div>`;
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
      showToast("Logged in via Mobile QR (Restricted Mode)", "success");
      await bootAuthenticatedDashboard(data.redirect || null);
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

function confirmLogoutModal() {
  const dropdown = document.getElementById("profile-menu-dropdown");
  if (dropdown) dropdown.style.display = "none";
  openSessionConfirmModal(
    "Logout Vault?",
    "Are you sure you want to close your PrintSafe Cloud session?",
    "Yes, Logout",
    performLogout
  );
}

async function performLogout() {
  try {
    const res = await fetch("/api/logout", { method: "POST" });
    const data = await res.json();
    sessionStorage.clear();
    window.location.replace(data.redirect || "/");
  } catch (e) {
    window.location.replace("/");
  }
}