import time
import uuid
from flask import Blueprint, request, jsonify
from db_setup import (
    set_encrypted_config_db, get_decrypted_config_db,
    get_all_feature_flags_db, toggle_feature_flag_db
)
from admin_db import (
    get_admin_db_conn, set_admin_secret, get_admin_secret,
    list_smtp_profiles_db, sync_active_smtp_gateway
)
from routes.admin.auth_ops import is_admin_authenticated

admin_int_bp = Blueprint('admin_integrations', __name__)


@admin_int_bp.route('/api/admin/features', methods=['GET', 'POST'])
def manage_feature_flags():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403

    if request.method == 'GET':
        return jsonify({"success": True, "features": get_all_feature_flags_db()})

    data = request.get_json(silent=True) or {}
    ok = toggle_feature_flag_db(data.get("feature_key"), bool(data.get("is_enabled")))
    return jsonify({"success": ok})


@admin_int_bp.route('/api/admin/integrations', methods=['GET', 'POST'])
def manage_admin_integrations():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403

    base_url = request.host_url.rstrip('/')
    if request.method == 'GET':
        g_id = get_admin_secret("google_client_id") or get_decrypted_config_db("google_client_id")
        o_id = get_admin_secret("onedrive_client_id") or get_decrypted_config_db("onedrive_client_id")
        relay_url = get_admin_secret("cpanel_relay_url")
        relay_domain = get_admin_secret("cpanel_relay_domain")
        relay_has_secret = bool(get_admin_secret("cpanel_relay_secret"))

        return jsonify({
            "google": {
                "has_client_id": bool(g_id),
                "masked_id": (g_id[:8] + "••••" + g_id[-6:]) if len(g_id) > 14 else ("Configured" if g_id else ""),
                "has_secret": bool(get_admin_secret("google_client_secret") or get_decrypted_config_db("google_client_secret")),
                "login_callback_uri": f"{base_url}/api/auth/google/user-callback",
                "drive_callback_uri": f"{base_url}/api/google/callback"
            },
            "onedrive": {
                "has_client_id": bool(o_id),
                "masked_id": (o_id[:8] + "••••" + o_id[-6:]) if len(o_id) > 14 else ("Configured" if o_id else ""),
                "has_secret": bool(get_admin_secret("onedrive_client_secret") or get_decrypted_config_db("onedrive_client_secret")),
                "drive_callback_uri": f"{base_url}/api/onedrive/callback"
            },
            "relay": {
                "relay_domain": relay_domain,
                "relay_url": relay_url,
                "has_secret": relay_has_secret
            },
            "smtp_profiles": list_smtp_profiles_db()
        })

    data = request.get_json(silent=True) or {}
    section = data.get("section")

    if section == "google":
        if data.get("client_id"):
            set_admin_secret("google_client_id", data["client_id"].strip())
            set_encrypted_config_db("google_client_id", data["client_id"].strip())
        if data.get("client_secret"):
            set_admin_secret("google_client_secret", data["client_secret"].strip())
            set_encrypted_config_db("google_client_secret", data["client_secret"].strip())
        set_encrypted_config_db("google_redirect_uri", f"{base_url}/api/google/callback")
        return jsonify({"success": True, "message": "Google OAuth encrypted (AES-256) in admin_vault.db!"})

    if section == "onedrive":
        if data.get("client_id"):
            set_admin_secret("onedrive_client_id", data["client_id"].strip())
            set_encrypted_config_db("onedrive_client_id", data["client_id"].strip())
        if data.get("client_secret"):
            set_admin_secret("onedrive_client_secret", data["client_secret"].strip())
            set_encrypted_config_db("onedrive_client_secret", data["client_secret"].strip())
        set_encrypted_config_db("onedrive_redirect_uri", f"{base_url}/api/onedrive/callback")
        return jsonify({"success": True, "message": "Microsoft OAuth encrypted (AES-256) in admin_vault.db!"})

    if section == "relay":
        set_admin_secret("cpanel_relay_domain", (data.get("relay_domain") or "").strip().lower())
        set_admin_secret("cpanel_relay_url", (data.get("relay_url") or "").strip())
        if data.get("relay_secret"):
            set_admin_secret("cpanel_relay_secret", data["relay_secret"].strip())
        return jsonify({"success": True, "message": "HTTPS Mail Relay secrets encrypted in admin_vault.db!"})

    if section == "smtp_save":
        prof_id = (data.get("id") or "").strip() or f"smtp_{uuid.uuid4().hex[:8]}"
        smtp_host = (data.get("smtp_host") or "").strip()
        smtp_user = (data.get("smtp_user") or "").strip()
        smtp_pass = (data.get("smtp_pass") or "").strip()
        provider = (data.get("provider") or "custom").strip()
        label = (data.get("label") or "").strip() or f"{provider.upper()} — {smtp_user}"
        smtp_port = str(data.get("smtp_port") or "465").strip()
        smtp_from_name = (data.get("smtp_from_name") or "PrintSafe Cloud").strip()
        smtp_from_email = (data.get("smtp_from_email") or "").strip() or smtp_user
        make_active = bool(data.get("is_active", False))

        if not smtp_host or not smtp_user:
            return jsonify({"success": False, "error": "SMTP Host and Username are required."}), 400

        existing_profiles = list_smtp_profiles_db()
        existing = next((p for p in existing_profiles if p["profile_id"] == prof_id), None)
        if not existing and not smtp_pass:
            return jsonify({"success": False, "error": "SMTP Password / App Password is required."}), 400

        if smtp_pass:
            set_admin_secret(f"smtp_prof_pass_{prof_id}", smtp_pass)

        if not existing_profiles:
            make_active = True

        conn = get_admin_db_conn()
        try:
            if make_active:
                conn.execute("UPDATE smtp_gateway_profiles SET is_active = 0")
            active_flag = 1 if make_active else (1 if (existing and existing["is_active"]) else 0)
            conn.execute(
                """
                INSERT INTO smtp_gateway_profiles
                (profile_id, label, provider, smtp_host, smtp_port, smtp_user, smtp_from_name, smtp_from_email, is_active, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(profile_id) DO UPDATE SET
                    label = excluded.label,
                    provider = excluded.provider,
                    smtp_host = excluded.smtp_host,
                    smtp_port = excluded.smtp_port,
                    smtp_user = excluded.smtp_user,
                    smtp_from_name = excluded.smtp_from_name,
                    smtp_from_email = excluded.smtp_from_email,
                    is_active = excluded.is_active,
                    updated_at = excluded.updated_at
                """,
                (prof_id, label, provider, smtp_host, smtp_port, smtp_user, smtp_from_name, smtp_from_email, active_flag, time.time())
            )
            conn.commit()
        finally:
            conn.close()

        sync_active_smtp_gateway()
        return jsonify({"success": True, "message": f"SMTP profile '{label}' encrypted & saved!"})

    if section == "smtp_toggle":
        prof_id = (data.get("id") or "").strip()
        enable = bool(data.get("enable", True))
        conn = get_admin_db_conn()
        try:
            if enable:
                conn.execute("UPDATE smtp_gateway_profiles SET is_active = 0")
            cur = conn.execute(
                "UPDATE smtp_gateway_profiles SET is_active = ? WHERE profile_id = ?",
                (1 if enable else 0, prof_id)
            )
            conn.commit()
            if cur.rowcount == 0:
                return jsonify({"success": False, "error": "SMTP profile not found."}), 404
        finally:
            conn.close()

        sync_active_smtp_gateway()
        return jsonify({
            "success": True,
            "message": "Active SMTP gateway switched!" if enable else "SMTP gateway disabled."
        })

    if section == "smtp_delete":
        prof_id = (data.get("id") or "").strip()
        conn = get_admin_db_conn()
        try:
            conn.execute("DELETE FROM smtp_gateway_profiles WHERE profile_id = ?", (prof_id,))
            conn.commit()
        finally:
            conn.close()
        set_admin_secret(f"smtp_prof_pass_{prof_id}", "")
        sync_active_smtp_gateway()
        return jsonify({"success": True, "message": "SMTP profile deleted."})

    return jsonify({"success": False, "error": "Invalid section"}), 400


@admin_int_bp.route('/api/admin/smtp/test', methods=['POST'])
def test_active_smtp_gateway():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json(silent=True) or {}
    to_email = (data.get("to_email") or "").strip()
    prof_id = (data.get("id") or "").strip()

    if not to_email or "@" not in to_email:
        return jsonify({"success": False, "error": "Enter a valid recipient email address."}), 400

    profiles = list_smtp_profiles_db()
    prev_active = next((p["profile_id"] for p in profiles if p["is_active"]), "")
    switched = False

    if prof_id and prof_id != prev_active:
        conn = get_admin_db_conn()
        try:
            conn.execute("UPDATE smtp_gateway_profiles SET is_active = 0")
            conn.execute("UPDATE smtp_gateway_profiles SET is_active = 1 WHERE profile_id = ?", (prof_id,))
            conn.commit()
        finally:
            conn.close()
        sync_active_smtp_gateway()
        switched = True

    try:
        from routes.auth_routes import send_verification_email
        send_verification_email(to_email, "849201", "PrintSafe Cloud — Admin SMTP Gateway Test")
        return jsonify({"success": True, "message": f"Test OTP delivered successfully to {to_email}!"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if switched:
            conn = get_admin_db_conn()
            try:
                conn.execute("UPDATE smtp_gateway_profiles SET is_active = 0")
                if prev_active:
                    conn.execute("UPDATE smtp_gateway_profiles SET is_active = 1 WHERE profile_id = ?", (prev_active,))
                conn.commit()
            finally:
                conn.close()
            sync_active_smtp_gateway()