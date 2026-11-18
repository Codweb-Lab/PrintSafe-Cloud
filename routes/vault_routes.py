import os
import shutil
import base64
import json
import uuid
import time
import sqlite3
import requests
from flask import Blueprint, request, jsonify, session
from werkzeug.utils import secure_filename
from vault_crypto import encrypt_bytes, decrypt_bytes
from remote_storage import (
    encrypt_storage_password,
    test_remote_storage_connection,
    list_remote_directory,
    upload_remote_file_bytes,
    download_remote_file_bytes,
    delete_remote_file
)
from db_setup import (
    get_db_connection,
    get_qr_session_db, get_cloud_account_db, get_first_enabled_cloud_account_db,
    get_all_cloud_accounts_db, get_all_imported_assets_db,
    get_print_queue_db, add_to_print_queue_db, remove_from_print_queue_db,
    record_sync_event_db
)

vault_bp = Blueprint('vault', __name__)
DOCUMENTS_DIR = os.getenv("DOCUMENTS_DIR", os.path.join(os.getcwd(), 'documents'))
os.makedirs(DOCUMENTS_DIR, exist_ok=True)
ALLOWED_EXTENSIONS = {'pdf', 'jpg', 'jpeg', 'png', 'webp', 'ipynb'}


def allowed_file(filename):
    """Checks whether the uploaded filename has an allowed document/image extension."""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


# ========================================================================
# 🌐 CUSTOM HOSTING STORAGE (SSH/SFTP & FTP) — ADD, EDIT & HARD DELETE
# ========================================================================
@vault_bp.route('/api/remote-storage', methods=['GET', 'POST', 'PUT', 'DELETE'])
def manage_remote_storage():
    """Manages SFTP/FTP connections in SQLite and purges orphaned entries on delete."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403

    owner_id = session.get('user_id', 'user')
    conn = None
    try:
        conn = get_db_connection()

        if request.method == 'GET':
            rows = conn.execute(
                """
                SELECT storage_id, label, protocol, host, port, username, base_path, is_enabled
                FROM remote_storages
                WHERE owner_id = ? OR owner_id = 'user' OR owner_id IS NULL
                ORDER BY created_at DESC
                """,
                (owner_id,)
            ).fetchall()
            return jsonify({"storages": [dict(r) for r in rows]})

        data = request.get_json(silent=True) or {}

        if request.method == 'POST':
            protocol = (data.get('protocol') or 'sftp').lower()
            host = (data.get('host') or '').strip()
            port = int(data.get('port') or (22 if protocol == 'sftp' else 21))
            username = (data.get('username') or '').strip()
            password = data.get('password') or ''
            base_path = (data.get('base_path') or '/').strip() or '/'
            label = (data.get('label') or f"{protocol.upper()} ({host})").strip()

            if not host or not username or not password:
                return jsonify({"success": False, "error": "Host, Username, and Password are required"}), 400

            dup = conn.execute(
                """
                SELECT storage_id FROM remote_storages
                WHERE (owner_id = ? OR owner_id = 'user')
                  AND protocol = ? AND host = ? AND port = ? AND username = ? AND base_path = ?
                """,
                (owner_id, protocol, host, port, username, base_path)
            ).fetchone()
            if dup:
                return jsonify({
                    "success": False,
                    "error": "This SFTP/FTP account is already connected! Click the Edit icon to update it."
                }), 409

            ok, msg = test_remote_storage_connection(protocol, host, port, username, password, base_path)
            if not ok:
                return jsonify({"success": False, "error": msg}), 400

            sid = f"rem_{uuid.uuid4().hex[:8]}"
            conn.execute('''
                INSERT INTO remote_storages
                (storage_id, owner_id, label, protocol, host, port, username, encrypted_secret, base_path, is_enabled, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            ''', (sid, owner_id, label, protocol, host, port, username, encrypt_storage_password(password), base_path, time.time()))
            conn.commit()
            return jsonify({"success": True, "message": msg})

        if request.method == 'PUT':
            sid = data.get('storage_id')
            existing = conn.execute("SELECT * FROM remote_storages WHERE storage_id = ?", (sid,)).fetchone()
            if not existing:
                return jsonify({"success": False, "error": "Storage record not found"}), 404

            protocol = (data.get('protocol') or existing['protocol']).lower()
            host = (data.get('host') or existing['host']).strip()
            port = int(data.get('port') or existing['port'])
            username = (data.get('username') or existing['username']).strip()
            base_path = (data.get('base_path') or existing['base_path']).strip() or '/'
            label = (data.get('label') or existing['label']).strip()
            new_password = data.get('password') or ''

            if new_password:
                ok, msg = test_remote_storage_connection(protocol, host, port, username, new_password, base_path)
                if not ok:
                    return jsonify({"success": False, "error": msg}), 400
                enc_secret = encrypt_storage_password(new_password)
            else:
                enc_secret = existing['encrypted_secret']

            conn.execute('''
                UPDATE remote_storages
                SET owner_id = ?, label = ?, protocol = ?, host = ?, port = ?, username = ?, encrypted_secret = ?, base_path = ?
                WHERE storage_id = ?
            ''', (owner_id, label, protocol, host, port, username, enc_secret, base_path, sid))
            conn.commit()
            return jsonify({"success": True, "message": "Hosting storage updated!", "new_label": label})

        if request.method == 'DELETE':
            sid = (data.get('storage_id') or '').strip()
            if sid == 'all':
                conn.execute("DELETE FROM remote_storages WHERE owner_id = ? OR owner_id = 'user' OR owner_id IS NULL", (owner_id,))
                conn.execute("DELETE FROM print_queue WHERE provider IN ('ftp', 'sftp')")
            elif sid:
                row = conn.execute("SELECT label FROM remote_storages WHERE storage_id = ?", (sid,)).fetchone()
                conn.execute("DELETE FROM remote_storages WHERE storage_id = ?", (sid,))
                if row and row['label']:
                    conn.execute("DELETE FROM print_queue WHERE account_name = ?", (row['label'],))
            conn.commit()
            return jsonify({"success": True, "message": "Hosting storage permanently deleted!"})

    except sqlite3.Error as e:
        print(f"[REMOTE STORAGE DB ERROR]: {e}")
        return jsonify({"success": False, "error": f"Database error: {e}"}), 500
    finally:
        if conn:
            conn.close()


# ========================================================================
# 🗑️ UNMOUNT MOUNTED FOLDER & UNIVERSAL PERMANENT FILE DELETION
# ========================================================================
@vault_bp.route('/api/vault/remove-mounted', methods=['POST'])
def remove_mounted_asset():
    """Unmounts a mounted Cloud/Hosting root asset from the user's workspace view."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    cloud_id = (data.get('cloud_id') or '').strip()
    storage_id = (data.get('storage_id') or '').strip()

    conn = None
    try:
        conn = get_db_connection()
        if storage_id:
            conn.execute("DELETE FROM remote_storages WHERE storage_id = ?", (storage_id,))
        if cloud_id:
            conn.execute("DELETE FROM imported_assets WHERE cloud_id = ?", (cloud_id,))
        if name:
            conn.execute("DELETE FROM imported_assets WHERE name = ?", (name,))
            conn.execute("DELETE FROM remote_storages WHERE label = ?", (name,))
            conn.execute("DELETE FROM print_queue WHERE account_name = ? OR name = ?", (name, name))
        conn.commit()

        for root, dirs, _ in os.walk(DOCUMENTS_DIR):
            if name in dirs:
                shutil.rmtree(os.path.join(root, name), ignore_errors=True)

        return jsonify({"success": True, "message": f'"{name}" unmounted from Vault!'})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@vault_bp.route('/api/vault/delete-file', methods=['POST'])
def delete_vault_file():
    """Permanently deletes a file from Google Drive, OneDrive, SFTP/FTP, or Local Encrypted Vault."""
    from routes.cloud_routes import get_valid_account_token
    if not session.get('is_authenticated') or session.get('login_type') == 'qr_restricted':
        return jsonify({"success": False, "error": "Unauthorized or Restricted Mode!"}), 403

    data = request.get_json(silent=True) or {}
    provider = (data.get('provider') or 'local').lower()
    relative_path = (data.get('filename') or '').strip()
    cloud_id = (data.get('cloud_id') or '').strip()
    account_id = (data.get('account_id') or '').strip()
    storage_id = (data.get('storage_id') or '').strip()
    remote_path = (data.get('remote_path') or '').strip()

    try:
        # 1. Delete from Hosting SFTP / FTP Server
        if provider in ('sftp', 'ftp') and storage_id and remote_path:
            conn = None
            try:
                conn = get_db_connection()
                row = conn.execute("SELECT * FROM remote_storages WHERE storage_id = ?", (storage_id,)).fetchone()
                if not row:
                    return jsonify({"success": False, "error": "Hosting storage configuration not found."}), 404
                delete_remote_file(dict(row), remote_path)
            finally:
                if conn:
                    conn.close()

        # 2. Delete from Google Drive or Microsoft OneDrive
        elif provider in ('google', 'onedrive') and cloud_id:
            acc = get_cloud_account_db(account_id) if account_id else get_first_enabled_cloud_account_db()
            if not acc:
                return jsonify({"success": False, "error": "Cloud account not linked or disabled."}), 404
            token = get_valid_account_token(acc['account_id'])
            if not token:
                return jsonify({"success": False, "error": "Cloud session expired. Reconnect account first."}), 401

            headers = {'Authorization': f'Bearer {token}'}
            if provider == 'google':
                del_url = f"https://www.googleapis.com/drive/v3/files/{cloud_id}"
            else:
                del_url = f"https://graph.microsoft.com/v1.0/me/drive/items/{cloud_id}"

            r = requests.delete(del_url, headers=headers, timeout=20)
            if r.status_code not in (200, 204):
                return jsonify({"success": False, "error": f"Cloud provider rejected deletion ({r.status_code}): {r.text[:120]}"}), 502

            # Also prune deleted item from cached imported_assets children JSON if present
            conn = None
            try:
                conn = get_db_connection()
                conn.execute("DELETE FROM imported_assets WHERE cloud_id = ?", (cloud_id,))
                for asset in conn.execute("SELECT cloud_id, children_data FROM imported_assets").fetchall():
                    if asset['children_data'] and cloud_id in asset['children_data']:
                        def prune_tree(nodes):
                            cleaned = []
                            for n in nodes:
                                if n.get('cloud_id') == cloud_id:
                                    continue
                                if n.get('children'):
                                    n['children'] = prune_tree(n['children'])
                                cleaned.append(n)
                            return cleaned
                        updated = prune_tree(json.loads(asset['children_data']))
                        conn.execute("UPDATE imported_assets SET children_data = ? WHERE cloud_id = ?", (json.dumps(updated), asset['cloud_id']))
                conn.commit()
            finally:
                if conn:
                    conn.close()

        # 3. Delete from Local Encrypted Vault
        elif relative_path:
            user_id = session.get('user_id', 'shared')
            user_root = os.path.join(DOCUMENTS_DIR, secure_filename(user_id))
            secure_path = os.path.normpath(os.path.join(user_root, relative_path.lstrip('/')))
            if not secure_path.startswith(os.path.normpath(user_root)) or not os.path.exists(secure_path):
                return jsonify({"success": False, "error": "File not found in encrypted vault."}), 404
            os.remove(secure_path)
        else:
            return jsonify({"success": False, "error": "Insufficient file identifiers to delete."}), 400

        # Remove from To Be Printed queue if present & broadcast sync
        if relative_path:
            remove_from_print_queue_db(relative_path)
        record_sync_event_db('file_deleted', os.path.basename(relative_path or remote_path or cloud_id), provider.upper())
        return jsonify({"success": True, "message": "File permanently deleted!"})

    except Exception as e:
        print(f"[UNIVERSAL FILE DELETE ERROR]: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# ========================================================================
# 🖨️ "TO BE PRINTED" WISHLIST QUEUE & DIRECT UPLOAD ENDPOINTS
# ========================================================================
@vault_bp.route('/api/print-queue', methods=['GET', 'POST', 'DELETE'])
def manage_print_queue():
    """Handles reading, adding, and removing files from the To Be Printed wishlist."""
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized"}), 403
    try:
        if request.method == 'GET':
            return jsonify({"items": get_print_queue_db()})
        data = request.get_json(silent=True) or {}
        if request.method == 'POST':
            add_to_print_queue_db(data)
            record_sync_event_db('print_queue_updated', data.get('name', 'Document'), 'To Be Printed')
            return jsonify({"success": True})
        if request.method == 'DELETE':
            remove_from_print_queue_db(data.get('item_path'))
            record_sync_event_db('print_queue_updated', data.get('item_path', 'Document'), 'Removed from Print Queue')
            return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@vault_bp.route('/api/upload-file', methods=['POST'])
def upload_file_to_vault():
    """Uploads files directly to active SFTP/FTP folder if inside remote storage, else user vault."""
    if not session.get('is_authenticated'):
        return jsonify({"success": False, "error": "Unauthorized Access!"}), 403
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "No file selected"}), 400

    file = request.files['file']
    target_folder = request.form.get('folder_path', '').strip('/')
    storage_id = (request.form.get('storage_id') or '').strip()
    remote_dir = (request.form.get('remote_dir') or '').strip()

    if file.filename == '' or not allowed_file(file.filename):
        return jsonify({"success": False, "error": "Invalid file or unsupported extension!"}), 400

    filename = secure_filename(file.filename)
    raw_bytes = file.read()
    ext = filename.rsplit('.', 1)[1].lower()
    file_type = "notebook" if ext == 'ipynb' else ("pdf" if ext == 'pdf' else "image")

    if storage_id:
        conn = None
        try:
            conn = get_db_connection()
            row = conn.execute("SELECT * FROM remote_storages WHERE storage_id = ?", (storage_id,)).fetchone()
            if not row:
                return jsonify({"success": False, "error": "Remote storage not found"}), 404
            row_dict = dict(row)
            remote_file_path = upload_remote_file_bytes(row_dict, remote_dir, filename, raw_bytes)
            record_sync_event_db('file_uploaded', filename, target_folder or row_dict['label'])
            return jsonify({
                "success": True,
                "file_item": {
                    "name": filename,
                    "type": "file",
                    "file_type": file_type,
                    "size": len(raw_bytes),
                    "remote_path": remote_file_path,
                    "storage_id": storage_id,
                    "provider": row_dict["protocol"],
                    "account_name": row_dict["label"]
                }
            }), 200
        except Exception as e:
            return jsonify({"success": False, "error": f"Remote upload failed: {e}"}), 500
        finally:
            if conn:
                conn.close()

    user_id = session.get('user_id', 'shared')
    user_root = os.path.join(DOCUMENTS_DIR, secure_filename(user_id))
    destination_dir = os.path.normpath(os.path.join(user_root, target_folder))

    if not destination_dir.startswith(os.path.normpath(user_root)):
        return jsonify({"success": False, "error": "Invalid directory path!"}), 403

    try:
        os.makedirs(destination_dir, exist_ok=True)
        save_path = os.path.join(destination_dir, filename)
        with open(save_path, "wb") as f:
            f.write(encrypt_bytes(raw_bytes))

        record_sync_event_db('file_uploaded', filename, target_folder or 'My Vault')
        return jsonify({
            "success": True,
            "file_item": {
                "name": filename,
                "type": "file",
                "file_type": file_type,
                "size": len(raw_bytes),
                "provider": "local",
                "account_name": "Encrypted Vault"
            }
        }), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ========================================================================
# 📂 FETCH USER VAULT TREE & IN-MEMORY STREAMING
# ========================================================================
@vault_bp.route('/fetch-vault-list', methods=['POST'])
def fetch_vault_list():
    """Builds the unified directory tree from User Vault, Cloud Drives, and Active SFTP/FTP."""
    from routes.cloud_routes import get_valid_account_token
    data = request.get_json(silent=True) or {}
    session_id = data.get('session_id') or session.get('session_id')
    if session_id:
        session_id = session_id.split('?')[0].strip()

    is_session_valid = session.get('is_authenticated') == True
    if not is_session_valid and session_id:
        qr_row = get_qr_session_db(session_id)
        if qr_row and qr_row['status'] == "authenticated":
            is_session_valid = True
            session.permanent = True
            session['is_authenticated'] = True
            session['session_id'] = session_id
            session['login_type'] = 'qr_restricted'

    if not is_session_valid:
        return jsonify({"error": "Unauthorized Access!"}), 403

    owner_id = session.get('user_id', 'shared')
    vault_tree = []

    user_root = os.path.join(DOCUMENTS_DIR, secure_filename(owner_id))
    if os.path.exists(user_root):
        def scan_user_dir(curr):
            res = []
            try:
                for entry in os.scandir(curr):
                    ext = entry.name.split('.')[-1].lower() if '.' in entry.name else ''
                    if entry.is_dir():
                        res.append({
                            "name": entry.name, "type": "folder", "children": scan_user_dir(entry.path),
                            "provider": "local", "account_name": "Encrypted Vault", "is_expired": False
                        })
                    elif entry.is_file() and ext in ALLOWED_EXTENSIONS:
                        res.append({
                            "name": entry.name, "type": "file",
                            "file_type": "notebook" if ext == 'ipynb' else ("pdf" if ext == 'pdf' else "image"),
                            "size": entry.stat().st_size, "provider": "local",
                            "account_name": "Encrypted Vault", "is_expired": False
                        })
            except OSError:
                pass
            return sorted(res, key=lambda x: (x['type'] != 'folder', x['name'].lower()))
        vault_tree.extend(scan_user_dir(user_root))

    # 2. Mounted Cloud Drive Assets (With Auto-Sync for Reconnected Accounts)

    # 2. Mounted Cloud Drive Assets (Hide when account is toggled OFF; Show instantly when toggled ON)
    try:
        from routes.cloud_routes import _fetch_cloud_folder_children
        acc_map = {}
        disabled_providers = set()
        enabled_providers = set()

        for r in get_all_cloud_accounts_db():
            acc_id = r["account_id"]
            is_en = bool(r["is_enabled"])
            prov = (r["provider"] or "google").lower()
            if is_en:
                enabled_providers.add(prov)
            else:
                disabled_providers.add(prov)

            tok = get_valid_account_token(acc_id) if is_en else None
            acc_map[acc_id] = {
                "name": r["custom_name"] if r["custom_name"] else r["email"],
                "enabled": is_en,
                "expired": (is_en and tok is None),
                "token": tok,
                "provider": prov
            }

        for row in get_all_imported_assets_db():
            acc_id = row["account_id"]
            prov = (row["provider"] or "google").lower()

            # Hide (without unmounting) if linked account is disabled
            if acc_id and acc_id in acc_map:
                if not acc_map[acc_id]["enabled"]:
                    continue
            elif prov in disabled_providers and prov not in enabled_providers:
                continue

            is_expired = acc_map[acc_id]["expired"] if (acc_id and acc_id in acc_map) else False
            effective_acc_name = (
                acc_map[acc_id]["name"]
                if (acc_id and acc_id in acc_map)
                else (row["account_name"] or ("Google Drive" if prov == "google" else "OneDrive"))
            )
            inner_children = []
            try:
                if row["children_data"] and not is_expired:
                    inner_children = json.loads(row["children_data"])
                if row["type"] == "folder" and not is_expired and acc_id in acc_map and acc_map[acc_id]["token"]:
                    fresh = _fetch_cloud_folder_children(
                        prov,
                        acc_map[acc_id]["token"],
                        row["cloud_id"],
                        acc_id,
                        effective_acc_name,
                        depth=0
                    )
                    if fresh is not None:
                        inner_children = fresh
                        c_upd = get_db_connection()
                        c_upd.execute(
                            "UPDATE imported_assets SET children_data = ?, account_name = ? WHERE cloud_id = ?",
                            (json.dumps(fresh), effective_acc_name, row["cloud_id"])
                        )
                        c_upd.commit()
                        c_upd.close()
            except Exception:
                pass

            vault_tree.append({
                "name": row["name"],
                "type": row["type"],
                "file_type": "folder" if row["type"] == 'folder' else "pdf",
                "size": 0,
                "children": inner_children,
                "cloud_id": row["cloud_id"],
                "provider": prov,
                "account_id": acc_id or "",
                "account_name": effective_acc_name,
                "is_expired": is_expired
            })
    except Exception as e:
        print(f"[CLOUD MERGE WARNING]: {e}")

    conn = None
    try:
        conn = get_db_connection()
        remotes = conn.execute(
            """
            SELECT * FROM remote_storages
            WHERE (owner_id = ? OR owner_id = 'user' OR owner_id IS NULL) AND is_enabled = 1
            """,
            (owner_id,)
        ).fetchall()
        for rem in remotes:
            rem_dict = dict(rem)
            children = list_remote_directory(rem_dict)
            vault_tree.append({
                "name": rem_dict["label"], "type": "folder", "file_type": "folder",
                "size": 0, "children": children, "storage_id": rem_dict["storage_id"],
                "remote_path": rem_dict["base_path"] or "/",
                "provider": rem_dict["protocol"],
                "account_name": f"{rem_dict['protocol'].upper()} • {rem_dict['host']}",
                "is_expired": False
            })
    except Exception as e:
        print(f"[REMOTE STORAGE TREE WARNING]: {e}")
    finally:
        if conn:
            conn.close()

    return jsonify({"tree": vault_tree})


@vault_bp.route('/fetch-file-data', methods=['POST'])
def fetch_file_data():
    """Streams file bytes from Hosting SFTP/FTP, Cloud Drives, or User Encrypted Vault."""
    from routes.cloud_routes import get_valid_account_token
    if not session.get('is_authenticated'):
        return jsonify({"error": "Unauthorized Access!"}), 403

    data = request.get_json(silent=True) or {}
    relative_path = data.get('filename')
    cloud_id = data.get('cloud_id')
    account_id = data.get('account_id')
    storage_id = data.get('storage_id')
    remote_path = data.get('remote_path')

    if storage_id and remote_path:
        conn = None
        try:
            conn = get_db_connection()
            row = conn.execute("SELECT * FROM remote_storages WHERE storage_id = ?", (storage_id,)).fetchone()
            if row:
                raw_bytes = download_remote_file_bytes(dict(row), remote_path)
                return jsonify({"base64": base64.b64encode(raw_bytes).decode('utf-8')}), 200
        except Exception as e:
            return jsonify({"error": f"Remote storage stream error: {e}"}), 502
        finally:
            if conn:
                conn.close()

    if cloud_id:
        try:
            acc = get_cloud_account_db(account_id) if account_id else get_first_enabled_cloud_account_db()
            if acc:
                token = get_valid_account_token(acc['account_id'])
                if token:
                    headers = {'Authorization': f'Bearer {token}'}
                    url = (
                        f"https://www.googleapis.com/drive/v3/files/{cloud_id}?alt=media"
                        if acc['provider'] == 'google'
                        else f"https://graph.microsoft.com/v1.0/me/drive/items/{cloud_id}/content"
                    )
                    r = requests.get(url, headers=headers, timeout=25)
                    if r.ok:
                        return jsonify({"base64": base64.b64encode(r.content).decode('utf-8')}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 502

    if relative_path:
        user_id = session.get('user_id', 'shared')
        user_root = os.path.join(DOCUMENTS_DIR, secure_filename(user_id))
        secure_path = os.path.normpath(os.path.join(user_root, relative_path.lstrip('/')))
        if secure_path.startswith(os.path.normpath(user_root)) and os.path.exists(secure_path):
            try:
                with open(secure_path, "rb") as f:
                    dec = decrypt_bytes(f.read())
                return jsonify({"base64": base64.b64encode(dec).decode('utf-8')}), 200
            except Exception as e:
                return jsonify({"error": str(e)}), 500

    return jsonify({"error": "File not found!"}), 404