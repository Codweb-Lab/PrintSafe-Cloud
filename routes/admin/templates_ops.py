import os
import time
import uuid
from werkzeug.utils import secure_filename
from flask import Blueprint, request, jsonify
from admin_db import get_admin_db_conn, init_admin_db
from routes.admin.auth_ops import is_admin_authenticated

admin_tpl_bp = Blueprint('admin_templates', __name__)

PRESET_TEMPLATES_LIBRARY = [
    {
        "template_id": "tpl_default_otp",
        "name": "Zero-Trust OTP Verification",
        "category": "otp",
        "subject": "PrintSafe Cloud — Verification Code: {{otp_code}}",
        "logo_url": "/static/images/logo3.png",
        "is_active": 1,
        "html_body": """<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:500px;margin:auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
  <div style="background:#0f172a;padding:24px;text-align:center;">
    <img src="{{logo_url}}" alt="Logo" width="46" height="46" style="border-radius:10px;margin-bottom:8px;" />
    <div style="font-size:20px;font-weight:800;color:#ffffff;">PrintSafe <span style="color:#38bdf8;">Cloud</span></div>
    <div style="font-size:11px;color:#94a3b8;">Zero-Trust Cloud &amp; Remote Print Vault</div>
  </div>
  <div style="padding:28px;text-align:center;color:#0f172a;">
    <h3 style="margin:0 0 8px;">Security Verification</h3>
    <p style="font-size:13.5px;color:#475569;margin:0 0 18px;">Use this one-time verification code to authenticate. Valid for 10 minutes.</p>
    <div style="background:#f8fafc;border:1.5px dashed #38bdf8;border-radius:10px;padding:14px 22px;display:inline-block;">
      <span style="font-size:28px;font-weight:800;letter-spacing:8px;color:#0284c7;font-family:monospace;">{{otp_code}}</span>
    </div>
  </div>
  <div style="background:#f8fafc;padding:12px;text-align:center;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0;">
    Automated message by PrintSafe Cloud • Powered by Codweb Lab
  </div>
</div>"""
    },
    {
        "template_id": "tpl_default_signup",
        "name": "Welcome & Signup Success",
        "category": "signup_welcome",
        "subject": "Welcome to PrintSafe Cloud, {{user_name}}!",
        "logo_url": "/static/images/logo3.png",
        "is_active": 1,
        "html_body": """<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:500px;margin:auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#0f172a,#1e3a8a);padding:26px;text-align:center;">
    <img src="{{logo_url}}" alt="Logo" width="46" height="46" style="border-radius:10px;margin-bottom:8px;" />
    <div style="font-size:20px;font-weight:800;color:#ffffff;">Welcome to PrintSafe <span style="color:#38bdf8;">Cloud</span></div>
  </div>
  <div style="padding:26px;color:#0f172a;">
    <h3 style="margin:0 0 10px;">Hi {{user_name}}, your vault is ready!</h3>
    <p style="font-size:13.5px;color:#475569;line-height:1.6;">Your account (<strong>{{user_email}}</strong>) has been verified. Connect Google Drive, OneDrive, or SFTP folders and print securely using Zero-Trust QR pairing.</p>
  </div>
  <div style="background:#f8fafc;padding:12px;text-align:center;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0;">
    PrintSafe Cloud • Powered by Codweb Lab
  </div>
</div>"""
    },
    {
        "template_id": "tpl_default_broadcast",
        "name": "General Global Announcement",
        "category": "broadcast",
        "subject": "PrintSafe Cloud — {{subject}}",
        "logo_url": "/static/images/logo3.png",
        "is_active": 1,
        "html_body": """<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
  <div style="background:#0f172a;padding:22px;text-align:center;">
    <img src="{{logo_url}}" alt="Logo" width="44" height="44" style="border-radius:10px;margin-bottom:8px;" />
    <div style="font-size:19px;font-weight:800;color:#ffffff;">PrintSafe <span style="color:#38bdf8;">Cloud</span></div>
  </div>
  <div style="padding:26px;color:#0f172a;">
    <span style="display:inline-block;background:#e0f2fe;color:#0369a1;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;margin-bottom:10px;">ANNOUNCEMENT</span>
    <h3 style="margin:0 0 12px;font-size:18px;">{{subject}}</h3>
    <div style="font-size:14px;color:#334155;line-height:1.65;white-space:pre-line;">{{message}}</div>
  </div>
  <div style="background:#f8fafc;padding:12px;text-align:center;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0;">
    Official Broadcast • PrintSafe Cloud (@Codweb Lab)
  </div>
</div>"""
    },
    {
        "template_id": "tpl_preset_feature_update",
        "name": "New Feature Update Release",
        "category": "feature_update",
        "subject": "New Feature Released: {{subject}}",
        "logo_url": "/static/images/logo3.png",
        "is_active": 1,
        "html_body": """<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#0f172a 0%,#0369a1 100%);padding:24px;text-align:center;">
    <img src="{{logo_url}}" alt="Logo" width="44" height="44" style="border-radius:10px;margin-bottom:8px;" />
    <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:#7dd3fc;text-transform:uppercase;">Product Release Notes</div>
    <div style="font-size:20px;font-weight:800;color:#ffffff;margin-top:4px;">What's New in PrintSafe Cloud</div>
  </div>
  <div style="padding:26px;color:#0f172a;">
    <span style="display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;margin-bottom:10px;">NEW FEATURE</span>
    <h3 style="margin:0 0 10px;font-size:18px;">{{subject}}</h3>
    <div style="font-size:14px;color:#334155;line-height:1.65;white-space:pre-line;">{{message}}</div>
  </div>
  <div style="background:#f8fafc;padding:12px;text-align:center;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0;">
    PrintSafe Cloud Engineering • Codweb Lab
  </div>
</div>"""
    },
    {
        "template_id": "tpl_preset_deprecation",
        "name": "Feature Deprecation & Sunset Notice",
        "category": "feature_deprecation",
        "subject": "Important Notice: {{subject}}",
        "logo_url": "/static/images/logo3.png",
        "is_active": 1,
        "html_body": """<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:auto;background:#ffffff;border:1px solid #fde68a;border-radius:14px;overflow:hidden;">
  <div style="background:#1c1917;padding:22px;text-align:center;">
    <img src="{{logo_url}}" alt="Logo" width="44" height="44" style="border-radius:10px;margin-bottom:8px;" />
    <div style="font-size:19px;font-weight:800;color:#fbbf24;">Lifecycle &amp; Deprecation Notice</div>
  </div>
  <div style="padding:26px;color:#0f172a;">
    <span style="display:inline-block;background:#fef3c7;color:#b45309;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;margin-bottom:10px;">ACTION RECOMMENDED</span>
    <h3 style="margin:0 0 10px;font-size:18px;">{{subject}}</h3>
    <div style="font-size:14px;color:#334155;line-height:1.65;white-space:pre-line;">{{message}}</div>
  </div>
  <div style="background:#fffbeb;padding:12px;text-align:center;font-size:11px;color:#92400e;border-top:1px solid #fde68a;">
    PrintSafe Cloud Platform Governance • Codweb Lab
  </div>
</div>"""
    },
    {
        "template_id": "tpl_preset_event_sale",
        "name": "Event Countdown / Summer Sale Offer",
        "category": "event_promo",
        "subject": "Limited-Time Event: {{subject}}",
        "logo_url": "/static/images/logo3.png",
        "is_active": 1,
        "html_body": """<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#312e81 0%,#7c3aed 100%);padding:26px;text-align:center;color:#ffffff;">
    <img src="{{logo_url}}" alt="Logo" width="46" height="46" style="border-radius:10px;margin-bottom:8px;" />
    <div style="font-size:11px;font-weight:700;letter-spacing:1.4px;color:#ddd6fe;text-transform:uppercase;">Special Event Countdown</div>
    <h2 style="margin:6px 0 0;font-size:22px;">{{subject}}</h2>
  </div>
  <div style="padding:26px;text-align:center;color:#0f172a;">
    <div style="background:#f5f3ff;border:1.5px dashed #7c3aed;border-radius:12px;padding:12px 18px;margin-bottom:16px;display:inline-block;">
      <span style="font-size:12px;font-weight:800;color:#6d28d9;letter-spacing:0.8px;">OFFER ENDS SOON • UPGRADE STORAGE QUOTA</span>
    </div>
    <div style="font-size:14px;color:#334155;line-height:1.65;text-align:left;white-space:pre-line;">{{message}}</div>
  </div>
  <div style="background:#f8fafc;padding:12px;text-align:center;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0;">
    PrintSafe Cloud Events • Codweb Lab
  </div>
</div>"""
    },
    {
        "template_id": "tpl_preset_maintenance",
        "name": "Scheduled Server Maintenance Alert",
        "category": "maintenance",
        "subject": "Maintenance Window: {{subject}}",
        "logo_url": "/static/images/logo3.png",
        "is_active": 1,
        "html_body": """<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:auto;background:#ffffff;border:1px solid #fecaca;border-radius:14px;overflow:hidden;">
  <div style="background:#1e293b;padding:22px;text-align:center;">
    <img src="{{logo_url}}" alt="Logo" width="44" height="44" style="border-radius:10px;margin-bottom:8px;" />
    <div style="font-size:18px;font-weight:800;color:#f87171;">Scheduled Infrastructure Maintenance</div>
  </div>
  <div style="padding:26px;color:#0f172a;">
    <span style="display:inline-block;background:#fee2e2;color:#b91c1c;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;margin-bottom:10px;">SYSTEM STATUS NOTICE</span>
    <h3 style="margin:0 0 10px;font-size:18px;">{{subject}}</h3>
    <div style="font-size:14px;color:#334155;line-height:1.65;white-space:pre-line;">{{message}}</div>
  </div>
  <div style="background:#f8fafc;padding:12px;text-align:center;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0;">
    Zero-Trust Operations Team • PrintSafe Cloud
  </div>
</div>"""
    }
]


def ensure_email_templates_table():
    init_admin_db()
    conn = get_admin_db_conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS email_templates (
                template_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                subject TEXT NOT NULL,
                logo_url TEXT NOT NULL DEFAULT '',
                html_body TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                updated_at REAL NOT NULL
            )
        """)
        now = time.time()
        for t in PRESET_TEMPLATES_LIBRARY:
            exists = conn.execute("SELECT 1 FROM email_templates WHERE template_id = ?", (t["template_id"],)).fetchone()
            if not exists:
                conn.execute(
                    """
                    INSERT INTO email_templates (template_id, name, category, subject, logo_url, html_body, is_active, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (t["template_id"], t["name"], t["category"], t["subject"], t["logo_url"], t["html_body"], t["is_active"], now)
                )
        conn.commit()
    finally:
        conn.close()


def get_template_by_id_or_category(template_id: str = "", category: str = "broadcast"):
    ensure_email_templates_table()
    conn = get_admin_db_conn()
    try:
        if template_id:
            row = conn.execute("SELECT * FROM email_templates WHERE template_id = ?", (template_id,)).fetchone()
            if row:
                return dict(row)
        row = conn.execute(
            "SELECT * FROM email_templates WHERE category = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1",
            (category,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


@admin_tpl_bp.route('/api/admin/email-templates', methods=['GET', 'POST'])
def manage_email_templates():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403

    ensure_email_templates_table()
    if request.method == 'GET':
        conn = get_admin_db_conn()
        try:
            rows = conn.execute("SELECT * FROM email_templates ORDER BY category ASC, is_active DESC, updated_at DESC").fetchall()
            return jsonify({"success": True, "templates": [dict(r) for r in rows]})
        finally:
            conn.close()

    data = request.get_json(silent=True) or {}
    action = data.get("action", "save")

    conn = get_admin_db_conn()
    try:
        if action == "activate":
            tid = (data.get("template_id") or "").strip()
            cat = (data.get("category") or "").strip()
            conn.execute("UPDATE email_templates SET is_active = 0 WHERE category = ?", (cat,))
            conn.execute("UPDATE email_templates SET is_active = 1 WHERE template_id = ?", (tid,))
            conn.commit()
            return jsonify({"success": True, "message": f"Active '{cat.upper()}' template switched!"})

        if action == "delete":
            tid = (data.get("template_id") or "").strip()
            conn.execute("DELETE FROM email_templates WHERE template_id = ?", (tid,))
            conn.commit()
            return jsonify({"success": True, "message": "Email template deleted."})

        tid = (data.get("template_id") or "").strip() or f"tpl_{uuid.uuid4().hex[:8]}"
        name = (data.get("name") or "").strip() or "Custom Template"
        category = (data.get("category") or "broadcast").strip()
        subject = (data.get("subject") or "").strip()
        logo_url = (data.get("logo_url") or "/static/images/logo3.png").strip()
        html_body = (data.get("html_body") or "").strip()
        is_active = 1 if data.get("is_active", True) else 0

        if not subject or not html_body:
            return jsonify({"success": False, "error": "Subject and HTML body are required."}), 400

        if is_active:
            conn.execute("UPDATE email_templates SET is_active = 0 WHERE category = ?", (category,))

        conn.execute(
            """
            INSERT INTO email_templates (template_id, name, category, subject, logo_url, html_body, is_active, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(template_id) DO UPDATE SET
                name = excluded.name,
                category = excluded.category,
                subject = excluded.subject,
                logo_url = excluded.logo_url,
                html_body = excluded.html_body,
                is_active = excluded.is_active,
                updated_at = excluded.updated_at
            """,
            (tid, name, category, subject, logo_url, html_body, is_active, time.time())
        )
        conn.commit()
        return jsonify({"success": True, "message": f"Template '{name}' saved!"})
    finally:
        conn.close()


@admin_tpl_bp.route('/api/admin/email-templates/upload-logo', methods=['POST'])
def upload_template_logo():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403
    f = request.files.get("logo")
    if not f or not f.filename:
        return jsonify({"success": False, "error": "Select an image file"}), 400

    ext = os.path.splitext(secure_filename(f.filename))[1].lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".svg"):
        return jsonify({"success": False, "error": "Only PNG, JPG, WEBP, or SVG allowed"}), 400

    save_dir = os.path.join(os.getcwd(), "static", "images", "email_logos")
    os.makedirs(save_dir, exist_ok=True)
    fname = f"brand_{uuid.uuid4().hex[:8]}{ext}"
    f.save(os.path.join(save_dir, fname))
    return jsonify({"success": True, "logo_url": f"/static/images/email_logos/{fname}"})