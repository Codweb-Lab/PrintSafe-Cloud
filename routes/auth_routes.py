import os
import ssl
import time
import uuid
import random
import secrets
import smtplib
import threading
import mimetypes
from urllib.parse import urlencode
from email.message import EmailMessage
from email.utils import formataddr
from flask import (
    Blueprint, render_template, request, jsonify,
    session, redirect, url_for, current_app, has_request_context
)
from werkzeug.security import check_password_hash, generate_password_hash
import requests

from admin_db import get_admin_secret
from cloud_sync import CloudSyncVault
from totp_2fa import generate_totp_setup, verify_totp_code
from db_setup import (
    get_db_connection, get_system_config_db, get_decrypted_config_db,
    get_qr_session_db, terminate_qr_session_db, get_latest_sync_state_db,
    get_feature_flags_map_db, push_notification_db
)

auth_bp = Blueprint('auth', __name__)

# Lazy singleton for CloudSyncVault so module import & non-OAuth requests stay zero-overhead
_cloud_engine = None
_SESSION_META_CACHE = {"ts": 0.0, "features": {}, "latest_ev": 0}


def get_cloud_engine() -> CloudSyncVault:
    global _cloud_engine
    if _cloud_engine is None:
        _cloud_engine = CloudSyncVault()
    return _cloud_engine


def _get_cached_session_meta() -> dict:
    now = time.time()
    if now - _SESSION_META_CACHE["ts"] > 5.0:
        latest_ev, _ = get_latest_sync_state_db()
        _SESSION_META_CACHE["features"] = get_feature_flags_map_db()
        _SESSION_META_CACHE["latest_ev"] = latest_ev["event_id"] if latest_ev else 0
        _SESSION_META_CACHE["ts"] = now
    return _SESSION_META_CACHE


def _ensure_vault_route_token() -> str:
    """Generates or returns a random 16-char alphanumeric session token for the workspace URL."""
    tok = session.get('vault_route_token')
    if not tok:
        tok = secrets.token_hex(8)
        session['vault_route_token'] = tok
    return tok


def send_verification_email(
    to_email: str,
    otp_code: str,
    subject: str = "PrintSafe Cloud — Verification OTP",
    category: str = "otp",
    template_id: str = "",
    extra_vars: dict = None,
    base_url_override: str = ""
):
    smtp_host = (get_system_config_db("smtp_host") or "").strip()
    smtp_port = int(get_system_config_db("smtp_port") or "465")
    smtp_user = (get_system_config_db("smtp_user") or "").strip()
    smtp_pass = (get_admin_secret("active_smtp_pass") or get_decrypted_config_db("smtp_pass") or "").strip()

    sender_name = (get_system_config_db("smtp_from_name") or "PrintSafe Cloud").strip()
    sender_email = (get_system_config_db("smtp_from_email") or "").strip() or smtp_user

    relay_url = (get_admin_secret("cpanel_relay_url") or "").strip()
    relay_secret = (get_admin_secret("cpanel_relay_secret") or "").strip()
    relay_domain = (get_admin_secret("cpanel_relay_domain") or "").strip().lower()

    if not smtp_host or not smtp_user or not smtp_pass:
        raise RuntimeError(
            "All SMTP gateways are currently disabled or unconfigured. "
            "Please enable an active SMTP profile in the /admin console."
        )

    static_img_dir = os.path.join(os.getcwd(), "static", "images")
    logo_path = None
    for candidate in ("logo3.png", "logo.png", "logo3.svg"):
        full_p = os.path.join(static_img_dir, candidate)
        if os.path.exists(full_p):
            logo_path = full_p
            break

    is_cpanel_relay = bool(relay_url and relay_secret and relay_domain and relay_domain in smtp_host.lower())

    if is_cpanel_relay:
        base_public = relay_url.rsplit("/", 1)[0]
    elif base_url_override:
        base_public = base_url_override.rstrip("/")
    elif has_request_context():
        base_public = request.host_url.rstrip("/")
    else:
        base_public = ""

    default_logo_src = (
        f"{base_public}/static/images/{os.path.basename(logo_path)}"
        if (logo_path and (is_cpanel_relay or base_public))
        else ("cid:printsafe_logo" if logo_path else "")
    )

    custom_tpl = None
    try:
        from routes.admin.templates_ops import get_template_by_id_or_category
        custom_tpl = get_template_by_id_or_category(template_id=template_id, category=category)
    except Exception:
        custom_tpl = None

    if custom_tpl:
        tpl_logo = (custom_tpl.get("logo_url") or "").strip()
        if tpl_logo.startswith("/"):
            tpl_logo = f"{base_public}{tpl_logo}" if base_public else "cid:printsafe_logo"
        elif not tpl_logo:
            tpl_logo = default_logo_src

        vars_map = {
            "{{otp_code}}": str(otp_code),
            "{{subject}}": str(subject),
            "{{message}}": str(otp_code),
            "{{logo_url}}": tpl_logo,
            "{{user_email}}": str(to_email),
            "{{user_name}}": str((extra_vars or {}).get("user_name") or to_email.split("@")[0]),
        }
        rendered_subject = custom_tpl["subject"]
        html_body = custom_tpl["html_body"]
        for k, v in vars_map.items():
            rendered_subject = rendered_subject.replace(k, v)
            html_body = html_body.replace(k, v)
        subject = rendered_subject
    else:
        logo_img_tag = (
            f'<img src="{default_logo_src}" alt="{sender_name}" width="46" height="46" '
            f'style="display:block;margin:0 auto 10px auto;border-radius:10px;" />'
            if default_logo_src
            else ""
        )
        html_body = f"""
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        </head>
        <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f1f5f9;padding:32px 16px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background-color:#ffffff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.06);">
                  <tr>
                    <td style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:26px 24px;text-align:center;">
                      {logo_img_tag}
                      <div style="font-size:20px;font-weight:800;letter-spacing:-0.4px;color:#ffffff;">
                        PrintSafe <span style="color:#38bdf8;">Cloud</span>
                      </div>
                      <div style="font-size:11.5px;color:#94a3b8;margin-top:4px;font-weight:500;">
                        Zero-Trust Cloud &amp; Remote Print Vault
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:28px 28px 22px 28px;text-align:center;">
                      <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:8px;">
                        {subject}
                      </div>
                      <p style="margin:0 0 22px 0;font-size:13.5px;line-height:1.6;color:#475569;">
                        Use the one-time verification code below to complete your authentication. For your security, never share this code with anyone.
                      </p>
                      <div style="background-color:#f8fafc;border:1.5px dashed #38bdf8;border-radius:12px;padding:16px 20px;margin:0 auto 20px auto;display:inline-block;min-width:220px;">
                        <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#64748b;margin-bottom:6px;">
                          Verification Code
                        </div>
                        <div style="font-size:30px;font-weight:800;letter-spacing:8px;color:#0284c7;font-family:'Courier New',monospace;">
                          {otp_code}
                        </div>
                      </div>
                      <div style="font-size:12px;color:#64748b;margin-bottom:6px;">
                        This code will expire in <strong style="color:#0f172a;">10 minutes</strong>.
                      </div>
                      <div style="font-size:11.5px;color:#94a3b8;">
                        If you did not request this code, you can safely ignore this email.
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td style="background-color:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 24px;text-align:center;font-size:11px;color:#64748b;">
                      Sent automatically by <strong>PrintSafe Cloud</strong> • Powered by <strong>Codweb Lab</strong><br/>
                      <span style="color:#94a3b8;">This is an unmonitored message from {sender_email} — replies are disabled.</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
        """

    if is_cpanel_relay:
        res = requests.post(
            relay_url,
            json={
                "api_key": relay_secret,
                "to": to_email,
                "subject": subject,
                "html": html_body,
                "from_name": sender_name,
                "from_email": sender_email,
                "smtp_user": smtp_user,
                "smtp_pass": smtp_pass
            },
            timeout=10
        )
        data = res.json()
        if not res.ok or not data.get("success"):
            raise RuntimeError(data.get("error", "Failed to send email via HTTPS Mail Relay"))
        return True

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((sender_name, sender_email))
    msg["Reply-To"] = f"no-reply@{smtp_host}"
    msg["Auto-Submitted"] = "auto-generated"
    msg["Precedence"] = "bulk"
    msg["X-Auto-Response-Suppress"] = "All"
    msg["To"] = to_email

    msg.set_content(
        f"{subject}\n\n"
        f"{'Verification Code: ' + otp_code if otp_code else ''}\n\n"
        f"— PrintSafe Cloud Security Team (Codweb Lab)"
    )
    msg.add_alternative(html_body, subtype="html")

    if logo_path and "cid:printsafe_logo" in html_body:
        mime_type, _ = mimetypes.guess_type(logo_path)
        maintype, subtype = (mime_type or "image/png").split("/", 1)
        with open(logo_path, "rb") as img_file:
            msg.get_payload()[1].add_related(
                img_file.read(),
                maintype=maintype,
                subtype=subtype,
                cid="printsafe_logo",
                filename=os.path.basename(logo_path)
            )

    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    ports_to_try = [smtp_port, 587 if smtp_port == 465 else 465]
    last_err = None

    for port in ports_to_try:
        try:
            if port == 465:
                with smtplib.SMTP_SSL(smtp_host, port, local_hostname=smtp_host, timeout=6, context=ssl_ctx) as server:
                    server.login(smtp_user, smtp_pass)
                    server.send_message(msg)
            else:
                with smtplib.SMTP(smtp_host, port, local_hostname=smtp_host, timeout=6) as server:
                    server.ehlo()
                    server.starttls(context=ssl_ctx)
                    server.ehlo()
                    server.login(smtp_user, smtp_pass)
                    server.send_message(msg)
            return True
        except smtplib.SMTPAuthenticationError:
            raise RuntimeError("SMTP Login failed: Please verify SMTP Username & Password in /admin.")
        except Exception as e:
            last_err = e
            continue

    raise RuntimeError(f"SMTP Server ({smtp_host}) unreachable on ports 465/587. Details: {last_err}")


def send_verification_email_async(
    app_obj,
    to_email: str,
    otp_code: str,
    subject: str = "PrintSafe Cloud — Verification OTP",
    category: str = "otp",
    template_id: str = "",
    extra_vars: dict = None,
    base_url_override: str = ""
):
    """Dispatches OTP/Welcome emails in a daemon thread so auth APIs return in <50ms."""
    def _worker():
        with app_obj.app_context():
            try:
                send_verification_email(
                    to_email=to_email,
                    otp_code=otp_code,
                    subject=subject,
                    category=category,
                    template_id=template_id,
                    extra_vars=extra_vars,
                    base_url_override=base_url_override
                )
            except Exception as e:
                print(f"[ASYNC MAIL ERROR -> {to_email}]: {e}")

    threading.Thread(target=_worker, daemon=True).start()


@auth_bp.route('/', methods=['GET'])
def index():
    """Root '/' serves standalone Login screen, or redirects authenticated users to /v/<random_token>."""
    if session.get('is_authenticated'):
        tok = _ensure_vault_route_token()
        return redirect(url_for('auth.vault_workspace', vault_token=tok))
    return render_template('login.html', features=_get_cached_session_meta()["features"])


@auth_bp.route('/v/<vault_token>', methods=['GET'])
def vault_workspace(vault_token: str):
    """Serves the authenticated Dashboard under a random session-bound alphanumeric URL."""
    if not session.get('is_authenticated'):
        return redirect(url_for('auth.index'))

    expected_tok = _ensure_vault_route_token()
    if vault_token != expected_tok:
        return redirect(url_for('auth.vault_workspace', vault_token=expected_tok))

    return render_template(
        'index.html',
        features=_get_cached_session_meta()["features"],
        vault_token=expected_tok
    )


@auth_bp.route('/api/public/features', methods=['GET'])
def public_feature_flags():
    return jsonify({"features": _get_cached_session_meta()["features"]})


@auth_bp.route('/scan', methods=['GET'])
def my_private_scanner():
    return render_template('scanner.html')


@auth_bp.route('/api/check-session', methods=['GET'])
def check_session_status():
    sid = session.get('session_id')
    login_type = session.get('login_type', 'user_account')
    restrictions = {"is_restricted": False, "mask_folders": False, "disable_profile": False, "allow_print": True}
    meta = _get_cached_session_meta()

    if sid and login_type == 'qr_restricted':
        r = get_qr_session_db(sid)
        if not r or r['status'] != 'authenticated':
            session.pop('is_authenticated', None)
            session.pop('session_id', None)
            session.pop('vault_route_token', None)
            return jsonify({"authenticated": False, "features": meta["features"]}), 200
        restrictions = {
            "is_restricted": bool(r['is_restricted']),
            "mask_folders": bool(r['mask_folders']),
            "disable_profile": bool(r['disable_profile']),
            "allow_print": bool(r['allow_print'])
        }

    is_auth = bool(session.get('is_authenticated'))
    vault_redirect = f"/v/{_ensure_vault_route_token()}" if is_auth else "/"

    return jsonify({
        "authenticated": is_auth,
        "session_id": sid,
        "vault_redirect": vault_redirect,
        "login_type": login_type,
        "user_id": session.get('user_id', ''),
        "user_role": "user",
        "user_name": session.get('user_name', ''),
        "user_email": session.get('user_email', ''),
        "restrictions": restrictions,
        "features": meta["features"],
        "latest_event_id": meta["latest_ev"]
    }), 200


@auth_bp.route('/api/poll-events', methods=['GET'])
def poll_vault_events():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    latest, active_count = get_latest_sync_state_db()
    user_id = session.get('user_id', 'all')
    conn = get_db_connection()
    try:
        unread = conn.execute(
            "SELECT COUNT(*) as c FROM notifications WHERE (target_user_id = 'all' OR target_user_id = ?) AND is_read = 0",
            (user_id,)
        ).fetchone()["c"]
    finally:
        conn.close()
    return jsonify({
        "latest_event": latest,
        "connected_count": active_count,
        "unread_notifications": unread,
        "features": _get_cached_session_meta()["features"]
    })


@auth_bp.route('/api/notifications', methods=['GET', 'POST'])
def manage_notifications():
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    user_id = session.get('user_id', 'all')
    conn = get_db_connection()
    try:
        if request.method == 'POST':
            conn.execute(
                "UPDATE notifications SET is_read = 1 WHERE target_user_id = 'all' OR target_user_id = ?",
                (user_id,)
            )
            conn.commit()
            return jsonify({"success": True})

        rows = conn.execute(
            "SELECT * FROM notifications WHERE target_user_id = 'all' OR target_user_id = ? ORDER BY notif_id DESC LIMIT 25",
            (user_id,)
        ).fetchall()
        return jsonify({"notifications": [dict(r) for r in rows]})
    finally:
        conn.close()


@auth_bp.route('/api/user/profile', methods=['GET', 'POST'])
def user_profile_settings():
    user_id = session.get('user_id')
    if not session.get('is_authenticated') or not user_id:
        return jsonify({"error": "Unauthorized"}), 403

    conn = get_db_connection()
    try:
        if request.method == 'GET':
            row = conn.execute(
                "SELECT user_id, full_name, email, phone, bio, auth_provider, storage_quota_mb FROM users WHERE user_id = ?",
                (user_id,)
            ).fetchone()
            return jsonify({"success": True, "profile": dict(row) if row else {}})

        data = request.get_json(silent=True) or {}
        full_name = (data.get("full_name") or "").strip()
        phone = (data.get("phone") or "").strip()
        bio = (data.get("bio") or "").strip()

        conn.execute(
            "UPDATE users SET full_name = ?, phone = ?, bio = ? WHERE user_id = ?",
            (full_name, phone, bio, user_id)
        )
        conn.commit()
        session['user_name'] = full_name or session.get('user_email', '').split('@')[0]
        return jsonify({"success": True, "message": "Profile updated successfully!"})
    finally:
        conn.close()


@auth_bp.route('/api/user/verify-email', methods=['POST'])
def verify_registered_email():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not email or "@" not in email:
        return jsonify({"success": False, "error": "Please enter a valid email address."}), 400

    conn = get_db_connection()
    try:
        row = conn.execute("SELECT user_id, password_hash FROM users WHERE email = ?", (email,)).fetchone()
        if not row:
            return jsonify({"success": False, "error": "No account found with this email. Please Register first."}), 404
        if not row["password_hash"]:
            return jsonify({"success": False, "error": "Please sign in using Google or OTP."}), 400
        return jsonify({"success": True})
    finally:
        conn.close()


@auth_bp.route('/api/user/send-login-otp', methods=['POST'])
def user_send_login_otp():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not email or "@" not in email:
        return jsonify({"success": False, "error": "Enter a valid email address."}), 400

    conn = get_db_connection()
    try:
        user_row = conn.execute("SELECT user_id, full_name FROM users WHERE email = ?", (email,)).fetchone()
        if not user_row:
            return jsonify({"success": False, "error": "Email is not registered. Please Register first."}), 404

        otp = f"{random.randint(100000, 999999)}"
        conn.execute(
            "INSERT OR REPLACE INTO email_otps (email, otp_code, purpose, expires_at) VALUES (?, ?, 'login', ?)",
            (email, otp, time.time() + 600)
        )
        conn.commit()

        send_verification_email_async(
            current_app._get_current_object(),
            email,
            otp,
            "PrintSafe Cloud — Sign-In OTP",
            category="otp",
            extra_vars={"user_name": user_row["full_name"] or email.split("@")[0]},
            base_url_override=request.host_url
        )
        return jsonify({"success": True, "message": "OTP sent to your registered email!"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        conn.close()


@auth_bp.route('/api/login', methods=['POST'])
def api_user_login():
    t0 = time.perf_counter()
    data = request.get_json(silent=True) or {}
    method = data.get('method', 'email')
    email = (data.get('email') or '').strip().lower()
    credential = (data.get('credential') or '').strip()
    totp_code = (data.get('totp_code') or '').strip()

    if not credential:
        return jsonify({"success": False, "error": "Credential is required"}), 400

    conn = get_db_connection()
    try:
        user_row = None
        if method == 'pin':
            if not email:
                return jsonify({"success": False, "error": "Email or User ID is required for PIN sign-in."})
            if not credential.isdigit() or len(credential) not in (4, 6):
                return jsonify({"success": False, "error": "PIN must be 4 or 6 digits."})

            cand = conn.execute(
                "SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(user_id) = ?",
                (email, email)
            ).fetchone()

            if not cand or not cand['pin_hash'] or not check_password_hash(cand['pin_hash'], credential):
                return jsonify({"success": False, "error": "Invalid Email/User ID or Security PIN!"})
            user_row = cand
        else:
            user_row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            if not user_row:
                return jsonify({"success": False, "error": "Account not found."})

            if method == 'email':
                if not (user_row['password_hash'] and check_password_hash(user_row['password_hash'], credential)):
                    return jsonify({"success": False, "error": "Incorrect Password!"})
            elif method == 'otp':
                otp_row = conn.execute(
                    "SELECT otp_code, expires_at FROM email_otps WHERE email = ? AND purpose = 'login'",
                    (email,)
                ).fetchone()
                if not otp_row or otp_row['otp_code'] != credential or time.time() > otp_row['expires_at']:
                    return jsonify({"success": False, "error": "Invalid or expired OTP!"})
                conn.execute("DELETE FROM email_otps WHERE email = ?", (email,))
                conn.commit()

        if user_row['totp_enabled'] == 1 and user_row['totp_secret']:
            if not totp_code:
                return jsonify({"success": False, "require_2fa": True, "message": "Enter 6-digit Authenticator App code."})
            if not verify_totp_code(user_row['totp_secret'], totp_code):
                return jsonify({"success": False, "require_2fa": True, "error": "Invalid 2FA code!"})

        session.permanent = True
        session['is_authenticated'] = True
        session['session_id'] = user_row['user_id']
        session['user_id'] = user_row['user_id']
        session['user_name'] = user_row['full_name'] or user_row['email'].split('@')[0]
        session['user_email'] = user_row['email']
        session['login_type'] = "user_account"
        vault_tok = _ensure_vault_route_token()

        print(f"[LOGIN PERF] /api/login ({method}) completed in {(time.perf_counter() - t0) * 1000:.1f} ms")
        return jsonify({"success": True, "redirect": f"/v/{vault_tok}"})
    finally:
        conn.close()


@auth_bp.route('/api/auth/google/login')
def user_google_oauth_start():
    flags = _get_cached_session_meta()["features"]
    if not flags.get("google_oauth_login", False):
        return "Google OAuth Sign-In is currently disabled by Administrator.", 403
    g_cfg = get_cloud_engine().google_config
    if not g_cfg['client_id']:
        return "Google OAuth Client ID is not configured in Admin Console.", 400
    redirect_uri = request.host_url.rstrip('/') + '/api/auth/google/user-callback'
    params = {
        'client_id': g_cfg['client_id'],
        'redirect_uri': redirect_uri,
        'response_type': 'code',
        'scope': 'openid email profile',
        'prompt': 'select_account'
    }
    return redirect(f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}")


@auth_bp.route('/api/auth/google/user-callback')
def user_google_oauth_callback():
    code = request.args.get('code')
    if not code:
        return redirect(url_for('auth.index'))
    g_cfg = get_cloud_engine().google_config
    redirect_uri = request.host_url.rstrip('/') + '/api/auth/google/user-callback'
    try:
        tok_res = requests.post('https://oauth2.googleapis.com/token', data={
            'code': code,
            'client_id': g_cfg['client_id'],
            'client_secret': g_cfg['client_secret'],
            'redirect_uri': redirect_uri,
            'grant_type': 'authorization_code'
        }, timeout=12).json()
        access_token = tok_res.get('access_token')
        if not access_token:
            return redirect(url_for('auth.index'))

        u_info = requests.get(
            'https://www.googleapis.com/oauth2/v2/userinfo',
            headers={'Authorization': f'Bearer {access_token}'},
            timeout=10
        ).json()
        email = (u_info.get('email') or '').lower()
        full_name = u_info.get('name') or email.split('@')[0]

        conn = get_db_connection()
        try:
            row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            if not row:
                user_id = f"usr_{uuid.uuid4().hex[:10]}"
                conn.execute('''
                    INSERT INTO users (user_id, full_name, email, password_hash, auth_provider, role, is_verified, created_at)
                    VALUES (?, ?, ?, '', 'google', 'user', 1, ?)
                ''', (user_id, full_name, email, time.time()))
                conn.commit()
                push_notification_db(user_id, "Welcome to PrintSafe Cloud!", "Complete your profile anytime from the top-right user menu.", "welcome")
            else:
                user_id = row['user_id']
                full_name = row['full_name'] or full_name
        finally:
            conn.close()

        session.permanent = True
        session['is_authenticated'] = True
        session['session_id'] = user_id
        session['user_id'] = user_id
        session['user_name'] = full_name
        session['user_email'] = email
        session['login_type'] = 'google_oauth'
        vault_tok = _ensure_vault_route_token()
        return redirect(url_for('auth.vault_workspace', vault_token=vault_tok))
    except Exception as e:
        print(f"[GOOGLE OAUTH ERROR]: {e}")
    return redirect(url_for('auth.index'))


@auth_bp.route('/api/register/send-otp', methods=['POST'])
def register_send_otp():
    flags = _get_cached_session_meta()["features"]
    if not flags.get("user_registration", True):
        return jsonify({"success": False, "error": "New registrations are currently disabled by Admin."}), 403

    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not email or "@" not in email:
        return jsonify({"success": False, "error": "Please enter a valid email address"}), 400

    conn = get_db_connection()
    try:
        if conn.execute("SELECT user_id FROM users WHERE email = ?", (email,)).fetchone():
            return jsonify({"success": False, "error": "Email is already registered. Please Sign In."}), 409

        otp = f"{random.randint(100000, 999999)}"
        conn.execute(
            "INSERT OR REPLACE INTO email_otps (email, otp_code, purpose, expires_at) VALUES (?, ?, 'register', ?)",
            (email, otp, time.time() + 600)
        )
        conn.commit()

        send_verification_email_async(
            current_app._get_current_object(),
            email,
            otp,
            "PrintSafe Cloud — Registration Verification OTP",
            category="otp",
            base_url_override=request.host_url
        )
        return jsonify({"success": True, "message": "OTP sent to your email!"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        conn.close()


@auth_bp.route('/api/register/check-otp', methods=['POST'])
def register_check_otp():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    otp = (data.get("otp") or "").strip()

    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT otp_code, expires_at FROM email_otps WHERE email = ? AND purpose = 'register'",
            (email,)
        ).fetchone()
        if not row or row["otp_code"] != otp or time.time() > row["expires_at"]:
            return jsonify({"success": False, "error": "Invalid or expired OTP code"}), 400
        return jsonify({"success": True})
    finally:
        conn.close()


@auth_bp.route('/api/register/complete', methods=['POST'])
def register_complete_user():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    otp = (data.get("otp") or "").strip()
    password = (data.get("password") or "").strip()
    pin = (data.get("pin") or "").strip()

    if len(password) < 4:
        return jsonify({"success": False, "error": "Password must be at least 4 characters"}), 400
    if pin and (not pin.isdigit() or len(pin) not in (4, 6)):
        return jsonify({"success": False, "error": "PIN must be 4 or 6 digits"}), 400

    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT otp_code, expires_at FROM email_otps WHERE email = ? AND purpose = 'register'",
            (email,)
        ).fetchone()
        if not row or row["otp_code"] != otp or time.time() > row["expires_at"]:
            return jsonify({"success": False, "error": "OTP expired. Please request a new OTP."}), 400

        user_id = f"usr_{uuid.uuid4().hex[:10]}"
        default_name = email.split("@")[0]
        pin_hashed = generate_password_hash(pin) if pin else ""

        conn.execute('''
            INSERT INTO users (user_id, full_name, email, password_hash, pin_hash, auth_provider, role, is_verified, created_at)
            VALUES (?, ?, ?, ?, ?, 'local', 'user', 1, ?)
        ''', (user_id, default_name, email, generate_password_hash(password), pin_hashed, time.time()))
        conn.execute("DELETE FROM email_otps WHERE email = ?", (email,))
        conn.commit()

        push_notification_db(
            user_id,
            "Welcome to PrintSafe Cloud!",
            "Your account is verified. Click your top-right Profile icon to complete your profile details or enable 2FA.",
            "welcome"
        )

        send_verification_email_async(
            current_app._get_current_object(),
            email,
            "",
            "Welcome to PrintSafe Cloud!",
            category="signup_welcome",
            extra_vars={"user_name": default_name},
            base_url_override=request.host_url
        )

        session.permanent = True
        session['is_authenticated'] = True
        session['session_id'] = user_id
        session['user_id'] = user_id
        session['user_name'] = default_name
        session['user_email'] = email
        session['login_type'] = "user_account"
        vault_tok = _ensure_vault_route_token()

        return jsonify({"success": True, "redirect": f"/v/{vault_tok}"})
    finally:
        conn.close()


@auth_bp.route('/api/user/security/2fa/status', methods=['GET'])
def user_2fa_status():
    user_id = session.get('user_id')
    if not session.get('is_authenticated') or not user_id:
        return jsonify({"error": "Unauthorized"}), 403
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT totp_enabled, pin_hash FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return jsonify({"totp_enabled": bool(row["totp_enabled"]), "has_pin": bool(row["pin_hash"])}) if row else jsonify({})
    finally:
        conn.close()


@auth_bp.route('/api/user/security/2fa/setup', methods=['POST'])
def user_2fa_setup():
    user_id = session.get('user_id')
    if not session.get('is_authenticated') or not user_id:
        return jsonify({"error": "Unauthorized"}), 403
    setup_data = generate_totp_setup(session.get('user_email', 'user@printsafe.cloud'))
    session['pending_totp_secret'] = setup_data['secret']
    return jsonify({"success": True, "secret": setup_data['secret'], "qr_image": setup_data['qr_image']})


@auth_bp.route('/api/user/security/2fa/enable', methods=['POST'])
def user_2fa_enable():
    user_id = session.get('user_id')
    if not session.get('is_authenticated') or not user_id:
        return jsonify({"error": "Unauthorized"}), 403
    code = ((request.get_json(silent=True) or {}).get("code") or "").strip()
    secret = session.get('pending_totp_secret')
    if not verify_totp_code(secret, code):
        return jsonify({"success": False, "error": "Invalid 6-digit code from Authenticator app"}), 400
    conn = get_db_connection()
    try:
        conn.execute("UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE user_id = ?", (secret, user_id))
        conn.commit()
        session.pop('pending_totp_secret', None)
        return jsonify({"success": True, "message": "2FA Authenticator enabled!"})
    finally:
        conn.close()


@auth_bp.route('/api/user/security/2fa/disable', methods=['POST'])
def user_2fa_disable():
    user_id = session.get('user_id')
    if not session.get('is_authenticated') or not user_id:
        return jsonify({"error": "Unauthorized"}), 403
    conn = get_db_connection()
    try:
        conn.execute("UPDATE users SET totp_secret = '', totp_enabled = 0 WHERE user_id = ?", (user_id,))
        conn.commit()
        return jsonify({"success": True, "message": "2FA disabled"})
    finally:
        conn.close()


@auth_bp.route('/api/user/security/pin', methods=['POST'])
def user_set_pin():
    user_id = session.get('user_id')
    if not session.get('is_authenticated') or not user_id:
        return jsonify({"error": "Unauthorized"}), 403
    pin = ((request.get_json(silent=True) or {}).get("pin") or "").strip()
    if not pin.isdigit() or len(pin) not in (4, 6):
        return jsonify({"success": False, "error": "PIN must be 4 or 6 digits"}), 400
    conn = get_db_connection()
    try:
        conn.execute("UPDATE users SET pin_hash = ? WHERE user_id = ?", (generate_password_hash(pin), user_id))
        conn.commit()
        return jsonify({"success": True, "message": "Login PIN updated!"})
    finally:
        conn.close()


@auth_bp.route('/api/user/security/password', methods=['POST'])
def user_change_password():
    user_id = session.get('user_id')
    if not session.get('is_authenticated') or not user_id:
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json(silent=True) or {}
    current_pw = (data.get("current_password") or "").strip()
    new_pw = (data.get("new_password") or "").strip()
    confirm_pw = (data.get("confirm_password") or "").strip()

    if len(new_pw) < 6:
        return jsonify({"success": False, "error": "New password must be at least 6 characters long."})
    if new_pw != confirm_pw:
        return jsonify({"success": False, "error": "New password and confirm password do not match."})

    conn = get_db_connection()
    try:
        row = conn.execute("SELECT password_hash FROM users WHERE user_id = ?", (user_id,)).fetchone()
        if not row:
            return jsonify({"success": False, "error": "User account not found."})

        existing_hash = row["password_hash"] or ""
        if existing_hash:
            if not current_pw or not check_password_hash(existing_hash, current_pw):
                return jsonify({"success": False, "error": "Current password is incorrect."})

        conn.execute("UPDATE users SET password_hash = ? WHERE user_id = ?", (generate_password_hash(new_pw), user_id))
        conn.commit()
        return jsonify({"success": True, "message": "Account password updated successfully!"})
    finally:
        conn.close()


@auth_bp.route('/api/logout', methods=['POST'])
def api_logout():
    sid = session.get('session_id')
    if sid and sid != "core_authenticated_user" and not str(sid).startswith("usr_"):
        terminate_qr_session_db(sid)
    for key in ['is_authenticated', 'session_id', 'user_id', 'user_name', 'user_email', 'login_type', 'vault_route_token']:
        session.pop(key, None)
    return jsonify({"success": True, "redirect": "/"})


@auth_bp.route('/api/debug-smtp', methods=['GET'])
def debug_smtp_check():
    if not session.get('admin_authenticated'):
        return jsonify({"error": "Admin authentication required"}), 403

    to_email = request.args.get('to', '').strip()
    if not to_email:
        return jsonify({
            "smtp_host": get_system_config_db("smtp_host"),
            "smtp_port": get_system_config_db("smtp_port"),
            "smtp_user": get_system_config_db("smtp_user"),
            "smtp_from_email": get_system_config_db("smtp_from_email"),
            "has_pass": bool(get_admin_secret("active_smtp_pass") or get_decrypted_config_db("smtp_pass")),
            "tip": "Pass ?to=your_email@gmail.com in URL to test live email delivery"
        })
    try:
        send_verification_email(to_email, "123456", "PrintSafe Cloud — SMTP Diagnostic Test", category="otp")
        return jsonify({"success": True, "message": f"Email sent to {to_email}"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500