import os
import shutil
import platform
import psutil
from werkzeug.utils import secure_filename
from flask import Blueprint, request, jsonify
from db_setup import get_db_connection, DB_PATH, get_system_config_db, set_system_config_db
from admin_db import ADMIN_DB_PATH
from routes.admin.auth_ops import is_admin_authenticated

admin_vu_bp = Blueprint('admin_vault_users', __name__)
DEFAULT_HOSTED_DIR = os.getenv("DOCUMENTS_DIR", os.path.join(os.getcwd(), 'documents'))

# Prime psutil CPU counter once so subsequent reads are 0ms non-blocking
psutil.cpu_percent(interval=None)


def get_admin_vault_dir():
    configured = get_system_config_db("admin_hosted_vault_dir") or DEFAULT_HOSTED_DIR
    os.makedirs(configured, exist_ok=True)
    return os.path.abspath(configured)


def _safe_resolve_subpath(subpath: str):
    root = get_admin_vault_dir()
    clean_sub = (subpath or "").strip().lstrip("/\\")
    target = os.path.abspath(os.path.join(root, clean_sub))
    if not target.startswith(root):
        raise ValueError("Path traversal blocked")
    return root, target


def calculate_dir_size_mb(folder_path):
    total = 0
    try:
        for dp, _, fns in os.walk(folder_path):
            for f in fns:
                fp = os.path.join(dp, f)
                if os.path.isfile(fp):
                    total += os.path.getsize(fp)
    except OSError:
        pass
    return round(total / (1024 * 1024), 2)


@admin_vu_bp.route('/api/admin/vault-dir', methods=['GET', 'POST'])
def manage_admin_vault_dir():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403

    if request.method == 'POST':
        data = request.get_json(silent=True) or {}
        new_path = (data.get('path') or '').strip()
        if not new_path:
            return jsonify({"success": False, "error": "Directory path required"}), 400
        try:
            os.makedirs(new_path, exist_ok=True)
            set_system_config_db("admin_hosted_vault_dir", os.path.abspath(new_path))
            return jsonify({"success": True, "path": os.path.abspath(new_path)})
        except Exception as e:
            return jsonify({"success": False, "error": f"Invalid path: {e}"}), 400

    subpath = request.args.get("subpath", "")
    try:
        root_dir, target_dir = _safe_resolve_subpath(subpath)
        os.makedirs(target_dir, exist_ok=True)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

    entries = []
    try:
        for entry in os.scandir(target_dir):
            st = entry.stat()
            entries.append({
                "name": entry.name,
                "is_dir": entry.is_dir(),
                "size_kb": round(st.st_size / 1024, 1) if entry.is_file() else 0,
                "modified": int(st.st_mtime)
            })
    except OSError as e:
        return jsonify({"success": False, "error": str(e)}), 500

    rel_sub = os.path.relpath(target_dir, root_dir)
    if rel_sub == ".":
        rel_sub = ""

    return jsonify({
        "success": True,
        "root_path": root_dir,
        "subpath": rel_sub.replace("\\", "/"),
        "entries": sorted(entries, key=lambda x: (not x["is_dir"], x["name"].lower()))
    })


@admin_vu_bp.route('/api/admin/vault-dir/create-folder', methods=['POST'])
def admin_create_hosted_folder():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    folder_name = (data.get('folder_name') or '').strip()
    subpath = (data.get('subpath') or '').strip()
    if not folder_name or "/" in folder_name or "\\" in folder_name:
        return jsonify({"success": False, "error": "Invalid folder name"}), 400
    try:
        _, parent_dir = _safe_resolve_subpath(subpath)
        os.makedirs(os.path.join(parent_dir, folder_name), exist_ok=True)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400


@admin_vu_bp.route('/api/admin/vault-dir/upload', methods=['POST'])
def admin_upload_hosted_files():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403
    subpath = request.form.get("subpath", "")
    files = request.files.getlist("files")
    if not files:
        return jsonify({"success": False, "error": "No files selected"}), 400

    try:
        _, target_dir = _safe_resolve_subpath(subpath)
        os.makedirs(target_dir, exist_ok=True)
        saved = 0
        for f in files:
            fname = secure_filename(f.filename or "")
            if fname:
                f.save(os.path.join(target_dir, fname))
                saved += 1
        return jsonify({"success": True, "message": f"{saved} file(s) uploaded to Server Vault!"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@admin_vu_bp.route('/api/admin/vault-dir/delete', methods=['POST'])
def admin_delete_hosted_item():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    item_name = (data.get("name") or "").strip()
    subpath = (data.get("subpath") or "").strip()
    if not item_name or "/" in item_name or "\\" in item_name:
        return jsonify({"success": False, "error": "Invalid item name"}), 400

    try:
        _, parent_dir = _safe_resolve_subpath(subpath)
        target = os.path.join(parent_dir, item_name)
        if os.path.isdir(target):
            shutil.rmtree(target)
        elif os.path.isfile(target):
            os.remove(target)
        return jsonify({"success": True, "message": f"Removed '{item_name}'"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@admin_vu_bp.route('/api/admin/overview', methods=['GET'])
def admin_overall_dashboard():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403

    conn = None
    try:
        cpu = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory()
        disk = psutil.disk_usage(os.getcwd())
        hosted_dir = get_admin_vault_dir()

        conn = get_db_connection()
        users = [dict(r) for r in conn.execute(
            "SELECT user_id, full_name, email, phone, auth_provider, totp_enabled, storage_quota_mb, created_at FROM users ORDER BY created_at DESC"
        ).fetchall()]
        clouds_count = conn.execute("SELECT COUNT(*) as c FROM cloud_accounts").fetchone()["c"]
        remote_count = conn.execute("SELECT COUNT(*) as c FROM remote_storages").fetchone()["c"]
        qr_count = conn.execute("SELECT COUNT(*) as c FROM secure_qr_vault WHERE status = 'authenticated'").fetchone()["c"]

        user_db_kb = round(os.path.getsize(DB_PATH) / 1024, 1) if os.path.exists(DB_PATH) else 0
        admin_db_kb = round(os.path.getsize(ADMIN_DB_PATH) / 1024, 1) if os.path.exists(ADMIN_DB_PATH) else 0

        return jsonify({
            "success": True,
            "telemetry": {
                "os": f"{platform.system()} {platform.release()}",
                "python": platform.python_version(),
                "cpu_percent": cpu,
                "ram_percent": mem.percent,
                "ram_used_mb": round(mem.used / (1024 * 1024), 1),
                "ram_total_mb": round(mem.total / (1024 * 1024), 1),
                "disk_free_gb": round(disk.free / (1024 ** 3), 2),
                "db_size_kb": round(user_db_kb + admin_db_kb, 1),
                "hosted_vault_mb": calculate_dir_size_mb(hosted_dir),
                "total_users": len(users),
                "total_clouds": clouds_count,
                "total_remote_storages": remote_count,
                "active_qr_sessions": qr_count
            },
            "users": users
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@admin_vu_bp.route('/api/admin/users/update', methods=['POST'])
def admin_update_user():
    if not is_admin_authenticated():
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    user_id = data.get("user_id")
    action = data.get("action")
    conn = get_db_connection()
    try:
        if action == "delete":
            conn.execute("DELETE FROM users WHERE user_id = ?", (user_id,))
        conn.commit()
        return jsonify({"success": True})
    finally:
        conn.close()